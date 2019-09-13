const express = require('express');
const debug = require('debug')('ita:api');
const { tryWithLock } = require("./locking");
const flush = require("./flush");

function forwardExceptions(routeFn) {
  return (req, res, next) => routeFn(req, res).catch(next);
}

function create(schemas, cloudFormation, parameterStore, habitat) {
  const router = express.Router();

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
    if (!parameterStore.pathPrefix) {
      return res.status(503).json({ error: "Service initializing." });
    }
    if (!(req.params.service in schemas)) {
      return res.status(400).json({ error: "Invalid service name." });
    }
    debug(`Updating ${req.params.service} with new values.`);
    // todo: validate against schema?
    await parameterStore.write(req.params.service, req.body);
    await flush(req.params.service, cloudFormation, parameterStore, habitat, schemas);
    return res.json({ msg: `Update succeeded.` });
  }));

  // flushes data from parameter store to habitat ring
  router.post('/configs/flush/:service?', forwardExceptions(async (req, res) => {
    if (!parameterStore.pathPrefix) {
      return res.status(503).json({ error: "Service initializing." });
    }
    if (req.params.service && !(req.params.service in schemas)) {
      return res.status(400).json({ error: "Invalid service name." });
    }
    const services = req.params.service ? [req.params.service] : Object.keys(schemas);
    let msg = `Flush already underway.`

    await tryWithLock(schemas, cloudFormation, async () => {
      for (const srv of services) {
        await flush(srv, cloudFormation, parameterStore, habitat, schemas);
      }
      msg = `Flush done. Services up-to-date: ${services.join(", ")}`
    });

    return res.json({ msg });
  }));

  return router;
}

module.exports = { create };
