const process = require('process');
const AWS = require('aws-sdk');
const { CloudFormation } = require("../cloud-formation");
const { ParameterStore } = require('hubs-configtool');
const { exec } = require("child_process");
const util = require("util");
const flush = require("../flush");

class AWSProvider {
  async init() {
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

    this.parameterStore = new ParameterStore({
      credentialProvider,
      region: process.env.AWS_REGION,
      retryDelayOptions: { base: process.env.AWS_PS_RETRY_DELAY_MS },
      // logger: { write: msg => debug(msg.trimEnd()) }
    }, process.env.AWS_PS_REQS_PER_SEC);
  }

  async getLastUpdateIfComplete() {
    return await this.cloudFormation.getLastUpdatedIfComplete(this.stackName);
  }

  async readStackConfigs(service, schema) {
    return await this.cloudFormation.read(process.env.AWS_STACK_ID, service, schema, this.parameterStore);
  }

  async readParameterConfigs(service) {
    return await this.parameterStore.read(`ita/${this.stackName}/${service}`);
  }

  getStoredFileStream(bucket, key) {
    return this.s3.getObject({ Bucket: bucket, Key: key }).createReadStream();
  }

  async pushDeploymentToStorage(tempDir, bucket, service) {
    // Push non-wasm assets
    await new Promise((res, rej) => {
      exec(`${process.env.AWS_CLI} s3 sync --region ${process.env.AWS_REGION} --acl public-read --cache-control "max-age-31556926" --exclude "*.html" --exclude "*.wasm" "${tempDir}/assets" "s3://${bucket}/${service}/assets"`, {}, err => {
        if (err) rej(err);
        res();
      })
    });

    // Push wasm assets
    await new Promise((res, rej) => {
      exec(`${process.env.AWS_CLI} s3 sync --region ${process.env.AWS_REGION} --acl public-read --cache-control "max-age-31556926" --exclude "*" --include "*.wasm" --content-type "application/wasm" "${tempDir}/assets" "s3://${bucket}/${service}/assets"`, {}, err => {
        if (err) rej(err);
        res();
      })
    });

    // Push pages
    await new Promise((res, rej) => {
      exec(`${process.env.AWS_CLI} s3 sync --region ${process.env.AWS_REGION} --acl public-read --cache-control "no-cache" --delete --exclude "assets/*" --exclude "_/*" "${tempDir}" "s3://${bucket}/${service}/pages/latest"`, {}, err => {
        if (err) rej(err);
        res();
      })
    });
  }

  async writeAndFlushParameters(service, configs, habitat, schemas) {
    await this.parameterStore.write(`ita/${this.stackName}/${service}`, configs);
    await new Promise(r => setTimeout(r, 5000));
    await flush(service, this, habitat, schemas);
  }

  async getUploadUrl(service, filename, schemas) {
    const schema = schemas[service];
    const stackConfigs = await this.readStackConfigs(process.env.AWS_STACK_ID, service, schema);

    return this.s3.getSignedUrl("putObject", {
      Bucket: stackConfigs.deploy.target,
      Expires: 1800,
      Key: `${service}/builds/${filename}`
    });
  }

  async getDailyEmailSendQuota() {
    const getSendQuota = util.promisify(this.ses.getSendQuota).bind(this.ses);
    const { Max24HourSend } = await getSendQuota({});
    return Max24HourSend;
  }

  async writeParameterConfigs(service, configs) {
    await this.parameterStore.write(`ita/${this.stackName}/${service}`, configs);
  }
}

module.exports = { AWSProvider };
