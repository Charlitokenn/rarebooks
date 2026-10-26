/**
 * Spec 0001 AC-2 / AC-4: the organization.created webhook route (signature
 * gate, response mapping) and the provisioning handler behind it (claim,
 * Neon call, encrypted write, FAILED state). Clerk verification, Neon, and
 * the control plane are mocked at the boundary; encryption is real.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md (AC-2, AC-3, AC-4)
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhook } from '@clerk/hono/webhooks';
import * as control from '../db/control';
import { decrypt } from '../lib/encryption';
import { organizationCreatedRoute } from '../routes/webhooks/organization-created';
import { handleOrganizationCreated } from '../../custom/web/auth/handleOrganizationCreated';

vi.mock('@clerk/hono/webhooks', () => ({ verifyWebhook: vi.fn() }));
vi.mock('../lib/neon-client', () => ({
  createNeonProvisioningClient: vi.fn(() => ({ createAndConnect: vi.fn() })),
}));
vi.mock('../db/control', () => ({
  getControlDb: vi.fn(() => ({})),
  getTenantProject: vi.fn(),
  insertOrganization: vi.fn(),
  claimTenantProject: vi.fn(),
  claimTenantProjectMigration: vi.fn(),
  insertTenantProject: vi.fn(),
  failTenantProjectClaim: vi.fn(),
  releaseTenantProjectMigration: vi.fn(),
  setTenantProjectStatus: vi.fn(),
}));
// Schema migration is spec 0002's surface; here it is only a boundary.
vi.mock('../../custom/web/auth/applyTenantSchema', () => ({
  applyTenantSchema: vi.fn(),
}));

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const env = {
  CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_test',
  NEON_API_KEY: 'neon-key',
  NEON_ACCOUNT_ORG_ID: 'neon-org',
  CONTROL_DATABASE_URL: 'postgres://control',
  TENANT_ENCRYPTION_KEY: KEY,
} as never;

const mockVerify = vi.mocked(verifyWebhook);
const mocked = vi.mocked(control);

describe('POST organization.created route', () => {
  const app = new Hono();
  app.route('/webhooks/organization-created', organizationCreatedRoute);
  const post = () =>
    app.request('/webhooks/organization-created', { method: 'POST', body: '{}' }, env);

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('400 on a bad or missing signature, before any provisioning runs (AC-2, AC-4)', async () => {
    mockVerify.mockRejectedValue(new Error('bad signature'));
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid webhook signature' });
    expect(mocked.insertOrganization).not.toHaveBeenCalled();
    expect(mocked.claimTenantProject).not.toHaveBeenCalled();
  });

  it('verifies against the Worker secret, not process.env', async () => {
    mockVerify.mockRejectedValue(new Error('x'));
    await post();
    expect(mockVerify).toHaveBeenCalledWith(expect.anything(), {
      signingSecret: 'whsec_test',
    });
  });

  it('acknowledges but ignores other event types', async () => {
    mockVerify.mockResolvedValue({ type: 'user.created', data: { id: 'u' } } as never);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: 'user.created' });
    expect(mocked.insertOrganization).not.toHaveBeenCalled();
  });

  it('200 once the org is provisioned', async () => {
    mockVerify.mockResolvedValue({
      type: 'organization.created',
      data: { id: 'org_1', name: 'Acme' },
    } as never);
    mocked.claimTenantProject.mockResolvedValue(false);
    mocked.claimTenantProjectMigration.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(200);
    expect(mocked.insertOrganization).toHaveBeenCalledWith(expect.anything(), {
      id: 'org_1',
      name: 'Acme',
    });
  });

  it('500 retry when provisioning throws and the tenant is not FAILED', async () => {
    mockVerify.mockResolvedValue({
      type: 'organization.created',
      data: { id: 'org_1', name: 'Acme' },
    } as never);
    mocked.insertOrganization.mockRejectedValue(new Error('db down'));
    mocked.getTenantProject.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ received: false, provisioning: 'retry' });
  });

  it('200 with provisioning failed when the tenant ended FAILED (no endless retries)', async () => {
    mockVerify.mockResolvedValue({
      type: 'organization.created',
      data: { id: 'org_1', name: 'Acme' },
    } as never);
    mocked.insertOrganization.mockRejectedValue(new Error('neon 5xx'));
    mocked.getTenantProject.mockResolvedValue({ status: 'FAILED' } as never);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, provisioning: 'failed' });
  });
});

describe('handleOrganizationCreated (AC-2, AC-3, AC-4)', () => {
  const event = { data: { id: 'org_9', name: 'Nine Books' } };
  const db = {} as never;
  const applySchema = vi.fn();
  const neon = {
    createAndConnect: vi.fn(),
  };
  const run = () =>
    handleOrganizationCreated(event, env, neon, db, applySchema);

  beforeEach(() => {
    vi.resetAllMocks();
    neon.createAndConnect.mockResolvedValue({
      neonProjectId: 'proj_1',
      connectionString: 'postgres://u:topsecret@host/db',
      region: 'aws-us-east-2',
    });
    mocked.claimTenantProject.mockResolvedValue(true);
    mocked.insertTenantProject.mockResolvedValue(true);
  });

  it('records the org, provisions Neon, stores the string encrypted, then marks READY', async () => {
    await run();

    expect(mocked.insertOrganization).toHaveBeenCalledWith(db, {
      id: 'org_9',
      name: 'Nine Books',
    });
    expect(neon.createAndConnect).toHaveBeenCalledWith({
      name: 'rarebooks-tenant-org_9',
    });

    const stored = mocked.insertTenantProject.mock.calls[0][1];
    expect(stored.orgId).toBe('org_9');
    expect(stored.neonProjectId).toBe('proj_1');
    expect(stored.region).toBe('aws-us-east-2');
    expect(stored.encryptedConnectionString).not.toContain('topsecret');
    expect(await decrypt(stored.encryptedConnectionString, KEY)).toBe(
      'postgres://u:topsecret@host/db'
    );

    expect(applySchema).toHaveBeenCalledWith('postgres://u:topsecret@host/db');
    expect(mocked.setTenantProjectStatus).toHaveBeenCalledWith(db, 'org_9', 'READY');
  });

  it('records the org before attempting to provision', async () => {
    const order: string[] = [];
    mocked.insertOrganization.mockImplementation(async () => {
      order.push('org');
    });
    neon.createAndConnect.mockImplementation(async () => {
      order.push('neon');
      return { neonProjectId: 'p', connectionString: 'c', region: 'r' };
    });
    await run();
    expect(order).toEqual(['org', 'neon']);
  });

  it('marks the claim FAILED and rethrows when Neon provisioning fails', async () => {
    neon.createAndConnect.mockRejectedValue(new Error('neon 503'));
    await expect(run()).rejects.toThrow('neon 503');
    expect(mocked.failTenantProjectClaim).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ orgId: 'org_9' })
    );
    expect(mocked.insertTenantProject).not.toHaveBeenCalled();
    expect(applySchema).not.toHaveBeenCalled();
  });

  it('fails the claim when the claim is lost before completion', async () => {
    mocked.insertTenantProject.mockResolvedValue(false);
    await expect(run()).rejects.toThrow(/claim was lost/);
    expect(mocked.failTenantProjectClaim).toHaveBeenCalled();
    expect(applySchema).not.toHaveBeenCalled();
  });

  it('does nothing further for a duplicate webhook when another worker owns the org', async () => {
    mocked.claimTenantProject.mockResolvedValue(false);
    mocked.claimTenantProjectMigration.mockResolvedValue(null);
    await run();
    expect(neon.createAndConnect).not.toHaveBeenCalled();
    expect(applySchema).not.toHaveBeenCalled();
  });

  it('resumes a PROJECT_CREATED org by decrypting its stored string, without a second Neon project', async () => {
    const { encrypt } = await import('../lib/encryption');
    mocked.claimTenantProject.mockResolvedValue(false);
    mocked.claimTenantProjectMigration.mockResolvedValue(
      await encrypt('postgres://existing', KEY)
    );
    await run();
    expect(neon.createAndConnect).not.toHaveBeenCalled();
    expect(applySchema).toHaveBeenCalledWith('postgres://existing');
    expect(mocked.setTenantProjectStatus).toHaveBeenCalledWith(db, 'org_9', 'READY');
  });

  it('sets FAILED when the schema migration throws', async () => {
    applySchema.mockRejectedValue(new Error('migrate boom'));
    await expect(run()).rejects.toThrow('migrate boom');
    expect(mocked.setTenantProjectStatus).toHaveBeenCalledWith(db, 'org_9', 'FAILED');
    expect(mocked.setTenantProjectStatus).not.toHaveBeenCalledWith(db, 'org_9', 'READY');
  });

  it('releases the migration claim when marking READY fails, so a retry can resume', async () => {
    applySchema.mockResolvedValue(undefined);
    mocked.setTenantProjectStatus.mockRejectedValueOnce(new Error('status write failed'));
    await expect(run()).rejects.toThrow('status write failed');
    expect(mocked.releaseTenantProjectMigration).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ orgId: 'org_9' })
    );
  });
});
