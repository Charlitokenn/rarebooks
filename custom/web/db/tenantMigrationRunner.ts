/**
 * The spec 0002 (AC-5) migration runner: applies `DatabaseCore.migrate()`
 * against every eligible row in the control plane's `tenant_projects`
 * table, so a schema change reaches each tenant's own Neon project instead
 * of one shared database. Because there is one project per tenant, there is
 * no single `ALTER TABLE` that can do this — the runner is the mechanism.
 *
 * Invocation (decided 2026-09-12): a one-off script,
 * `scripts/migrate-tenants.ts` (`npm run migrate:tenants`), run by hand with
 * the Worker's own secrets (`CONTROL_DATABASE_URL`, `TENANT_ENCRYPTION_KEY`)
 * from the environment or a local env file — not an HTTP route and not a
 * Cron Trigger. A schema rollout is a deliberate, observed operational
 * action: it must never be reachable over HTTP, and it must not run
 * unattended against tenants a billing suspension has just taken down.
 *
 * This module deliberately imports NOTHING from `worker/`: `worker/package.
 * json` declares `"type": "module"`, so any require() chain reaching a
 * `worker/**` file trips under the root package's CJS ts-node pipeline (the
 * same wall `tests/organizationCreatedProvisioning.spec.ts` hits, which is
 * why it needs `scripts/runner.sh`'s Electron node). `decryptTenant-
 * ConnectionString` below is therefore a deliberate, async copy of
 * `worker/lib/encryption.ts`'s decrypt() — same AES-256-GCM envelope,
 * base64(iv || ciphertext || tag), 12-byte IV, Web Crypto throughout so the
 * file also survives the worker tsconfig (which includes ../custom/web/**)
 * where no Node types exist. If that envelope format ever changes, both
 * files must change together.
 *
 * The connection string is decrypted in memory here and only ever handed to
 * `migrateTenantProject` — never logged, never returned.
 *
 * `--include-project-created` takes the same provisioning lease the queue
 * consumer does (spec 0010 AC-10): a random claim id per row, the same
 * claimable predicate, and READY written only under that claim. So a row
 * the consumer is working on is skipped, and a row the runner holds can't
 * be taken by the consumer until its lease is released or expires.
 * `PROVISIONING_LEASE_SQL` below is a byte identical copy of
 * worker/db/control.ts's (same import wall as decrypt).
 *
 * Spec: docs/specs/0002-tenant-schema-data-layer.md (AC-5)
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md (AC-10)
 */
import { neon } from 'pg';
import DatabaseCore from '../../../backend/database/core';
import { getSchemas } from '../../../schemas';
import { newTenantKnexConfig } from './knexPgConfig';
import { seedDefaultEntries } from './seedDefaultEntries';
import type { RawCustomField } from '../../../backend/database/types';

export type ControlQueryFn = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<unknown>) & {
  /** Raw SQL interpolation (`neon()`'s `sql.unsafe`), used only for the lease. */
  unsafe(rawSql: string): unknown;
};

export interface RunnerSecrets {
  controlDatabaseUrl: string;
  tenantEncryptionKey: string;
}

export interface RunnerOptions {
  /** Limit the rollout to one tenant (org repair, staged canary). */
  orgId?: string;
  /**
   * Also migrate `PROJECT_CREATED` tenants — the recovery path when
   * provisioning created the Neon project but died before its own
   * schema-migration step ran. Each one is migrated under the runner's own
   * provisioning lease (spec 0010 AC-10) and advances to `READY` on
   * success; one whose lease is held elsewhere is skipped as provisioning
   * in flight. `PROVISIONING`, `SUSPENDED`, and `FAILED` tenants are always
   * left alone: in-flight provisioning, a billing suspension, and a
   * provisioning failure (`npm run provision:retry`) are none of them
   * schema-rollout targets.
   */
  includeProjectCreated: boolean;
  dryRun: boolean;
}

export interface TenantProjectRecord {
  orgId: string;
  status: string;
  encryptedConnectionString: string;
}

export interface TenantMigrationSummary {
  scanned: number;
  wouldMigrate: number;
  migrated: number;
  skipped: { orgId: string; status: string; reason?: string }[];
  failed: { orgId: string; error: string }[];
}

export interface RunnerDeps {
  controlDb?: ControlQueryFn;
  decrypt?: (encoded: string, rawKey: string) => Promise<string>;
  migrateTenantProject?: (
    orgId: string,
    connectionString: string
  ) => Promise<void>;
  claimProjectCreated?: (
    db: ControlQueryFn,
    claim: { orgId: string; claimId: string }
  ) => Promise<string | null>;
  releaseProjectCreated?: (
    db: ControlQueryFn,
    claim: { orgId: string; claimId: string }
  ) => Promise<void>;
  markTenantReady?: (
    db: ControlQueryFn,
    claim: { orgId: string; claimId: string }
  ) => Promise<boolean>;
  log?: (message: string) => void;
}

