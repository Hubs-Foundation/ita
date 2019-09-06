const debug = require("debug")("ita");
const fs = require("fs");
const toml = require("@iarna/toml");
const path = require("path");

// A TOML object is considered to be a config descriptor if it at least has
// a "type" key and has no keys which aren't valid descriptor metadata.
const DESCRIPTOR_FIELDS = ["from", "default", "type", "of"];
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

function getDefaultValue(descriptor, stackOutputs) {
  if ("from" in descriptor && descriptor.from in stackOutputs) {
    return stackOutputs[descriptor.from];
  } else if ("default" in descriptor) {
    return descriptor.default;
  } else {
    return undefined;
  }
}

function getDefaults(schema, stackOutputs) {
  const config = {};
  for (const k in schema) {
    const v = schema[k];
    if (typeof v === "object") {
      // it's either a descriptor, or a subtree of descriptors
      if (isDescriptor(v)) {
        const defaultValue = getDefaultValue(v, stackOutputs);
        if (defaultValue !== undefined) {
          config[k] = defaultValue;
        }
      } else {
        config[k] = getDefaults(v, stackOutputs);
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
        schemas[path.basename(name, ".toml")] = toml.parse(schemaContents);
      } catch (err) {
        debug(`Error loading schema file ${name}: ${err}.`);
      }
    }
  }
  return schemas;
}

module.exports = { loadSchemas, getDefaults };
