const AWS = require("aws-sdk");
const util = require("util");

class CloudFormation {
  constructor(cfOptions, cmOptions, s3Options) {
    const cf = new AWS.CloudFormation(cfOptions);
    const cm = new AWS.SecretsManager(cmOptions)
    const s3 = new AWS.S3(s3Options)
    this.describeStacks = util.promisify(cf.describeStacks).bind(cf);
    this.getSecretValue = util.promisify(cm.getSecretValue).bind(cm);
    this.getS3Object = util.promisify(s3.getObject).bind(s3);
  }

  async getName(stack) {
    const res = await this.describeStacks({ StackName: stack });
    return res.Stacks[0].StackName;
  }

  async read(stack, service) {
    const setters = [];
    const res = await this.describeStacks({ StackName: stack });
    if (res.Stacks.length === 0) {
      throw new Error(`Stack ${stack} not found.`);
    }
    const data = {};
    for (const output of res.Stacks[0].Outputs) {
      // The targets are encoded in the stack output descriptions, contained in []'s'
      let targets = [];
      const description = output.Description;
      const targetsMatch = description.match(/\[(.*)\]/);

      if (targetsMatch) {
        const targetSpecifiers = targetsMatch[1].split(",");
        targets = targetSpecifiers.map(spec => {
          const [path, xform] = spec.split("!");
          const [service, section, config] = path.split("/");
          const target = { service, section, config, xform: null, args: [] };

          if (xform) {
            target.xform = xform;

            const argsMatch = xform.match(/(.*)\((.*)\)$/);

            if (argsMatch) {
              target.xform = argsMatch[1];
              target.args = argsMatch[2].split(",");
            }
          }

          return target;
        });
      }

      const serviceTargets = targets.filter(t => t.service === service);
      for (let i = 0; i < serviceTargets.length; i++) {
        const t = serviceTargets[i];
        const path = `${t.service}/${t.section}/${t.config}`;
        const value = output.OutputValue;

        setters.push(new Promise(resolve => {
          if (t.xform) {
            this._performOutputXform(value, t.xform, t.args).then(value => {
              data[path] = value;
              resolve();
            })
          } else {
            data[path] = value;
            resolve();
          }
        }));
      }
    }

    await Promise.all(setters);
    return data;
  }

  async _performOutputXform(value, xform, args) {
    if (xform === "read-aws-secret" || xform === "inject-aws-secret") {
      let secretId = value;

      if (xform === "inject-aws-secret") {
        secretId = value.match(/{(.*)}/)[1];
      }

      const secret = await this.getSecretValue({ SecretId: secretId });
      const secretValue = JSON.parse(secret.SecretString).password; // By convention we just use the key 'password' in stacks

      if (xform === "inject-aws-secret") {
        return value.replace(`{${secretId}}`, secretValue);
      } else {
        return secretValue;
      }
    } else if (xform === "read-s3-file" || xform === "read-s3-file-as-json") {
      const [_, bucket, key] = value.match(/^s3:\/\/([^/]+)\/(.*)$/);
      const obj = await this.getS3Object({ Bucket: bucket, Key: key });
      const body = obj.Body.toString();
      if (xform === "read-s3-file") {
        return body;
      } else {
        return JSON.parse(body)[args[0]];
      }
    } else {
      return value;
    }
  }
}

module.exports = { CloudFormation };
