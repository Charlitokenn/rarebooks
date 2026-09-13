/**
 * Reads an org's subscription status from the control plane, and maps the
 * stored row to the wire status the gate and the client speak. Lives here
 * rather than in worker/ so the root seed script can share it (root ts-node
 * cannot require worker/, which is "type": "module").
 *
 * A query error propagates on purpose: the middleware turns it into the
 * fixed 503, the status route into the same, the seed script into a nonzero
 * exit — each caller knows better than this file what its own failure copy
 * should be.
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-1, AC-2, AC-8)
 */
import type {
  ControlQueryFn,
  SubscriptionStatus,
  SubscriptionWireStatus,
} from './types';

const STATUSES: readonly SubscriptionStatus[] = [
  'ACTIVE',
  'PAST_DUE',
  'EXPIRED',
  'PENDING_REVIEW',
  'SUSPENDED',
  'CANCELLED',
];

export async function getSubscriptionStatus(
  db: ControlQueryFn,
  orgId: string
): Promise<SubscriptionStatus | null> {
  const rows = (await db`
    SELECT status FROM subscriptions WHERE org_id = ${orgId}
  `) as unknown as Array<{ status: string }>;

  const status = rows[0]?.status;
  if (!status || !STATUSES.includes(status as SubscriptionStatus)) {
    // An unrecognized stored value is treated as absent: fail closed rather
    // than hand an unknown status the ACTIVE benefit of the doubt.
    return null;
  }
  return status as SubscriptionStatus;
}

/**
 * Maps the queried row to the wire status (AC-2): null (no row, or an
 * unrecognized value) becomes 'MISSING'. 'UNAVAILABLE' never passes through
 * here — it is produced by the caller that caught a query error.
 */
export function wireFromStatus(
  status: SubscriptionStatus | null
): Exclude<SubscriptionWireStatus, 'UNAVAILABLE'> {
  return status ?? 'MISSING';
}
