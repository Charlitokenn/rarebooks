/**
 * The provisioning lease SQL, run for real against Postgres: the claim, its
 * refusal, the fences, the failure record, and the dead letter statement in
 * worker/db/control.ts, plus provision:retry's eligibility query. The other
 * specs fake the control plane; this one closes the "race safety never
 * executes" gap from the 2026-10-26 review.
 *
 * Needs CONTROL_TEST_DATABASE_URL: a Neon DEV BRANCH, never the live control
 * plane. Skipped when unset. It creates the control plane tables if missing
 * (schema.sql, then the 0010 migration), works only on org ids it makes up,
 * and deletes those rows afterwards.
 *
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md
 * (AC-3, AC-4, AC-6, AC-7, AC-10, AC-11)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimProvisioningLease,
  ensureTenantProjectRow,
  failDeadLetteredTenantProject,
  getProvisioningState,
  getTenantProject,
  insertNeonProjectOrphan,
  markTenantProjectReady,
  recordProvisioningFailure,
  recordTenantProject,
  type ControlDb,
} from '../db/control';
// @ts-expect-error plain ESM operator script, no type declarations
import { checkRetryEligibility } from '../../scripts/lib/provisionRetry.mjs';

const url = process.env.CONTROL_TEST_DATABASE_URL;
const RUN = `t${Date.now().toString(36)}`;

/** Splits a plain DDL file (no functions or dollar quoting) into statements. */
function statements(relativePath: string): string[] {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf8')
    .split(/\r?\n/)
    // Inline comments too: some carry semicolons. No string literal in
    // these files contains `--`.
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'BEGIN' && s !== 'COMMIT');
}

