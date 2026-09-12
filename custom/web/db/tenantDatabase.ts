/**
 * Per-request tenant DatabaseCore access for generic doc CRUD. Builds a
 * Postgres flavored DatabaseCore against a tenant's own Neon project (the
 * same class and schema-driven setup applyTenantSchema.ts uses for the
 * one-time migration step), runs one DatabaseBase method or bespoke query
 * against it, then closes the connection: one connect, operate, close cycle
 * per request, matching applyTenantSchema.ts's already-proven connect,
 * migrate, close pattern rather than introducing a new pooling cache this
 * feature has not proven. Revisit pooling connections across requests once
 * this tracer bullet slice is confirmed correct end to end.
 *
 * This mirrors what backend/database/manager.ts's DatabaseManager does for
 * Desktop (call, callBespoke, getSchemaMap all dispatched onto one
 * DatabaseCore), except Desktop keeps one long lived DatabaseManager per app
 * process while Web has no equivalent long lived process to hold state in,
 * so this opens a fresh DatabaseCore per call instead.
 *
 * The method name always comes over HTTP as a plain string, so it is
 * checked against ALLOWED_METHODS before anything is dispatched onto it.
 * This list mirrors backend/helpers.ts's databaseMethodSet, redefined here
 * rather than imported, since that file also pulls in fs and fs/promises,
 * real Node built-ins this Workers bundle has no reason to carry just for
 * one Set literal. 'close' is deliberately excluded: this module owns
 * opening and closing the connection itself around each call, a client
 * should never be able to trigger it directly.
 *
 * Spec: docs/specs/0002-tenant-schema-data-layer.md (AC-2, AC-3)
 */
import DatabaseCore from '../../../backend/database/core';
import { getSchemas } from '../../../schemas';
import { BespokeQueries } from '../../../backend/database/bespoke';
import type { BespokeFunction } from '../../../backend/database/types';
import type { DatabaseMethod } from '../../../utils/db/types';
import type { SchemaMap } from '../../../schemas/types';

const ALLOWED_METHODS: ReadonlySet<string> = new Set<DatabaseMethod>([
  'insert',
  'get',
  'getAll',
  'getSingleValues',
  'rename',
  'update',
  'delete',
  'deleteAll',
  'exists',
]);

export class InvalidDatabaseMethodError extends Error {
  constructor(method: string) {
    super(`'${method}' is not an allowed doc CRUD method`);
  }
}

function newTenantDb(connectionString: string): DatabaseCore {
  const db = new DatabaseCore({
    client: 'pg',
    connection: connectionString,
    pool: { min: 0, max: 1 },
    useNullAsDefault: true,
  });
  // No custom fields are read here: the schema shape a CRUD call needs is
  // the one already migrated onto this tenant project. Reading a tenant's
  // own CustomField rows (the way DatabaseManager.setRawCustomFields does on
  // Desktop) belongs to the migration runner's concern (spec 0002
  // Follow-up), not each request's, until custom fields are actually
  // supported on Web.
  db.setSchemaMap(getSchemas('-', []));
  return db;
}

export async function callTenantDatabaseMethod(
  connectionString: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  if (!ALLOWED_METHODS.has(method)) {
    throw new InvalidDatabaseMethodError(method);
  }

  const db = newTenantDb(connectionString);
  try {
    await db.connect();
    const fn = db[method as DatabaseMethod] as (
      ...fnArgs: unknown[]
    ) => Promise<unknown>;
    return await fn.apply(db, args);
  } finally {
    await db.close();
  }
}

export async function callTenantBespokeMethod(
  connectionString: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(BespokeQueries, method)) {
    throw new InvalidDatabaseMethodError(method);
  }

  const db = newTenantDb(connectionString);
  try {
    await db.connect();
    // BespokeQueries only declares its members as `static async <name>(...)`
    // methods, so its instance index signature (`[key: string]:
    // BespokeFunction`) does not actually cover indexing the class object
    // itself by an arbitrary string. backend/database/manager.ts's
    // callBespoke() casts through `keyof BespokeFunction` for the same
    // lookup, which does not hold up under this package's stricter
    // tsconfig; casting through Record<string, BespokeFunction> here says
    // what is actually true instead.
    const queryFunction = (
      BespokeQueries as unknown as Record<string, BespokeFunction>
    )[method];
    return await queryFunction(db, ...args);
  } finally {
    await db.close();
  }
}

export function getTenantSchemaMap(): SchemaMap {
  // Static for the default country code ('-' — the same one
  // applyTenantSchema.ts migrates new tenants with); describing the schema
  // shape needs no live connection, so this never opens the tenant database.
  return getSchemas('-', []);
}
