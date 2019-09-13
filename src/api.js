const express = require('express');
const debug = require('debug')('ita:api');
const diff = require('deep-diff').diff;
const merge = require('lodash.merge');
const path = require('path');
const AWS = require('aws-sdk');
const { CloudFormation } = require("./cloud-formation");
const { ParameterStore, Habitat } = require('hubs-configtool');
const { loadSchemas, getDefaults, getEmptyValue } = require("./schemas");
const { withLock } = require("./locking");

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
    () => new AWS.SharedIniFileCredentials(),
    () => new AWS.EC2MetadataCredentials()
  ]);

  const sharedOptions = {
    credentialProvider,
    region: process.env.AWS_REGION,
    // logger: { write: msg => debug(msg.trimEnd()) }
  };

  const cloudFormation = new CloudFormation(sharedOptions, sharedOptions, sharedOptions);

  let parameterStore;

  cloudFormation.getName(process.env.AWS_STACK_ID).then(stackName => {
    const paramsPath = `ita/${stackName}`;

    parameterStore = new ParameterStore({
      credentialProvider,
      region: process.env.AWS_REGION,
      retryDelayOptions: { base: process.env.AWS_PS_RETRY_DELAY_MS },
      // logger: { write: msg => debug(msg.trimEnd()) }
    }, paramsPath, process.env.AWS_PS_REQS_PER_SEC);
  });

  const habitat = new Habitat(process.env.HAB_HTTP_HOST, process.env.HAB_HTTP_PORT,
                              process.env.HAB_SUP_HOST, process.env.HAB_SUP_PORT);

  const schemas = loadSchemas(path.join(__dirname, "..", "schemas"));

  const router = express.Router();

  async function flushDiffs(service, now) {
    debug(`Flushing service ${service}...`);
    const schema = schemas[service];
    const stackConfigs = await cloudFormation.read(process.env.AWS_STACK_ID, service, schema);
    const parameterStoreConfigs = await parameterStore.read(service) || {};
    const defaultConfigs = getDefaults(schema);
    const oldConfigs = await habitat.read(service, process.env.HAB_SERVICE_GROUP_SUFFIX);

    // Any old configs not present in new configs implies they are no longer have a value, blank them out for
    // security and so subsequent runs will have no diff.
    const blankOldConfigs = {};

    for (let section in oldConfigs) {
      blankOldConfigs[section] = {};

      for (let config in oldConfigs[section]) {
        if (schema[section] && schema[section][config]) {
          blankOldConfigs[section][config] = getEmptyValue(schema, section, config);
        } else {
          blankOldConfigs[section][config] = "";
        }
      }
    }

    // Parameter store overrides stack overrides defaults overrides blank old configs.
    const newConfigs = merge(blankOldConfigs, defaultConfigs, stackConfigs, parameterStoreConfigs);
    const differences = diff(oldConfigs, newConfigs);
    if (differences != null) {
      const diffPaths = new Set();
      for (const d of differences) {
        diffPaths.add(d.path.join("/"));
      }
      debug(`Updating Habitat configs: ${Array.prototype.join(diffPaths, ', ')}`);
      await habitat.write(service, process.env.HAB_SERVICE_GROUP_SUFFIX, newConfigs, getVersion(now));
      return diffPaths;
    } else {
      debug(`All ${service} configs already up-to-date.`);
      return null;
    }
  }

  // emits schemas for one or all services
  router.get('/schemas/:service?', forwardExceptions(async (req, res) => {
    if (req.params.service) {
      if (!(req.params.service in schemas)) {
        return res.status(400).json({ error: "Invalid service name." });
      }
      return res.json(schemas[req.params.service]);
    } else {
      return res.json(schemas);
    }
  }));

  // reads the latest configs from parameter store
  router.get('/configs/:service/ps', forwardExceptions(async (req, res) => {
    if (!(req.params.service in schemas)) {
      return res.status(400).json({ error: "Invalid service name." });
    }
    const configs = await parameterStore.read(req.params.service);
    return res.json(configs);
  }));

  router.get('/configs/lock', forwardExceptions(async (req, res) => {
    await withLock(() => {
      console.log("in");
    });
    return res.json({});
  }));

  // reads the latest configs from the Habitat ring
  router.get('/configs/:service/hab', forwardExceptions(async (req, res) => {
    if (!(req.params.service in schemas)) {
      return res.status(400).json({ error: "Invalid service name." });
    }
    const configs = await habitat.read(req.params.service, process.env.HAB_SERVICE_GROUP_SUFFIX);
    return res.json(configs);
  }));

  // updates parameter store with new client-supplied values and flushes them to ring
  router.patch('/configs/:service', forwardExceptions(async (req, res) => {
    if (!parameterStore) {
      return res.status(503).json({ error: "Service initializing." });
    }
    if (!(req.params.service in schemas)) {
      return res.status(400).json({ error: "Invalid service name." });
    }
    debug(`Updating ${req.params.service} with new values.`);
    // todo: validate against schema?
    await parameterStore.write(req.params.service, req.body);
    await flushDiffs(req.params.service, Date.now());
    return res.json({ msg: `Update succeeded.` });
  }));

  // flushes data from parameter store to habitat ring
  router.post('/configs/flush/:service?', forwardExceptions(async (req, res) => {
    if (!parameterStore) {
      return res.status(503).json({ error: "Service initializing." });
    }
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

  return router;
}

module.exports = { create };
