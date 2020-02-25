#!/usr/bin/env bash
mkdir -p data/parameter-store-local
DEBUG=*,*:* PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres PGDATABASE=ret_dev HOST=localhost PORT=6000 SERVER_DOMAIN=hubs.local ASSETS_DOMAIN=hubs.local HAB_GROUP=default HAB_HTTP_HOST=127.0.0.1 HAB_HTTP_PORT=9631 HAB_SUP_HOST=127.0.0.1 HAB_SUP_PORT=9632 HAB_COMMAND=/usr/bin/hab HAB_CTL_SECRET=$(cat /hab/sup/default/CTL_SECRET) SCHEMAS_DIR=./schemas PROVIDER=arbortect PARAMETER_STORE_PATH=data/parameter-store-local STACK_CONFIGS_PATH=data/stack-local.yaml npm run start
