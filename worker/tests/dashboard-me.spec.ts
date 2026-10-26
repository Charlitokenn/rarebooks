/**
 * Spec 0001 AC-1 / AC-5: /api/me and /api/dashboard behind the Clerk
 * session. Real Hono routes, Clerk session and control plane lookup mocked
 * at the boundary.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md (AC-1, AC-5)
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuth } from '@clerk/hono';
import { meRoute } from '../routes/me';
import { dashboardRoute } from '../routes/dashboard';
import { getControlDb, getTenantProject } from '../db/control';

vi.mock('@clerk/hono', () => ({
  clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
  getAuth: vi.fn(),
}));

vi.mock('../db/control', () => ({
  getControlDb: vi.fn(() => ({})),
  getTenantProject: vi.fn(),
}));

const mockGetAuth = vi.mocked(getAuth);
const mockGetTenant = vi.mocked(getTenantProject);

const env = {
  CONTROL_DATABASE_URL: 'postgres://control',
  TENANT_ENCRYPTION_KEY: 'k',
} as never;

const app = new Hono();
app.route('/api/me', meRoute);
app.route('/api/dashboard', dashboardRoute);

function signedIn(orgId: string | null = 'org_1') {
  mockGetAuth.mockReturnValue({
    isAuthenticated: true,
    userId: 'user_1',
    orgId,
    orgRole: 'org:admin',
  } as never);
}

function tenantWithStatus(status: string) {
  mockGetTenant.mockResolvedValue({
    org_id: 'org_1',
    neon_project_id: 'p',
    connection_string: 'ENCRYPTED-SECRET-BLOB',
    region: 'aws-us-east-1',
    provisioning_claim_id: null,
    status,
    created_at: '2026-09-03',
  } as never);
}

const get = (path: string) => app.request(path, {}, env);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getControlDb).mockReturnValue({} as never);
});

describe('GET /api/me', () => {
  it('returns the session identity (AC-1)', async () => {
    signedIn();
    const res = await get('/api/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: 'user_1',
      orgId: 'org_1',
      orgRole: 'org:admin',
    });
  });

  it('401 when unauthenticated', async () => {
    mockGetAuth.mockReturnValue({ isAuthenticated: false } as never);
    const res = await get('/api/me');
    expect(res.status).toBe(401);
  });

  it('401 when there is no auth object at all', async () => {
    mockGetAuth.mockReturnValue(null as never);
    expect((await get('/api/me')).status).toBe(401);
  });

  it('403 when signed in without an active organization', async () => {
    signedIn(null);
    expect((await get('/api/me')).status).toBe(403);
  });

  it('falls back to an empty orgRole when Clerk has none', async () => {
    mockGetAuth.mockReturnValue({
      isAuthenticated: true,
      userId: 'user_1',
      orgId: 'org_1',
    } as never);
    const body = (await (await get('/api/me')).json()) as { orgRole: string };
    expect(body.orgRole).toBe('');
  });
});

describe('GET /api/dashboard (AC-5)', () => {
  it.each(['PROJECT_CREATED', 'READY'])(
    'reaches the shell when the tenant is %s',
    async (status) => {
      signedIn();
      tenantWithStatus(status);
      const res = await get('/api/dashboard');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status, orgId: 'org_1' });
    }
  );

  it('never lets the response be cached', async () => {
    signedIn();
    tenantWithStatus('READY');
    const res = await get('/api/dashboard');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('202 PROVISIONING while the tenant is still provisioning', async () => {
    signedIn();
    tenantWithStatus('PROVISIONING');
    const res = await get('/api/dashboard');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'PROVISIONING' });
  });

  it('202 PROVISIONING when no tenant row exists yet (webhook lag)', async () => {
    signedIn();
    mockGetTenant.mockResolvedValue(null);
    const res = await get('/api/dashboard');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'PROVISIONING' });
  });

  it('500 FAILED when provisioning failed', async () => {
    signedIn();
    tenantWithStatus('FAILED');
    const res = await get('/api/dashboard');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: 'FAILED' });
  });

  it('does not open the shell for SUSPENDED', async () => {
    signedIn();
    tenantWithStatus('SUSPENDED');
    const res = await get('/api/dashboard');
    expect(res.status).toBe(202);
    expect(((await res.json()) as { orgId?: string }).orgId).toBeUndefined();
  });

  it('401 when unauthenticated, without touching the control plane', async () => {
    mockGetAuth.mockReturnValue({ isAuthenticated: false } as never);
    expect((await get('/api/dashboard')).status).toBe(401);
    expect(mockGetTenant).not.toHaveBeenCalled();
  });

  it('looks the tenant up by the session org only, ignoring client input (isolation)', async () => {
    signedIn('org_session');
    tenantWithStatus('READY');
    await app.request(
      '/api/dashboard?orgId=org_attacker',
      { headers: { 'x-org-id': 'org_attacker' } },
      env
    );
    expect(mockGetTenant).toHaveBeenCalledWith(expect.anything(), 'org_session');
  });

  it('never leaks the connection string or neon project id (AC-4)', async () => {
    signedIn();
    tenantWithStatus('READY');
    const text = await (await get('/api/dashboard')).text();
    expect(text).not.toContain('ENCRYPTED-SECRET-BLOB');
    expect(text).not.toContain('connection_string');
    expect(text).not.toContain('neon_project_id');
  });
});
