/**
 * Resolves the signed-in session's org to ITS OWN Neon project connection
 * string. This is the only place a tenant's connection string is decrypted,
 * and it happens in memory, per request, from a short-TTL cache keyed on
 * org_id — never cached across different orgs, never logged, never returned
 * to the client.
 *
 * Every later feature that touches tenant data (0002 onward) calls this
 * first. There is no `org_id` column anywhere in a tenant project: the
 * connection returned here IS the tenant boundary.
 *
 * NOTE (0002): this used to return a one-shot `neon()` tagged-template
 * function, the right shape for feature 0001's own lightweight control-plane
 * queries but the wrong one for this feature: spec 0002's Decision calls for
 * doc CRUD to run through `DatabaseCore`'s Knex `pg` client on
 * `@neondatabase/serverless`'s `Pool`, not a one-shot query function. Nothing
 * had called this export yet (0001 only shipped the resolution plumbing), so
 * this feature changes the return type to the decrypted connection string
 * itself and leaves building a `DatabaseCore` from it to
 * `custom/web/db/tenantDatabase.ts`, which also owns pooling that connection
 * across requests. Keeping "resolve which tenant, decrypt its string" and
 * "hold a live DB client for it" as separate concerns matches how
 * `worker/db/control.ts` (connection) and `worker/db/resolve-tenant.ts`
 * (resolution) were already split for the control plane.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md,
 * docs/specs/0002-tenant-schema-data-layer.md
 */
import { getControlDb, getTenantProject } from './control';
import { decrypt } from '../lib/encryption';

export type TenantStatus =
  | 'PROVISIONING'
  | 'PROJECT_CREATED'
  | 'READY'
  | 'SUSPENDED'
  | 'FAILED';

interface CacheEntry {
  connectionString: string | null;
  status: TenantStatus;
  expiresAt: number;
}

// Per-isolate, in-memory only — never persisted, never shared across orgs.
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

export class TenantNotReadyError extends Error {
  constructor(public readonly status: string) {
    super(`Tenant project is not READY (status: ${status})`);
  }
}

/**
 * Returns the decrypted connection string for a READY tenant, or throws
 * TenantNotReadyError with the tenant's actual status otherwise.
 */
export async function resolveTenantConnectionString(
  orgId: string,
  env: { CONTROL_DATABASE_URL: string; TENANT_ENCRYPTION_KEY: string }
): Promise<string> {
  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.status !== 'READY' || !cached.connectionString) {
      throw new TenantNotReadyError(cached.status);
    }
    return cached.connectionString;
  }

  const controlDb = getControlDb(env);
  const row = await getTenantProject(controlDb, orgId);
  if (!row) {
    throw new Error(`No tenant project provisioned for org ${orgId}`);
  }

  if (row.status !== 'READY') {
    cache.set(orgId, {
      connectionString: null,
      status: row.status,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    throw new TenantNotReadyError(row.status);
  }

  const connectionString = await decrypt(
    row.connection_string,
    env.TENANT_ENCRYPTION_KEY
  );

  cache.set(orgId, {
    connectionString,
    status: row.status,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return connectionString;
}
