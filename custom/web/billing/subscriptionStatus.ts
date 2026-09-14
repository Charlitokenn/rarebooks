/**
 * Reads an org's subscription row from the control plane, and maps the
 * stored status to the wire status the gate and the client speak. Lives here
 * rather than in worker/ so the root seed script can share it (root ts-node
 * cannot require worker/, which is "type": "module").
 *
 * A query error propagates on purpose: the middleware turns it into the
 * fixed 503, the status route into the same, the seed script into a nonzero
 * exit — each caller knows better than this file what its own failure copy
 * should be.
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-1, AC-2, AC-8),
 * docs/specs/0004-paypal-subscriptions.md (AC-16: the ladder fields)
 */
import type {
  ControlQueryFn,
  SubscriptionStatus,
  SubscriptionWireStatus,
} from './types';

const STATUSES: readonly SubscriptionStatus[] = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'GRACE',
  'READ_ONLY',
  'CANCELLED',
];

/**
 * The authoritative row as the gate and the status route need it. Timestamps
 * are normalized to ISO strings (Neon returns `timestamptz` as Date
 * objects), so every wire consumer — Worker JSON, sessionStorage record,
 * client display — sees the same shape.
 */
export interface SubscriptionRow {
  status: SubscriptionStatus;
  plan: string | null;
  currentPeriodEnd: string | null;
  stageEndsAt: string | null;
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

export async function getSubscriptionRow(
  db: ControlQueryFn,
  orgId: string
): Promise<SubscriptionRow | null> {
  const rows = (await db`
    SELECT status, plan, current_period_end, stage_ends_at
    FROM subscriptions WHERE org_id = ${orgId}
  `) as unknown as Array<{
    status: string;
    plan: unknown;
    current_period_end: unknown;
    stage_ends_at: unknown;
  }>;

  const row = rows[0];
  const status = row?.status;
  if (!status || !STATUSES.includes(status as SubscriptionStatus)) {
    // An unrecognized stored value is treated as absent: fail closed rather
    // than hand an unknown status the ACTIVE benefit of the doubt.
    return null;
  }
  return {
    status: status as SubscriptionStatus,
    plan: typeof row.plan === 'string' ? row.plan : null,
    currentPeriodEnd: toIsoOrNull(row.current_period_end),
    stageEndsAt: toIsoOrNull(row.stage_ends_at),
  };
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
