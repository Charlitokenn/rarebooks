/**
 * The single, fixed connection to the shared control plane project.
 * This is the ONLY file that talks to CONTROL_DATABASE_URL. Every other
 * query in worker/ goes through resolve-tenant.ts against a tenant's own
 * Neon project instead. Never query accounting data through this client.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md (the lease
 * and every fenced tenant_projects writer)
 */
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

export type ControlDb = NeonQueryFunction<false, false>;

let cached: ControlDb | null = null;

export function getControlDb(env: { CONTROL_DATABASE_URL: string }): ControlDb {
  if (!cached) {
    cached = neon(env.CONTROL_DATABASE_URL);
  }
  return cached;
}

export interface OrganizationRow {
  id: string;
  name: string;
  plan_seat_limit: number | null;
  created_at: string;
}

export interface TenantProjectRow {
  org_id: string;
  neon_project_id: string;
  connection_string: string; // still encrypted here — decrypt only in resolve-tenant.ts, in memory, per request
  region: string;
  provisioning_claim_id: string | null;
  provisioning_claimed_at: string | null;
  provisioning_attempts: number;
  provisioning_last_error: string | null;
  status: 'PROVISIONING' | 'PROJECT_CREATED' | 'READY' | 'SUSPENDED' | 'FAILED';
  created_at: string;
}

export async function insertOrganization(
  db: ControlDb,
  org: { id: string; name: string }
): Promise<void> {
  await db`
    INSERT INTO organizations (id, name)
    VALUES (${org.id}, ${org.name})
    ON CONFLICT (id) DO NOTHING
  `;
}

// ── Provisioning lease (spec 0010) ─────────────────────────────────────────
//
// The single definition of the lease length for the Worker. Byte identical
// copies live in custom/web/db/tenantMigrationRunner.ts and
// scripts/lib/provisioningLease.mjs (they cannot share an import; see the
// runner's header), held in step by worker/tests/provisioning-lease-copies.spec.ts.
// Lease time is always Postgres now(), never the Worker's clock.
export const PROVISIONING_LEASE_SQL = "interval '20 minutes'";

/** A claimed row: the fields the consumer needs to carry on. */
export interface ClaimedTenantProject {
  status: TenantProjectRow['status'];
  neon_project_id: string;
  connection_string: string; // encrypted
  region: string;
}

/** What a refused claim reads back to decide between ack and retry. */
export interface ProvisioningState {
  status: TenantProjectRow['status'];
  /** A claim set, claimed_at set and within the lease, held by someone else. */
  live_foreign_claim: boolean;
  /** Seconds until that lease expires (may be <= 0, or null with no claim). */
  lease_remaining_seconds: number | null;
}

/**
 * Consumer step 1: create the PROVISIONING row if it's missing, always before
 * any Neon call. Throws (and the delivery is retried) if the org row is absent.
 */
export async function ensureTenantProjectRow(
  db: ControlDb,
  orgId: string
): Promise<void> {
  await db`
    INSERT INTO tenant_projects (org_id, neon_project_id, connection_string, region, status)
    VALUES (${orgId}, '', '', '', 'PROVISIONING')
    ON CONFLICT (org_id) DO NOTHING
  `;
}

/**
 * The claim statement (spec 0010 AC-3, AC-6, AC-11). Takes the row when it has
 * no claim, the claim is the caller's own (a redelivery resumes at once), or
 * the lease has expired (NULL claimed_at counts as expired). Moves FAILED back
 * to PROVISIONING without blanking the project fields. A refused claim
 * changes nothing and returns null.
 */
export async function claimProvisioningLease(
  db: ControlDb,
  claim: { orgId: string; claimId: string }
): Promise<ClaimedTenantProject | null> {
  const rows = (await db`
    UPDATE tenant_projects SET
      provisioning_claim_id   = ${claim.claimId},
      provisioning_claimed_at = now(),
      provisioning_attempts   = provisioning_attempts + 1,
      status = CASE WHEN status = 'FAILED' THEN 'PROVISIONING' ELSE status END
    WHERE org_id = ${claim.orgId}
      AND status IN ('PROVISIONING', 'PROJECT_CREATED', 'FAILED')
      AND (provisioning_claim_id IS NULL
           OR provisioning_claim_id = ${claim.claimId}
           OR provisioning_claimed_at IS NULL
           OR provisioning_claimed_at < now() - ${db.unsafe(
             PROVISIONING_LEASE_SQL
           )})
    RETURNING status, neon_project_id, connection_string, region
  `) as unknown as ClaimedTenantProject[];
  return rows[0] ?? null;
}

/**
 * Reads the row after a refused claim (consumer step 2), or before a DLQ
 * retry. `claimId` is the caller's own id, so its own claim is never "foreign".
 */
export async function getProvisioningState(
  db: ControlDb,
  claim: { orgId: string; claimId: string }
): Promise<ProvisioningState | null> {
  const rows = (await db`
    SELECT
      status,
      (provisioning_claim_id IS NOT NULL
       AND provisioning_claim_id <> ${claim.claimId}
       AND provisioning_claimed_at IS NOT NULL
       AND provisioning_claimed_at >= now() - ${db.unsafe(
         PROVISIONING_LEASE_SQL
       )}) AS live_foreign_claim,
      ceil(extract(epoch FROM provisioning_claimed_at + ${db.unsafe(
        PROVISIONING_LEASE_SQL
      )} - now()))::int
        AS lease_remaining_seconds
    FROM tenant_projects
    WHERE org_id = ${claim.orgId}
  `) as unknown as ProvisioningState[];
  return rows[0] ?? null;
}

