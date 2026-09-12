/**
 * Worker-side tests for spec 0003: the subscription gate's denial shapes,
 * its position before tenant resolution (AC-1, AC-2), and the fact that
 * every route under /api/db is covered by the single `dbRoute.use(...)`
 * mount rather than per-route arguments (AC-3). Vitest with the real Hono
 * app, fake control plane, and the tenant resolver mocked out so "never
 * resolved" is provable, not assumed.
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-1, AC-2, AC-3, AC-8)
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuth } from '@clerk/hono';
import type { ControlQueryFn } from '../../custom/web/billing/types';
import { dbRoute } from '../routes/db';
import { subscriptionStatusRoute } from '../routes/subscription-status';
import { getControlDb } from '../db/control';
// The module is mocked below, so this is the mocked class: exactly the one
// db.ts's `instanceof` check sees at runtime.
import { resolveTenantConnectionString, TenantNotReadyError } from '../db/resolve-tenant';

const mockGetAuth = vi.mocked(getAuth);
const mockGetControlDb = vi.mocked(getControlDb);
const mockResolve = vi.mocked(resolveTenantConnectionString);

vi.mock('@clerk/hono', () => ({
  clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getAuth: vi.fn(),
}));

vi.mock('../db/control', () => ({
  getControlDb: vi.fn(),
  // db.ts's siblings import helpers from here; only what the gate and the
  // status route touch needs a runtime mock.
}));

vi.mock('../db/resolve-tenant', () => {
  class TenantNotReadyError extends Error {
    constructor(public readonly status: string) {
      super(`Tenant project is not READY (status: ${status})`);
    }
  }
  return { TenantNotReadyError, resolveTenantConnectionString: vi.fn() };
});

// The tenant DB layer sits behind the gate; real behavior there is spec
// 0002's test surface. Stubbed so importing routes/db.ts never evaluates
// backend/database/core.ts (whose root path aliases don't resolve in vitest).
vi.mock('../../custom/web/db/tenantDatabase', () => ({
  callTenantDatabaseMethod: vi.fn(async () => ({})),
  callTenantBespokeMethod: vi.fn(async () => ({})),
  getTenantSchemaMap: vi.fn(() => ({})),
  InvalidDatabaseMethodError: class InvalidDatabaseMethodError extends Error {},
}));

function fakeControlDb(
  handler: (orgId: string) => Array<{ status: string }> | Error
) {
  const db: ControlQueryFn = async (strings, ...values) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    if (!sql.startsWith('SELECT status FROM subscriptions')) {
      throw new Error(`unexpected SQL in fake control db: ${sql}`);
    }
    const result = handler(values[0] as string);
    if (result instanceof Error) throw result;
    return result;
  };
  return db;
}

function signedInApp() {
  const app = new Hono();
  app.route('/api/db', dbRoute);
  app.route('/api/subscription/status', subscriptionStatusRoute);
  return app;
}

const AUTH_OK = {
  isAuthenticated: true,
  userId: 'user_1',
  orgId: 'org_1',
  orgRole: 'org:admin',
};

beforeEach(() => {
  vi.resetAllMocks();
  mockGetAuth.mockReturnValue(AUTH_OK as never);
  // A default READY tenant: denial tests assert the resolver was NOT
  // called, pass tests assert it WAS.
  mockResolve.mockResolvedValue('postgres://tenant-fake');
});

describe('subscription gate on /api/db (AC-1, AC-2, AC-3)', () => {
  it('passes an ACTIVE org through to the route handler', async () => {
    mockGetControlDb.mockReturnValue(
      fakeControlDb(() => [{ status: 'ACTIVE' }]) as never
    );
    mockResolve.mockResolvedValue('postgres://fake');
    const app = signedInApp();

    const res = await app.request('/api/db/schema');
    expect(res.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  for (const [stored, wire] of [
    ['PAST_DUE', 'PAST_DUE'],
    ['SUSPENDED', 'SUSPENDED'],
    ['CANCELLED', 'CANCELLED'],
    ['PENDING_REVIEW', 'PENDING_REVIEW'],
    ['EXPIRED', 'EXPIRED'],
  ] as const) {
    it(`denies ${stored} with the fixed 402 body before tenant resolution`, async () => {
      mockGetControlDb.mockReturnValue(
        fakeControlDb(() => [{ status: stored }]) as never
      );
      const app = signedInApp();

      for (const path of ['/api/db/schema', '/api/db/call', '/api/db/bespoke']) {
        const isGet = path === '/api/db/schema';
        const res = await app.request(
          path,
          isGet
            ? { method: 'GET' }
            : { method: 'POST', body: JSON.stringify({ method: 'get' }) }
        );
        expect(res.status).toBe(402);
        await expect(res.json()).resolves.toEqual({
          error: 'Subscription is not active',
          code: 'SUBSCRIPTION_INACTIVE',
          status: wire,
        });
      }
      expect(mockResolve).not.toHaveBeenCalled();
    });
  }

  it('denies a missing subscription row as 402 with status MISSING', async () => {
    mockGetControlDb.mockReturnValue(fakeControlDb(() => []) as never);
    const app = signedInApp();

    const res = await app.request('/api/db/call', {
      method: 'POST',
      body: JSON.stringify({ method: 'get' }),
    });
    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toMatchObject({ status: 'MISSING' });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('fails closed with the fixed 503 body when the control plane query throws', async () => {
    mockGetControlDb.mockReturnValue(
      fakeControlDb(() => new Error('connection reset')) as never
    );
    const app = signedInApp();

    const res = await app.request('/api/db/schema');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: 'Subscription status temporarily unavailable',
      code: 'CONTROL_PLANE_UNAVAILABLE',
      status: 'UNAVAILABLE',
    });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('lets a gated, ACTIVE request through to the route handler (resolver mock proves the pass)', async () => {
    mockGetControlDb.mockReturnValue(
      fakeControlDb(() => [{ status: 'ACTIVE' }]) as never
    );
    mockResolve.mockRejectedValue(new TenantNotReadyError('PROVISIONING'));
    const app = signedInApp();

    const res = await app.request('/api/db/schema');
    // 409 comes from db.ts's own tenant-status branch: the route ran, the
    // gate passed, and the resolver WAS reached. Contrast the denial tests.
    expect(res.status).toBe(409);
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it('still rejects an unauthenticated session with 401, and no org with 403, before the gate', async () => {
    mockGetAuth.mockReturnValue({ isAuthenticated: false } as never);
    const app = signedInApp();
    const res = await app.request('/api/db/schema');
    expect(res.status).toBe(401);
    expect(mockGetControlDb).not.toHaveBeenCalled();
  });

  it('rejects a session with no active organization with 403, not 402 (403 stays clerk-auth\'s)', async () => {
    mockGetAuth.mockReturnValue({
      isAuthenticated: true,
      userId: 'user_1',
      orgId: null,
    } as never);
    const app = signedInApp();
    const res = await app.request('/api/db/schema');
    expect(res.status).toBe(403);
    expect(mockGetControlDb).not.toHaveBeenCalled();
  });
});

describe('GET /api/subscription/status (AC-8)', () => {
  it('returns { status, code } for the session org, un-gated', async () => {
    mockGetControlDb.mockReturnValue(
      fakeControlDb(() => [{ status: 'ACTIVE' }]) as never
    );
    const app = signedInApp();

    const res = await app.request('/api/subscription/status');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ACTIVE', code: null });
  });

  it('reports PAST_DUE to a client the gate would deny', async () => {
    mockGetControlDb.mockReturnValue(
      fakeControlDb(() => [{ status: 'PAST_DUE' }]) as never
    );
    const app = signedInApp();

    const res = await app.request('/api/subscription/status');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'PAST_DUE',
      code: 'SUBSCRIPTION_INACTIVE',
    });
  });

  it('reports MISSING when no row exists', async () => {
    mockGetControlDb.mockReturnValue(fakeControlDb(() => []) as never);
    const app = signedInApp();

    const res = await app.request('/api/subscription/status');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'MISSING' });
  });

  it('surfaces a control plane failure as the same fixed 503', async () => {
    mockGetControlDb.mockReturnValue(
      fakeControlDb(() => new Error('connection reset')) as never
    );
    const app = signedInApp();

    const res = await app.request('/api/subscription/status');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: 'Subscription status temporarily unavailable',
      code: 'CONTROL_PLANE_UNAVAILABLE',
      status: 'UNAVAILABLE',
    });
  });

  it('requires a session (an unauthenticated call gets 401, not another org\'s status)', async () => {
    mockGetAuth.mockReturnValue({ isAuthenticated: false } as never);
    const app = new Hono();
    app.route('/api/subscription/status', subscriptionStatusRoute);
    const res = await app.request('/api/subscription/status');
    expect(res.status).toBe(401);
    expect(mockGetControlDb).not.toHaveBeenCalled();
  });
});
