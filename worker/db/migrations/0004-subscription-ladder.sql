-- Spec 0004 (PayPal subscriptions) operator migration for the LIVE control
-- plane. worker/db/schema.sql is the source of truth for fresh installs;
-- this file brings an EXISTING staging plane up to it. DDL and data fixes
-- against shared infra remain a human call (the 0003 precedent), so nothing
-- runs this automatically. Apply once, against CONTROL_DATABASE_URL, inside
-- the transaction below. Idempotent: safe to re-run.
--
-- Pre-flight (read the counts, confirm before proceeding):
--   SELECT status, count(*) FROM subscriptions GROUP BY status;
--   SELECT count(*) FROM organizations o
--     LEFT JOIN subscriptions s ON s.org_id = o.id WHERE s.id IS NULL;
--   -- 0003's unresolved drift: subscriptions_org_id_key UNIQUE and the
--   -- SUSPENDED-inclusive status CHECK were owed on staging. If the UNIQUE
--   -- constraint is still missing, the 0003 verify.md ALTERs run first.
--
-- Retired status mapping (all three should be zero rows on staging; the
-- UPDATEs are defensive so the CHECK swap never fails on a surprise row):
--   EXPIRED         -> CANCELLED   (both were hard locks)
--   SUSPENDED       -> PAST_DUE    (a payment problem, before the ladder)
--   PENDING_REVIEW  -> GRACE       (spec 0005 was never built; no real
--                                   review rows can exist. If any do, the
--                                   operator reviews them before running
--                                   this and removes the mapping.)

BEGIN;

-- 1. subscriptions: provider becomes nullable (a trial row predates any
--    payment provider).
ALTER TABLE subscriptions ALTER COLUMN provider DROP NOT NULL;

-- 2. subscriptions: ladder columns.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan text
  CHECK (plan IN ('diy', 'dfy'));
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_cancel boolean
  NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stage_ends_at timestamptz;

-- 3. subscriptions: swap the six-state status CHECK for the ladder CHECK.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
UPDATE subscriptions SET status = 'CANCELLED' WHERE status = 'EXPIRED';
UPDATE subscriptions SET status = 'PAST_DUE' WHERE status = 'SUSPENDED';
UPDATE subscriptions
   SET status = 'GRACE', stage_ends_at = now() + interval '7 days'
 WHERE status = 'PENDING_REVIEW';
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE', 'READ_ONLY', 'CANCELLED'));

-- 4. payments: currency column.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency text;

-- 5. subscription_checkout_intents (matches schema.sql).
CREATE TABLE IF NOT EXISTS subscription_checkout_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organizations(id),
  plan text NOT NULL CHECK (plan IN ('diy', 'dfy')),
  period text NOT NULL CHECK (period IN ('monthly', 'yearly')),
  status text NOT NULL
    CHECK (status IN ('PENDING', 'CREATED', 'FAILED', 'DONE')),
  paypal_request_id text NOT NULL UNIQUE,
  paypal_subscription_id text UNIQUE,
  approval_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intents_one_open_per_org
  ON subscription_checkout_intents(org_id)
  WHERE status IN ('PENDING', 'CREATED');
CREATE INDEX IF NOT EXISTS idx_checkout_intents_paypal_request_id
  ON subscription_checkout_intents(paypal_request_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stage_ends_at
  ON subscriptions(stage_ends_at)
  WHERE stage_ends_at IS NOT NULL;

-- 6. Backfill (spec 0004 AC-14): every org with no subscription row, and
--    every seeded ACTIVE PayPal placeholder with no binding, becomes a 14-day TRIAL
--    on the app's own clock. Rows WITH a paypal_subscription_id keep their
--    status; the hourly cron owns their ladder from then on.
INSERT INTO subscriptions (org_id, status, stage_ends_at)
SELECT o.id, 'TRIAL', now() + interval '14 days'
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.org_id = o.id);

UPDATE subscriptions
   SET status = 'TRIAL',
       plan = NULL,
       stage_ends_at = now() + interval '14 days',
       updated_at = now()
 WHERE status = 'ACTIVE'
   AND provider = 'paypal'
   AND paypal_subscription_id IS NULL;

COMMIT;

-- Post-flight note: backfilled TRIAL orgs should sit at the trial seat cap
-- (5). Clerk's maxAllowedMemberships and organizations.plan_seat_limit are
-- NOT touched here (Clerk is not reachable from SQL). If a backfilled org
-- was seeded at a different cap, an operator syncs it once with:
--   npm run seed:subscription -- --org=... --seats=5   (re-arms seats; note
--   that script also sets ACTIVE; for a pure seat-only sync use the Clerk
--   dashboard or the sync helper directly). The cron and activation paths
--   keep the cap correct from here on.
