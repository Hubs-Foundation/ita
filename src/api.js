const express = require('express');
const debug = require('debug')('ita:api');
const { tryWithLock } = require("./locking");
const flush = require("./flush");
const { getDefaults } = require("./schemas");
const { getTimeString } = require("./utils");
const merge = require('lodash.merge');
const MAX_UPLOADED_BUILD_SIZE = 1024 * 1024 * 256;

function forwardExceptions(routeFn) {
  return (req, res, next) => routeFn(req, res).catch(next);
}

function create(schemas, stackName, s3, cloudFormation, parameterStore, habitat, sshTotpQrData) {
  const router = express.Router();

  router.get('/deploy/:service/upload_url', forwardExceptions(async (req, res) => {
    const service = req.params.service;
    if (service !== "hubs" && service !== "spoke") {
      return res.status(400).json({ error: "Invalid service name. (Valid values: hubs, spoke)" });
    }
  
    const schema = schemas[service];
    const version = getTimeString();
    const filename = `${service}-build-${version}.tar.gz`;
    const stackConfigs = await cloudFormation.read(process.env.AWS_STACK_ID, service, schema);

    if (stackConfigs.deploy.type !== 's3') {
      return res.status(400).json({ error: `${service} is not configured for S3.` });
    }

    const s3Params = {
      Bucket: stackConfigs.deploy.target,
      Expires: 30,
      Fields: {
        key: `builds/${filename}`
      },
      Conditions: [[ "content-length-range", 0, MAX_UPLOADED_BUILD_SIZE]]
    };

    const data = await new Promise((res, rej) => {
      s3.createPresignedPost(s3Params, (err, data) => {
        if (err) rej(err);
        res(data);
      });
    });

    return res.json({ type: "s3", data, version });
  }));

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
    const configs = await parameterStore.read(`ita/${stackName}/${req.params.service}`);
    return res.json(configs);
  }));

  // reads the latest merged configs for a service
  // this is only used for hubs + spoke, so do not reveal anything else (eg ret secrets)
  router.get('/configs/:service', forwardExceptions(async (req, res) => {
    const service = req.params.service;
    if (service !== "hubs" && service !== "spoke") {
      return res.status(400).json({ error: "Invalid service name. (Valid values: hubs, spoke)" });
    }

    const schema = schemas[service];
    const stackConfigs = await cloudFormation.read(process.env.AWS_STACK_ID, service, schema);
    const parameterStoreConfigs = await parameterStore.read(`ita/${stackName}/${service}`) || {};
    const defaultConfigs = getDefaults(schema);
    const configs = merge(defaultConfigs, stackConfigs, parameterStoreConfigs);
    return res.json(configs);
  }));

  // reads additional admin-only information about the stack
  router.get('/admin-info', forwardExceptions(async (req, res) => {
    return res.json({
      ssh_totp_qr_data: sshTotpQrData,
      external_cors_proxy_domain: `${process.env.AWS_STACK_NAME}-${process.env.AWS_ACCOUNT_ID}-cors-proxy.com`,
      external_storage_domain: `${process.env.AWS_STACK_NAME}-${process.env.AWS_ACCOUNT_ID}-storage.com`,
      server_domain: process.env.SERVER_DOMAIN
    });
  }));

  // updates parameter store with new client-supplied values and flushes them to ring
  router.patch('/configs/:service', forwardExceptions(async (req, res) => {
    if (!(req.params.service in schemas)) {
      return res.status(400).json({ error: "Invalid service name." });
    }
    if (req.params.service === "ita") {
      return res.status(400).json({ error: "ita cannot manage ita." });
    }
    debug(`Updating ${req.params.service} with new values.`);
    // todo: validate against schema?
    await tryWithLock(schemas, cloudFormation, async () => {
      await parameterStore.write(`ita/${stackName}/${req.params.service}`, req.body);
      await flush(req.params.service, stackName, cloudFormation, parameterStore, habitat, schemas);
    });

    return res.json({ msg: `Update succeeded.` });
  }));

  return router;
}

module.exports = { create };
