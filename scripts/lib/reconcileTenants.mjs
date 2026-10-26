/**
 * `npm run reconcile:tenants` logic (spec 0010 AC-9), kept apart from the
 * CLI so tests can inject `sql` and `fetch`. Neon is read over its REST API;
 * the control plane through `@neondatabase/serverless`. Deleting a Neon
 * project happens here and nowhere else, one ledgered project at a time.
 */
import {
  PROVISIONING_LEASE_SQL,
  TENANT_PROJECT_PREFIX,
} from './provisioningLease.mjs';

const NEON_API = 'https://console.neon.tech/api/v2';
const PAGE_LIMIT = 400;
export const MIN_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * @typedef {{ id: string, name: string, created_at: string }} NeonProject
 * @typedef {{ fetch: typeof fetch, apiKey: string }} NeonAccess
 */

/** @param {NeonAccess} neon @param {string} path @param {RequestInit} [init] */
function neonRequest(neon, path, init = {}) {
  return neon.fetch(`${NEON_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${neon.apiKey}`,
      Accept: 'application/json',
    },
  });
}

/**
 * Every project whose name starts with `rarebooks-tenant-`, across every
 * page (`search` is a substring match, so the prefix is checked here).
 *
 * @param {NeonAccess & { neonOrgId: string }} neon
 * @returns {Promise<NeonProject[]>}
 */
export async function listTenantNamedProjects(neon) {
  /** @type {NeonProject[]} */
  const all = [];
  let cursor;
  for (;;) {
    const params = new URLSearchParams({
      search: TENANT_PROJECT_PREFIX,
      limit: String(PAGE_LIMIT),
      org_id: neon.neonOrgId,
    });
    if (cursor) params.set('cursor', cursor);
    const res = await neonRequest(neon, `/projects?${params}`);
    if (!res.ok) {
      throw new Error(`Neon list projects failed: HTTP ${res.status}`);
    }
    const { projects = [], pagination } = await res.json();
    all.push(...projects);
    const next = pagination?.cursor;
    if (projects.length < PAGE_LIMIT || !next || next === cursor) break;
    cursor = next;
  }
  return all.filter((p) => p.name.startsWith(TENANT_PROJECT_PREFIX));
}

/**
 * The report: strays (ledgered as they're found), stuck rows, and FAILED
 * rows with their last error.
 *
 * @param {{ sql: any, projects: NeonProject[], now?: number }} args
 */
export async function reconcileTenants({ sql, projects, now = Date.now() }) {
  const tenantRows =
    await sql`SELECT org_id, neon_project_id FROM tenant_projects`;
  const referenced = new Set(
    tenantRows.map((r) => r.neon_project_id).filter(Boolean)
  );
  const orgsWithRow = new Set(tenantRows.map((r) => r.org_id));

  const strays = [];
  for (const project of projects) {
    if (referenced.has(project.id)) continue;
    if (now - Date.parse(project.created_at) < MIN_AGE_MS) continue; // may still be mid provisioning
    const orgId = project.name.slice(TENANT_PROJECT_PREFIX.length);
    const reason = orgsWithRow.has(orgId)
      ? 'MISMATCHED_TENANT_ROW'
      : 'NO_TENANT_ROW';
    await sql`
      INSERT INTO neon_project_orphans (neon_project_id, org_id, reason)
      VALUES (${project.id}, ${orgId}, ${reason})
      ON CONFLICT (neon_project_id) DO NOTHING
    `;
    strays.push({
      neonProjectId: project.id,
      orgId,
      reason,
      createdAt: project.created_at,
    });
  }

  const stuck = await sql`
    SELECT org_id, status, provisioning_attempts, created_at
    FROM tenant_projects
    WHERE status IN ('PROVISIONING', 'PROJECT_CREATED')
      AND created_at <= now() - interval '1 hour'
      AND NOT COALESCE(
        provisioning_claim_id IS NOT NULL
        AND provisioning_claimed_at IS NOT NULL
        AND provisioning_claimed_at >= now() - ${sql.unsafe(
          PROVISIONING_LEASE_SQL
        )},
        false
      )
    ORDER BY created_at
  `;
  const orgsWithoutRow = await sql`
    SELECT o.id AS org_id, o.created_at
    FROM organizations o
    LEFT JOIN tenant_projects t ON t.org_id = o.id
    WHERE t.org_id IS NULL AND o.created_at <= now() - interval '1 hour'
    ORDER BY o.created_at
  `;
  const failed = await sql`
    SELECT org_id, provisioning_attempts, provisioning_last_error
    FROM tenant_projects
    WHERE status = 'FAILED'
    ORDER BY created_at
  `;
  const ledger = await sql`
    SELECT neon_project_id, org_id, reason, detected_at
    FROM neon_project_orphans
    WHERE deleted_at IS NULL
    ORDER BY detected_at
  `;

  return { strays, stuck, orgsWithoutRow, failed, ledger };
}

/**
 * `--delete <neonProjectId>`. Outcomes: `deleted`, `already_deleted` (a no
 * op), or `refused` (not ledgered, still referenced, or too young).
 *
 * @param {{ sql: any, neon: NeonAccess, projectId: string, now?: number }} args
 * @returns {Promise<{ outcome: 'deleted' | 'already_deleted' | 'refused', message: string }>}
 */
export async function deleteOrphanProject({
  sql,
  neon,
  projectId,
  now = Date.now(),
}) {
  const [entry] = await sql`
    SELECT deleted_at FROM neon_project_orphans WHERE neon_project_id = ${projectId}
  `;
  if (!entry) {
    return {
      outcome: 'refused',
      message: `${projectId} is not in neon_project_orphans; run the report first`,
    };
  }
  if (entry.deleted_at) {
    return {
      outcome: 'already_deleted',
      message: `${projectId} was already deleted at ${entry.deleted_at}`,
    };
  }

  // Check again right before deleting: a tenant row may point at it now.
  const referencing = await sql`
    SELECT org_id FROM tenant_projects WHERE neon_project_id = ${projectId}
  `;
  if (referencing.length > 0) {
    return {
      outcome: 'refused',
      message: `${projectId} is referenced by tenant_projects (org ${referencing[0].org_id}); not deleting`,
    };
  }

  const getRes = await neonRequest(neon, `/projects/${projectId}`);
  if (getRes.status !== 404) {
    if (!getRes.ok) {
      throw new Error(`Neon get project failed: HTTP ${getRes.status}`);
    }
    const { project } = await getRes.json();
    if (now - Date.parse(project.created_at) < MIN_AGE_MS) {
      return {
        outcome: 'refused',
        message: `${projectId} is less than 1 hour old; not deleting`,
      };
    }
    const delRes = await neonRequest(neon, `/projects/${projectId}`, {
      method: 'DELETE',
    });
    if (!delRes.ok && delRes.status !== 404) {
      throw new Error(`Neon delete project failed: HTTP ${delRes.status}`);
    }
  }

  // A Neon 404 counts as deleted.
  await sql`
    UPDATE neon_project_orphans SET deleted_at = now()
    WHERE neon_project_id = ${projectId} AND deleted_at IS NULL
  `;
  return { outcome: 'deleted', message: `${projectId} deleted and stamped` };
}
