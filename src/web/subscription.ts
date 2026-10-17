/**
 * Client-side handling of the subscription gate's denials (spec 0003 AC-4).
 * Web only.
 *
 * The mechanism: fyo/demux/db.ts throws SubscriptionInactiveError when any
 * /api/db call is denied 402 with code SUBSCRIPTION_INACTIVE; a 503 stays a
 * plain error (an outage is not a billing problem, so it must never route
 * here — the caller's own error handling shows retry copy instead). This
 * module turns a 402 into a navigation: persist the denial as immediate
 * context for the /billing prompt (the page itself re-reads authoritative
 * state from GET /api/subscription/status, AC-8), then route.
 *
 * Installed once from rendererWeb.ts as a global unhandledrejection net, so
 * db calls that don't catch locally still redirect; code that does catch may
 * call handleSubscriptionError directly instead.
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-4)
 */
import { SubscriptionInactiveError } from 'fyo/utils/errors';
import type { Router } from 'vue-router';

export const SUBSCRIPTION_DENIAL_KEY = 'rarebooks:subscription-denial';

export interface SubscriptionDenialRecord {
  status: string;
  at: number;
}

export function recordDenial(status: string): void {
  try {
    sessionStorage.setItem(
      SUBSCRIPTION_DENIAL_KEY,
      JSON.stringify({ status, at: Date.now() })
    );
  } catch {
    // Private-mode/full storage: the prompt page's own status fetch still
    // works; the denial context is only a nicety.
  }
}

export function readDenial(): SubscriptionDenialRecord | null {
  try {
    const raw = sessionStorage.getItem(SUBSCRIPTION_DENIAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SubscriptionDenialRecord>;
    if (typeof parsed.status !== 'string' || typeof parsed.at !== 'number') {
      return null;
    }
    return { status: parsed.status, at: parsed.at };
  } catch {
    return null;
  }
}

/** True (and handled) when err is a 402 denial; routes to /billing. */
export function handleSubscriptionError(err: unknown, router: Router): boolean {
  if (!(err instanceof SubscriptionInactiveError)) {
    return false;
  }
  recordDenial(err.status);
  void router.replace('/billing');
  return true;
}

export function initSubscriptionRedirect(router: Router): void {
  window.addEventListener('unhandledrejection', (event) => {
    if (handleSubscriptionError(event.reason, router)) {
      event.preventDefault();
    }
  });
}
