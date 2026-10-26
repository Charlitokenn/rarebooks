/**
 * Thin Hono route: verify the Clerk webhook signature, record the org, and
 * enqueue `{ orgId }` for the provisioning consumer (worker/queues/
 * provisioning.ts → custom/web/auth/handleOrganizationCreated.ts). No Neon
 * call, no migration, and no tenant row read happens here: that work takes
 * longer than Svix waits for an answer, so it lives behind the queue.
 *
 * Uses @clerk/hono/webhooks' verifyWebhook rather than a manual svix
 * integration: it verifies AND parses the payload in one call (reads the
 * body itself via c.req.text(), so don't read c.req.text()/json()
 * separately before calling it — the request body can only be consumed
 * once). Originally built by hand with the svix package directly; swapped
 * after @hono/clerk-auth's deprecation warning pointed at @clerk/hono,
 * which turned out to also fix an actual bug in the original code (see
 * git history: svix's own verify() doesn't parse the payload the way this
 * route first assumed).
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md (AC-2, AC-4)
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md (AC-1)
 */
import { Hono } from 'hono';
import { verifyWebhook } from '@clerk/hono/webhooks';
import type { OrganizationJSON, WebhookEvent } from '@clerk/backend';
import { getControlDb, insertOrganization } from '../../db/control';
import type { WorkerEnv } from '../../types';

export const organizationCreatedRoute = new Hono<{ Bindings: WorkerEnv }>();

organizationCreatedRoute.post('/', async (c) => {
  let event: WebhookEvent;
  try {
    // Explicitly pass signingSecret rather than relying on verifyWebhook's
    // process.env fallback — Workers has no process.env, only c.env.
    event = await verifyWebhook(c, {
      signingSecret: c.env.CLERK_WEBHOOK_SIGNING_SECRET,
    });
  } catch {
    // Never act on an unverified (or unparseable) payload — AC-4.
    return c.json({ error: 'Invalid webhook signature' }, 400);
  }

  if (event.type !== 'organization.created') {
    // We only registered this endpoint for organization.created, but be
    // defensive if Clerk's dashboard config ever changes underneath us.
    return c.json({ received: true, ignored: event.type }, 200);
  }

  const orgId = event.data.id;
  try {
    // The org name goes to `organizations` only, never into the message.
    await insertOrganization(getControlDb(c.env), {
      id: orgId,
      name: (event.data as OrganizationJSON).name,
    });
    // Sent every time, even for an org that exists or is READY: the
    // consumer drops those, so a Svix redelivery is always safe.
    await c.env.PROVISIONING_QUEUE.send({ orgId });
  } catch (err) {
    // 500 so Svix retries; both writes are idempotent.
    console.error(
      JSON.stringify({
        event: 'provisioning.enqueue_failed',
        orgId,
        errorClass: err instanceof Error ? err.name : typeof err,
      })
    );
    return c.json({ received: false }, 500);
  }

  return c.json({ received: true }, 200);
});
