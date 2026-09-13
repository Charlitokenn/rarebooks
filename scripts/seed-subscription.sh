#! /usr/bin/env bash

# One-off subscription seed (spec 0003, AC-7). Thin wrapper, same ts-node
# bootstrap as scripts/migrate-tenants.sh — plain node, not Electron's:
# this path only talks Postgres and the Clerk REST API, so it never loads
# better-sqlite3 and has no NODE_MODULE_VERSION concern.
#
# Usage and flags: npm run seed:subscription -- --help

export TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}'
exec node --require ts-node/register --require tsconfig-paths/register \
  scripts/seed-subscription.ts "$@"
