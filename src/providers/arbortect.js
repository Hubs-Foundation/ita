const process = require('process');
const { exec } = require("child_process");
const flush = require("../flush");
const { stackOutputsToStackConfigs } = require("../utils");

// When using the ArbortectProvider, the stack configs and user.configurable parameters are stored
// in the habitat ring, in the `polycosm-parameters` service.
//
// These configs are analagous to the CloudFormation stack Outputs and ParameterStore data in AWS.
class ArbortectProvider {
  async init(habitat) {
    this.habitat = habitat;
    console.log("init");
  }

  async getLastUpdatedIfComplete() {
    return await this.habitat.getVersion("polycosm-parameters", process.env.HAB_GROUP, process.env.HAB_ORG);
  }

  async readStackConfigs(service, schema) {
    const configs = (await this.habitat.read("polycosm-parameters", process.env.HAB_GROUP, process.env.HAB_ORG)).stack || {};
    return await stackOutputsToStackConfigs(configs, service, schema);
  }

  async readParameterConfigs(service) {
    return ((await this.habitat.read("polycosm-parameters", process.env.HAB_GROUP, process.env.HAB_ORG)).params || {})[service];
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

  async writeAndFlushParameters(service, configs, schemas) {
    await this.writeParameterConfigs(service, configs)
    await flush(service, this, this.habitat, schemas);
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
    return 1000000;
  }

  async writeParameterConfigs(service, configs) {
    await this.habitat.write("polycosm-parameters", process.env.HAB_GROUP, process.env.HAB_ORG, { params: { [service]: configs } }, Math.floor(Date.now() / 1000))
  }
}

module.exports = { ArbortectProvider };
