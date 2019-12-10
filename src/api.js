const express = require('express');
const https = require('https');
const debug = require('debug')('ita:api');
const { tryWithLock } = require("./locking");
const flush = require("./flush");
const { getDefaults } = require("./schemas");
const { getTimeString } = require("./utils");
const merge = require('lodash.merge');
const { tmpdir } = require('os');
const { unlinkSync, mkdirSync, createWriteStream } = require('fs');
const tar = require('tar');
const rmdir = require('rimraf');
const { exec } = require("child_process");

function forwardExceptions(routeFn) {
  return (req, res, next) => routeFn(req, res).catch(next);
}

function create(schemas, provider, habitat, sshTotpQrData) {
  const router = express.Router();

  router.post('/deploy/:service', forwardExceptions(async (req, res) => {
    const service = req.params.service;
    if (service !== "hubs" && service !== "spoke") {
      return res.status(400).json({ error: "Invalid service name. (Valid values: hubs, spoke)" });
    }
  
    const schema = schemas[service];
    const { url, version } = req.body;
    const filename = `${service}-build-${version}.tar.gz`;
    const stackConfigs = await provider.readStackConfigs(service, schema);

    // Create temp directory
    const tempDir = `${process.env.TEMP || tmpdir()}/ita-deploy-${getTimeString()}`;
    await new Promise(r => rmdir(tempDir, r));
    mkdirSync(tempDir);

    // Read build tarball into temp directory
    const outStream = createWriteStream(`${tempDir}/${filename}`);
    const target = stackConfigs.deploy.target;

    await new Promise((resolve, rej) => {
      https.get(url, res => res.pipe(outStream).on('error', rej).on('close', resolve));
    });

    // Extract build and remove tarball
    await tar.x({ file: `${tempDir}/${filename}`, gzip: true, C: tempDir });
    unlinkSync(`${tempDir}/${filename}`);

    await provider.pushDeploymentToStorage(tempDir, target, service);

    // Cleanup
    await new Promise(r => rmdir(tempDir, r));

    // Stop hab package from deploying.
    await tryWithLock(schemas, provider, async () => {
      const newConfigs = {
        deploy: { type: "none" }
      };

      await provider.writeAndFlushParameters(service, newConfigs, schemas)
    });

    return res.json({ result: "ok" });
  }));

  router.post('/undeploy/:service', forwardExceptions(async (req, res) => {
    const service = req.params.service;
    if (service !== "hubs" && service !== "spoke") {
      return res.status(400).json({ error: "Invalid service name. (Valid values: hubs, spoke)" });
    }
  
    // Re-enable hab package to deploying.
    await tryWithLock(schemas, provider, async () => {
      const newConfigs = {
        deploy: { type: process.env.PROVIDER === "aws" ? "s3" : "cp" }
      };

      await provider.writeAndFlushParameters(service, newConfigs, schemas)
    });

    // Restart package, which will flush it
    await new Promise((res, rej) => {
      exec(`${process.env.HAB_COMMAND} svc stop mozillareality/${service}`, {}, err => {
        if (err) rej(err);
        res();
      })
    });

    await new Promise(r => setTimeout(r, 5000));

    await new Promise((res, rej) => {
      exec(`${process.env.HAB_COMMAND} svc start mozillareality/${service}`, {}, err => {
        if (err) rej(err);
        res();
      })
    });

    return res.json({ result: "ok" });
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
    const configs = await provider.readEditableConfigs(req.params.service);
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
    const stackConfigs = await provider.readStackConfigs(service, schema);
    const editableConfigs = await provider.readEditableConfigs(req.params.service);
    const defaultConfigs = getDefaults(schema);
    const configs = merge(defaultConfigs, stackConfigs, editableConfigs);
    return res.json(configs);
  }));

  // reads additional admin-only information about the stack
  router.get('/admin-info', forwardExceptions(async (req, res) => {
    const sendEmailQuota = await provider.getDailyEmailSendQuota();
    const retConfigs = await provider.readEditableConfigs("reticulum") || {};
    const isUsing3rdPartyEmail = process.env.MODE !== "aws" || !!(retConfigs && retConfigs.email && retConfigs.email.server);

    return res.json({
      ssh_totp_qr_data: sshTotpQrData,
      ses_max_24_hour_send: sendEmailQuota,
      using_ses: !isUsing3rdPartyEmail,
      worker_domain: await provider.getWorkerDomain(),
      assets_domain: process.env.ASSETS_DOMAIN,
      server_domain: process.env.SERVER_DOMAIN,
      provider: process.env.PROVIDER
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
    await tryWithLock(schemas, provider, async () => {
      await provider.writeParameterConfigs(req.params.service, req.body);
      await flush(req.params.service, provider, habitat, schemas);
    });

    return res.json({ msg: `Update succeeded.` });
  }));

  return router;
}

module.exports = { create };
