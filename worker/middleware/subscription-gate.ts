/**
 * Subscription gate: the web replacement for Desktop's device-bound Keymint
 * check. Runs after requireOrgSession and BEFORE any tenant data route,
 * reading the org's single authoritative `subscriptions` row from the
 * control plane (AC-1). Denials are the two fixed shapes from AC-2, both
 * produced before the tenant connection is ever resolved or decrypted.
 *
 * Fail-closed on purpose: no row, any non-ACTIVE status, or a control plane
 * query failure all deny. A transient outage denies a paying customer for
 * seconds (with honest 503 retry copy, routed away from /billing); a free
 * ride on a guess would not self-heal.
 *
 * Seats are NOT checked here — Clerk's own `maxAllowedMemberships` is the
 * single enforcer (AC-6); see custom/web/billing/seatSync.ts.
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-1, AC-2, AC-6)
 */
import { createMiddleware } from 'hono/factory';
import {
  getSubscriptionStatus,
  wireFromStatus,
} from '../../custom/web/billing/subscriptionStatus';
import {
  CONTROL_PLANE_UNAVAILABLE_CODE,
  CONTROL_PLANE_UNAVAILABLE_ERROR,
  SUBSCRIPTION_INACTIVE_CODE,
  SUBSCRIPTION_INACTIVE_ERROR,
} from '../../custom/web/billing/types';
import { getControlDb } from '../db/control';
import type { AuthedVariables } from './clerk-auth';
import type { WorkerEnv } from '../types';

export const requireActiveSubscription = createMiddleware<{
  Bindings: WorkerEnv;
  Variables: AuthedVariables;
}>(async (c, next) => {
  const orgId = c.get('orgId');

  let status;
  try {
    status = await getSubscriptionStatus(getControlDb(c.env), orgId);
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

  const wire = wireFromStatus(status);
  if (wire !== 'ACTIVE') {
    return c.json(
      {
        error: SUBSCRIPTION_INACTIVE_ERROR,
        code: SUBSCRIPTION_INACTIVE_CODE,
        status: wire,
      },
      402
    );
  }

  await next();
});
