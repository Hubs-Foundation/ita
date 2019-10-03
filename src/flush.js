const diff = require('deep-diff').diff;
const merge = require('lodash.merge');
const debug = require('debug')('ita:flush');
const { getDefaults, getEmptyValue } = require("./schemas");

function getVersion(ts) {
  return Math.floor(ts / 1000);
}

async function flush(service, stackName, cloudFormation, parameterStore, habitat, schemas) {
  debug(`Flushing service ${service}...`);
  const now = Date.now();
  const schema = schemas[service];
  const stackConfigs = await cloudFormation.read(process.env.AWS_STACK_ID, service, schema);
  const parameterStoreConfigs = await parameterStore.read(`ita/${stackName}/${service}`) || {};
  const defaultConfigs = getDefaults(schema);
  const oldConfigs = await habitat.read(service, process.env.HAB_GROUP, process.env.HAB_ORG);
  debug(`Computing delta for ${service}...`);

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
    await habitat.write(service, process.env.HAB_GROUP, process.env.HAB_ORG, newConfigs, getVersion(now));
    return diffPaths;
  } else {
    debug(`All ${service} configs already up-to-date.`);
    return null;
  }
}

module.exports = flush;
