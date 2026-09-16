/**
 * The single source of plan, price, seat, and ladder-window truth for both
 * the web client (Billing page cards, banners) and the Worker (trial row,
 * activation seat cap, cron rung arithmetic, env var lookup). Specs 0004
 * (PayPal) and 0005 (Lipa Namba) both read plans from here; neither invents
 * a seat number anywhere else.
 *
 * Side-agnostic and dependency-free so the root ts-node scripts, the
 * Worker bundle, and the Vite client bundle can all import it (same shared
 * rule as custom/web/billing/types.ts).
 *
 * Spec: docs/specs/0004-paypal-subscriptions.md (AC-1, AC-2, AC-9)
 */

export type PlanKey = 'diy' | 'dfy';
export type PlanPeriod = 'monthly' | 'yearly';

/** Own-clock trial: 14 days from provisioning, full app, TRIAL_SEATS seats. */
export const TRIAL_DAYS = 14;
/** After entitlement ends: 7 days of full access with upgrade nudges. */
export const GRACE_DAYS = 7;
/** After grace: 5 days where reads pass and every write is refused. */
export const READ_ONLY_DAYS = 5;
/** The trial runs the full app at DFY's seat count. */
export const TRIAL_SEATS = 5;
/** The banner starts nudging a trial org one week before the stage ends. */
export const TRIAL_NUDGE_DAYS = 7;
/** The checkout create call is abandoned (FAILED) after this long. */
export const CHECKOUT_INTENT_TIMEOUT_HOURS = 24;
/** All PayPal billing happens in USD (sandbox and live alike). */
export const PAYPAL_CURRENCY = 'USD';
/** Fixed cancellation note sent to PayPal (AC-11: no admin typed input). */
export const PAYPAL_CANCEL_REASON = 'Canceled from RareBooks billing page';

export interface PlanTier {
  key: PlanKey;
  name: string;
  tagline: string;
  seats: number;
  /** USD, matching the PayPal billing plan values set up per environment. */
  priceUsd: Record<PlanPeriod, number>;
  /** Rendered as the card's feature list. */
  perks: string[];
}

export const PLANS: Record<PlanKey, PlanTier> = {
  diy: {
    key: 'diy',
    name: 'Do It Yourself',
    tagline: 'You keep the books, we keep them straight.',
    seats: 2,
    priceUsd: { monthly: 20, yearly: 204 },
    perks: [
      'The full RareBooks app for 2 seats',
      'Email support',
    ],
  },
  dfy: {
    key: 'dfy',
    name: 'Done For You',
    tagline: 'We set it up, teach it, and stay on call.',
    seats: 5,
    priceUsd: { monthly: 49, yearly: 500 },
    perks: [
      'The full RareBooks app for 5 seats',
      'Data migration and app setup',
      'Over the shoulder software use training',
      'Priority support',
    ],
  },
};

export function isPlanKey(value: unknown): value is PlanKey {
  return value === 'diy' || value === 'dfy';
}

export function isPlanPeriod(value: unknown): value is PlanPeriod {
  return value === 'monthly' || value === 'yearly';
}

/** Seat cap for an activated plan; the trial cap lives in TRIAL_SEATS. */
export function planSeats(plan: PlanKey): number {
  return PLANS[plan].seats;
}

/**
 * The Worker env var holding the PayPal billing plan ID for a (plan, period)
 * pair, e.g. ('diy', 'yearly') → 'PAYPAL_PLAN_ID_DIY_YEARLY'. The value is
 * per-environment (sandbox vs live) in wrangler.toml [vars].
 */
export function planEnvVarName(plan: PlanKey, period: PlanPeriod): string {
  return `PAYPAL_PLAN_ID_${plan.toUpperCase()}_${period.toUpperCase()}`;
}