describe.skipIf(!url)('provisioning lease SQL against real Postgres', () => {
  const db = (url ? neon(url) : null) as ControlDb;
  let n = 0;
  let orgId = '';
  const orgs: string[] = [];

  const row = async () => (await getTenantProject(db, orgId))!;
  const ageClaim = (minutes: number) =>
    db.query(
      `UPDATE tenant_projects SET provisioning_claimed_at = now() - ($2 || ' minutes')::interval WHERE org_id = $1`,
      [orgId, String(minutes)]
    );
  const setRow = (sqlSet: string, params: unknown[] = []) =>
    db.query(`UPDATE tenant_projects SET ${sqlSet} WHERE org_id = $1`, [
      orgId,
      ...params,
    ]);

  beforeAll(async () => {
    for (const statement of [
      ...statements('db/schema.sql'),
      ...statements('db/migrations/0010-provisioning-lease.sql'),
    ]) {
      await db.query(statement);
    }
  }, 60_000);

  beforeEach(async () => {
    n += 1;
    orgId = `org_${RUN}_${n}`;
    orgs.push(orgId);
    await db`INSERT INTO organizations (id, name) VALUES (${orgId}, 'sql spec')`;
    await ensureTenantProjectRow(db, orgId);
  });

  afterAll(async () => {
    if (!url) return;
    await db`DELETE FROM neon_project_orphans WHERE org_id = ANY(${orgs})`;
    await db`DELETE FROM tenant_projects WHERE org_id = ANY(${orgs})`;
    await db`DELETE FROM organizations WHERE id = ANY(${orgs})`;
  });

  it('upserts the PROVISIONING row once, and refuses an org with no organizations row', async () => {
    await ensureTenantProjectRow(db, orgId);
    expect(await row()).toMatchObject({
      status: 'PROVISIONING',
      neon_project_id: '',
      provisioning_attempts: 0,
    });
    await expect(
      ensureTenantProjectRow(db, `org_${RUN}_missing`)
    ).rejects.toThrow();
  });

  it('claims a fresh row, then lets the same message reclaim at once (AC-3)', async () => {
    expect(
      await claimProvisioningLease(db, { orgId, claimId: 'm1' })
    ).toMatchObject({
      status: 'PROVISIONING',
      neon_project_id: '',
    });
    expect(
      await claimProvisioningLease(db, { orgId, claimId: 'm1' })
    ).not.toBeNull();
    expect(await row()).toMatchObject({
      provisioning_claim_id: 'm1',
      provisioning_attempts: 2,
    });
  });

  it('refuses a live foreign claim without touching claimed_at, and reports the remainder (AC-3)', async () => {
    await claimProvisioningLease(db, { orgId, claimId: 'm1' });
    await ageClaim(2);
    const before = await row();

    expect(
      await claimProvisioningLease(db, { orgId, claimId: 'm2' })
    ).toBeNull();
    const after = await row();
    expect(after.provisioning_claimed_at).toEqual(
      before.provisioning_claimed_at
    );
    expect(after.provisioning_attempts).toBe(before.provisioning_attempts);

    const state = await getProvisioningState(db, { orgId, claimId: 'm2' });
    expect(state?.live_foreign_claim).toBe(true);
    expect(state?.lease_remaining_seconds).toBeGreaterThan(1070);
    expect(state?.lease_remaining_seconds).toBeLessThanOrEqual(1080);
    expect(
      (await getProvisioningState(db, { orgId, claimId: 'm1' }))
        ?.live_foreign_claim
    ).toBe(false);
  });

  it("takes over a claim older than 20 minutes; the old holder's fenced writes then change nothing (AC-3, AC-4)", async () => {
    await claimProvisioningLease(db, { orgId, claimId: 'old' });
    await ageClaim(21);
    expect(
      await claimProvisioningLease(db, { orgId, claimId: 'new' })
    ).not.toBeNull();

    const write = {
      orgId,
      claimId: 'old',
      neonProjectId: 'p-old',
      encryptedConnectionString: 'enc',
      region: 'r',
    };
    expect(await recordTenantProject(db, write)).toBe(false);
    expect(await markTenantProjectReady(db, { orgId, claimId: 'old' })).toBe(
      false
    );
    expect(
      await recordProvisioningFailure(db, {
        orgId,
        claimId: 'old',
        error: 'x',
        final: true,
      })
    ).toBe(false);
    expect(await row()).toMatchObject({
      status: 'PROVISIONING',
      provisioning_claim_id: 'new',
      neon_project_id: '',
    });
  });

  it('treats a legacy claim with NULL claimed_at as expired (AC-11)', async () => {
    await setRow(
      `provisioning_claim_id = 'legacy-uuid', provisioning_claimed_at = NULL`
    );
    expect(
      await claimProvisioningLease(db, { orgId, claimId: 'm1' })
    ).not.toBeNull();
  });

  it('records the project once under the claim, then marks READY and clears the lease (AC-4, AC-6)', async () => {
    await claimProvisioningLease(db, { orgId, claimId: 'm1' });
    await ageClaim(10);
    const write = {
      orgId,
      claimId: 'm1',
      neonProjectId: 'p1',
      encryptedConnectionString: 'enc',
      region: 'aws-us-east-2',
    };
    expect(await recordTenantProject(db, write)).toBe(true);
    const recorded = await row();
    expect(recorded).toMatchObject({
      status: 'PROJECT_CREATED',
      neon_project_id: 'p1',
    });
    // The record refreshes the lease right before the migrate.
    expect(
      (await getProvisioningState(db, { orgId, claimId: 'x' }))
        ?.lease_remaining_seconds
    ).toBeGreaterThan(1190);
    // A recorded project is never replaced.
    expect(
      await recordTenantProject(db, { ...write, neonProjectId: 'p2' })
    ).toBe(false);

    expect(await markTenantProjectReady(db, { orgId, claimId: 'm1' })).toBe(
      true
    );
    expect(await row()).toMatchObject({
      status: 'READY',
      neon_project_id: 'p1',
      provisioning_claim_id: null,
      provisioning_claimed_at: null,
      provisioning_last_error: null,
    });
    expect(
      await claimProvisioningLease(db, { orgId, claimId: 'm2' })
    ).toBeNull();
  });

  it('refuses READY for a row with no project recorded', async () => {
    await claimProvisioningLease(db, { orgId, claimId: 'm1' });
    expect(await markTenantProjectReady(db, { orgId, claimId: 'm1' })).toBe(
      false
    );
  });

  it('moves FAILED back to PROVISIONING on claim, keeping the project fields (AC-6)', async () => {
    await setRow(
      `status = 'FAILED', neon_project_id = 'p1', connection_string = 'enc', region = 'r', provisioning_last_error = 'Error: boom'`
    );
    expect(
      await claimProvisioningLease(db, { orgId, claimId: 'm1' })
    ).toMatchObject({
      status: 'PROVISIONING',
      neon_project_id: 'p1',
      connection_string: 'enc',
      region: 'r',
    });
    expect((await row()).provisioning_last_error).toBe('Error: boom'); // a claim never clears it
  });

  it('records a failure and releases the claim in one statement; FAILED only when final (AC-7)', async () => {
    await claimProvisioningLease(db, { orgId, claimId: 'm1' });
    expect(
      await recordProvisioningFailure(db, {
        orgId,
        claimId: 'm1',
        error: 'Error: one',
        final: false,
      })
    ).toBe(true);
    expect(await row()).toMatchObject({
      status: 'PROVISIONING',
      provisioning_claim_id: null,
      provisioning_claimed_at: null,
      provisioning_last_error: 'Error: one',
    });

    await claimProvisioningLease(db, { orgId, claimId: 'm1' });
    expect(
      await recordProvisioningFailure(db, {
        orgId,
        claimId: 'm1',
        error: 'Error: five',
        final: true,
      })
    ).toBe(true);
    expect(await row()).toMatchObject({
      status: 'FAILED',
      provisioning_claim_id: null,
      provisioning_last_error: 'Error: five',
    });
  });

  it('dead letter: waits for a live lease, fails an expired one, and forces on the final delivery (AC-7)', async () => {
    await claimProvisioningLease(db, { orgId, claimId: 'm1' });
    expect(
      await failDeadLetteredTenantProject(db, { orgId, force: false })
    ).toBe(false);
    expect(
      (await getProvisioningState(db, { orgId, claimId: 'dlq-1' }))
        ?.live_foreign_claim
    ).toBe(true);

    await ageClaim(21);
    expect(
      await failDeadLetteredTenantProject(db, { orgId, force: false })
    ).toBe(true);
    expect(await row()).toMatchObject({
      status: 'FAILED',
      provisioning_claim_id: null,
      provisioning_last_error: 'dead lettered',
    });

    await setRow(
      `status = 'PROJECT_CREATED', provisioning_claim_id = 'm2', provisioning_claimed_at = now(), provisioning_last_error = 'Error: kept'`
    );
    expect(
      await failDeadLetteredTenantProject(db, { orgId, force: true })
    ).toBe(true);
    expect(await row()).toMatchObject({
      status: 'FAILED',
      provisioning_last_error: 'Error: kept',
    });
  });

  it('a runner held lease blocks the consumer until the runner marks READY (AC-10)', async () => {
    await setRow(
      `status = 'PROJECT_CREATED', neon_project_id = 'p1', provisioning_claim_id = $2, provisioning_claimed_at = now()`,
      [crypto.randomUUID()]
    );
    expect(
      await claimProvisioningLease(db, { orgId, claimId: 'queue-msg' })
    ).toBeNull();
  });

  it('ledgers an orphan once, keeping the first reason', async () => {
    const neonProjectId = `proj_${orgId}`;
    await insertNeonProjectOrphan(db, {
      neonProjectId,
      orgId,
      reason: 'DUPLICATE_NAME',
    });
    await insertNeonProjectOrphan(db, {
      neonProjectId,
      orgId,
      reason: 'NO_TENANT_ROW',
    });
    const rows =
      (await db`SELECT reason FROM neon_project_orphans WHERE neon_project_id = ${neonProjectId}`) as Array<{
        reason: string;
      }>;
    expect(rows).toEqual([{ reason: 'DUPLICATE_NAME' }]);
  });

  it('provision:retry eligibility reads the same lease (AC-8)', async () => {
    expect((await checkRetryEligibility(db, orgId)).eligible).toBe(true);
    await claimProvisioningLease(db, { orgId, claimId: 'm1' });
    expect((await checkRetryEligibility(db, orgId)).eligible).toBe(false);
    await ageClaim(21);
    expect((await checkRetryEligibility(db, orgId)).eligible).toBe(true);
    await db`DELETE FROM tenant_projects WHERE org_id = ${orgId}`;
    expect(await checkRetryEligibility(db, orgId)).toEqual({
      eligible: true,
      reason: 'org has no tenant_projects row yet',
    });
  });
});
