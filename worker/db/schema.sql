-- Control plane schema (0001: web platform foundation & control plane).
-- Applied once, by hand or via a migration runner, against CONTROL_DATABASE_URL.
-- This is the ONE shared Neon project. It never holds accounting data —
-- accounting data lives only in each org's own tenant project (feature 0002).

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,               -- Clerk organization ID
  name text NOT NULL,
  plan_seat_limit integer,           -- record of intent, synced to Clerk's maxAllowedMemberships (0003); never re-checked per request
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_projects (
  org_id text PRIMARY KEY REFERENCES organizations(id),
  neon_project_id text NOT NULL,
  connection_string text NOT NULL,   -- AES-256-GCM encrypted at rest with TENANT_ENCRYPTION_KEY; never logged or returned in an API response
  region text NOT NULL,
  provisioning_claim_id text,
  status text NOT NULL DEFAULT 'PROVISIONING'
    CHECK (status IN ('PROVISIONING', 'PROJECT_CREATED', 'READY', 'SUSPENDED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- subscriptions and payments are created here (0001) but populated by
-- 0004 (PayPal) and 0005 (Lipa Namba); kept here since they are control
-- plane, cross-tenant tables, not per-tenant accounting data.
--
-- The status ladder (spec 0004): TRIAL -> GRACE -> READ_ONLY -> CANCELLED,
-- with ACTIVE / PAST_DUE as the paid states. `stage_ends_at` is when the
-- hourly cron advances the row one rung; NULL on a healthy ACTIVE.

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL UNIQUE REFERENCES organizations(id),
  -- NULL through the trial: a trial row predates any payment provider.
  provider text CHECK (provider IN ('paypal', 'lipa_namba')),
  status text NOT NULL
    CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE', 'READ_ONLY', 'CANCELLED')),
  -- NULL through the trial; written by the checkout create (spec 0004 AC-6).
  plan text CHECK (plan IN ('diy', 'dfy')),
  paypal_subscription_id text UNIQUE,
  current_period_end timestamptz,
  pending_cancel boolean NOT NULL DEFAULT false,
  stage_ends_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organizations(id),
  provider text NOT NULL CHECK (provider IN ('paypal', 'lipa_namba')),
  amount numeric NOT NULL,
  currency text,
  status text NOT NULL,
  reference text,
  provider_event_id text,
  reviewed_by text,                  -- Clerk user ID of the approving super admin (lipa_namba only)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One open checkout per org at a time (spec 0004 AC-3): PENDING until the
-- PayPal create call returns, CREATED with the subscription ID and approval
-- URL, DONE on activation, FAILED on switch, abandonment, or activation
-- cancellation.
CREATE TABLE IF NOT EXISTS subscription_checkout_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organizations(id),
  plan text NOT NULL CHECK (plan IN ('diy', 'dfy')),
  period text NOT NULL CHECK (period IN ('monthly', 'yearly')),
  status text NOT NULL
    CHECK (status IN ('PENDING', 'CREATED', 'FAILED', 'DONE')),
  -- Stable idempotency key for the PayPal create call, reused across retries.
  paypal_request_id text NOT NULL UNIQUE,
  paypal_subscription_id text UNIQUE,
  approval_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_org_id ON subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_payments_org_id ON payments(org_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_event_id
  ON payments(provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intents_one_open_per_org
  ON subscription_checkout_intents(org_id)
  WHERE status IN ('PENDING', 'CREATED');
CREATE INDEX IF NOT EXISTS idx_checkout_intents_paypal_request_id
  ON subscription_checkout_intents(paypal_request_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stage_ends_at
  ON subscriptions(stage_ends_at)
  WHERE stage_ends_at IS NOT NULL;
