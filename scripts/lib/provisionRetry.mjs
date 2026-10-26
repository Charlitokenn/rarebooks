/**
 * `npm run provision:retry -- <orgId>` logic (spec 0010 AC-8), kept apart
 * from the CLI so tests can inject `sql` and `fetch`. Sends a fresh
 * `{ orgId }` to the provisioning queue over Cloudflare's Queues HTTP API.
 * The fresh message starts again at attempts = 1, by design.
 */
import { PROVISIONING_LEASE_SQL } from './provisioningLease.mjs';

/**
 * Eligible: a FAILED row, a PROVISIONING / PROJECT_CREATED row with no live
 * lease, or an org with no tenant row yet. Refused: READY, SUSPENDED, an
 * unknown org, or a live lease.
 *
 * @param {import('@neondatabase/serverless').NeonQueryFunction<false, false>} sql
 * @param {string} orgId
 * @returns {Promise<{ eligible: boolean, reason: string }>}
 */
export async function checkRetryEligibility(sql, orgId) {
  const rows = await sql`
    SELECT
      o.id AS org_id,
      t.status,
      COALESCE(
        t.provisioning_claim_id IS NOT NULL
        AND t.provisioning_claimed_at IS NOT NULL
        AND t.provisioning_claimed_at >= now() - ${sql.unsafe(
          PROVISIONING_LEASE_SQL
        )},
        false
      ) AS live_lease
    FROM organizations o
    LEFT JOIN tenant_projects t ON t.org_id = o.id
    WHERE o.id = ${orgId}
  `;
  const row = rows[0];

  if (!row) {
    return {
      eligible: false,
      reason: `unknown org ${orgId} (no organizations row)`,
    };
  }
  if (row.status === null || row.status === undefined) {
    return { eligible: true, reason: 'org has no tenant_projects row yet' };
  }
  if (row.status === 'READY' || row.status === 'SUSPENDED') {
    return {
      eligible: false,
      reason: `tenant is ${row.status}, nothing to retry`,
    };
  }
  if (row.live_lease) {
    return {
      eligible: false,
      reason: `tenant is ${row.status} with a live lease (provisioning in flight); wait up to 20 minutes`,
    };
  }
  return {
    eligible: true,
    reason: `tenant is ${row.status} with no live lease`,
  };
}

/**
 * POST /accounts/{account_id}/queues/{queue_id}/messages with `{ body }`.
 *
 * @param {{ fetch: typeof fetch, accountId: string, queueId: string, apiToken: string, orgId: string }} args
 */
export async function sendProvisioningMessage({
  fetch,
  accountId,
  queueId,
  apiToken,
  orgId,
}) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: { orgId } }),
    }
  );
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.success) {
    const codes = (payload?.errors ?? [])
      .map((e) => `${e.code} ${e.message}`)
      .join('; ');
    throw new Error(
      `Cloudflare Queues push failed: HTTP ${res.status}${
        codes ? ` (${codes})` : ''
      }`
    );
  }
}
