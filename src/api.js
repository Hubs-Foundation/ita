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

function create() {

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
    retryDelayOptions: { base: 5000 }, // very conservative retry rate because of free tier rate limiting
    // logger: { write: msg => debug(msg.trimEnd()) }
  });
  const habitat = new Habitat(process.env.HAB_HTTP_HOST, process.env.HAB_HTTP_PORT,
                              process.env.HAB_SUP_HOST, process.env.HAB_SUP_PORT);
  const schemas = loadSchemas(path.join(__dirname, "..", "schemas"));
  const router = express.Router();

  // returns list of services we interact with == services we have defined config schema for
  router.get('/services', forwardExceptions(async (req, res) => {
    res.json({ services: Object.keys(schemas) });
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
    for (const srv of services) {
      debug(`Initializing service ${srv}...`);
      const schema = schemas[srv];
      const defaults = getDefaults(schema, stackOutputs);
      await parameterStore.write(srv, defaults);
      const version = Math.floor(Date.now() / 1000);
      await habitat.write(srv, process.env.HAB_SERVICE_GROUP, defaults, version);
    }
    return res.json({ msg: `Initialization done. Services up-to-date: ${services.join(", ")}` });
  }));

  // flushes data from parameter store to habitat ring
  router.post('/flush/:service?', forwardExceptions(async (req, res) => {
    if (req.params.service && !(req.params.service in schemas)) {
      return res.status(400).json({ error: "Invalid service name." });
    }
    const services = req.params.service ? [req.params.service] : Object.keys(schemas);
    for (const srv of services) {
      debug(`Flushing service ${srv}...`);
      const newConfigs = await parameterStore.read(srv);
      const oldConfigs = await habitat.read(srv, process.env.HAB_SERVICE_GROUP);
      const differences = diff(oldConfigs, newConfigs);
      if (differences != null) {
        const diffPaths = new Set();
        for (const d of differences) {
          diffPaths.add(d.path.join("/"));
        }
        const version = Math.floor(Date.now() / 1000);
        await habitat.write(srv, process.env.HAB_SERVICE_GROUP, newConfigs, version);
        return res.json({ msg: `Flush done. Services up-to-date: ${services.join(", ")}` });
      } else {
        return res.json({ msg: `Flush done. No service needed updates.` });
      }
    }
  }));

  return router;
}

module.exports = { create };
