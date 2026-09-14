/**
 * Subscription gate: the web replacement for Desktop's device-bound Keymint
 * check. Runs after requireOrgSession and BEFORE any tenant data route,
 * reading the org's single authoritative `subscriptions` row from the
 * control plane (AC-1). Denials are fixed shapes, both produced before the
 * tenant connection is ever resolved or decrypted.
 *
 * The ladder (spec 0004 AC-10): `gateDecision` says whether this request's
 * call kind passes at the org's rung. `READ_ONLY` refuses writes with the
 * 402 `SUBSCRIPTION_READ_ONLY` body and lets reads through; `CANCELLED` or a
 * missing row keeps the existing 402 `SUBSCRIPTION_INACTIVE` denial.
 *
 * Fail-closed on purpose: no row, any rung with no access, or a control plane
 * query failure all deny. A transient outage denies a paying customer for
 * seconds (with honest 503 retry copy, routed away from /billing); a free
 * ride on a guess would not self-heal.
 *
 * Seats are NOT checked here — Clerk's own `maxAllowedMemberships` is the
 * single enforcer (AC-6); see custom/web/billing/seatSync.ts.
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-1, AC-2, AC-6),
 * docs/specs/0004-paypal-subscriptions.md (AC-10)
 */
import { createMiddleware } from 'hono/factory';
import {
  getSubscriptionRow,
  wireFromStatus,
} from '../../custom/web/billing/subscriptionStatus';
import {
  classifyDbCall,
  gateDecision,
} from '../../custom/web/billing/subscriptionGate';
import {
  CONTROL_PLANE_UNAVAILABLE_CODE,
  CONTROL_PLANE_UNAVAILABLE_ERROR,
  SUBSCRIPTION_INACTIVE_CODE,
  SUBSCRIPTION_INACTIVE_ERROR,
  SUBSCRIPTION_READ_ONLY_CODE,
  SUBSCRIPTION_READ_ONLY_ERROR,
} from '../../custom/web/billing/types';
import { getControlDb } from '../db/control';
import type { AuthedVariables } from './clerk-auth';
import type { WorkerEnv } from '../types';

export const requireActiveSubscription = createMiddleware<{
  Bindings: WorkerEnv;
  Variables: AuthedVariables;
}>(async (c, next) => {
  const orgId = c.get('orgId');

  let row;
  try {
    row = await getSubscriptionRow(getControlDb(c.env), orgId);
  } catch (err) {
    console.warn(
      `[subscription-gate] control plane read failed for org ${orgId}:`,
      err
    );
    return c.json(
      {
        error: CONTROL_PLANE_UNAVAILABLE_ERROR,
        code: CONTROL_PLANE_UNAVAILABLE_CODE,
        status: 'UNAVAILABLE',
      },
      503
    );
  }

  // Hono 4 caches the parsed body per request, so reading it here for the
  // read versus write classification does not starve routes/db.ts's parse.
  let method: string | null = null;
  if (c.req.method === 'POST') {
    const body: unknown = await c.req.json().catch(() => null);
    const candidate = (body as { method?: unknown } | null)?.method;
    method = typeof candidate === 'string' ? candidate : null;
  }

  const path = new URL(c.req.url).pathname;
  const wire = wireFromStatus(row?.status ?? null);
  const decision = gateDecision(wire, classifyDbCall(path, method));

  if (decision === 'block') {
    return c.json(
      {
        error: SUBSCRIPTION_INACTIVE_ERROR,
        code: SUBSCRIPTION_INACTIVE_CODE,
        status: wire,
      },
      402
    );
  }

  if (decision === 'read-only') {
    return c.json(
      {
        error: SUBSCRIPTION_READ_ONLY_ERROR,
        code: SUBSCRIPTION_READ_ONLY_CODE,
        status: wire,
      },
      402
    );
  }

  await next();
});
