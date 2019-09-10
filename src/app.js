const debug = require('debug')('ita');
const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const api = require('./api');

const app = express();
const logger = morgan(process.env.REQ_LOG_FORMAT, { stream: { write: msg => debug(msg.trimEnd()) } });
app.use(logger);
app.use(bodyParser.json({ strict: true }));
app.use('/', api.create());
app.use(function (req, res, _next) {
  res.status(404).send({ error: "No such endpoint." });
});
app.use(function (err, req, res, _next) {
  debug(err);
  res.status(500).json({ error: "Internal error. See logs for details." });
});

module.exports = app;