/**
 * Records a created or adopted project (consumer step 3), fenced by the
 * claim (AC-4). Only writes a row with no project recorded yet, so a
 * recorded neon_project_id is never replaced (AC-6). Refreshes the lease
 * right before the migrate. False means the claim was lost.
 */
export async function recordTenantProject(
  db: ControlDb,
  row: {
    orgId: string;
    claimId: string;
    neonProjectId: string;
    encryptedConnectionString: string;
    region: string;
  }
): Promise<boolean> {
  const rows = (await db`
    UPDATE tenant_projects SET
      neon_project_id = ${row.neonProjectId},
      connection_string = ${row.encryptedConnectionString},
      region = ${row.region},
      status = 'PROJECT_CREATED',
      provisioning_claimed_at = now()
    WHERE org_id = ${row.orgId}
      AND provisioning_claim_id = ${row.claimId}
      AND status = 'PROVISIONING'
      AND neon_project_id = ''
    RETURNING org_id
  `) as unknown as Array<{ org_id: string }>;
  return rows.length === 1;
}

/**
 * Marks the row READY once its schema is applied (consumer step 5), fenced by
 * the claim. Clears the claim, claimed_at, and the last error, so READY
 * always implies no claim. False means the claim was lost.
 */
export async function markTenantProjectReady(
  db: ControlDb,
  claim: { orgId: string; claimId: string }
): Promise<boolean> {
  const rows = (await db`
    UPDATE tenant_projects SET
      status = 'READY',
      provisioning_claim_id = NULL,
      provisioning_claimed_at = NULL,
      provisioning_last_error = NULL
    WHERE org_id = ${claim.orgId}
      AND provisioning_claim_id = ${claim.claimId}
      AND status IN ('PROVISIONING', 'PROJECT_CREATED')
      AND neon_project_id <> ''
    RETURNING org_id
  `) as unknown as Array<{ org_id: string }>;
  return rows.length === 1;
}

/**
 * The single failure record (consumer step 6, AC-7): stores the sanitized
 * error and releases the claim in one fenced statement, and sets FAILED only
 * on the last delivery. False means the claim was lost. Throws if the control
 * plane itself is down; the caller lets that propagate.
 */
export async function recordProvisioningFailure(
  db: ControlDb,
  failure: { orgId: string; claimId: string; error: string; final: boolean }
): Promise<boolean> {
  const rows = (await db`
    UPDATE tenant_projects SET
      provisioning_last_error = ${failure.error},
      provisioning_claim_id = NULL,
      provisioning_claimed_at = NULL,
      status = CASE WHEN ${failure.final}::boolean THEN 'FAILED' ELSE status END
    WHERE org_id = ${failure.orgId}
      AND provisioning_claim_id = ${failure.claimId}
    RETURNING org_id
  `) as unknown as Array<{ org_id: string }>;
  return rows.length === 1;
}

/**
 * The dead letter backstop (AC-7). Fails a row still mid provisioning once no
 * live lease remains, or, with `force` (the DLQ's own final delivery),
 * whatever the lease says: by then the owner is long past its wall time.
 */
export async function failDeadLetteredTenantProject(
  db: ControlDb,
  row: { orgId: string; force: boolean }
): Promise<boolean> {
  const rows = (await db`
    UPDATE tenant_projects SET
      status = 'FAILED',
      provisioning_claim_id = NULL,
      provisioning_claimed_at = NULL,
      provisioning_last_error = COALESCE(provisioning_last_error, 'dead lettered')
    WHERE org_id = ${row.orgId}
      AND status IN ('PROVISIONING', 'PROJECT_CREATED')
      AND (${row.force}::boolean
           OR provisioning_claim_id IS NULL
           OR provisioning_claimed_at IS NULL
           OR provisioning_claimed_at < now() - ${db.unsafe(
             PROVISIONING_LEASE_SQL
           )})
    RETURNING org_id
  `) as unknown as Array<{ org_id: string }>;
  return rows.length === 1;
}

export type OrphanReason =
  | 'DUPLICATE_NAME'
  | 'NO_TENANT_ROW'
  | 'MISMATCHED_TENANT_ROW';

/** Ledgers a stray Neon project. The first reason recorded wins. */
export async function insertNeonProjectOrphan(
  db: ControlDb,
  orphan: { neonProjectId: string; orgId: string | null; reason: OrphanReason }
): Promise<void> {
  await db`
    INSERT INTO neon_project_orphans (neon_project_id, org_id, reason)
    VALUES (${orphan.neonProjectId}, ${orphan.orgId}, ${orphan.reason})
    ON CONFLICT (neon_project_id) DO NOTHING
  `;
}

export async function getTenantProject(
  db: ControlDb,
  orgId: string
): Promise<TenantProjectRow | null> {
  const rows = (await db`
    SELECT * FROM tenant_projects WHERE org_id = ${orgId}
  `) as unknown as TenantProjectRow[];
  return rows[0] ?? null;
}
