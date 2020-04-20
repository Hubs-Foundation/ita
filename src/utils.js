const { coerceToType } = require("./schemas");

function getTimeString() {
  const p = n => (n < 10 ? `0${n}` : n);
  const d = new Date();
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds()
  )}`;
}

async function _performOutputXform(value, xform, args, keymasterSecrets, getSecretValue, getS3Object) {
  if (xform === "read-aws-secret" || xform === "inject-aws-secret" || xform === "read-keymaster-secret" || xform === "inject-keymaster-secret" || xform == "inject-secrets" || xform == "read-secrets") {
    let isInjection = xform.startsWith("inject-");

    let isKeymasterAndProvider = xform === "inject-secrets" || xform == "read-secrets";
    let isKeymasterOnly = xform.indexOf("keymaster") >= 0;
    let isProviderOnly = xform.indexOf("aws") >= 0;

    let secretId = value;

    if (isInjection) {
      secretId = value.match(/{(.*)}/)[1];
    }

    let secretValue;

    if (isKeymasterOnly || isKeymasterAndProvider) {
      secretValue = keymasterSecrets[secretId];
    }

    if (isProviderOnly || (isKeymasterAndProvider && !secretValue)) {
      const secret = await getSecretValue({ SecretId: secretId });
      secretValue = JSON.parse(secret.SecretString).password; // By convention we just use the key 'password' in stacks
    }

    if (isInjection) {
      return value.split(`{${secretId}}`).join(secretValue);
    } else {
      return secretValue;
    }
  } else if (xform === "read-s3-file-escaped" || xform === "read-s3-file-as-json") {
    const [_, bucket, key] = value.match(/^s3:\/\/([^/]+)\/(.*)$/);
    const obj = await getS3Object({ Bucket: bucket, Key: key });
    const body = obj.Body.toString();
    if (xform === "read-s3-file-escaped") {
      return body.replace(/\n/g, "\\n");
    } else {
      return JSON.parse(body)[args[0]];
    }
  } else {
    return value;
  }
}

async function stackOutputsToStackConfigs(outputs, service, schema, keymasterSecrets, getSecretValue, getS3Object) {
  const setters = [];

  const data = {};
  for (const output of outputs) {
    // The targets are encoded in the stack output descriptions, contained in []'s', or in Targets field
    let targets = [];
    const description = output.Description || "";
    const targetsMatch = description.match(/\[(.*)\]/);

    if (targetsMatch || output.Targets) {
      const targetSpecifiers = output.Targets || targetsMatch[1].split(",");
      targets = targetSpecifiers.map(spec => {
        const [path, xform] = spec.split("!");
        const [service, sectionAndSub, config] = path.split("/");
        const [section, subSection] = sectionAndSub.split(".");
        const target = { service, section, subSection, config, xform: null, args: [] };

        if (xform) {
          target.xform = xform;

          const argsMatch = xform.match(/(.*)\((.*)\)$/);

          if (argsMatch) {
            target.xform = argsMatch[1];
            target.args = argsMatch[2].split(",");
          }
        }

        return target;
      });
    }

    const serviceTargets = targets.filter(t => t.service === service);
    for (let i = 0; i < serviceTargets.length; i++) {
      const t = serviceTargets[i];
      const value = output.OutputValue;

      if (!data[t.section]) {
        data[t.section] = {}
      }

      if (t.subSection && !data[t.section][t.subSection]) {
        data[t.section][t.subSection] = {};
      }

      setters.push(new Promise(resolve => {
        const dataTarget = t.subSection ? data[t.section][t.subSection] : data[t.section];

        if (t.xform) {
          _performOutputXform(value, t.xform, t.args, keymasterSecrets, getSecretValue, getS3Object).then(value => {
            dataTarget[t.config] = coerceToType(schema, t.section, t.subSection, t.config, value);
            resolve();
          })
        } else {
          dataTarget[t.config] = coerceToType(schema, t.section, t.subSection, t.config, value);
          resolve();
        }
      }));
    }
  }

  await Promise.all(setters);
  return data;
}

module.exports = { getTimeString, stackOutputsToStackConfigs };
