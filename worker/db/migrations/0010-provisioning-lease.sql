-- Spec 0010 (provisioning claim lease & orphan tracking) operator migration
-- for the LIVE control plane. worker/db/schema.sql is the source of truth for
-- fresh installs; this file brings an EXISTING plane up to it. DDL against
-- shared infra remains a human call (the 0003/0004 precedent), so nothing
-- runs this automatically. Apply once, against CONTROL_DATABASE_URL, inside
-- the transaction below, BEFORE deploying the queue-backed Worker. Purely
-- additive and idempotent: safe to re-run, and harmless to the old Worker.
--
-- Pre-flight (read the counts, confirm before proceeding):
--   SELECT status, count(*) FROM tenant_projects GROUP BY status;
--   -- Rows stuck mid provisioning by the old synchronous webhook. After this
--   -- migration they carry a NULL provisioning_claimed_at, which the lease
--   -- treats as expired (AC-11), so `npm run provision:retry -- <orgId>`
--   -- can recover each one once the new Worker is deployed:
--   SELECT org_id, status, provisioning_claim_id, created_at
--     FROM tenant_projects
--    WHERE status IN ('PROVISIONING', 'PROJECT_CREATED', 'FAILED');

BEGIN;

-- 1. tenant_projects: lease, attempt count, and last failure reason.
ALTER TABLE tenant_projects
  ADD COLUMN IF NOT EXISTS provisioning_claimed_at timestamptz;
ALTER TABLE tenant_projects
  ADD COLUMN IF NOT EXISTS provisioning_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE tenant_projects
  ADD COLUMN IF NOT EXISTS provisioning_last_error text;

-- 2. neon_project_orphans: Neon projects nothing points at (matches schema.sql).
CREATE TABLE IF NOT EXISTS neon_project_orphans (
  neon_project_id text PRIMARY KEY,
  org_id text,
  reason text NOT NULL
    CHECK (reason IN ('DUPLICATE_NAME', 'NO_TENANT_ROW', 'MISMATCHED_TENANT_ROW')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

COMMIT;

-- Post-flight:
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'tenant_projects'
--      AND column_name LIKE 'provisioning_%';
--   SELECT count(*) FROM neon_project_orphans;   -- 0
