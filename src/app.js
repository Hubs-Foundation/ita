const fs = require('fs');
const process = require('process');
const debug = require('debug')('ita');
const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const api = require('./api');
const AWS = require('aws-sdk');
const { CloudFormation } = require("./cloud-formation");
const { ParameterStore, Habitat } = require('hubs-configtool');
const { loadSchemas } = require("./schemas");
const { tryWithLock } = require("./locking");
const flush = require("./flush");
const AUTO_FLUSH_DURATION_MS = 30000;

async function createApp() {
  // Remove existing ready file, if exists
  if (process.env.READY_FILE && fs.existsSync(process.env.READY_FILE)) {
    fs.unlinkSync(process.env.READY_FILE);
  }

  // accept credentials from either ~/.aws/credentials file, or from standard AWS_ env variables
  const credentialProvider = new AWS.CredentialProviderChain([
    () => new AWS.EnvironmentCredentials('AWS'),
    () => new AWS.SharedIniFileCredentials(),
    () => new AWS.EC2MetadataCredentials()
  ]);

  const sharedOptions = {
    credentialProvider,
    region: process.env.AWS_REGION,
    // logger: { write: msg => debug(msg.trimEnd()) }
  };

  const cloudFormation = new CloudFormation(sharedOptions, sharedOptions, sharedOptions);
  const stackName = await cloudFormation.getName(process.env.AWS_STACK_ID);

  const parameterStore = new ParameterStore({
    credentialProvider,
    region: process.env.AWS_REGION,
    retryDelayOptions: { base: process.env.AWS_PS_RETRY_DELAY_MS },
    // logger: { write: msg => debug(msg.trimEnd()) }
  }, process.env.AWS_PS_REQS_PER_SEC);

  const habitat = new Habitat(process.env.HAB_COMMAND,
                              process.env.HAB_HTTP_HOST, process.env.HAB_HTTP_PORT,
                              process.env.HAB_SUP_HOST, process.env.HAB_SUP_PORT);

  const schemas = loadSchemas(process.env.SCHEMAS_DIR);

  const app = express();
  const logger = morgan(process.env.REQ_LOG_FORMAT, { stream: { write: msg => debug(msg.trimEnd()) } });
  app.use(logger);
  app.use(bodyParser.json({ strict: true }));
  app.use('/', api.create(schemas, stackName, cloudFormation, parameterStore, habitat));
  app.use(function (req, res, _next) {
    res.status(404).send({ error: "No such endpoint." });
  });
  app.use(function (err, req, res, _next) {
    debug(err);
    res.status(500).json({ error: "Internal error. See logs for details." });
  });

  const flushAllServices = async () => {
    const services = Object.keys(schemas);
    let msg = `Auto-Flush: Flush already underway.`;

    await tryWithLock(schemas, cloudFormation, async () => {
      for (const srv of services) {
        if (srv === "ita") continue; // Do not flush ita. ita should be managed via user.toml.
        if (!await habitat.has(srv, process.env.HAB_GROUP, process.env.HAB_ORG)) {
          debug(`${srv}.${process.env.HAB_GROUP} not running, skipping.`);
          continue;
        }

        try {
          await flush(srv, stackName, cloudFormation, parameterStore, habitat, schemas);
        } catch (e) {
          debug(`Auto-flush of ${srv} failed.`);
          debug(e);
        }
      }
      msg = `Auto-Flush done. Services up-to-date: ${services.join(", ")}`;
    });

    debug(msg);
  };

  await flushAllServices();
  // Flush all services regularly
  setInterval(flushAllServices, AUTO_FLUSH_DURATION_MS);

  // Touch ready file
  if (process.env.READY_FILE) {
    fs.closeSync(fs.openSync(process.env.READY_FILE, 'w'));

    process.on('SIGINT', () => {
      if (fs.existsSync(process.env.READY_FILE)) {
        fs.unlinkSync(process.env.READY_FILE);
      }

      process.exit(); // eslint-disable-line no-process-exit
    });
  }

  return app;
}

module.exports = { createApp };
