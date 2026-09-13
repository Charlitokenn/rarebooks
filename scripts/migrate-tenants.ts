/**
 * One-off CLI for the spec 0002 (AC-5) tenant migration runner. Run by hand
 * when a doctype schema change needs to reach every tenant project:
 *
 *   npm run migrate:tenants -- --dry-run                  # list what would migrate
 *   npm run migrate:tenants --                            # migrate all READY tenants
 *   npm run migrate:tenants -- --org=org_abc123           # one tenant (staged canary)
 *   npm run migrate:tenants -- --include-project-created  # also recover stranded ones
 *
 * Reads CONTROL_DATABASE_URL and TENANT_ENCRYPTION_KEY from the environment,
 * the root .env, or (for local runs) worker/.dev.vars — the same values as
 * the Worker secrets, never committed. Exit code is 1 if any tenant failed,
 * so shell callers and CI wrappers can gate on it.
 */
import dotenv from 'dotenv';
import { runTenantMigrations } from '../custom/web/db/tenantMigrationRunner';

const USAGE = `Usage: npm run migrate:tenants -- [options]

Options:
  --org=<orgId>                only this tenant (default: every eligible tenant)
  --include-project-created    also migrate PROJECT_CREATED tenants (recovery
                               path for provisioning webhook deaths; advances
                               them to READY on success)
  --dry-run                    list what would migrate, change nothing
  --help                       this message

Requires CONTROL_DATABASE_URL and TENANT_ENCRYPTION_KEY (env, root .env, or
worker/.dev.vars). Never commit those values; they are the same secrets as
the Worker's.`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const orgArg = argv.find((arg) => arg.startsWith('--org='));
  const orgId = orgArg ? orgArg.slice('--org='.length).trim() : undefined;
  if (orgArg && !orgId) {
    console.error('[migrate-tenants] --org= needs a value; see --help');
    return 1;
  }
  const dryRun = argv.includes('--dry-run');

  dotenv.config();
  if (!process.env.CONTROL_DATABASE_URL || !process.env.TENANT_ENCRYPTION_KEY) {
    // Local runs: wrangler dev's secret file fills whatever the env/root .env
    // did not set (dotenv never overwrites an existing value).
    dotenv.config({ path: 'worker/.dev.vars' });
  }
  try {
    const summary = await runTenantMigrations(
      {
        controlDatabaseUrl: process.env.CONTROL_DATABASE_URL ?? '',
        tenantEncryptionKey: process.env.TENANT_ENCRYPTION_KEY ?? '',
      },
      {
        orgId,
        includeProjectCreated: argv.includes('--include-project-created'),
        dryRun,
      }
    );

    console.log(
      `[migrate-tenants] scanned ${summary.scanned}, ${
        dryRun ? 'would migrate' : 'migrated'
      } ${dryRun ? summary.wouldMigrate : summary.migrated}, skipped ${
        summary.skipped.length
      }, failed ${summary.failed.length}`
    );
    for (const failure of summary.failed) {
      console.error(`[migrate-tenants] ${failure.orgId}: ${failure.error}`);
    }
    return summary.failed.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(
      `[migrate-tenants] ${err instanceof Error ? err.message : String(err)}`,
      (err as any)?.sourceError,
      (err as any)?.sourceError?.cause
    );
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[migrate-tenants] unexpected failure', err);
    process.exitCode = 1;
  });
