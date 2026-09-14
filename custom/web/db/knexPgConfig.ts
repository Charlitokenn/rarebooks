/**
 * The single place a Web tenant's Knex config is built. Every Postgres
 * flavored `DatabaseCore` on the Web path (applyTenantSchema.ts at
 * provisioning, tenantDatabase.ts per doc CRUD call,
 * tenantMigrationRunner.ts per rollout) gets its config from here.
 *
 * Why not `{ client: 'pg' }` plus the root's `pg` package alias (the
 * original spec 0002 mechanism): Knex's string-client path runs
 * `require('pg')` from inside `knex/lib/dialects/postgres`, and the
 * Cloudflare Workers bundler turns that request into an empty stub. Knex's
 * own `browser` field in its package.json maps every database driver (`pg`,
 * `mysql2`, `sqlite3`, `better-sqlite3`, `tedious`, `oracledb`) to `false`,
 * the bundler honors that mapping, and a false-mapped CJS require compiles
 * to a no-op function. The stub surfaces far from its cause: Knex stores
 * the empty module object as its driver, and the first real connection
 * attempt throws `TypeError: this.driver.Client is not a constructor`,
 * which during provisioning marked otherwise healthy tenants FAILED.
 * Confirmed in a `wrangler deploy --dry-run` bundle of this app: the pg
 * require compiles to `__commonJS({ "(disabled):../node_modules/pg/index.js"() {} })`,
 * and the live failure trace pointed at exactly knex's
 * `new this.driver.Client(this.connectionSettings)`.
 *
 * The fix keeps the `pg` specifier out of the Worker graph entirely: pass
 * Knex the Postgres dialect class itself (the same class its string
 * resolution hands back) subclassed with `_driver()` overridden to return
 * `@neondatabase/serverless`. A direct ESM import of that package is
 * untouched by the browser mapping, so the driver object is the real one.
 * This also matches spec 0002's Decision more literally than the alias
 * did: Knex runs on `@neondatabase/serverless`'s pg-compatible Client/Pool,
 * named explicitly rather than under a specifier the bundler refuses to
 * resolve. Identical behavior in plain Node (the migration runner script
 * and the tape tests), where the alias worked; only the Worker build needed
 * the change.
 *
 * Spec: docs/specs/0002-tenant-schema-data-layer.md (AC-4); fixes the
 * provisioning failure observed while verifying docs/specs/0001 (AC-2).
 *
 * Note for whoever sets `neonConfig` someday: the Worker bundle carries two
 * copies of `@neondatabase/serverless` (worker/package.json's own dependency
 * and the root one these Web files import resolve to different real paths),
 * so a global set on one is not seen by the other. Nothing sets it today;
 * if that changes, set it on the copy the tenant connections use (the one
 * this file imports).
 */
import * as neonDriver from '@neondatabase/serverless';
import type { Knex } from 'knex';
// @ts-ignore knex ships no types for its dialect subpaths; this resolves to
// the same Client_PG class Knex's own `client: 'pg'` lookup returns.
import ClientPgCjs from 'knex/lib/dialects/postgres';

const ClientPg = ClientPgCjs as unknown as typeof Knex.Client;

/**
 * The real pg dialect with its driver lookup replaced. Knex calls
 * `new this.driver.Client(...)` when opening a connection
 * (Client_PG's `_acquireOnlyConnection`); `@neondatabase/serverless`
 * exports a pg-compatible `Client`, so its whole module namespace serves as
 * the driver object Knex would otherwise have required (and the bundler
 * would have stubbed).
 */
class NeonPgClient extends ClientPg {
  _driver(): unknown {
    return neonDriver;
  }
}

export function newTenantKnexConfig(connectionString: string): Knex.Config {
  return {
    client: NeonPgClient,
    connection: connectionString,
    pool: { min: 0, max: 1 },
    useNullAsDefault: true,
  } as Knex.Config;
}
