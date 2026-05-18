const fs = require('fs');
const process = require('process');
const debug = require('debug')('ita:app');
const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const api = require('./api');
const { Habitat } = require('hubs-configtool');
const { loadSchemas } = require("./schemas");
const { tryWithLock } = require("./locking");
const { AWSProvider } = require("./providers/aws");
const { ArbortectProvider } = require("./providers/arbortect");

const flush = require("./flush");
const AUTO_FLUSH_DURATION_MS = 30000;

async function createApp() {
  // Remove existing ready file, if exists
  if (process.env.READY_FILE && fs.existsSync(process.env.READY_FILE)) {
    fs.unlinkSync(process.env.READY_FILE);
  }

  let sshTotpQrData;

  if (process.env.SSH_TOTP_QR_FILE && fs.existsSync(process.env.SSH_TOTP_QR_FILE)) {
    sshTotpQrData = fs.readFileSync(process.env.SSH_TOTP_QR_FILE).toString();
  }

  const provider = process.env.PROVIDER === "arbortect" ? new ArbortectProvider() : new AWSProvider();

  const habitat = new Habitat(process.env.HAB_COMMAND,
                              process.env.HAB_HTTP_HOST, process.env.HAB_HTTP_PORT,
                              process.env.HAB_SUP_HOST, process.env.HAB_SUP_PORT, process.env.HAB_USER ? process.env.HAB_USER : null);

  await provider.init(habitat);

  const schemas = loadSchemas(process.env.SCHEMAS_DIR);

  const app = express();
  const logger = morgan(process.env.REQ_LOG_FORMAT, { stream: { write: msg => debug(msg && msg.trimEnd && msg.trimEnd()) } });
  app.use(logger);
  app.use(bodyParser.json({ strict: true }));
  app.use('/', api.create(schemas, provider, habitat, sshTotpQrData));
  app.use(function (req, res, _next) {
    res.status(404).send({ error: "No such endpoint." });
  });
  app.use(function (err, req, res, _next) {
    debug(err);
    res.status(500).json({ error: "Internal error. See logs for details." });
  });

  let stackLastUpdatedTime = null;

  const flushAllServicesOnStackUpdate = async () => {
    const services = Object.keys(schemas);
    let msg = `Auto-Flush: Flush already underway.`;

    const newLastUpdatedTime = await provider.getLastUpdatedIfComplete();
    if (!newLastUpdatedTime) return;

    if (!stackLastUpdatedTime || stackLastUpdatedTime !== newLastUpdatedTime) {
      await tryWithLock(schemas, provider, async () => {
        for (const srv of services) {
          if (srv === "ita") continue; // Do not flush ita. ita should be managed via user.toml.
          if (!await habitat.has(srv, process.env.HAB_GROUP, process.env.HAB_ORG)) {
            debug(`${srv}.${process.env.HAB_GROUP} not running, skipping.`);
            continue;
          }

          try {
            await flush(srv, provider, habitat, schemas);
          } catch (e) {
            debug(`Auto-flush of ${srv} failed.`);
            debug(e);
          }
        }
        msg = `Stack update detected at ${newLastUpdatedTime}. Flush done. Services up-to-date: ${services.join(", ")}`;

        stackLastUpdatedTime = newLastUpdatedTime;
      });

      debug(msg);
    }
  };

  await flushAllServicesOnStackUpdate();
  // Flush all services regularly
  setInterval(flushAllServicesOnStackUpdate, AUTO_FLUSH_DURATION_MS);

  // Touch ready file
  if (process.env.READY_FILE) {
    fs.closeSync(fs.openSync(process.env.READY_FILE, 'w'));
  }

  process.on('SIGINT', async () => {
    if (process.env.READY_FILE) {
      if (fs.existsSync(process.env.READY_FILE)) {
        fs.unlinkSync(process.env.READY_FILE);
      }
    }

    await provider.close();

    process.exit(); // eslint-disable-line no-process-exit
  });

  return app;
}

module.exports = { createApp };
