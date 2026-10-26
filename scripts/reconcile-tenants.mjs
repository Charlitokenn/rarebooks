/**
 * Find and clean up stray tenant Neon projects (spec 0010 AC-9):
 *
 *   npm run reconcile:tenants                       # report (and ledger strays)
 *   npm run reconcile:tenants -- --delete <projId>  # delete ONE ledgered project
 *
 * The report lists every `rarebooks-tenant-*` project at least 1 hour old
 * that no tenant_projects row points at (and records it in
 * neon_project_orphans), stuck rows with no live lease, orgs with no tenant
 * row, FAILED rows with their last error, and the undeleted ledger. Review
 * the ledger before any --delete; deletion is one project per run, by hand.
 *
 * Needs CONTROL_DATABASE_URL, NEON_API_KEY, NEON_ACCOUNT_ORG_ID (env, root
 * .env, or worker/.dev.vars). Exit 1 if --delete is refused or fails.
 */
import { neon } from '@neondatabase/serverless';
import { loadOperatorEnv } from './lib/loadOperatorEnv.mjs';
import {
  deleteOrphanProject,
  listTenantNamedProjects,
  reconcileTenants,
} from './lib/reconcileTenants.mjs';

const USAGE = 'Usage: npm run reconcile:tenants [-- --delete <neonProjectId>]';

function section(title, rows, format) {
  console.log(`\n${title} (${rows.length})`);
  for (const row of rows) console.log(`  ${format(row)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const deleteIndex = argv.indexOf('--delete');
  const deleteId = deleteIndex >= 0 ? argv[deleteIndex + 1] : undefined;
  if (deleteIndex >= 0 && (!deleteId || deleteId.startsWith('-'))) {
    console.error(USAGE);
    return 1;
  }

  const env = loadOperatorEnv([
    'CONTROL_DATABASE_URL',
    'NEON_API_KEY',
    'NEON_ACCOUNT_ORG_ID',
  ]);
  const sql = neon(env.CONTROL_DATABASE_URL);
  const neonAccess = {
    fetch,
    apiKey: env.NEON_API_KEY,
    neonOrgId: env.NEON_ACCOUNT_ORG_ID,
  };

  if (deleteId) {
    const { outcome, message } = await deleteOrphanProject({
      sql,
      neon: neonAccess,
      projectId: deleteId,
    });
    (outcome === 'refused' ? console.error : console.log)(
      `[reconcile-tenants] ${outcome}: ${message}`
    );
    return outcome === 'refused' ? 1 : 0;
  }

  const projects = await listTenantNamedProjects(neonAccess);
  const report = await reconcileTenants({ sql, projects });

  console.log(
    `[reconcile-tenants] scanned ${projects.length} rarebooks-tenant-* projects`
  );
  section(
    'Stray projects, ledgered',
    report.strays,
    (s) =>
      `${s.neonProjectId}  ${s.reason}  org ${s.orgId}  created ${s.createdAt}`
  );
  section(
    'Stuck rows, no live lease (npm run provision:retry -- <orgId>)',
    report.stuck,
    (r) =>
      `${r.org_id}  ${r.status}  attempts ${r.provisioning_attempts}  since ${r.created_at}`
  );
  section(
    'Orgs with no tenant row (npm run provision:retry -- <orgId>)',
    report.orgsWithoutRow,
    (r) => `${r.org_id}  since ${r.created_at}`
  );
  section(
    'FAILED rows',
    report.failed,
    (r) =>
      `${r.org_id}  attempts ${r.provisioning_attempts}  ${
        r.provisioning_last_error ?? '(no error recorded)'
      }`
  );
  section(
    'Undeleted ledger (review before --delete)',
    report.ledger,
    (r) =>
      `${r.neon_project_id}  ${r.reason}  org ${r.org_id ?? '?'}  detected ${
        r.detected_at
      }`
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(
      `[reconcile-tenants] ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  });
