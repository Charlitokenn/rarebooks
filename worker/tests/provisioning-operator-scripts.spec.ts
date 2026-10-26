/**
 * `npm run provision:retry` and `npm run reconcile:tenants` logic
 * (scripts/lib/*.mjs) with the control plane and the Cloudflare / Neon HTTP
 * APIs faked at the boundary. The CLIs themselves are thin wrappers.
 *
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md (AC-8, AC-9)
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM operator script, no type declarations
import * as provisionRetry from '../../scripts/lib/provisionRetry.mjs';
// @ts-expect-error plain ESM operator script, no type declarations
import * as reconcile from '../../scripts/lib/reconcileTenants.mjs';

const { checkRetryEligibility, sendProvisioningMessage } = provisionRetry;
const { deleteOrphanProject, listTenantNamedProjects, reconcileTenants } =
  reconcile;

type Rows = Record<string, unknown>[];

/** A tagged template `sql` that answers by the first query keyword it matches. */
function fakeSql(
  answers: Array<[RegExp, Rows | ((values: unknown[]) => Rows)]>
) {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      calls.push({ text, values });
      const match = answers.find(([pattern]) => pattern.test(text));
      if (!match) throw new Error(`unexpected query: ${text}`);
      return typeof match[1] === 'function' ? match[1](values) : match[1];
    },
    { unsafe: (raw: string) => raw }
  );
  return { sql, calls };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const NOW = Date.parse('2026-10-26T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

describe('provision:retry eligibility (AC-8)', () => {
  const check = (row: Record<string, unknown> | undefined) =>
    checkRetryEligibility(
      fakeSql([[/FROM organizations/, row ? [row] : []]]).sql,
      'org_1'
    );

  it('sends for FAILED, for stuck rows with no live lease, and for an org with no tenant row', async () => {
    expect(
      await check({ org_id: 'org_1', status: 'FAILED', live_lease: false })
    ).toMatchObject({ eligible: true });
    expect(
      await check({
        org_id: 'org_1',
        status: 'PROVISIONING',
        live_lease: false,
      })
    ).toMatchObject({ eligible: true });
    expect(
      await check({
        org_id: 'org_1',
        status: 'PROJECT_CREATED',
        live_lease: false,
      })
    ).toMatchObject({ eligible: true });
    expect(
      await check({ org_id: 'org_1', status: null, live_lease: false })
    ).toEqual({
      eligible: true,
      reason: 'org has no tenant_projects row yet',
    });
  });

  it('refuses READY, SUSPENDED, an unknown org, and a live lease, and says which', async () => {
    expect(
      await check({ org_id: 'org_1', status: 'READY', live_lease: false })
    ).toEqual({
      eligible: false,
      reason: 'tenant is READY, nothing to retry',
    });
    expect(
      (await check({ org_id: 'org_1', status: 'SUSPENDED', live_lease: false }))
        .eligible
    ).toBe(false);
    expect(await check(undefined)).toEqual({
      eligible: false,
      reason: 'unknown org org_1 (no organizations row)',
    });
    const live = await check({
      org_id: 'org_1',
      status: 'PROVISIONING',
      live_lease: true,
    });
    expect(live.eligible).toBe(false);
    expect(live.reason).toMatch(/live lease/);
  });

  it('uses the shared lease definition in its query', async () => {
    const { sql, calls } = fakeSql([[/FROM organizations/, []]]);
    await checkRetryEligibility(sql, 'org_1');
    expect(calls[0].values).toContain("interval '20 minutes'");
  });

  it('pushes { body: { orgId } } to the Cloudflare Queues HTTP API, and throws on an error', async () => {
    const fetch = vi.fn(async () => json(200, { success: true }));
    await sendProvisioningMessage({
      fetch,
      accountId: 'acc',
      queueId: 'q1',
      apiToken: 'tok',
      orgId: 'org_1',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/acc/queues/q1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: { orgId: 'org_1' } }),
      })
    );

    const denied = vi.fn(async () =>
      json(403, {
        success: false,
        errors: [{ code: 10106, message: 'Unauthorized' }],
      })
    );
    await expect(
      sendProvisioningMessage({
        fetch: denied,
        accountId: 'acc',
        queueId: 'q1',
        apiToken: 'bad',
        orgId: 'org_1',
      })
    ).rejects.toThrow('HTTP 403 (10106 Unauthorized)');
  });
});

