const diff = require('deep-diff').diff;
const merge = require('lodash.merge');
const debug = require('debug')('ita:flush');
const { getDefaults, getEmptyValue, isUnmanaged, isDescriptor } = require("./schemas");

function getVersion(ts) {
  return Math.floor(ts / 1000);
}

function deleteUnmanagedConfigs(schema, configs) {
  // For completeness, all server configs are in the schema. However, some are
  // marked as 'unmanaged', which means ita is not responsible for syncing them
  // to the ring. (Eg they are managed in user.toml) So, we strip them here so
  // when we flush we do not affect the ring with any unmanaged configs.
  const stripUnmanaged = (o, schema, section, subSection) => {
    const unmanaged = [];

    for (const k of Object.keys(o)) {
      if (isUnmanaged(schema, section, subSection, k)) {
        unmanaged.push(k);
      }
    }

    for (const k of unmanaged) {
      delete o[k];
    }
  }

  for (const section of Object.keys(configs)) {
    stripUnmanaged(configs[section], schema, section);

    for (const subSection of Object.keys(configs[section])) {
      if (!isDescriptor(schema[section][subSection])) {
        // Subsection
        stripUnmanaged(configs[section][subSection], schema, section, subSection);
      }
    }
  }
}

async function flush(service, stackName, cloudFormation, parameterStore, habitat, schemas) {
  debug(`Flushing service ${service}...`);
  const now = Date.now();
  const schema = schemas[service];
  const stackConfigs = await cloudFormation.read(process.env.AWS_STACK_ID, service, schema);

  if (!stackConfigs || stackConfigs.length === 0) {
    debug("Stack outputs are unavailable. Try again later.");
    return;
  }

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

  // Strip out any un-managed configs before flushing since the above code may have read them
  // from Habitat.
  deleteUnmanagedConfigs(schema, newConfigs);

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
