const express = require('express');
const debug = require('debug')('ita:api');
const diff = require('deep-diff').diff;
const path = require('path');
const AWS = require('aws-sdk');
const { CloudFormation } = require("./cloud-formation");
const { ParameterStore, Habitat } = require('hubs-configtool');
const { loadSchemas, getDefaults } = require("./schemas");

function forwardExceptions(routeFn) {
  return (req, res, next) => routeFn(req, res).catch(next);
}

function getVersion(ts) {
  return Math.floor(ts / 1000);
}

function create() {

  // accept credentials from either ~/.aws/credentials file, or from standard AWS_ env variables
  const credentialProvider = new AWS.CredentialProviderChain([
    () => new AWS.EnvironmentCredentials('AWS'),
    () => new AWS.SharedIniFileCredentials()
  ]);

  const cloudFormation = new CloudFormation({
    credentialProvider,
    region: process.env.AWS_REGION,
    // logger: { write: msg => debug(msg.trimEnd()) }
  });

  const parameterStore = new ParameterStore({
    credentialProvider,
    region: process.env.AWS_REGION,
    retryDelayOptions: { base: process.env.AWS_PS_RETRY_DELAY_MS },
    // logger: { write: msg => debug(msg.trimEnd()) }
  }, process.env.AWS_PS_REQS_PER_SEC);

  const habitat = new Habitat(process.env.HAB_HTTP_HOST, process.env.HAB_HTTP_PORT,
                              process.env.HAB_SUP_HOST, process.env.HAB_SUP_PORT);

  const schemas = loadSchemas(path.join(__dirname, "..", "schemas"));

  const router = express.Router();

  async function flushDiffs(service, now) {
    debug(`Flushing service ${service}...`);
    const newConfigs = await parameterStore.read(service);
    const oldConfigs = await habitat.read(service, process.env.HAB_SERVICE_GROUP);
    const differences = diff(oldConfigs, newConfigs);
    if (differences != null) {
      const diffPaths = new Set();
      for (const d of differences) {
        diffPaths.add(d.path.join("/"));
      }
      debug(`Updating Habitat configs: ${Array.prototype.join(diffPaths, ', ')}`);
      await habitat.write(service, process.env.HAB_SERVICE_GROUP, newConfigs, getVersion(now));
      return diffPaths;
    } else {
      debug(`All ${service} configs already up-to-date.`);
      return null;
    }
  }

  router.get('/schemas', forwardExceptions(async (req, res) => {
    res.json(schemas);
  }));

  // initializes parameter store with data from schema + stack outputs
  router.post('/initialize/:service?', forwardExceptions(async (req, res) => {
    if (req.params.service && !(req.params.service in schemas)) {
      return res.status(400).json({ error: "Invalid service name." });
    }
    if (!process.env.AWS_STACK_ID) {
      return res.status(400).json({ error: "No stack ID configured; can't initialize from stack outputs." });
    }
    const stackOutputs = await cloudFormation.read(process.env.AWS_STACK_ID);
    const services = req.params.service ? [req.params.service] : Object.keys(schemas);
    const now = Date.now();
    for (const srv of services) {
      debug(`Initializing service ${srv}...`);
      const schema = schemas[srv];
      const defaults = getDefaults(schema, stackOutputs);
      await parameterStore.write(srv, defaults);
      await habitat.write(srv, process.env.HAB_SERVICE_GROUP, defaults, getVersion(now));
    }
    return res.json({ msg: `Initialization done. Services up-to-date: ${services.join(", ")}` });
  }));

  // flushes data from parameter store to habitat ring
  router.post('/flush/:service?', forwardExceptions(async (req, res) => {
    if (req.params.service && !(req.params.service in schemas)) {
      return res.status(400).json({ error: "Invalid service name." });
    }
    const services = req.params.service ? [req.params.service] : Object.keys(schemas);
    const now = Date.now();
    for (const srv of services) {
      await flushDiffs(srv, now);
    }
    return res.json({ msg: `Flush done. Services up-to-date: ${services.join(", ")}` });
  }));

  // updates parameter store with new client-supplied values and flushes them to ring
  router.post('/update/:service', forwardExceptions(async (req, res) => {
    if (!(req.params.service in schemas)) {
      return res.status(400).json({ error: "Invalid service name." });
    }
    debug(`Updating ${req.params.service} with new values.`);
    // todo: validate against schema?
    await parameterStore.write(req.params.service, req.body);
    await flushDiffs(req.params.service, Date.now());
    return res.json({ msg: `Update succeeded.` });
  }));


  return router;
}

module.exports = { create };
