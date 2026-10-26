/**
 * Pins the public URL layout of the real Worker app (worker/index.ts): the
 * Clerk webhook must stay mounted at /webhooks/organization-created, since
 * that exact URL is what is registered in Clerk. Individual route behavior
 * is covered in the other specs.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md (AC-2, AC-4)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhook } from '@clerk/hono/webhooks';
import app from '../index';

vi.mock('@clerk/hono', () => ({
  clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
  getAuth: vi.fn(() => ({ isAuthenticated: false })),
}));
vi.mock('@clerk/hono/webhooks', () => ({ verifyWebhook: vi.fn() }));
vi.mock('../lib/neon-client', () => ({
  createNeonProvisioningClient: vi.fn(),
}));
vi.mock('../db/control', () => ({
  getControlDb: vi.fn(() => ({})),
  getTenantProject: vi.fn(),
}));
// The tenant DB layer is spec 0002's surface; stubbed so importing the app
// never evaluates backend/database/core.ts (its root aliases don't resolve
// in vitest).
vi.mock('../../custom/web/db/tenantDatabase', () => ({
  callTenantDatabaseMethod: vi.fn(),
  callTenantBespokeMethod: vi.fn(),
  getTenantSchemaMap: vi.fn(() => ({})),
  InvalidDatabaseMethodError: class InvalidDatabaseMethodError extends Error {},
}));

vi.mock('../../custom/web/auth/applyTenantSchema', () => ({
  applyTenantSchema: vi.fn(),
}));

const env = { CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_test' } as never;

describe('Worker app routing', () => {
  beforeEach(() => {
    vi.mocked(verifyWebhook).mockReset();
  });

  it('serves the Clerk webhook at /webhooks/organization-created, behind signature verification', async () => {
    vi.mocked(verifyWebhook).mockRejectedValue(new Error('bad signature'));
    const res = await app.request(
      '/webhooks/organization-created',
      { method: 'POST', body: '{}' },
      env
    );
    expect(res.status).toBe(400);
    expect(verifyWebhook).toHaveBeenCalledTimes(1);
  });

  it('does not serve the webhook at the old spec path', async () => {
    const res = await app.request(
      '/webhooks/clerk/organization-created',
      { method: 'POST', body: '{}' },
      env
    );
    expect(res.status).toBe(404);
    expect(verifyWebhook).not.toHaveBeenCalled();
  });

  it('answers the health check without a session', async () => {
    const res = await app.request('/api/health', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'rarebooks-web' });
  });
});
