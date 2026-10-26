/**
 * Spec 0001 AC-4 / Value sourcing: per request tenant resolution. Real
 * encryption, control plane lookup mocked. Each test uses its own org id
 * because the resolver's cache is module level.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md (AC-4)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTenantProject } from '../db/control';
import { encrypt } from '../lib/encryption';
import {
  resolveTenantConnectionString,
  TenantNotReadyError,
} from '../db/resolve-tenant';

vi.mock('../db/control', () => ({
  getControlDb: vi.fn(() => ({})),
  getTenantProject: vi.fn(),
}));

const mockGetTenant = vi.mocked(getTenantProject);
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const env = { CONTROL_DATABASE_URL: 'postgres://control', TENANT_ENCRYPTION_KEY: KEY };

let n = 0;
const nextOrg = () => `org_resolve_${++n}`;

async function row(status: string, conn = 'postgres://tenant-a') {
  return {
    org_id: 'x',
    neon_project_id: 'p',
    connection_string: await encrypt(conn, KEY),
    region: 'r',
    provisioning_claim_id: null,
    status,
    created_at: 'now',
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('resolveTenantConnectionString', () => {
  it('returns the decrypted string for a READY tenant', async () => {
    mockGetTenant.mockResolvedValue(await row('READY'));
    await expect(resolveTenantConnectionString(nextOrg(), env)).resolves.toBe(
      'postgres://tenant-a'
    );
  });

  it('throws when the org has no tenant project', async () => {
    mockGetTenant.mockResolvedValue(null);
    const org = nextOrg();
    await expect(resolveTenantConnectionString(org, env)).rejects.toThrow(
      `No tenant project provisioned for org ${org}`
    );
  });

  it.each(['PROVISIONING', 'PROJECT_CREATED', 'SUSPENDED', 'FAILED'])(
    'throws TenantNotReadyError carrying %s',
    async (status) => {
      mockGetTenant.mockResolvedValue(await row(status));
      const err = await resolveTenantConnectionString(nextOrg(), env).catch(
        (e) => e
      );
      expect(err).toBeInstanceOf(TenantNotReadyError);
      expect(err.status).toBe(status);
    }
  );

  it('serves a repeat request from cache within the TTL', async () => {
    mockGetTenant.mockResolvedValue(await row('READY'));
    const org = nextOrg();
    await resolveTenantConnectionString(org, env);
    await resolveTenantConnectionString(org, env);
    expect(mockGetTenant).toHaveBeenCalledTimes(1);
  });

  it('looks up again after the TTL expires', async () => {
    mockGetTenant.mockResolvedValue(await row('READY'));
    const org = nextOrg();
    await resolveTenantConnectionString(org, env);
    vi.advanceTimersByTime(31_000);
    await resolveTenantConnectionString(org, env);
    expect(mockGetTenant).toHaveBeenCalledTimes(2);
  });

  it('caches a not ready status too, then picks up READY after the TTL', async () => {
    const org = nextOrg();
    mockGetTenant.mockResolvedValueOnce(await row('PROJECT_CREATED'));
    await expect(resolveTenantConnectionString(org, env)).rejects.toBeInstanceOf(
      TenantNotReadyError
    );
    await expect(resolveTenantConnectionString(org, env)).rejects.toBeInstanceOf(
      TenantNotReadyError
    );
    expect(mockGetTenant).toHaveBeenCalledTimes(1);

    mockGetTenant.mockResolvedValueOnce(await row('READY', 'postgres://now-ready'));
    vi.advanceTimersByTime(31_000);
    await expect(resolveTenantConnectionString(org, env)).resolves.toBe(
      'postgres://now-ready'
    );
  });

  it('never serves one org the cached connection of another', async () => {
    const a = nextOrg();
    const b = nextOrg();
    mockGetTenant.mockResolvedValueOnce(await row('READY', 'postgres://tenant-a'));
    mockGetTenant.mockResolvedValueOnce(await row('READY', 'postgres://tenant-b'));
    expect(await resolveTenantConnectionString(a, env)).toBe('postgres://tenant-a');
    expect(await resolveTenantConnectionString(b, env)).toBe('postgres://tenant-b');
    expect(await resolveTenantConnectionString(a, env)).toBe('postgres://tenant-a');
    expect(mockGetTenant).toHaveBeenNthCalledWith(1, expect.anything(), a);
    expect(mockGetTenant).toHaveBeenNthCalledWith(2, expect.anything(), b);
  });

  it('fails when the stored value cannot be decrypted with the key', async () => {
    mockGetTenant.mockResolvedValue({
      ...((await row('READY')) as object),
      connection_string: 'bm90LWVuY3J5cHRlZC1hdC1hbGw=',
    } as never);
    await expect(resolveTenantConnectionString(nextOrg(), env)).rejects.toThrow();
  });
});
