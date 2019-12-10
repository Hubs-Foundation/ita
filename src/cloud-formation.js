const AWS = require("aws-sdk");
const util = require("util");
const { stackOutputsToStackConfigs } = require("./utils");

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
    const res = await this.describeStacks({ StackName: stack });
    if (res.Stacks.length === 0) {
      throw new Error(`Stack ${stack} not found.`);
    }
    if (res.Stacks[0].Outputs.length === 0) {
      throw new Error(`Stack outputs unavailable.`);
    }

    const stackName = res.Stacks[0].StackName;
    const keymasterSecrets = parameterStore ? await parameterStore.read(`keymaster/${stackName}`) || {} : {};
    const stackOutputs = await stackOutputsToStackConfigs(res.Stacks[0].Outputs, service, schema, keymasterSecrets, this.getSecretValue, this.getS3Object);

    return stackOutputs;
  }
}

module.exports = { CloudFormation };
