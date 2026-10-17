/**
 * Regression guard for the provisioning failure found while verifying spec
 * 0001 (AC-2): Knex's `client: 'pg'` string path runs `require('pg')` from
 * inside its Postgres dialect, the Workers bundler stubs that to an empty
 * object (knex's own package.json `browser` field maps every DB driver to
 * false), and the first connection then threw
 * `TypeError: this.driver.Client is not a constructor`.
 *
 * Two halves:
 * 1. The config builder: `newTenantKnexConfig` hands Knex a real dialect
 *    class whose `_driver()` returns the actual `@neondatabase/serverless`
 *    namespace (pg-compatible `Client` included), never a bare string that
 *    would route back through the stubbable require.
 * 2. Structural: every Web tenant DatabaseCore construction site must build
 *    its config through `newTenantKnexConfig`; a reintroduced literal
 *    `client: 'pg'` in those files fails here even though plain Node (where
 *    the alias works) would still pass.
 *
 * Runs in the root tape suite (like custom/web/billing/tests/*), which
 * resolves the repo's tsconfig paths.
 *
 * Spec: docs/specs/0002-tenant-schema-data-layer.md (AC-4),
 * docs/specs/0001-web-platform-foundation-control-plane.md (AC-2).
 */
import test from 'tape';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as neonDriver from '@neondatabase/serverless';
import { knex } from 'knex';
import { newTenantKnexConfig } from '../knexPgConfig';

test('newTenantKnexConfig gives knex a real pg-compatible driver', (t) => {
  const config = newTenantKnexConfig(
    'postgresql://user:***@ep-test-123.us-east-2.aws.neon.test/db?sslmode=require'
  );
  t.equal(
    typeof config.client,
    'function',
    'client is the dialect class itself, not a string'
  );
  t.notEqual(
    config.client,
    'pg',
    'never the string that routes require("pg") through the bundler stub'
  );

  const instance = knex(config as never);
  const client: any = instance.client;
  t.equal(
    client.driverName,
    'pg',
    'still the real pg dialect under the hood (driverName)'
  );
  t.equal(client.dialect, 'postgresql', 'still the real pg dialect (dialect)');
  t.equal(
    client.driver,
    neonDriver,
    '_driver() override returns the @neondatabase/serverless namespace'
  );
  t.equal(
    typeof client.driver.Client,
    'function',
    'driver.Client is a constructor (the exact thing that was missing)'
  );
  t.equal(
    client.connectionSettings.host,
    'ep-test-123.us-east-2.aws.neon.test',
    'connection string parsed by knex as before'
  );

  instance.destroy().catch(() => undefined);
  t.end();
});

const WEB_TENANT_DB_FILES = [
  join(__dirname, '..', '..', 'auth', 'applyTenantSchema.ts'),
  join(__dirname, '..', 'tenantDatabase.ts'),
  join(__dirname, '..', 'tenantMigrationRunner.ts'),
];

test('no Web tenant DatabaseCore site configures knex via the pg string client', (t) => {
  for (const file of WEB_TENANT_DB_FILES) {
    const source = readFileSync(file, 'utf8');
    t.ok(
      !/client:\s*['"]pg['"]/.test(source),
      `${file.split('/').slice(-2).join('/')} does not use literal client: 'pg'`
    );
    t.ok(
      /newTenantKnexConfig/.test(source),
      `${file
        .split('/')
        .slice(-2)
        .join('/')} builds its knex config through newTenantKnexConfig`
    );
  }
  t.end();
});
