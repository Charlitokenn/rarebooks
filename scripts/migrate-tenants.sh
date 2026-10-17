#! /usr/bin/env bash

# One-off tenant schema migration (spec 0002, AC-5). Thin wrapper so the
# ts-node bootstrap matches scripts/runner.sh's compiler settings — but
# plain node, not Electron's: this path only ever talks Postgres (Knex's
# pg client on @neondatabase/serverless via the `pg` alias), so it never
# loads better-sqlite3 and has no NODE_MODULE_VERSION concern.
#
# Usage and flags: npm run migrate:tenants -- --help

export TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}'
exec node --require ts-node/register --require tsconfig-paths/register \
  scripts/migrate-tenants.ts "$@"
