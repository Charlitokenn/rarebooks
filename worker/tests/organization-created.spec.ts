/**
 * The organization.created webhook route: signature gate, then record the
 * org and enqueue `{ orgId }`. No Neon call, no migration, no tenant row
 * read. Clerk verification and the control plane are mocked at the
 * boundary; provisioning itself is covered in provisioning-consumer.spec.ts.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md (AC-2, AC-4)
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md (AC-1)
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhook } from '@clerk/hono/webhooks';
import * as control from '../db/control';
import { createNeonProvisioningClient } from '../lib/neon-client';
import { organizationCreatedRoute } from '../routes/webhooks/organization-created';

vi.mock('@clerk/hono/webhooks', () => ({ verifyWebhook: vi.fn() }));
vi.mock('../lib/neon-client', () => ({
  createNeonProvisioningClient: vi.fn(),
}));
vi.mock('../db/control', () => ({
  getControlDb: vi.fn(() => ({})),
  getTenantProject: vi.fn(),
  insertOrganization: vi.fn(),
}));

const send = vi.fn();
const env = {
  CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_test',
  CONTROL_DATABASE_URL: 'postgres://control',
  PROVISIONING_QUEUE: { send },
} as never;

const mockVerify = vi.mocked(verifyWebhook);
const mocked = vi.mocked(control);

const orgCreated = () =>
  mockVerify.mockResolvedValue({
    type: 'organization.created',
    data: { id: 'org_1', name: 'Acme' },
  } as never);

describe('POST organization.created route', () => {
  const app = new Hono();
  app.route('/webhooks/organization-created', organizationCreatedRoute);
  const post = () =>
    app.request(
      '/webhooks/organization-created',
      { method: 'POST', body: '{}' },
      env
    );

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('400 on a bad or missing signature, before anything is written (AC-4)', async () => {
    mockVerify.mockRejectedValue(new Error('bad signature'));
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid webhook signature' });
    expect(mocked.insertOrganization).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('verifies against the Worker secret, not process.env', async () => {
    mockVerify.mockRejectedValue(new Error('x'));
    await post();
    expect(mockVerify).toHaveBeenCalledWith(expect.anything(), {
      signingSecret: 'whsec_test',
    });
  });

  it('acknowledges but ignores other event types', async () => {
    mockVerify.mockResolvedValue({
      type: 'user.created',
      data: { id: 'u' },
    } as never);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: true,
      ignored: 'user.created',
    });
    expect(mocked.insertOrganization).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('records the org, then enqueues { orgId } only, and answers 200 (AC-1)', async () => {
    orgCreated();
    const order: string[] = [];
    mocked.insertOrganization.mockImplementation(async () => {
      order.push('org');
    });
    send.mockImplementation(async () => {
      order.push('send');
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mocked.insertOrganization).toHaveBeenCalledWith(expect.anything(), {
      id: 'org_1',
      name: 'Acme',
    });
    expect(send).toHaveBeenCalledWith({ orgId: 'org_1' });
    expect(order).toEqual(['org', 'send']);
  });

  it('makes no Neon call and never reads the tenant row (AC-1)', async () => {
    orgCreated();
    await post();
    expect(createNeonProvisioningClient).not.toHaveBeenCalled();
    expect(mocked.getTenantProject).not.toHaveBeenCalled();
  });

  it('enqueues the same way for an org that already exists or is READY (AC-1)', async () => {
    orgCreated();
    await post();
    await post();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('500 when the org insert fails, so Svix retries, and nothing is enqueued (AC-1)', async () => {
    orgCreated();
    mocked.insertOrganization.mockRejectedValue(new Error('db down'));
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ received: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('500 when the enqueue fails (AC-1)', async () => {
    orgCreated();
    send.mockRejectedValue(new Error('queue unavailable'));
    const res = await post();
    expect(res.status).toBe(500);
  });
});
