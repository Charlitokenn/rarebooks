/**
 * The provisioning queue consumer and its dead letter backstop, run against
 * an in memory control plane that applies the same lease rules as the SQL in
 * worker/db/control.ts (20 minute lease, own claim resumes, NULL claimed_at
 * is expired, every post claim write fenced by claim id), with a clock the
 * test moves. Neon is an in memory project list; encryption is real.
 * provisioning-sql.spec.ts runs the real statements against Postgres.
 *
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md
 * (critical test scenarios; AC-2 to AC-7, AC-11, AC-12)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleDeadLetteredProvisioning,
  provisionTenant,
  ProvisioningNotReadyError,
  sanitizeError,
  type NeonProvisioningClient,
  type ProvisioningMessage,
} from '../../custom/web/auth/handleOrganizationCreated';
import { decrypt, encrypt } from '../lib/encryption';
import { isDeadLetterQueue, queue } from '../queues/provisioning';

const plane = vi.hoisted(() => {
  const LEASE_MS = 20 * 60 * 1000;
  type Status =
    | 'PROVISIONING'
    | 'PROJECT_CREATED'
    | 'READY'
    | 'SUSPENDED'
    | 'FAILED';
  interface Row {
    status: Status;
    neon_project_id: string;
    connection_string: string;
    region: string;
    claim: string | null;
    claimedAt: number | null;
    attempts: number;
    lastError: string | null;
  }
  const state = {
    now: Date.parse('2026-10-26T10:00:00Z'),
    orgs: new Set<string>(),
    rows: new Map<string, Row>(),
    orphans: new Map<string, { orgId: string | null; reason: string }>(),
    failureWriteThrows: false,
    readyWriteThrowsOnce: false,
  };
  const live = (row: Row) =>
    row.claim !== null &&
    row.claimedAt !== null &&
    row.claimedAt >= state.now - LEASE_MS;
  const claimable = (row: Row, claimId: string) =>
    row.claim === null ||
    row.claim === claimId ||
    row.claimedAt === null ||
    row.claimedAt < state.now - LEASE_MS;

  const module = {
    PROVISIONING_LEASE_SQL: "interval '20 minutes'",
    getControlDb: () => ({}),
    async ensureTenantProjectRow(_db: unknown, orgId: string) {
      if (!state.orgs.has(orgId))
        throw new Error('violates foreign key constraint');
      if (!state.rows.has(orgId)) {
        state.rows.set(orgId, {
          status: 'PROVISIONING',
          neon_project_id: '',
          connection_string: '',
          region: '',
          claim: null,
          claimedAt: null,
          attempts: 0,
          lastError: null,
        });
      }
    },
    async claimProvisioningLease(
      _db: unknown,
      c: { orgId: string; claimId: string }
    ) {
      const row = state.rows.get(c.orgId);
      if (
        !row ||
        !['PROVISIONING', 'PROJECT_CREATED', 'FAILED'].includes(row.status) ||
        !claimable(row, c.claimId)
      ) {
        return null;
      }
      row.claim = c.claimId;
      row.claimedAt = state.now;
      row.attempts += 1;
      if (row.status === 'FAILED') row.status = 'PROVISIONING';
      const { status, neon_project_id, connection_string, region } = row;
      return { status, neon_project_id, connection_string, region };
    },
    async getProvisioningState(
      _db: unknown,
      c: { orgId: string; claimId: string }
    ) {
      const row = state.rows.get(c.orgId);
      if (!row) return null;
      return {
        status: row.status,
        live_foreign_claim: live(row) && row.claim !== c.claimId,
        lease_remaining_seconds:
          row.claimedAt === null
            ? null
            : Math.ceil((row.claimedAt + LEASE_MS - state.now) / 1000),
      };
    },
    async recordTenantProject(
      _db: unknown,
      r: {
        orgId: string;
        claimId: string;
        neonProjectId: string;
        encryptedConnectionString: string;
        region: string;
      }
    ) {
      const row = state.rows.get(r.orgId);
      if (
        !row ||
        row.claim !== r.claimId ||
        row.status !== 'PROVISIONING' ||
        row.neon_project_id !== ''
      ) {
        return false;
      }
      row.neon_project_id = r.neonProjectId;
      row.connection_string = r.encryptedConnectionString;
      row.region = r.region;
      row.status = 'PROJECT_CREATED';
      row.claimedAt = state.now;
      return true;
    },
    async markTenantProjectReady(
      _db: unknown,
      c: { orgId: string; claimId: string }
    ) {
      if (state.readyWriteThrowsOnce) {
        state.readyWriteThrowsOnce = false;
        throw new Error('transient READY write failure');
      }
      const row = state.rows.get(c.orgId);
      if (
        !row ||
        row.claim !== c.claimId ||
        !['PROVISIONING', 'PROJECT_CREATED'].includes(row.status) ||
        row.neon_project_id === ''
      ) {
        return false;
      }
      Object.assign(row, {
        status: 'READY',
        claim: null,
        claimedAt: null,
        lastError: null,
      });
      return true;
    },
    async recordProvisioningFailure(
      _db: unknown,
      f: { orgId: string; claimId: string; error: string; final: boolean }
    ) {
      if (state.failureWriteThrows)
        throw new Error('control plane unreachable');
      const row = state.rows.get(f.orgId);
      if (!row || row.claim !== f.claimId) return false;
      Object.assign(row, { lastError: f.error, claim: null, claimedAt: null });
      if (f.final) row.status = 'FAILED';
      return true;
    },
    async failDeadLetteredTenantProject(
      _db: unknown,
      r: { orgId: string; force: boolean }
    ) {
      const row = state.rows.get(r.orgId);
      if (
        !row ||
        !['PROVISIONING', 'PROJECT_CREATED'].includes(row.status) ||
        (!r.force && live(row))
      ) {
        return false;
      }
      Object.assign(row, {
        status: 'FAILED',
        claim: null,
        claimedAt: null,
        lastError: row.lastError ?? 'dead lettered',
      });
      return true;
    },
    async insertNeonProjectOrphan(
      _db: unknown,
      o: { neonProjectId: string; orgId: string | null; reason: string }
    ) {
      if (!state.orphans.has(o.neonProjectId)) {
        state.orphans.set(o.neonProjectId, {
          orgId: o.orgId,
          reason: o.reason,
        });
      }
    },
  };

  const reset = () => {
    state.now = Date.parse('2026-10-26T10:00:00Z');
    state.orgs.clear();
    state.rows.clear();
    state.orphans.clear();
    state.failureWriteThrows = false;
    state.readyWriteThrowsOnce = false;
  };
  const minutes = (n: number) => n * 60 * 1000;
  return { state, module, reset, minutes };
});

vi.mock('../db/control', () => plane.module);
vi.mock('../../custom/web/auth/applyTenantSchema', () => ({
  applyTenantSchema: vi.fn(),
}));
const neonForQueue = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/neon-client', () => ({
  createNeonProvisioningClient: () => neonForQueue.client,
}));

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const ORG = 'org_2abcDEF';
const NAME = `rarebooks-tenant-${ORG}`;
const { state } = plane;

interface FakeNeonProject {
  id: string;
  name: string;
  createdAt: string;
  region: string;
  databases: number;
}

function fakeNeon(projects: FakeNeonProject[] = []) {
  let created = 0;
  const client = {
    projects,
    createAndConnect: vi.fn(async ({ name }: { name: string }) => {
      created += 1;
      const id = `proj-created-${created}`;
      projects.push({
        id,
        name,
        createdAt: new Date(state.now).toISOString(),
        region: 'aws-us-east-2',
        databases: 1,
      });
      return {
        neonProjectId: id,
        connectionString: `postgres://owner:secret-${id}@host/neondb`,
        region: 'aws-us-east-2',
      };
    }),
    findProjectsByName: vi.fn(async (name: string) =>
      projects
        .filter((p) => p.name === name)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map(({ id, createdAt, region }) => ({ id, createdAt, region }))
    ),
    getConnectionString: vi.fn(async (projectId: string) => {
      const project = projects.find((p) => p.id === projectId)!;
      if (project.databases !== 1) {
        throw new ProvisioningNotReadyError(
          `project ${projectId} has ${project.databases} databases, expected exactly 1`
        );
      }
      return `postgres://owner:secret-${projectId}@host/neondb`;
    }),
  };
  return client satisfies NeonProvisioningClient;
}

function message(id: string, attempts = 1) {
  return {
    id,
    attempts,
    ack: vi.fn<ProvisioningMessage['ack']>(),
    retry: vi.fn<ProvisioningMessage['retry']>(),
  };
}

const row = () => state.rows.get(ORG)!;
const logLines: string[] = [];
const events = () => logLines.map((line) => JSON.parse(line));

function seedRow(fields: Partial<ReturnType<typeof row>>) {
  state.orgs.add(ORG);
  state.rows.set(ORG, {
    status: 'PROVISIONING',
    neon_project_id: '',
    connection_string: '',
    region: '',
    claim: null,
    claimedAt: null,
    attempts: 0,
    lastError: null,
    ...fields,
  });
}

beforeEach(() => {
  plane.reset();
  logLines.length = 0;
  vi.spyOn(console, 'log').mockImplementation(
    (line: string) => void logLines.push(line)
  );
  vi.spyOn(console, 'error').mockImplementation(
    (line: string) => void logLines.push(line)
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  // AC-12: no log line ever carries a connection string or secret.
  for (const line of logLines) {
    expect(line).not.toMatch(/postgres(ql)?:\/\//);
    expect(line).not.toContain('secret');
    expect(line).not.toContain(KEY);
  }
});

describe('provisionTenant', () => {
  it('happy path: creates, records PROJECT_CREATED, migrates, ends READY (AC-2)', async () => {
    state.orgs.add(ORG);
    const neon = fakeNeon();
    const statusesDuringMigrate: string[] = [];
    const applySchema = vi.fn(async () => {
      statusesDuringMigrate.push(row().status);
    });
    const msg = message('msg-1');

    await provisionTenant(ORG, msg, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema,
    });

    expect(neon.createAndConnect).toHaveBeenCalledWith({ name: NAME });
    expect(neon.projects).toHaveLength(1);
    expect(statusesDuringMigrate).toEqual(['PROJECT_CREATED']);
    expect(applySchema).toHaveBeenCalledWith(
      'postgres://owner:secret-proj-created-1@host/neondb'
    );
    expect(row()).toMatchObject({
      status: 'READY',
      neon_project_id: 'proj-created-1',
      region: 'aws-us-east-2',
      claim: null,
      claimedAt: null,
      lastError: null,
      attempts: 1,
    });
    expect(row().connection_string).not.toContain('secret');
    expect(await decrypt(row().connection_string, KEY)).toBe(
      'postgres://owner:secret-proj-created-1@host/neondb'
    );
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(events()).toEqual([
      { event: 'provisioning.ready', orgId: ORG, attempt: 1 },
    ]);
  });

  it('throws before any Neon call when the org row is missing, so the delivery retries', async () => {
    const neon = fakeNeon();
    const msg = message('msg-1');
    await expect(
      provisionTenant(ORG, msg, {
        controlDb: {} as never,
        neon,
        encryptionKey: KEY,
        applySchema: vi.fn(),
      })
    ).rejects.toThrow(/foreign key/);
    expect(neon.findProjectsByName).not.toHaveBeenCalled();
    expect(neon.createAndConnect).not.toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it.each(['READY', 'SUSPENDED'] as const)(
    'acks a %s org without touching it',
    async (status) => {
      seedRow({ status, neon_project_id: 'proj-1' });
      const neon = fakeNeon();
      const msg = message('msg-dup');
      await provisionTenant(ORG, msg, {
        controlDb: {} as never,
        neon,
        encryptionKey: KEY,
        applySchema: vi.fn(),
      });
      expect(msg.ack).toHaveBeenCalledOnce();
      expect(neon.findProjectsByName).not.toHaveBeenCalled();
      expect(row().attempts).toBe(0);
      expect(events()[0]).toMatchObject({
        event: 'provisioning.already_done',
        orgId: ORG,
        attempt: 1,
      });
    }
  );

  describe('crash and resume (AC-3, AC-5)', () => {
    // A consumer died after createAndConnect but before recording the project.
    function crashedAfterCreate() {
      seedRow({ claim: 'msg-1', claimedAt: state.now, attempts: 1 });
      return fakeNeon([
        {
          id: 'proj-orphaned',
          name: NAME,
          createdAt: new Date(state.now).toISOString(),
          region: 'aws-eu-central-1',
          databases: 1,
        },
      ]);
    }

    it('a redelivery with the same message id resumes at once and adopts the project', async () => {
      const neon = crashedAfterCreate();
      const applySchema = vi.fn();
      const msg = message('msg-1', 2);

      await provisionTenant(ORG, msg, {
        controlDb: {} as never,
        neon,
        encryptionKey: KEY,
        applySchema,
      });

      expect(neon.createAndConnect).not.toHaveBeenCalled();
      expect(neon.projects).toHaveLength(1);
      expect(row()).toMatchObject({
        status: 'READY',
        neon_project_id: 'proj-orphaned',
        region: 'aws-eu-central-1',
      });
      expect(applySchema).toHaveBeenCalledWith(
        'postgres://owner:secret-proj-orphaned@host/neondb'
      );
      expect(events().map((e) => e.event)).toEqual([
        'provisioning.adopted_project',
        'provisioning.ready',
      ]);
    });

    it('a redelivery with a new id waits out the lease, then adopts', async () => {
      const neon = crashedAfterCreate();
      const deferred = message('msg-1-redelivered', 2);
      await provisionTenant(ORG, deferred, {
        controlDb: {} as never,
        neon,
        encryptionKey: KEY,
        applySchema: vi.fn(),
      });
      expect(deferred.retry).toHaveBeenCalledWith({
        delaySeconds: 20 * 60 + 60,
      });

      state.now += plane.minutes(21);
      const later = message('msg-1-redelivered', 3);
      await provisionTenant(ORG, later, {
        controlDb: {} as never,
        neon,
        encryptionKey: KEY,
        applySchema: vi.fn(),
      });

      expect(neon.createAndConnect).not.toHaveBeenCalled();
      expect(neon.projects).toHaveLength(1);
      expect(row()).toMatchObject({
        status: 'READY',
        neon_project_id: 'proj-orphaned',
      });
    });
  });

  it('takeover: the old run, past its lease, changes nothing and acks without retrying (AC-3, AC-4)', async () => {
    state.orgs.add(ORG);
    const neon = fakeNeon();
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => (releaseOld = resolve));
    let calls = 0;
    const applySchema = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await oldBlocked;
    });

    const oldMsg = message('msg-old');
    const oldRun = provisionTenant(ORG, oldMsg, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema,
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(row().claim).toBe('msg-old');

    state.now += plane.minutes(21);
    const newMsg = message('msg-new');
    await provisionTenant(ORG, newMsg, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema,
    });
    expect(row()).toMatchObject({ status: 'READY', claim: null });
    const settled = { ...row() };

    releaseOld();
    await oldRun;

    expect(oldMsg.ack).toHaveBeenCalledOnce();
    expect(oldMsg.retry).not.toHaveBeenCalled();
    expect(row()).toEqual(settled);
    expect(neon.projects).toHaveLength(1);
    expect(events().map((e) => e.event)).toContain('provisioning.claim_lost');
  });

  it('live claim deferral: retries with the lease remainder plus 60 and leaves the row alone (AC-3)', async () => {
    seedRow({
      claim: 'msg-other',
      claimedAt: state.now - plane.minutes(2),
      attempts: 1,
    });
    const before = { ...row() };
    const neon = fakeNeon();
    const msg = message('msg-second');

    await provisionTenant(ORG, msg, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema: vi.fn(),
    });

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 1140 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(row()).toEqual(before);
    expect(neon.findProjectsByName).not.toHaveBeenCalled();
    expect(events()[0]).toMatchObject({
      event: 'provisioning.deferred_live_claim',
      delaySeconds: 1140,
    });
  });

  it('concurrent deliveries for one org create exactly one project (AC-2, AC-3)', async () => {
    state.orgs.add(ORG);
    const neon = fakeNeon();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(
      (resolve) => (releaseFirst = resolve)
    );
    const applySchema = vi.fn(() => firstBlocked);

    const first = message('msg-a');
    const firstRun = provisionTenant(ORG, first, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema,
    });
    await vi.waitFor(() => expect(applySchema).toHaveBeenCalled());

    const second = message('msg-b');
    await provisionTenant(ORG, second, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema,
    });
    expect(second.retry).toHaveBeenCalledOnce();

    releaseFirst();
    await firstRun;
    expect(neon.createAndConnect).toHaveBeenCalledOnce();
    expect(row()).toMatchObject({ status: 'READY', claim: null });
  });

  it('a READY write that fails once is retried against the same project (AC-6, AC-7)', async () => {
    state.orgs.add(ORG);
    state.readyWriteThrowsOnce = true;
    const neon = fakeNeon();
    const applySchema = vi.fn();

    const first = message('msg-1', 1);
    await provisionTenant(ORG, first, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema,
    });
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(row()).toMatchObject({ status: 'PROJECT_CREATED', claim: null });

    state.now += 60_000;
    const second = message('msg-1', 2);
    await provisionTenant(ORG, second, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema,
    });
    expect(neon.createAndConnect).toHaveBeenCalledOnce();
    expect(applySchema).toHaveBeenCalledTimes(2);
    expect(row().status).toBe('READY');
  });

  it('a legacy claim with NULL claimed_at counts as expired (AC-11)', async () => {
    seedRow({ claim: 'old-webhook-uuid', claimedAt: null });
    const neon = fakeNeon();
    const msg = message('msg-1');
    await provisionTenant(ORG, msg, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema: vi.fn(),
    });
    expect(row().status).toBe('READY');
  });

  it('duplicates in Neon: adopts the oldest, ledgers the newer, ignores a near match (AC-5)', async () => {
    state.orgs.add(ORG);
    const neon = fakeNeon([
      {
        id: 'proj-newer',
        name: NAME,
        createdAt: '2026-10-26T09:30:00Z',
        region: 'aws-us-east-2',
        databases: 1,
      },
      {
        id: 'proj-near',
        name: `${NAME}x`,
        createdAt: '2026-10-26T08:00:00Z',
        region: 'aws-us-east-2',
        databases: 1,
      },
      {
        id: 'proj-older',
        name: NAME,
        createdAt: '2026-10-26T09:00:00Z',
        region: 'aws-us-east-2',
        databases: 1,
      },
    ]);
    const msg = message('msg-1');

    await provisionTenant(ORG, msg, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema: vi.fn(),
    });

    expect(neon.createAndConnect).not.toHaveBeenCalled();
    expect(row()).toMatchObject({
      status: 'READY',
      neon_project_id: 'proj-older',
    });
    expect([...state.orphans]).toEqual([
      ['proj-newer', { orgId: ORG, reason: 'DUPLICATE_NAME' }],
    ]);
    expect(events()).toContainEqual({
      event: 'provisioning.duplicate_projects',
      orgId: ORG,
      attempt: 1,
      neonProjectIds: ['proj-newer'],
    });
  });

  it('adopt not ready: zero databases fails the attempt through the failure record and retries (AC-5, AC-7)', async () => {
    state.orgs.add(ORG);
    const neon = fakeNeon([
      {
        id: 'proj-empty',
        name: NAME,
        createdAt: '2026-10-26T09:00:00Z',
        region: 'aws-us-east-2',
        databases: 0,
      },
    ]);
    const msg = message('msg-1');

    await provisionTenant(ORG, msg, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema: vi.fn(),
    });

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(row()).toMatchObject({
      status: 'PROVISIONING',
      neon_project_id: '',
      claim: null,
      claimedAt: null,
    });
    expect(row().lastError).toMatch(
      /^ProvisioningNotReadyError: project proj-empty has 0 databases/
    );
    expect(events()[0]).toMatchObject({
      event: 'provisioning.attempt_failed',
      errorClass: 'ProvisioningNotReadyError',
      delaySeconds: 60,
    });
  });

  it('FAILED reuse: same project migrated to READY, nothing blanked, no create (AC-6)', async () => {
    seedRow({
      status: 'FAILED',
      neon_project_id: 'proj-kept',
      connection_string: await encrypt(
        'postgres://owner:secret-kept@host/neondb',
        KEY
      ),
      region: 'aws-us-east-2',
      lastError: 'Error: migrate boom',
      attempts: 5,
    });
    const neon = fakeNeon();
    const statusesDuringMigrate: string[] = [];
    const applySchema = vi.fn(async () => {
      statusesDuringMigrate.push(row().status);
      expect(row()).toMatchObject({
        neon_project_id: 'proj-kept',
        region: 'aws-us-east-2',
      });
    });
    const msg = message('msg-retry');

    await provisionTenant(ORG, msg, {
      controlDb: {} as never,
      neon,
      encryptionKey: KEY,
      applySchema,
    });

    expect(statusesDuringMigrate).toEqual(['PROVISIONING']); // dashboard 202, never usable mid retry
    expect(applySchema).toHaveBeenCalledWith(
      'postgres://owner:secret-kept@host/neondb'
    );
    expect(neon.findProjectsByName).not.toHaveBeenCalled();
    expect(neon.createAndConnect).not.toHaveBeenCalled();
    expect(row()).toMatchObject({
      status: 'READY',
      neon_project_id: 'proj-kept',
      lastError: null,
      attempts: 6,
    });
  });

  it('exhaustion: backs off 60, 300, 900, 1800, then FAILED with a redacted error (AC-7, AC-12)', async () => {
    state.orgs.add(ORG);
    const neon = fakeNeon();
    const applySchema = vi.fn(async () => {
      throw new Error(
        'connect failed for postgres://user:pw@host/db after timeout'
      );
    });
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 5; attempt++) {
      const msg = message('msg-1', attempt);
      await provisionTenant(ORG, msg, {
        controlDb: {} as never,
        neon,
        encryptionKey: KEY,
        applySchema,
      });
      if (attempt < 5) {
        expect(msg.ack).not.toHaveBeenCalled();
        delays.push(msg.retry.mock.calls[0][0]!.delaySeconds!);
        state.now += delays[delays.length - 1] * 1000;
      } else {
        expect(msg.ack).toHaveBeenCalledOnce();
        expect(msg.retry).not.toHaveBeenCalled();
      }
    }

    expect(delays).toEqual([60, 300, 900, 1800]);
    expect(neon.projects).toHaveLength(1); // recorded on the first attempt, reused after
    expect(row()).toMatchObject({
      status: 'FAILED',
      claim: null,
      claimedAt: null,
    });
    expect(row().lastError).toBe(
      'Error: connect failed for [redacted] after timeout'
    );
    expect(row().lastError).not.toContain('pw');
    expect(events().map((e) => e.event)).toEqual([
      'provisioning.attempt_failed',
      'provisioning.attempt_failed',
      'provisioning.attempt_failed',
      'provisioning.attempt_failed',
      'provisioning.failed',
    ]);
  });

  it('a failure record that throws propagates, and nothing acks or retries (AC-7)', async () => {
    state.orgs.add(ORG);
    state.failureWriteThrows = true;
    const msg = message('msg-1');
    await expect(
      provisionTenant(ORG, msg, {
        controlDb: {} as never,
        neon: fakeNeon(),
        encryptionKey: KEY,
        applySchema: vi.fn(async () => {
          throw new Error('migrate boom');
        }),
      })
    ).rejects.toThrow('control plane unreachable');
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });
});

describe('handleDeadLetteredProvisioning (AC-7)', () => {
  it('waits out a live lease, then marks the row FAILED', async () => {
    seedRow({ claim: 'msg-1', claimedAt: state.now - plane.minutes(2) });
    const first = message('dlq-1', 1);
    await handleDeadLetteredProvisioning(ORG, first, {
      controlDb: {} as never,
    });
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 1260 });
    expect(row().status).toBe('PROVISIONING');

    state.now += 1260 * 1000;
    const second = message('dlq-1', 2);
    await handleDeadLetteredProvisioning(ORG, second, {
      controlDb: {} as never,
    });
    expect(second.ack).toHaveBeenCalledOnce();
    expect(row()).toMatchObject({
      status: 'FAILED',
      claim: null,
      claimedAt: null,
      lastError: 'dead lettered',
    });
  });

  it('keeps an existing last error rather than overwriting it', async () => {
    seedRow({
      status: 'PROJECT_CREATED',
      neon_project_id: 'p',
      lastError: 'Error: migrate boom',
    });
    await handleDeadLetteredProvisioning(ORG, message('dlq-1'), {
      controlDb: {} as never,
    });
    expect(row()).toMatchObject({
      status: 'FAILED',
      lastError: 'Error: migrate boom',
    });
  });

  it('on its own final delivery, fails the row whatever the lease says', async () => {
    seedRow({ claim: 'msg-1', claimedAt: state.now - plane.minutes(1) });
    const last = message('dlq-1', 4);
    await handleDeadLetteredProvisioning(ORG, last, { controlDb: {} as never });
    expect(last.ack).toHaveBeenCalledOnce();
    expect(row()).toMatchObject({ status: 'FAILED', claim: null });
  });

  it('acks a row that already settled READY', async () => {
    seedRow({ status: 'READY', neon_project_id: 'p' });
    const msg = message('dlq-1');
    await handleDeadLetteredProvisioning(ORG, msg, { controlDb: {} as never });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(row().status).toBe('READY');
    expect(events()[0]).toMatchObject({
      event: 'provisioning.dead_lettered',
      outcome: 'settled',
    });
  });
});

describe('sanitizeError (AC-12)', () => {
  it('keeps the class and Neon HTTP status, trims to 200 characters, redacts connection strings', () => {
    const neonError = Object.assign(new Error('rate limited'), {
      name: 'NeonRateLimitError',
      status: 429,
    });
    expect(sanitizeError(neonError)).toBe(
      'NeonRateLimitError (HTTP 429): rate limited'
    );

    const long = new Error(`${'x'.repeat(190)} postgresql://u:p@h/db and more`);
    const out = sanitizeError(long);
    expect(out).not.toContain('u:p');
    expect(out.length).toBeLessThanOrEqual('Error: '.length + 200);
  });
});

describe('queue() handler', () => {
  it('routes the primary queue to the consumer and the DLQ to the backstop', async () => {
    expect(isDeadLetterQueue('rarebooks-provisioning')).toBe(false);
    expect(isDeadLetterQueue('rarebooks-provisioning-staging')).toBe(false);
    expect(isDeadLetterQueue('rarebooks-provisioning-dlq-production')).toBe(
      true
    );

    state.orgs.add(ORG);
    neonForQueue.client = fakeNeon();
    const msg = {
      ...message('msg-1'),
      body: { orgId: ORG },
      timestamp: new Date(),
    };
    await queue(
      { queue: 'rarebooks-provisioning', messages: [msg] } as never,
      { TENANT_ENCRYPTION_KEY: KEY } as never
    );
    expect(row().status).toBe('READY');

    seedRow({ claim: null });
    const dlqMsg = {
      ...message('dlq-1'),
      body: { orgId: ORG },
      timestamp: new Date(),
    };
    await queue(
      { queue: 'rarebooks-provisioning-dlq', messages: [dlqMsg] } as never,
      {} as never
    );
    expect(row().status).toBe('FAILED');
  });

  it('acks a malformed body instead of retrying it forever', async () => {
    const msg = {
      ...message('msg-1'),
      body: { nope: true },
      timestamp: new Date(),
    };
    await queue(
      { queue: 'rarebooks-provisioning', messages: [msg] } as never,
      {} as never
    );
    expect(msg.ack).toHaveBeenCalledOnce();
  });
});
