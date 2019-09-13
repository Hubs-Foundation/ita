const debug = require('debug')('ita:locking');

const { Client } = require('pg');

const LOCK_ID = -874238742382195 // Arbitrary lock id used for ita locking
const LOCK_TIMEOUT_MS = 30000;

let pgConfig;

async function connectToDatabase(schemas, cloudFormation) {
  if (!pgConfig) {
    const itaConfigs = cloudFormation.read(process.env.AWS_STACK_ID, "ita", schemas.ita)

    pgConfig = {
      user: process.env.PGUSER || itaConfigs.db.username,
      password: process.env.PGPASSWORD || itaConfigs.db.password,
      host: process.env.PGHOST || itaConfigs.db.hostname,
      database: process.env.PGDATABASE || itaConfigs.db.database
    }
  }

  const client = new Client(pgConfig);
  await client.connect();
  return client;
}

async function tryWithLock(schemas, cloudFormation, f) {
  let pg;

  try {
    pg = await connectToDatabase(schemas, cloudFormation);
  } catch {
    debug("Unable to connect to database for locking, skipping.");
    return;
  }

  await pg.query(`set idle_in_transaction_session_timeout = ${LOCK_TIMEOUT_MS}`);
  
  try {
    await pg.query("BEGIN");
    const res = await pg.query(`select pg_try_advisory_xact_lock(${LOCK_ID})`);
    if (res.rows[0].pg_try_advisory_xact_lock) {
      await f();
    }
    await pg.query("COMMIT");
  } finally {
    // For now, don't bother with connection pooling since this is such a low throughput service
    pg.end();
  }
}

module.exports = { tryWithLock };
