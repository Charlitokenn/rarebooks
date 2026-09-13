/**
 * The shared core behind `npm run seed:subscription` (spec 0003, AC-7):
 * marks an org's subscription ACTIVE in the control plane and syncs its
 * Clerk seat cap, so the gate, the /billing prompt, and the cap are all
 * exercisable while specs 0004 and 0005 (the real writers) build later.
 *
 * Row values are fixed by the schema's constraints (see spec 0003 "Seed row
 * values"): provider 'paypal' is a placeholder against the CHECK, not a
 * payment claim; spec 0004 overwrites it with the real subscription. The
 * update branch must set updated_at explicitly — the column DEFAULT only
 * fires on insert.
 *
 * `neon()` is imported from the root package's `pg` alias
 * (`pg` = npm:@neondatabase/serverless), the same wall-crossing trick
 * `custom/web/db/tenantMigrationRunner.ts` uses; this file must never
 * import from worker/.
 *
 * Spec: docs/specs/0003-subscription-gating-seat-sync.md (AC-5, AC-7)
 */
import { neon } from 'pg';
import { syncSeatCap, type SeatSyncDeps } from './seatSync';
import type { ControlQueryFn } from './types';

export interface SeedSecrets {
  controlDatabaseUrl: string;
  clerkSecretKey: string;
}

export interface SeedOptions {
  orgId: string;
  /** Required unless dryRun; a real sync with no number would be an error. */
  seats?: number;
  dryRun: boolean;
}

export interface SeedDeps {
  /** Control plane client; defaults to one built from the secrets. */
  db?: ControlQueryFn;
  syncSeatCap?: (
    db: ControlQueryFn,
    orgId: string,
    seats: number,
    deps: SeatSyncDeps
  ) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  log?: (message: string) => void;
}

export interface SeedResult {
  orgId: string;
  dryRun: boolean;
  seats: number | null;
}

/**
 * The fixed upsert from spec 0003: exactly one row per org (UNIQUE org_id),
 * always lands on ACTIVE + paypal. Throws (e.g. a foreign key violation)
 * if the org has no control plane row yet — the operator is told, exit 1.
 */
export async function upsertActiveSubscription(
  db: ControlQueryFn,
  orgId: string
): Promise<void> {
  await db`
    INSERT INTO subscriptions (org_id, provider, status)
    VALUES (${orgId}, 'paypal', 'ACTIVE')
    ON CONFLICT (org_id) DO UPDATE SET
      status = 'ACTIVE',
      provider = EXCLUDED.provider,
      updated_at = now()
  `;
}

export async function seedSubscription(
  secrets: SeedSecrets,
  options: SeedOptions,
  deps: SeedDeps = {}
): Promise<SeedResult> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const runSeatSync = deps.syncSeatCap ?? syncSeatCap;

  if (!options.orgId) {
    throw new Error(
      '--org= is required; see npm run seed:subscription -- --help'
    );
  }
  if (!options.dryRun && options.seats == null) {
    throw new Error(
      '--seats= is required (a missing cap would mean maxAllowedMemberships: null, i.e. no cap at all); use --dry-run to preview without it'
    );
  }
  if (!options.dryRun && !secrets.clerkSecretKey) {
    throw new Error(
      'CLERK_SECRET_KEY is not set (env, root .env, or worker/.dev.vars)'
    );
  }
  if (!options.dryRun && !secrets.controlDatabaseUrl) {
    throw new Error(
      'CONTROL_DATABASE_URL is not set (env, root .env, or worker/.dev.vars)'
    );
  }

  if (options.dryRun) {
    log(
      `[seed-subscription] dry run: would upsert an ACTIVE subscription (provider 'paypal') for org ${options.orgId}` +
        (options.seats != null
          ? ` and sync its Clerk seat cap to ${options.seats}`
          : ' (no seat sync without --seats)')
    );
    return { orgId: options.orgId, dryRun: true, seats: options.seats ?? null };
  }

  const db = deps.db ?? (neon(secrets.controlDatabaseUrl) as ControlQueryFn);
  const seats = options.seats as number;

  await upsertActiveSubscription(db, options.orgId);
  log(`[seed-subscription] subscription ACTIVE for org ${options.orgId}`);

  await runSeatSync(db, options.orgId, seats, {
    clerkSecretKey: secrets.clerkSecretKey,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    log,
  });
  log(
    `[seed-subscription] seat cap synced to ${seats} (Clerk maxAllowedMemberships + plan_seat_limit)`
  );

  return { orgId: options.orgId, dryRun: false, seats };
}