const LOG_PREFIX = '[tenant-migration-runner]';
// Copy of worker/db/control.ts's; see this file's header.
export const PROVISIONING_LEASE_SQL = "interval '20 minutes'";
const IV_LENGTH_BYTES = 12; // matches worker/lib/encryption.ts

export function isMigratableStatus(
  status: string,
  includeProjectCreated: boolean
): boolean {
  return (
    status === 'READY' ||
    (includeProjectCreated && status === 'PROJECT_CREATED')
  );
}

/**
 * Copy of worker/lib/encryption.ts's decrypt() — see this file's header for
 * why it is restated rather than imported.
 */
export async function decryptTenantConnectionString(
  encoded: string,
  rawKey: string
): Promise<string> {
  const keyBytes = Uint8Array.from(atob(rawKey), (c) => c.charCodeAt(0));
  if (keyBytes.length !== 32) {
    throw new Error(
      `TENANT_ENCRYPTION_KEY must decode to 32 bytes for AES-256-GCM, got ${keyBytes.length}`
    );
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, IV_LENGTH_BYTES);
  const ciphertext = combined.slice(IV_LENGTH_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

export async function listTenantProjects(
  db: ControlQueryFn,
  orgId?: string
): Promise<TenantProjectRecord[]> {
  const rows = (
    orgId
      ? await db`SELECT org_id, status, connection_string FROM tenant_projects WHERE org_id = ${orgId}`
      : await db`SELECT org_id, status, connection_string FROM tenant_projects`
  ) as Record<string, string>[];
  return rows.map((row) => ({
    orgId: row.org_id,
    status: row.status,
    encryptedConnectionString: row.connection_string,
  }));
}

/**
 * Takes the provisioning lease on a PROJECT_CREATED row (the consumer's claim
 * statement, PROJECT_CREATED only). Returns the encrypted connection string,
 * or null when a live lease is held elsewhere (provisioning in flight) or
 * the row has moved on.
 */
export async function claimProjectCreatedTenant(
  db: ControlQueryFn,
  claim: { orgId: string; claimId: string }
): Promise<string | null> {
  const rows = (await db`
    UPDATE tenant_projects SET
      provisioning_claim_id   = ${claim.claimId},
      provisioning_claimed_at = now(),
      provisioning_attempts   = provisioning_attempts + 1
    WHERE org_id = ${claim.orgId}
      AND status = 'PROJECT_CREATED'
      AND (provisioning_claim_id IS NULL
           OR provisioning_claim_id = ${claim.claimId}
           OR provisioning_claimed_at IS NULL
           OR provisioning_claimed_at < now() - ${db.unsafe(PROVISIONING_LEASE_SQL)})
    RETURNING connection_string
  `) as Array<{ connection_string: string }>;
  return rows[0]?.connection_string ?? null;
}

/**
 * Advances the row to READY, fenced by the runner's own claim, and clears
 * the lease and last error (READY implies no claim). False means the lease
 * was lost underneath it.
 */
export async function markTenantProjectReady(
  db: ControlQueryFn,
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
      AND status = 'PROJECT_CREATED'
    RETURNING org_id
  `) as Array<{ org_id: string }>;
  return rows.length === 1;
}

/**
 * Hands the lease back after a failed migrate, so the consumer (or the next
 * run) can take the row at once instead of waiting out the 20 minutes.
 */
export async function releaseProjectCreatedTenant(
  db: ControlQueryFn,
  claim: { orgId: string; claimId: string }
): Promise<void> {
  await db`
    UPDATE tenant_projects SET
      provisioning_claim_id = NULL,
      provisioning_claimed_at = NULL
    WHERE org_id = ${claim.orgId}
      AND provisioning_claim_id = ${claim.claimId}
  `;
}

/**
 * Same schema-migration shape as custom/web/auth/applyTenantSchema.ts, plus
 * what that first run could not yet do: a tenant that has been live can have
 * custom fields, so (mirroring DatabaseManager.setRawCustomFields on
 * Desktop) the runner reads them back before building the schema map.
 * Closes the gap custom/web/db/tenantDatabase.ts's header comment deferred
 * to this feature.
 */
export async function migrateTenantProject(
  orgId: string,
  connectionString: string,
  log: (message: string) => void = (message) => console.log(message)
): Promise<void> {
  const db = new DatabaseCore(newTenantKnexConfig(connectionString));

  try {
    await db.connect();
    let rawCustomFields: RawCustomField[] = [];
    try {
      rawCustomFields = (await db.knex!('CustomField')) as RawCustomField[];
    } catch (error) {
      if ((error as { code?: unknown }).code !== '42P01') {
        throw error;
      }
      // A tenant migrated before custom fields existed (or the first
      // recovery migrate of a freshly provisioned project) has no table yet.
      log(
        `${LOG_PREFIX} ${orgId}: no CustomField table yet, migrating without custom fields`
      );
    }
    db.setSchemaMap(getSchemas('-', rawCustomFields));
    await db.migrate();
    // Idempotent (checks existence per record) — safe on a tenant that was
    // already seeded, and closes the gap for a PROJECT_CREATED tenant whose
    // first (webhook) run never reached applyTenantSchema.ts's own seeding.
    await seedDefaultEntries(db);
  } finally {
    await db.close();
  }
}

export async function runTenantMigrations(
  secrets: RunnerSecrets,
  options: RunnerOptions,
  deps: RunnerDeps = {}
): Promise<TenantMigrationSummary> {
  if (!secrets.controlDatabaseUrl) {
    throw new Error(
      `${LOG_PREFIX} CONTROL_DATABASE_URL is not set — export it or put it in the local env file before running the migration (never commit it).`
    );
  }
  if (!secrets.tenantEncryptionKey) {
    throw new Error(
      `${LOG_PREFIX} TENANT_ENCRYPTION_KEY is not set — export it or put it in the local env file before running the migration (never commit it).`
    );
  }

  const log = deps.log ?? ((message: string) => console.log(message));
  const db =
    deps.controlDb ?? (neon(secrets.controlDatabaseUrl) as ControlQueryFn);
  const decrypt = deps.decrypt ?? decryptTenantConnectionString;
  const migrate =
    deps.migrateTenantProject ??
    ((orgId: string, connectionString: string) =>
      migrateTenantProject(orgId, connectionString, log));
  const setReady = deps.markTenantReady ?? markTenantProjectReady;
  const claimRow = deps.claimProjectCreated ?? claimProjectCreatedTenant;
  const releaseRow = deps.releaseProjectCreated ?? releaseProjectCreatedTenant;

  const records = await listTenantProjects(db, options.orgId);
  if (options.orgId && records.length === 0) {
    throw new Error(
      `${LOG_PREFIX} no tenant_projects row found for org ${options.orgId} — nothing to do.`
    );
  }

  const summary: TenantMigrationSummary = {
    scanned: records.length,
    wouldMigrate: 0,
    migrated: 0,
    skipped: [],
    failed: [],
  };

  for (const record of records) {
    if (!isMigratableStatus(record.status, options.includeProjectCreated)) {
      summary.skipped.push({ orgId: record.orgId, status: record.status });
      log(`${LOG_PREFIX} ${record.orgId}: skipped (status ${record.status})`);
      continue;
    }

    summary.wouldMigrate += 1;

    if (options.dryRun) {
      log(`${LOG_PREFIX} ${record.orgId}: [dry run] would migrate`);
      continue;
    }

    // A PROJECT_CREATED row is migrated only under the runner's own lease.
    const claim =
      record.status === 'PROJECT_CREATED'
        ? { orgId: record.orgId, claimId: crypto.randomUUID() }
        : null;

    try {
      let encryptedConnectionString = record.encryptedConnectionString;
      if (claim) {
        const claimed = await claimRow(db, claim);
        if (claimed === null) {
          summary.wouldMigrate -= 1;
          summary.skipped.push({
            orgId: record.orgId,
            status: record.status,
            reason: 'provisioning in flight',
          });
          log(`${LOG_PREFIX} ${record.orgId}: skipped (provisioning in flight)`);
          continue;
        }
        encryptedConnectionString = claimed;
      }

      const connectionString = await decrypt(
        encryptedConnectionString,
        secrets.tenantEncryptionKey
      );
      log(`${LOG_PREFIX} ${record.orgId}: migrating`);
      await migrate(record.orgId, connectionString);
      if (claim) {
        const advanced = await setReady(db, claim);
        log(
          `${LOG_PREFIX} ${record.orgId}: ${
            advanced
              ? 'status PROJECT_CREATED -> READY'
              : 'lease lost underneath, left alone'
          }`
        );
      }
      summary.migrated += 1;
    } catch (err) {
      if (claim) {
        // Best effort; an unreleased lease simply expires in 20 minutes.
        await releaseRow(db, claim).catch(() => undefined);
      }
      // One failing tenant must not abort the rollout of the rest.
      const message = err instanceof Error ? err.message : String(err);
      summary.failed.push({ orgId: record.orgId, error: message });
      log(`${LOG_PREFIX} ${record.orgId}: FAILED — ${message}`);
    }
  }

  return summary;
}
