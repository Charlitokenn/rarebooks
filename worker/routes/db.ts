/**
 * Generic doc CRUD over HTTP: the web equivalent of Desktop's DB_CALL,
 * DB_BESPOKE, and DB_SCHEMA IPC actions (main/registerIpcMainActionListeners.ts),
 * and the exact contract fyo/demux/db.ts's web branch already expects
 * (getSchemaMap, call, callBespoke) — it has been throwing NotImplemented
 * pointing at this feature since feature 0001 shipped the client side first.
 * This file stays thin: request parsing, tenant resolution, and status
 * codes only. The actual DatabaseCore work lives in
 * custom/web/db/tenantDatabase.ts, matching how organization-created.ts
 * stays thin and delegates to custom/web/auth/.
 *
 * Every route here runs behind requireOrgSession (verified Clerk session,
 * org_id from the session only, never a client supplied value) and then
 * resolveTenantConnectionString, which throws TenantNotReadyError for any
 * tenant not yet READY.
 *
 * Spec: docs/specs/0002-tenant-schema-data-layer.md (AC-2, AC-3)
 */
import { Hono } from 'hono';
import {
  requireOrgSession,
  type AuthedVariables,
} from '../middleware/clerk-auth';
import {
  resolveTenantConnectionString,
  TenantNotReadyError,
} from '../db/resolve-tenant';
import {
  callTenantDatabaseMethod,
  callTenantBespokeMethod,
  getTenantSchemaMap,
  InvalidDatabaseMethodError,
} from '../../custom/web/db/tenantDatabase';
import type { WorkerEnv } from '../types';

export const dbRoute = new Hono<{
  Bindings: WorkerEnv;
  Variables: AuthedVariables;
}>();

interface CallBody {
  method: string;
  args?: unknown[];
}

function isCallBody(value: unknown): value is CallBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { method?: unknown }).method === 'string' &&
    (!Object.prototype.hasOwnProperty.call(value, 'args') ||
      Array.isArray((value as { args?: unknown }).args))
  );
}

dbRoute.get('/schema', requireOrgSession, async (c) => {
  const orgId = c.get('orgId');
  try {
    // Resolving still gates on tenant readiness even though the schema
    // shape itself is static: a tenant that is not READY has nothing real
    // to read or write yet, and the client should see that the same way
    // every other doc route does, not get back a schema for a database
    // that does not actually have it applied.
    await resolveTenantConnectionString(orgId, c.env);
  } catch (err) {
    if (err instanceof TenantNotReadyError) {
      return c.json({ error: `Tenant not ready: ${err.status}` }, 409);
    }
    return c.json({ error: 'Unable to resolve tenant' }, 500);
  }

  return c.json(getTenantSchemaMap());
});

dbRoute.post('/call', requireOrgSession, async (c) => {
  const orgId = c.get('orgId');
  const body: unknown = await c.req.json().catch(() => null);
  if (!isCallBody(body)) {
    return c.json(
      {
        error:
          'Request body must include a method string and optional args array',
      },
      400
    );
  }

  let connectionString: string;
  try {
    connectionString = await resolveTenantConnectionString(orgId, c.env);
  } catch (err) {
    if (err instanceof TenantNotReadyError) {
      return c.json({ error: `Tenant not ready: ${err.status}` }, 409);
    }
    return c.json({ error: 'Unable to resolve tenant' }, 500);
  }

  try {
    const result = await callTenantDatabaseMethod(
      connectionString,
      body.method,
      body.args ?? []
    );
    return c.json(result ?? null);
  } catch (err) {
    if (err instanceof InvalidDatabaseMethodError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json(
      { error: err instanceof Error ? err.message : 'Database call failed' },
      422
    );
  }
});

dbRoute.post('/bespoke', requireOrgSession, async (c) => {
  const orgId = c.get('orgId');
  const body: unknown = await c.req.json().catch(() => null);
  if (!isCallBody(body)) {
    return c.json(
      {
        error:
          'Request body must include a method string and optional args array',
      },
      400
    );
  }

  let connectionString: string;
  try {
    connectionString = await resolveTenantConnectionString(orgId, c.env);
  } catch (err) {
    if (err instanceof TenantNotReadyError) {
      return c.json({ error: `Tenant not ready: ${err.status}` }, 409);
    }
    return c.json({ error: 'Unable to resolve tenant' }, 500);
  }

  try {
    const result = await callTenantBespokeMethod(
      connectionString,
      body.method,
      body.args ?? []
    );
    return c.json(result ?? null);
  } catch (err) {
    if (err instanceof InvalidDatabaseMethodError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json(
      { error: err instanceof Error ? err.message : 'Bespoke call failed' },
      422
    );
  }
});
