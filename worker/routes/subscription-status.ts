/**
 * The client's own read of its org's subscription state (spec 0003 AC-8),
 * so the /billing prompt can render correct state on a cold load or a
 * refresh, not only right after a 402. Session required, deliberately NOT
 * behind requireActiveSubscription: an org with an inactive subscription
 * must be able to ask why its door is closed.
 *
 * Returns the same { status, code } wire shape the denial bodies use.
 * A control plane query failure surfaces as the same fixed 503 (AC-2).
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-8)
 */
import { Hono } from 'hono';
import {
  requireOrgSession,
  type AuthedVariables,
} from '../middleware/clerk-auth';
import {
  getSubscriptionStatus,
  wireFromStatus,
} from '../../custom/web/billing/subscriptionStatus';
import {
  CONTROL_PLANE_UNAVAILABLE_CODE,
  CONTROL_PLANE_UNAVAILABLE_ERROR,
  SUBSCRIPTION_INACTIVE_CODE,
} from '../../custom/web/billing/types';
import { getControlDb } from '../db/control';
import type { WorkerEnv } from '../types';

export const subscriptionStatusRoute = new Hono<{
  Bindings: WorkerEnv;
  Variables: AuthedVariables;
}>();

subscriptionStatusRoute.get('/', requireOrgSession, async (c) => {
  c.header('Cache-Control', 'no-store');
  const orgId = c.get('orgId');

  try {
    const status = await getSubscriptionStatus(getControlDb(c.env), orgId);
    const wire = wireFromStatus(status);
    return c.json({
      status: wire,
      code: wire === 'ACTIVE' ? null : SUBSCRIPTION_INACTIVE_CODE,
    });
  } catch (err) {
    console.warn(
      `[subscription-status] control plane read failed for org ${orgId}:`,
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
});
