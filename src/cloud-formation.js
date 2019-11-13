const AWS = require("aws-sdk");
const util = require("util");
const { coerceToType } = require("./schemas");

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

  async getLastUpdatedIfComplete(stack) {
    const res = await this.describeStacks({ StackName: stack });

    const stackStatus = res.Stacks[0].StackStatus;

    if (stackStatus.endsWith("_COMPLETE") || stackStatus.endsWith("_FAILED")) {
      return res.Stacks[0].LastUpdatedTime || res.Stacks[0].CreationTime;
    } else {
      return null;
    }
  }

  async read(stack, service, schema, parameterStore) {
    const setters = [];
    const res = await this.describeStacks({ StackName: stack });
    if (res.Stacks.length === 0) {
      throw new Error(`Stack ${stack} not found.`);
    }
    if (res.Stacks[0].Outputs.length === 0) {
      throw new Error(`Stack outputs unavailable.`);
    }

    const stackName = res.Stacks[0].StackName;
    const keymasterSecrets = parameterStore ? await parameterStore.read(`keymaster/${stackName}`) || {} : {};

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
          const [service, sectionAndSub, config] = path.split("/");
          const [section, subSection] = sectionAndSub.split(".");
          const target = { service, section, subSection, config, xform: null, args: [] };

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
        const value = output.OutputValue;

        if (!data[t.section]) {
          data[t.section] = {}
        }

        if (t.subSection && !data[t.section][t.subSection]) {
          data[t.section][t.subSection] = {};
        }

        setters.push(new Promise(resolve => {
          const dataTarget = t.subSection ? data[t.section][t.subSection] : data[t.section];

          if (t.xform) {
            this._performOutputXform(value, t.xform, t.args, keymasterSecrets).then(value => {
              dataTarget[t.config] = coerceToType(schema, t.section, t.subSection, t.config, value);
              resolve();
            })
          } else {
            dataTarget[t.config] = coerceToType(schema, t.section, t.subSection, t.config, value);
            resolve();
          }
        }));
      }
    }

    await Promise.all(setters);
    return data;
  }

  async _performOutputXform(value, xform, args, keymasterSecrets) {
    if (xform === "read-aws-secret" || xform === "inject-aws-secret" || xform === "read-keymaster-secret" || xform === "inject-keymaster-secret") {
      let secretId = value;

      if (xform.startsWith("inject-")) {
        secretId = value.match(/{(.*)}/)[1];
      }

      let secretValue;

      if (xform.indexOf("keymaster") >= 0) {
        secretValue = keymasterSecrets[secretId];
      } else {
        const secret = await this.getSecretValue({ SecretId: secretId });
        secretValue = JSON.parse(secret.SecretString).password; // By convention we just use the key 'password' in stacks
      }

      if (xform.startsWith("inject-")) {
        return value.split(`{${secretId}}`).join(secretValue);
      } else {
        return secretValue;
      }
    } else if (xform === "read-s3-file-escaped" || xform === "read-s3-file-as-json") {
      const [_, bucket, key] = value.match(/^s3:\/\/([^/]+)\/(.*)$/);
      const obj = await this.getS3Object({ Bucket: bucket, Key: key });
      const body = obj.Body.toString();
      if (xform === "read-s3-file-escaped") {
        return body.replace(/\n/g, "\\n");
      } else {
        return JSON.parse(body)[args[0]];
      }
    } else {
      return value;
    }
  }
}

module.exports = { CloudFormation };
