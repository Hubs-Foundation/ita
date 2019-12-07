const process = require('process');
const { exec } = require("child_process");
const flush = require("../flush");
const { stackOutputsToStackConfigs } = require("../utils");
const { ParameterStore } = require('hubs-configtool');
const fs = require("fs");

const stackConfigsPath = process.env.STACK_CONFIGS_PATH;

// When using the ArbortectProvider, the stack configs and user-editable parameters are stored
// in the habitat ring, in the `polycosm-parameters` service.
//
// These configs are analagous to the CloudFormation stack Outputs and ParameterStore data in AWS.
class ArbortectProvider {
  async init(habitat) {
    this.habitat = habitat;

    this.parameterStore = new ParameterStore("leveldb", { location: process.env.PARAMETER_STORE_PATH });
    await this.parameterStore.init();
  }

  async getLastUpdatedIfComplete() {
    if (!fs.existsSync(stackConfigsPath)) {
      return null;
    }

    return fs.statSync(stackConfigsPath).mtime.getTime() * 1000;
  }

  async readStackConfigs(service, schema) {
    if (!fs.existsSync(stackConfigsPath)) {
      return {};
    }

    const configs = JSON.parse(fs.readFileSync(stackConfigsPath));
    return await stackOutputsToStackConfigs(Object.values(configs), service, schema);
  }

  async readEditableConfigs(service) {
    return await this.parameterStore.read(`ita/${service}`);
  }

  async pushDeploymentToStorage(tempDir, target, service) {
    await new Promise((res, rej) => {
      exec(`mkdir -p "${target}/${service}/pages/latest"`, {}, err => { if (err) rej(err); res(); })
    });

    await new Promise((res, rej) => {
      exec(`cp -R "${tempDir}/assets" "${target}/${service}"`, {}, err => { if (err) rej(err); res(); })
    });

    await new Promise((res, rej) => {
      exec(`cp -R ${tempDir}/pages/* "${target}/${service}/pages/latest"`, {}, err => { if (err) rej(err); res(); })
    });
  }

  async writeAndFlushParameters(service, configs, schemas) {
    await this.parameterStore.write(`ita/${service}`, configs);
    await flush(service, this, this.habitat, schemas);
  }

  async getDailyEmailSendQuota() {
    return 1000000;
  }

  async writeParameterConfigs(service, configs) {
    await this.parameterStore.write(`ita/${service}`, configs);
  }

  async getWorkerDomain() {
    if (!fs.existsSync(stackConfigsPath)) return "";
    return JSON.parse(fs.readFileSync(stackConfigsPath)).WorkerDomain.OutputValue;
  }

  async close() {
    if (this.db) {
      await this.db.close();
    }
  }
}

module.exports = { ArbortectProvider };
