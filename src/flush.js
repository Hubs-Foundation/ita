const diff = require('deep-diff').diff;
const merge = require('lodash.merge');
const debug = require('debug')('ita:flush');
const debugDiffs = require('debug')('ita-secrets:flush');
const { getDefaults, getSourcedConfigs, getEmptyValue, isUnmanaged, isDescriptor } = require("./schemas");

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

async function computeCurrentConfigs(service, provider, habitat, schemas, fnFetchOldConfigs = async () => {}, resolveSources = false) {
  const schema = schemas[service];
  let stackConfigs;

  try {
    stackConfigs = await provider.readStackConfigs(service, schema);
  } catch (e) {
    return { oldConfigs: null, newConfigs: null };
  }

  const editableConfigs = await provider.readEditableConfigs(service) || {};
  const defaultConfigs = getDefaults(schema);

  // For sourced configs, we need to provide a function that will compute the configs of another service.
  const fnCurrentConfigsForService = (() => {
    const sourceConfigCache = {};

    return async (service) => {
      if (sourceConfigCache[service]) return sourceConfigCache[service];
      const { newConfigs } = await computeCurrentConfigs(service, provider, habitat, schemas);
      sourceConfigCache[service] = newConfigs; // eslint-disable-line require-atomic-updates
      return newConfigs;
    };
  })();

  const sourceConfigs = resolveSources ? await getSourcedConfigs(schema, fnCurrentConfigsForService) : {};

  debug(`Computing delta for ${service}...`);

  // Any old configs not present in new configs implies they are no longer have a value, blank them out for
  // security and so subsequent runs will have no diff.
  const blankOldConfigs = {};
  const oldConfigs = await fnFetchOldConfigs();

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

  // Editable configs overrides stack overrides defaults overrides blank old configs.
  const newConfigs = merge(blankOldConfigs, defaultConfigs, sourceConfigs, stackConfigs, editableConfigs);

  return { oldConfigs, newConfigs };
}

async function flush(service, provider, habitat, schemas) {
  // TODO skip flush if the ring is already running a newer version of ita by checking census.
  // If we don't do this, adding new fields is risky because we briefly run a legacy version of ita
  // on startup, so any new configs since that version may be temporarily de-configured.
  debug(`Flushing service ${service}...`);
  const now = Date.now();
  const schema = schemas[service];
  const fnFetchOldConfigs = async () => await habitat.read(service, process.env.HAB_GROUP, process.env.HAB_ORG);

  // Editable configs overrides stack overrides defaults overrides blank old configs.
  const { oldConfigs, newConfigs } = await computeCurrentConfigs(service, provider, habitat, schemas, fnFetchOldConfigs, true);
  if (!newConfigs) {
    debug("Stack outputs are unavailable. Try again later.");
    return;
  }

  // Strip out any un-managed configs before flushing since the above code may have read them
  // from Habitat.
  deleteUnmanagedConfigs(schema, oldConfigs);
  deleteUnmanagedConfigs(schema, newConfigs);

  const differences = diff(oldConfigs, newConfigs);
  if (differences != null) {
    const diffPaths = new Set();
    for (const d of differences) {
      diffPaths.add(d.path.join("/"));
    }
    debugDiffs(differences);
    debug(`Updating Habitat configs: ${Array.prototype.join(diffPaths, ', ')}`);

    await habitat.write(service, process.env.HAB_GROUP, process.env.HAB_ORG, newConfigs, getVersion(now));
    return diffPaths;
  } else {
    debug(`All ${service} configs already up-to-date.`);
    return null;
  }
}

module.exports = flush;
