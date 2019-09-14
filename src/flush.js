import { diff } from "deep-diff";
import merge from "lodash.merge";
import debugFunc from "debug";
const { getDefaults, getEmptyValue } = require("./schemas");

const debug = debugFunc("ita:flush");

function getVersion(ts) {
  return Math.floor(ts / 1000);
}

export default async function flush(service, cloudFormation, parameterStore, habitat, schemas) {
  debug(`Flushing service ${service}...`);
  const now = Date.now();
  const schema = schemas[service];
  const stackConfigs = await cloudFormation.read(process.env.AWS_STACK_ID, service, schema);
  const parameterStoreConfigs = (await parameterStore.read(service)) || {};
  const defaultConfigs = getDefaults(schema);
  const oldConfigs = await habitat.read(service, process.env.HAB_SERVICE_GROUP_SUFFIX);

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
    debug(`Updating Habitat configs: ${Array.prototype.join(diffPaths, ", ")}`);
    await habitat.write(service, process.env.HAB_SERVICE_GROUP_SUFFIX, newConfigs, getVersion(now));
    return diffPaths;
  } else {
    debug(`All ${service} configs already up-to-date.`);
    return null;
  }
}
