# ita

Config management service.

Note that this is intentionally private for now as we don't want third-parties to easily clone our CF marketplace offering.

## Configuration schemas

Configuration schemas are TOML files where each configurable maps to an object (a TOML table) containing the keys:

- `type`: one of `string`, `boolean`, `number`, `datetime`, or `list`.
- `of` [optional]: if this value is a `list`, the `type` of each item in the list.
- `default` [optional]: the default value for this configurable.

You can use `bin/hab2schema` to generate a schema with types and defaults from a Habitat default.toml file (although in the future when these schemas are the source of truth, this generation should go the other direction.)

## Running it

Install dependencies:

```sh
$ npm ci
```

Run the server:

```sh
$ npm start
```

Put a bunch of Janus config values on Parameter Store based on schema defaults:

```sh
$ curl -X POST localhost:3000/api/initialize/janus-gateway
```

To use AWS, you will have to have credentials configured in a ~/.aws/credentials file or as environment variables (see https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EnvironmentCredentials.html).

To flush to Habitat, you'll need the `hab` binary available and access to the supervisor CTL_SECRET.

### Promote Package for Hubs Cloud Release or to unstable channel

Warning: Please be careful when doing these commands!

Promote to `polycosm-unstable` but follow the [deploying to HMC rules for the Discord bot](https://github.com/MozillaReality/hubs-discord-bot#deploying-to-hubsmozillacom) for the most part with a few differences, like:

The `export HAB_BLDR_URL=""` should match the Biome Hubs Cloud URL.
After you build the Habitat package in ita's root directory, you'll upload it to Biome using:

```
HAB_AUTH_TOKEN="<biome builder token>" hab pkg upload ./results/mozillareality-ita-0.0.1-<version>-x86_64-linux.hart
```

Then promote it to `polycosm-unstable` by using:

```
HAB_AUTH_TOKEN="<biome builder token>" hab pkg promote mozillareality/ita/0.0.1/<version> polycosm-unstable
```

Happy Ita promoting and deploying!
