/**
 * The ladder's single decision function (spec 0004 AC-10): given an org's
 * subscription rung and what a request wants to do, allow, allow-reads-only,
 * or block. Lives in custom/web/ so the Worker middleware, the client, and
 * the root tests all reason about one rung table, never three.
 *
 * Rungs, most access to least:
 *   TRIAL / ACTIVE / PAST_DUE / GRACE  everything passes (grace is nudged,
 *                                      not gated; past due keeps access until
 *                                      the cron moves it down, per AC-9).
 *   READ_ONLY                          reads pass, writes refuse.
 *   CANCELLED, MISSING (no row)        nothing passes.
 *
 * 'UNAVAILABLE' never reaches here: a control plane query failure is the
 * caller's 503 before any decision is made (spec 0003 AC-2, unchanged).
 *
 * Spec: docs/specs/0004-paypal-subscriptions.md (AC-10)
 */
import {
  SUBSCRIPTION_INACTIVE_CODE,
  SUBSCRIPTION_READ_ONLY_CODE,
} from './types';
import type { SubscriptionStatus, SubscriptionWireStatus } from './types';

/**
 * What a request wants to do. The Worker classifies each tenant call into
 * one of these before consulting the decision: a DB method name maps to
 * 'read' or 'write', and the bespoke allowlist below is what keeps every
 * bespoke call a pure read (enforced structurally by the bespoke-reads test,
 * AC-10).
 */
export type CallKind = 'read' | 'write';

export type GateDecision = 'allow' | 'read-only' | 'block';

/**
 * The DatabaseBase read methods /api/db/call may dispatch during READ_ONLY
 * (AC-10). Mirrors backend/helpers.ts's databaseMethodSet split; custom/web
 * must not import backend at the type level here, so the sets are defined
 * once in this file and re-exported by custom/web/db/tenantDatabase.ts
 * rather than duplicated.
 */
export const READ_DB_METHODS: ReadonlySet<string> = new Set([
  'get',
  'getAll',
  'getSingleValues',
  'exists',
]);

/** The write methods refused during READ_ONLY. */
export const WRITE_DB_METHODS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'delete',
  'deleteAll',
  'rename',
]);

/**
 * BespokeQueries members that are pure reads, so all of /api/db/bespoke can
 * pass during READ_ONLY (AC-10) without becoming a write door. Not every
 * BespokeQueries member qualifies: `migrateExpenseDescription` is a one-time
 * Desktop expense-schema DDL fix and is deliberately excluded, which also
 * removes it from the Web dispatch surface entirely (it was broken on
 * Postgres anyway; it uses SQLite PRAGMA). The bespoke-reads structural test
 * fails if a new BespokeQueries entry is added without being classified.
 */
export const BESPOKE_READ_METHODS: ReadonlySet<string> = new Set([
  'getLastInserted',
  'getTopExpenses',
  'getBestSellers',
  'getTotalOutstanding',
  'getCashflow',
  'getIncomeAndExpenses',
  'getTotalCreditAndDebit',
  'getStockQuantity',
  'getReturnBalanceItemsQty',
  'getPOSTransactedAmount',
]);

/**
 * Classifies one gated tenant request by its path and (for POST bodies) its
 * dispatch method name. Unknown method names and unreadable bodies classify
 * as 'write': fail closed, matching 0003's rule that anything unrecognized
 * gets the pessimistic rung. Paths outside the known set also classify
 * 'write', so a future route added under the gate without a classifier here
 * denies at READ_ONLY rather than silently passing.
 */
export function classifyDbCall(path: string, method: string | null): CallKind {
  if (path.endsWith('/schema')) {
    return 'read';
  }
  if (path.endsWith('/bespoke')) {
    return method !== null && BESPOKE_READ_METHODS.has(method)
      ? 'read'
      : 'write';
  }
  if (path.endsWith('/call')) {
    return method !== null && READ_DB_METHODS.has(method) ? 'read' : 'write';
  }
  return 'write';
}

const FULL_ACCESS: readonly SubscriptionStatus[] = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'GRACE',
];

/**
 * The rung table. Wire-only statuses are handled: MISSING (no row) blocks
 * like CANCELLED. `null` (an unrecognized stored value, treated as absent
 * by getSubscriptionRow) blocks too — fail closed, same rule as 0003.
 */
export function gateDecision(
  status: SubscriptionWireStatus | null,
  callKind: CallKind
): GateDecision {
  if (status === null || status === 'MISSING' || status === 'UNAVAILABLE') {
    return 'block';
  }
  if (FULL_ACCESS.includes(status)) {
    return 'allow';
  }
  if (status === 'READ_ONLY') {
    return callKind === 'read' ? 'allow' : 'read-only';
  }
  // CANCELLED, and any future status not deliberately allowed.
  return 'block';
}

/**
 * The AC-16 code mapping for GET /api/subscription/status: null for every
 * rung that keeps meaningful access, READ_ONLY its own code, and everything
 * else (CANCELLED, MISSING) the existing INACTIVE code, so a client written
 * against 0003's two codes still routes correctly on the new ladder.
 */
export function wireCodeForStatus(
  status: SubscriptionWireStatus
): string | null {
  switch (status) {
    case 'TRIAL':
    case 'ACTIVE':
    case 'PAST_DUE':
    case 'GRACE':
      return null;
    case 'READ_ONLY':
      return SUBSCRIPTION_READ_ONLY_CODE;
    default:
      return SUBSCRIPTION_INACTIVE_CODE;
  }
}
