const { loadSchemas } = require("./schemas");
const debug = require('debug')('ita:locking');
const AWS = require('aws-sdk');
const path = require('path');
const { CloudFormation } = require("./cloud-formation");

const { Client } = require('pg');

let pgConfig;

function connectToDatabase() {
  if (!pgConfig) {
    // accept credentials from either ~/.aws/credentials file, or from standard AWS_ env variables
    const credentialProvider = new AWS.CredentialProviderChain([
      () => new AWS.EnvironmentCredentials('AWS'),
      () => new AWS.SharedIniFileCredentials(),
      () => new AWS.EC2MetadataCredentials()
    ]);

    const schemas = loadSchemas(path.join(__dirname, "..", "schemas"));
    const sharedOptions = { credentialProvider, region: process.env.AWS_REGION };
    const cloudFormation = new CloudFormation(sharedOptions, sharedOptions, sharedOptions);
    const itaConfigs = cloudFormation.read(process.env.AWS_STACK_ID, "ita", schemas.ita)

    pgConfig = {
      user: process.env.PGUSER || itaConfigs.db.username,
      password: process.env.PGPASSWORD || itaConfigs.db.password,
      host: process.env.PGHOST || itaConfigs.db.hostname,
      database: process.env.PGDATABASE || itaConfigs.db.database
    }
  }

  return new Promise((resolve, reject) => {
    const client = new Client(pgConfig);
    client.connect(err => {
      if (err) {
        debug(err);
        reject();
      } else {
        resolve(client);
      }
    });
  });
}

async function withLock(f) {
  let pg;

  try {
    pg = await connectToDatabase();
  } catch {
    debug("Unable to connect to database for locking, skipping.");
    return;
  }

  try {
    await new Promise(resolve => {
      console.log("run");
      pg.query("select * from ret0.hubs", (err, res) => {
      console.log("ran");
        console.log(res);
        resolve();
      });
    });

    await f();
  } finally {
    console.log("done");
  }
}

module.exports = { withLock };
