const process = require('process');
const AWS = require('aws-sdk');
const { CloudFormation } = require("../cloud-formation");
const { ParameterStore } = require('hubs-configtool');
const { exec } = require("child_process");
const util = require("util");
const flush = require("../flush");
const { stackOutputsToStackConfigs } = require("../utils");

class AWSProvider {
  async init(habitat) {
    this.habitat = habitat;

    // accept credentials from either ~/.aws/credentials file, or from standard AWS_ env variables
    const credentialProvider = new AWS.CredentialProviderChain([
      () => new AWS.EnvironmentCredentials('AWS'),
      () => new AWS.SharedIniFileCredentials(),
      () => new AWS.EC2MetadataCredentials()
    ]);

    const sharedOptions = {
      credentialProvider,
      region: process.env.AWS_REGION,
      signatureVersion: "v4"
      // logger: { write: msg => debug(msg.trimEnd()) }
    };

    this.cloudFormation = new CloudFormation(sharedOptions, sharedOptions, sharedOptions);
    this.s3 = new AWS.S3(sharedOptions);
    this.ses = new AWS.SES({ ...sharedOptions, region: process.env.AWS_SES_REGION });
    this.stackName = await this.cloudFormation.getName(process.env.AWS_STACK_ID);

    this.parameterStore = new ParameterStore("aws", {
      credentialProvider,
      region: process.env.AWS_REGION,
      retryDelayOptions: { base: process.env.AWS_PS_RETRY_DELAY_MS },
      requestsPerSecond: process.env.AWS_PS_REQS_PER_SEC
      // logger: { write: msg => debug(msg.trimEnd()) }
    });
  }

  async getLastUpdatedIfComplete() {
    const lastUpdated = await this.cloudFormation.getLastUpdatedIfComplete(this.stackName);
    if (!lastUpdated) return null;
    return lastUpdated.getTime();
  }

  async readStackConfigs(service, schema) {
    const stack = process.env.AWS_STACK_ID;

    const res = await this.describeStacks({ StackName: stack });
    if (res.Stacks.length === 0) {
      throw new Error(`Stack ${stack} not found.`);
    }
    if (res.Stacks[0].Outputs.length === 0) {
      throw new Error(`Stack outputs unavailable.`);
    }

    const { StackName, Outputs } = res.Stacks[0];
    const keymasterSecrets = this.parameterStore ? await this.parameterStore.read(`keymaster/${StackName}`) || {} : {};

    return await stackOutputsToStackConfigs(Outputs, service, schema, keymasterSecrets);
  }

  async readEditableConfigs(service) {
    return await this.parameterStore.read(`ita/${this.stackName}/${service}`);
  }

  async pushDeploymentToStorage(tempDir, target, service) {
    // Push non-wasm assets
    await new Promise((res, rej) => {
      exec(`${process.env.AWS_CLI} s3 sync --region ${process.env.AWS_REGION} --acl public-read --cache-control "max-age-31556926" --exclude "*.html" --exclude "*.wasm" "${tempDir}/assets" "s3://${target}/${service}/assets"`, {}, err => {
        if (err) rej(err);
        res();
      })
    });

    // Push wasm assets
    await new Promise((res, rej) => {
      exec(`${process.env.AWS_CLI} s3 sync --region ${process.env.AWS_REGION} --acl public-read --cache-control "max-age-31556926" --exclude "*" --include "*.wasm" --content-type "application/wasm" "${tempDir}/assets" "s3://${target}/${service}/assets"`, {}, err => {
        if (err) rej(err);
        res();
      })
    });

    // Push pages
    await new Promise((res, rej) => {
      exec(`${process.env.AWS_CLI} s3 sync --region ${process.env.AWS_REGION} --acl public-read --cache-control "no-cache" --delete --exclude "assets/*" --exclude "_/*" "${tempDir}" "s3://${target}/${service}/pages/latest"`, {}, err => {
        if (err) rej(err);
        res();
      })
    });
  }

  async writeAndFlushParameters(service, configs, schemas) {
    await this.parameterStore.write(`ita/${this.stackName}/${service}`, configs);
    await new Promise(r => setTimeout(r, 5000));
    await flush(service, this, this.habitat, schemas);
  }

  async getDailyEmailSendQuota() {
    const getSendQuota = util.promisify(this.ses.getSendQuota).bind(this.ses);
    const { Max24HourSend } = await getSendQuota({});
    return Max24HourSend;
  }

  async writeParameterConfigs(service, configs) {
    await this.parameterStore.write(`ita/${this.stackName}/${service}`, configs);
  }

  async getWorkerDomain() {
    return `${process.env.AWS_STACK_NAME}-${process.env.AWS_ACCOUNT_ID}-hubs-worker.com`
  }

  async close() {

  }
}

module.exports = { AWSProvider };
