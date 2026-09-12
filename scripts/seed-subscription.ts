/**
 * One-off operator CLI for spec 0003 (AC-7): marks a dev or test org's
 * subscription ACTIVE and syncs its Clerk seat cap, so the subscription
 * gate, the /billing prompt, and Clerk's member cap are all demonstrable
 * while specs 0004 (PayPal) and 0005 (Lipa Namba) — the real writers of
 * subscription rows — build later.
 *
 *   npm run seed:subscription -- --org=org_abc123 --seats=3
 *   npm run seed:subscription -- --org=org_abc123 --dry-run
 *
 * Reads CONTROL_DATABASE_URL and CLERK_SECRET_KEY from the environment,
 * the root .env, or (for local runs) worker/.dev.vars — the same values as
 * the Worker secrets, never committed. Exit code is 1 on a missing flag,
 * a missing secret, a Clerk failure, or a failed control plane write.
 */
import dotenv from 'dotenv';
import { seedSubscription } from '../custom/web/billing/seedSubscription';

const USAGE = `Usage: npm run seed:subscription -- --org=<clerkOrgId> --seats=<n> [options]

Options:
  --org=<orgId>      the Clerk organization to seed (required)
  --seats=<n>        new Clerk member cap for the org (required unless
                     --dry-run); a positive integer
  --dry-run          show what would change, touch nothing (may omit --seats)
  --help             this message

Requires CONTROL_DATABASE_URL and CLERK_SECRET_KEY (env, root .env, or
worker/.dev.vars). Never commit those values; they are the same secrets as
the Worker's.`;

function argValue(prefix: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const orgId = argValue('--org=') ?? '';
  const seatsRaw = argValue('--seats=');
  const dryRun = argv.includes('--dry-run');

  let seats: number | undefined;
  if (seatsRaw != null) {
    seats = Number(seatsRaw);
    if (!Number.isInteger(seats) || seats < 1) {
      console.error('[seed-subscription] --seats= must be a positive integer');
      return 1;
    }
  }

  dotenv.config();
  if (!process.env.CONTROL_DATABASE_URL || !process.env.CLERK_SECRET_KEY) {
    // Local runs: wrangler dev's secret file fills whatever the env/root .env
    // did not set (dotenv never overwrites an existing value).
    dotenv.config({ path: 'worker/.dev.vars' });
  }

  try {
    await seedSubscription(
      {
        controlDatabaseUrl: process.env.CONTROL_DATABASE_URL ?? '',
        clerkSecretKey: process.env.CLERK_SECRET_KEY ?? '',
      },
      { orgId, seats, dryRun }
    );
    return 0;
  } catch (err) {
    console.error(
      `[seed-subscription] ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[seed-subscription] unexpected failure', err);
    process.exitCode = 1;
  });
