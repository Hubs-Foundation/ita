const debug = require("debug")("ita");
const fs = require("fs");
const toml = require("@iarna/toml");
const path = require("path");

// A TOML object is considered to be a config descriptor if it at least has
// a "type" key and has no keys which aren't valid descriptor metadata.
const DESCRIPTOR_FIELDS = ["default", "type", "of"];
function isDescriptor(obj) {
  if (typeof obj !== "object") return false;
  if (!("type" in obj)) return false;
  for (const k in obj) {
    if (!DESCRIPTOR_FIELDS.includes(k)) {
      return false;
    }
  }
  return true;
}

function getDefaultValue(descriptor) {
  if ("default" in descriptor) {
    return descriptor.default;
  } else {
    return undefined;
  }
}

// Given the schema and the path to a config, returns a valid empty value for the type of the descriptor if one is present.
function getEmptyValue(schema, section, config) {
  if (!schema[section]) return "";

  const descriptor = schema[section][config];
  if (!descriptor) return "";
  if (!("type" in descriptor)) return "";
  if (descriptor.type === "number") return 0;
  return "";
}

// Given the schema and the path to a config, coerces the value to the type of the descriptor if one is present.
function coerceToType(schema, section, subSection, config, value) {
  if (!schema[section]) return value;
  const descriptor = subSection ? schema[section][subSection][config] : schema[section][config];
  if (!descriptor || !("type" in descriptor)) return value;
  if (descriptor.type === "number" && value) return parseInt(value);
  return value;
}

function getDefaults(schema) {
  const config = {};
  for (const k in schema) {
    const v = schema[k];
    if (typeof v === "object") {
      // it's either a descriptor, or a subtree of descriptors
      if (isDescriptor(v)) {
        const defaultValue = getDefaultValue(v);
        if (defaultValue !== undefined) {
          config[k] = defaultValue;
        }
      } else {
        config[k] = getDefaults(v);
      }
    } else {
      // schemas should only be a tree of descriptors!
      throw new Error(`Schema contains invalid field ${k} = ${v}.`);
    }
  }
  return config;
}

function loadSchemas(dir) {
  const schemas = {};
  const schemaFiles = fs.readdirSync(dir);
  for (const name of schemaFiles) {
    if (name.endsWith(".toml")) {
      try {
        const schemaContents = fs.readFileSync(path.join(dir, name));
        const schema = toml.parse(schemaContents);

        // For completeness, all server configs are in the schema. However, some are
        // marked as 'unmanaged', which means ita is not responsible for syncing them
        // to the ring. (Eg they are managed in user.toml) So, we strip them here so
        // the rest of ita effectively can ignore the distinction.
        //
        // Note that as soon as a config is synced to the ring, it becomes impossible
        // to override it with user.toml, so basically once a config becomes managed
        // by ita it is not possible to revoke management. (Additionally, it becomes
        // impossible to vary that config on a per-node basis.);
        const stripUnmanaged = (o) => {
          const unmanaged = [];

          for (const k of Object.keys(o)) {
            if ("unmanaged" in o[k] && o[k].unmanaged) {
              unmanaged.push(k);
            }
          }

          for (const k of unmanaged) {
            delete o[k];
          }
        }

        for (const group of Object.keys(schema)) {
          stripUnmanaged(schema[group]);

          for (const field of Object.keys(schema[group])) {
            if (!("type" in schema[group][field])) {
              // Subgroup
              stripUnmanaged(schema[group][field]);
            }
          }
        }

        schemas[path.basename(name, ".toml")] = schema;
      } catch (err) {
        debug(`Error loading schema file ${name}: ${err}.`);
      }
    }
  }
  return schemas;
}

module.exports = { loadSchemas, getDefaults, getEmptyValue, coerceToType };
