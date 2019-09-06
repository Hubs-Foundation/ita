const AWS = require("aws-sdk");
const util = require("util");

class CloudFormation {
  constructor(cfOptions) {
    const cf = new AWS.CloudFormation(cfOptions);
    this.describeStacks = util.promisify(cf.describeStacks).bind(cf);
  }

  async read(stack) {
    const res = await this.describeStacks({ StackName: stack });
    if (res.Stacks.length === 0) {
      throw new Error(`Stack ${stack} not found.`);
    }
    const data = {};
    for (const output of res.Stacks[0].Outputs) {
      data[output.OutputKey] = output.OutputValue;
    }
    return data;
  }
}

module.exports = { CloudFormation };
