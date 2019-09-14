import debugFunc from "debug";
import express from "express";
import bodyParser from "body-parser";
import morgan from "morgan";
import { create } from "./api";
import path from "path";
import AWS from "aws-sdk";
import { CloudFormation } from "./cloud-formation";
import { ParameterStore, Habitat } from "hubs-configtool";
import { loadSchemas } from "./schemas";
import { tryWithLock } from "./locking";

const debug = debugFunc("ita:app");
const flush = require("./flush");
const AUTO_FLUSH_DURATION_MS = 30000;

// accept credentials from either ~/.aws/credentials file, or from standard AWS_ env variables
const credentialProvider = new AWS.CredentialProviderChain([
  () => new AWS.EnvironmentCredentials("AWS"),
  () => new AWS.SharedIniFileCredentials(),
  () => new AWS.EC2MetadataCredentials()
]);

const sharedOptions = {
  credentialProvider,
  region: process.env.AWS_REGION
  // logger: { write: msg => debug(msg.trimEnd()) }
};

const cloudFormation = new CloudFormation(sharedOptions, sharedOptions, sharedOptions);

const parameterStore = new ParameterStore(
  {
    credentialProvider,
    region: process.env.AWS_REGION,
    retryDelayOptions: { base: process.env.AWS_PS_RETRY_DELAY_MS }
    // logger: { write: msg => debug(msg.trimEnd()) }
  },
  null,
  process.env.AWS_PS_REQS_PER_SEC
);

const habitat = new Habitat(
  process.env.HAB_HTTP_HOST,
  process.env.HAB_HTTP_PORT,
  process.env.HAB_SUP_HOST,
  process.env.HAB_SUP_PORT
);

const schemas = loadSchemas("schemas");

const app = express();
const logger = morgan(process.env.REQ_LOG_FORMAT, { stream: { write: msg => debug(msg.trimEnd()) } });
app.use(logger);
app.use(bodyParser.json({ strict: true }));
app.use("/", create(schemas, cloudFormation, parameterStore, habitat));
app.use(function(req, res, _next) {
  res.status(404).send({ error: "No such endpoint." });
});
app.use(function(err, req, res, _next) {
  debug(err);
  res.status(500).json({ error: "Internal error. See logs for details." });
});

const flushAllServices = async () => {
  if (!parameterStore.pathPrefix) return; // Initializing, punt
  const services = Object.keys(schemas);
  let msg = `Auto-Flush: Flush already underway.`;

  await tryWithLock(schemas, cloudFormation, async () => {
    for (const srv of services) {
      try {
        await flush(srv, cloudFormation, parameterStore, habitat, schemas);
      } catch (e) {
        debug(`Auto-flush of ${srv} failed.`);
      }
    }
    msg = `Auto-Flush done. Services up-to-date: ${services.join(", ")}`;
  });

  debug(msg);
};
// Flush all services regularly
setInterval(flushAllServices, AUTO_FLUSH_DURATION_MS);

cloudFormation.getName(process.env.AWS_STACK_ID).then(stackName => {
  parameterStore.pathPrefix = `/ita/${stackName}`;
  flushAllServices();
});

export default app;
