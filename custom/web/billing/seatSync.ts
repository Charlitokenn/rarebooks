/**
 * Seat cap sync (spec 0003 AC-5): sets an org's Clerk
 * `maxAllowedMemberships` and records the same number in the control
 * plane's `organizations.plan_seat_limit`. This is THE function specs 0004
 * (PayPal) and 0005 (Lipa Namba) will call on activation, plan change, and
 * cancellation; in this feature it is exercised through the seed command.
 *
 * Clerk is the only seat enforcer (AC-6): nothing here counts members, and
 * no middleware ever re-checks the number. `plan_seat_limit` is a record of
 * intent, written after Clerk, never read back for enforcement.
 *
 * Ordering is deliberate per the spec's state transitions: Clerk first
 * (it's the actual enforcer), then the local record. A failed local write is
 * logged and does not roll back or re-throw over a successful Clerk update;
 * a failed Clerk call throws to the caller, because then nothing was synced.
 *
 * Clerk is reached by plain REST (fetch + CLERK_SECRET_KEY), not
 * `@clerk/backend`: this module must also run under the root package's
 * ts-node (the seed script), and @clerk/backend is only installed in
 * worker/node_modules. The body key is snake_case on the wire
 * (`max_allowed_memberships`), which is what the SDK would convert to
 * anyway. `0` means unlimited in Clerk's API, and a real cap of 0 is not a
 * tier this product sells, so seats must be >= 1 here.
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-5, AC-6, AC-9)
 */
import type { ControlQueryFn } from './types';

const CLERK_API_BASE = 'https://api.clerk.com/v1';

export interface SeatSyncDeps {
  /** Injectable fetch so tests can fake the Clerk REST call. */
  fetch?: typeof globalThis.fetch;
  /** Resolved by the caller (worker passes c.env.CLERK_SECRET_KEY, the seed
   * script passes its env) — this module deliberately never reads process. */
  clerkSecretKey: string;
  log?: (message: string) => void;
}

export class SeatSyncError extends Error {
  constructor(
    message: string,
    readonly orgId: string,
    readonly seats: number
  ) {
    super(message);
    this.name = 'SeatSyncError';
  }
}

/**
 * Sets the org's Clerk member cap to `seats`, then records the number in
 * `organizations.plan_seat_limit`. Throws SeatSyncError if Clerk rejected
 * the update (nothing was synced in that case). A failed local record is
 * logged only; the Clerk cap stands.
 */
export async function syncSeatCap(
  db: ControlQueryFn,
  orgId: string,
  seats: number,
  deps: SeatSyncDeps
): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(message));

  if (!Number.isInteger(seats) || seats < 1) {
    throw new SeatSyncError(
      `Seat cap must be a positive integer; got ${seats} (0 would mean no cap at all in Clerk)`,
      orgId,
      seats
    );
  }
  const secretKey = deps.clerkSecretKey;
  if (!secretKey) {
    throw new SeatSyncError(
      'CLERK_SECRET_KEY is not set; cannot sync the seat cap',
      orgId,
      seats
    );
  }

  const doFetch = deps.fetch ?? fetch;

  // 1. Clerk first: it is the actual enforcer.
  const res = await doFetch(
    `${CLERK_API_BASE}/organizations/${encodeURIComponent(orgId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ max_allowed_memberships: seats }),
    }
  );
  if (!res.ok) {
    throw new SeatSyncError(
      `Clerk updateOrganization failed with HTTP ${res.status}`,
      orgId,
      seats
    );
  }

  // 2. Local record of intent, best effort: never undoes or masks the
  // successful Clerk update above.
  try {
    await upsertPlanSeatLimit(db, orgId, seats);
  } catch (err) {
    log(
      `[seat-sync] plan_seat_limit write failed for ${orgId} (Clerk cap is still set): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Records the synced seat number on the org row. If the org has no control
 * plane row yet, nothing is recorded (an org the webhook hasn't caught up
 * with is not a seat-sync failure).
 */
export async function upsertPlanSeatLimit(
  db: ControlQueryFn,
  orgId: string,
  seats: number
): Promise<boolean> {
  const rows = (await db`
    UPDATE organizations
    SET plan_seat_limit = ${seats}
    WHERE id = ${orgId}
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length === 1;
}
