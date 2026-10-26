/**
 * Retry one org's tenant provisioning (spec 0010 AC-8):
 *
 *   npm run provision:retry -- <orgId>
 *
 * Sends a fresh `{ orgId }` to the provisioning queue when the org is
 * FAILED, stuck PROVISIONING / PROJECT_CREATED with no live lease, or has no
 * tenant row at all. Refuses READY, SUSPENDED, an unknown org, or a live
 * lease, and says which. Run locally only, never over HTTP.
 *
 * Needs CONTROL_DATABASE_URL, CLOUDFLARE_API_TOKEN (Queues write on this
 * account only; never a Worker secret), CLOUDFLARE_ACCOUNT_ID, and
 * CLOUDFLARE_PROVISIONING_QUEUE_ID (the queue's id for the env you target,
 * from `wrangler queues info <name>`). Exit 1 on a refusal or HTTP error.
 */
import { neon } from '@neondatabase/serverless';
import { loadOperatorEnv } from './lib/loadOperatorEnv.mjs';
import {
  checkRetryEligibility,
  sendProvisioningMessage,
} from './lib/provisionRetry.mjs';

const USAGE = 'Usage: npm run provision:retry -- <orgId>';

async function main() {
  const orgId = process.argv[2]?.trim();
  if (!orgId || orgId.startsWith('-')) {
    console.error(USAGE);
    return 1;
  }

  const env = loadOperatorEnv([
    'CONTROL_DATABASE_URL',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_PROVISIONING_QUEUE_ID',
  ]);

  const { eligible, reason } = await checkRetryEligibility(
    neon(env.CONTROL_DATABASE_URL),
    orgId
  );
  if (!eligible) {
    console.error(`[provision-retry] refused: ${reason}`);
    return 1;
  }

  await sendProvisioningMessage({
    fetch,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    queueId: env.CLOUDFLARE_PROVISIONING_QUEUE_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    orgId,
  });
  console.log(`[provision-retry] sent { orgId: ${orgId} } (${reason})`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(
      `[provision-retry] ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  });
