/**
 * The client's own read of its org's subscription state (spec 0003 AC-8,
 * extended by spec 0004 AC-16), so the /billing prompt and the banner can
 * render correct state on a cold load or a refresh, not only right after a
 * 402. Session required, deliberately NOT behind requireActiveSubscription:
 * an org with an inactive subscription must be able to ask why its door is
 * closed.
 *
 * Wire shape: `{ status, code, plan, currentPeriodEnd, stageEndsAt }`. The
 * code mapping is `wireCodeForStatus` (null for every access rung,
 * SUBSCRIPTION_READ_ONLY for READ_ONLY, SUBSCRIPTION_INACTIVE for CANCELLED
 * or a missing row). The three ladder fields are null when no row exists, so
 * the banner can distinguish nudge from block from lock on this response
 * alone (AC-16). A control plane query failure surfaces as the same fixed
 * 503 (AC-2).
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-8),
 * docs/specs/0004-paypal-subscriptions.md (AC-16)
 */
import { Hono } from 'hono';
import {
  requireOrgSession,
  type AuthedVariables,
} from '../middleware/clerk-auth';
import {
  getSubscriptionRow,
  wireFromStatus,
} from '../../custom/web/billing/subscriptionStatus';
import { wireCodeForStatus } from '../../custom/web/billing/subscriptionGate';
import {
  CONTROL_PLANE_UNAVAILABLE_CODE,
  CONTROL_PLANE_UNAVAILABLE_ERROR,
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
    const row = await getSubscriptionRow(getControlDb(c.env), orgId);
    const wire = wireFromStatus(row?.status ?? null);
    return c.json({
      status: wire,
      code: wireCodeForStatus(wire),
      plan: row?.plan ?? null,
      currentPeriodEnd: row?.currentPeriodEnd ?? null,
      stageEndsAt: row?.stageEndsAt ?? null,
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