describe('reconcile:tenants report (AC-9)', () => {
  it('lists every page and keeps only the rarebooks-tenant- prefix', async () => {
    const page1 = Array.from({ length: 400 }, (_, i) => ({
      id: `p${i}`,
      name: `rarebooks-tenant-org_${i}`,
      created_at: hoursAgo(2),
    }));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, { projects: page1, pagination: { cursor: 'c1' } })
      )
      .mockResolvedValueOnce(
        json(200, {
          projects: [
            {
              id: 'last',
              name: 'rarebooks-tenant-org_last',
              created_at: hoursAgo(2),
            },
            {
              id: 'other',
              name: 'my-rarebooks-tenant-thing',
              created_at: hoursAgo(2),
            },
          ],
          pagination: { cursor: 'c2' },
        })
      );
    const projects = await listTenantNamedProjects({
      fetch,
      apiKey: 'k',
      neonOrgId: 'neon-org',
    });
    expect(projects).toHaveLength(401);
    expect(fetch.mock.calls[1][0]).toContain('cursor=c1');
    expect(fetch.mock.calls[0][0]).toContain('org_id=neon-org');
  });

  it('ledgers a 2 hour old stray, ignores a 10 minute old one and referenced projects', async () => {
    const inserted: unknown[][] = [];
    const { sql } = fakeSql([
      [
        /^SELECT org_id, neon_project_id FROM tenant_projects/,
        [
          { org_id: 'org_ok', neon_project_id: 'proj-ok' },
          { org_id: 'org_mismatch', neon_project_id: 'proj-current' },
        ],
      ],
      [
        /^INSERT INTO neon_project_orphans/,
        (values) => (inserted.push(values), []),
      ],
      [
        /status IN \('PROVISIONING', 'PROJECT_CREATED'\)/,
        [{ org_id: 'org_stuck', status: 'PROVISIONING' }],
      ],
      [/LEFT JOIN tenant_projects/, []],
      [
        /status = 'FAILED'/,
        [{ org_id: 'org_failed', provisioning_last_error: 'Error: boom' }],
      ],
      [/FROM neon_project_orphans/, []],
    ]);

    const report = await reconcileTenants({
      sql,
      now: NOW,
      projects: [
        {
          id: 'proj-ok',
          name: 'rarebooks-tenant-org_ok',
          created_at: hoursAgo(5),
        },
        {
          id: 'proj-stray',
          name: 'rarebooks-tenant-org_gone',
          created_at: hoursAgo(2),
        },
        {
          id: 'proj-old',
          name: 'rarebooks-tenant-org_mismatch',
          created_at: hoursAgo(3),
        },
        {
          id: 'proj-young',
          name: 'rarebooks-tenant-org_new',
          created_at: new Date(NOW - 10 * 60_000).toISOString(),
        },
      ],
    });

    expect(inserted).toEqual([
      ['proj-stray', 'org_gone', 'NO_TENANT_ROW'],
      ['proj-old', 'org_mismatch', 'MISMATCHED_TENANT_ROW'],
    ]);
    expect(
      report.strays.map((s: { neonProjectId: string }) => s.neonProjectId)
    ).toEqual(['proj-stray', 'proj-old']);
    expect(report.stuck).toEqual([
      { org_id: 'org_stuck', status: 'PROVISIONING' },
    ]);
    expect(report.failed[0].provisioning_last_error).toBe('Error: boom');
  });
});

describe('reconcile:tenants --delete (AC-9)', () => {
  const neonFetch = (...responses: Response[]) => {
    const fetch = vi.fn();
    for (const r of responses) fetch.mockResolvedValueOnce(r);
    return fetch;
  };

  function sqlFor({
    ledger,
    referencedBy,
  }: {
    ledger?: Rows;
    referencedBy?: Rows;
  }) {
    const stamped: unknown[][] = [];
    const fake = fakeSql([
      [/^SELECT deleted_at FROM neon_project_orphans/, ledger ?? []],
      [/^SELECT org_id FROM tenant_projects/, referencedBy ?? []],
      [
        /^UPDATE neon_project_orphans SET deleted_at/,
        (values) => (stamped.push(values), []),
      ],
    ]);
    return { ...fake, stamped };
  }

  it('deletes a ledgered, unreferenced, old project and stamps deleted_at', async () => {
    const { sql, stamped } = sqlFor({ ledger: [{ deleted_at: null }] });
    const fetch = neonFetch(
      json(200, { project: { id: 'p1', created_at: hoursAgo(2) } }),
      json(200, {})
    );
    const result = await deleteOrphanProject({
      sql,
      neon: { fetch, apiKey: 'k' },
      projectId: 'p1',
      now: NOW,
    });
    expect(result.outcome).toBe('deleted');
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
    expect(stamped).toEqual([['p1']]);
  });

  it('refuses a referenced id without calling Neon', async () => {
    const { sql, stamped } = sqlFor({
      ledger: [{ deleted_at: null }],
      referencedBy: [{ org_id: 'org_1' }],
    });
    const fetch = vi.fn();
    const result = await deleteOrphanProject({
      sql,
      neon: { fetch, apiKey: 'k' },
      projectId: 'p1',
      now: NOW,
    });
    expect(result.outcome).toBe('refused');
    expect(result.message).toMatch(
      /referenced by tenant_projects \(org org_1\)/
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(stamped).toEqual([]);
  });

  it('refuses an id that is not ledgered, and one less than 1 hour old', async () => {
    const notLedgered = await deleteOrphanProject({
      sql: sqlFor({}).sql,
      neon: { fetch: vi.fn(), apiKey: 'k' },
      projectId: 'p1',
      now: NOW,
    });
    expect(notLedgered.outcome).toBe('refused');

    const fetch = neonFetch(
      json(200, { project: { id: 'p1', created_at: hoursAgo(0.5) } })
    );
    const young = await deleteOrphanProject({
      sql: sqlFor({ ledger: [{ deleted_at: null }] }).sql,
      neon: { fetch, apiKey: 'k' },
      projectId: 'p1',
      now: NOW,
    });
    expect(young.outcome).toBe('refused');
    expect(fetch).toHaveBeenCalledOnce(); // never reached DELETE
  });

  it('treats a Neon 404 as deleted', async () => {
    const { sql, stamped } = sqlFor({ ledger: [{ deleted_at: null }] });
    const fetch = neonFetch(json(404, { message: 'not found' }));
    const result = await deleteOrphanProject({
      sql,
      neon: { fetch, apiKey: 'k' },
      projectId: 'p1',
      now: NOW,
    });
    expect(result.outcome).toBe('deleted');
    expect(stamped).toEqual([['p1']]);
  });

  it('is a no op that says so for an id already stamped', async () => {
    const fetch = vi.fn();
    const result = await deleteOrphanProject({
      sql: sqlFor({ ledger: [{ deleted_at: '2026-10-25T00:00:00Z' }] }).sql,
      neon: { fetch, apiKey: 'k' },
      projectId: 'p1',
      now: NOW,
    });
    expect(result).toEqual({
      outcome: 'already_deleted',
      message: 'p1 was already deleted at 2026-10-25T00:00:00Z',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
