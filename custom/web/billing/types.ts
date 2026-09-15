/**
 * Shared wire types and constants for subscription gating, seat sync, and
 * the billing ladder. Side-agnostic per project rules: this file imports
 * only type files (here, none) so it can be consumed from the worker, from
 * root scripts/tests, and from the web client alike.
 *
 * The SubscriptionStatus union mirrors the `status` CHECK constraint on the
 * control plane's `subscriptions` table (worker/db/schema.sql) — if that
 * constraint ever changes, this union must change with it. The six states
 * are the spec 0004 ladder: TRIAL -> GRACE -> READ_ONLY -> CANCELLED, with
 * ACTIVE / PAST_DUE as the paid states.
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-2, AC-9),
 * docs/specs/0004-paypal-subscriptions.md (AC-10, AC-16)
 */

export type SubscriptionStatus =
  | 'TRIAL'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'GRACE'
  | 'READ_ONLY'
  | 'CANCELLED';

/**
 * What the gate, the status route, and the client exchange: the six stored
 * statuses plus two derived wire-only values. `'MISSING'` means no
 * subscription row exists for the org; `'UNAVAILABLE'` means the control
 * plane query failed. Neither is ever written to the database.
 */
export type SubscriptionWireStatus =
  | SubscriptionStatus
  | 'MISSING'
  | 'UNAVAILABLE';

export const SUBSCRIPTION_INACTIVE_CODE = 'SUBSCRIPTION_INACTIVE';
export const CONTROL_PLANE_UNAVAILABLE_CODE = 'CONTROL_PLANE_UNAVAILABLE';
export const SUBSCRIPTION_READ_ONLY_CODE = 'SUBSCRIPTION_READ_ONLY';
export const SUBSCRIPTION_ADMIN_REQUIRED_CODE = 'SUBSCRIPTION_ADMIN_REQUIRED';
export const SUBSCRIPTION_SEAT_DOWNGRADE_CODE = 'SUBSCRIPTION_SEAT_DOWNGRADE';

/** One constant message per code (AC-2); client copy keys off `code`/`status`, never this string. */
export const SUBSCRIPTION_INACTIVE_ERROR = 'Subscription is not active';
export const CONTROL_PLANE_UNAVAILABLE_ERROR =
  'Subscription status temporarily unavailable';
/** AC-10: the fixed body the gate returns for a write refused at READ_ONLY. */
export const SUBSCRIPTION_READ_ONLY_ERROR = 'Subscription is read only';
/** AC-2: checkout and cancel are organization owners and admins only. */
export const SUBSCRIPTION_ADMIN_REQUIRED_ERROR =
  'Only organization owners and admins can manage billing';
/** AC-11: the org's live member count exceeds the target plan's seats. */
export const SUBSCRIPTION_SEAT_DOWNGRADE_ERROR =
  'This organization has more members than the selected plan allows';

/**
 * Structural type for the control-plane tagged-template client, restated
 * here (same shape as `custom/web/db/tenantMigrationRunner.ts`'s
 * ControlQueryFn) so this tree never imports a `worker/` file at runtime:
 * worker/ declares "type": "module" and root ts-node cannot require it.
 * The worker's real `ControlDb` (a NeonQueryFunction) is assignable to it.
 */
export type ControlQueryFn = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<unknown>;

/** The fixed 402 denial body (AC-2). */
export interface SubscriptionInactiveResponseBody {
  error: typeof SUBSCRIPTION_INACTIVE_ERROR;
  code: typeof SUBSCRIPTION_INACTIVE_CODE;
  status: Exclude<SubscriptionWireStatus, 'UNAVAILABLE'>;
}

/** The fixed 503 denial body (AC-2). */
export interface ControlPlaneUnavailableResponseBody {
  error: typeof CONTROL_PLANE_UNAVAILABLE_ERROR;
  code: typeof CONTROL_PLANE_UNAVAILABLE_CODE;
  status: 'UNAVAILABLE';
}
