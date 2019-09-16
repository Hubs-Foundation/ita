const debug = require('debug')('ita');
const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const { createRouter } = require('./api');

function createDebugLogger(fmt) {
  return morgan(fmt, { stream: { write: msg => debug(msg.trimEnd()) } });
}

async function createApp() {
  const app = express();
  app.use(createDebugLogger(process.env.REQ_LOG_FORMAT));
  app.use(bodyParser.json({ strict: true }));
  app.use('/', await createRouter());
  app.use(function (req, res, _next) {
    res.status(404).send({ error: "No such endpoint." });
  });
  app.use(function (err, req, res, _next) {
    debug(err);
    res.status(500).json({ error: "Internal error. See logs for details." });
  });
  return app;
}

module.exports = { createApp };
