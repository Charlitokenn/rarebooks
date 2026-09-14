/**
 * Root-side tests for spec 0003's shared billing core (seat sync ordering
 * and the control-plane status read), per the spec's Testing setup: these
 * run in the existing tape suite with Clerk REST and the control query
 * injected as fakes — nothing real is contacted.
 */
import test from 'tape';
import { SeatSyncError, syncSeatCap, upsertPlanSeatLimit } from '../seatSync';
import { getSubscriptionRow, wireFromStatus } from '../subscriptionStatus';
import type { ControlQueryFn } from '../types';

interface FakeCall {
  sql: string;
  values: unknown[];
}

/**
 * Minimal in-memory control plane: a subscriptions row per org and an
 * organizations table, keyed on the SQL prefix the helpers actually emit.
 */
function createFakeDb(
  options: {
    subscriptionStatus?: string | null;
    orgExists?: boolean;
    failOn?: 'select' | 'update';
  } = {}
): { db: ControlQueryFn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const db: ControlQueryFn = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ sql, values });

    if (sql.startsWith('SELECT status') && sql.includes('FROM subscriptions')) {
      if (options.failOn === 'select') {
        throw new Error('connection reset');
      }
      if (
        options.subscriptionStatus === undefined ||
        options.subscriptionStatus === null
      ) {
        return [];
      }
      return [{ status: options.subscriptionStatus }];
    }

    if (sql.startsWith('UPDATE organizations')) {
      if (options.failOn === 'update') {
        throw new Error('write failed');
      }
      if (options.orgExists === false) {
        return [];
      }
      return [{ id: values[1] as string }];
    }

    throw new Error(`unexpected SQL in fake db: ${sql}`);
  };
  return { db, calls };
}

function createFakeFetch(options: {
  status?: number;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
}) {
  return (async (url: unknown, init?: RequestInit) => {
    options.calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return {
      ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
      status: options.status ?? 200,
    } as Response;
  }) as unknown as typeof globalThis.fetch;
}

test('getSubscriptionRow returns ACTIVE for an active row', async (t) => {
  const { db } = createFakeDb({ subscriptionStatus: 'ACTIVE' });
  const row = await getSubscriptionRow(db, 'org_1');
  t.equal(row?.status, 'ACTIVE');
  t.end();
});

test('getSubscriptionRow returns null when no row exists', async (t) => {
  const { db } = createFakeDb();
  const row = await getSubscriptionRow(db, 'org_1');
  t.equal(row, null);
  t.end();
});

test('getSubscriptionRow treats an unrecognized status as null (fail closed)', async (t) => {
  const { db } = createFakeDb({ subscriptionStatus: 'TRIALING' });
  const row = await getSubscriptionRow(db, 'org_1');
  t.equal(row, null);
  t.end();
});

test('getSubscriptionRow propagates a query error (caller maps to 503)', async (t) => {
  const { db } = createFakeDb({ failOn: 'select' });
  try {
    await getSubscriptionRow(db, 'org_1');
    t.fail('should have thrown');
  } catch (err) {
    t.match((err as Error).message, /connection reset/);
  }
  t.end();
});

test('getSubscriptionRow carries the ladder fields, ISO normalized (AC-16)', async (t) => {
  const calls: FakeCall[] = [];
  const db: ControlQueryFn = async (strings, ...values) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ sql, values });
    return [
      {
        status: 'TRIAL',
        plan: null,
        current_period_end: null,
        stage_ends_at: new Date('2026-09-28T00:00:00.000Z'),
      },
    ];
  };
  const row = await getSubscriptionRow(db, 'org_1');
  t.deepEqual(row, {
    status: 'TRIAL',
    plan: null,
    currentPeriodEnd: null,
    stageEndsAt: '2026-09-28T00:00:00.000Z',
  });
  t.match(
    calls[0].sql,
    /SELECT status, plan, current_period_end, stage_ends_at/
  );
  t.end();
});

test('wireFromStatus: null becomes MISSING', (t) => {
  t.equal(wireFromStatus(null), 'MISSING');
  t.equal(wireFromStatus('PAST_DUE'), 'PAST_DUE');
  t.end();
});

test('upsertPlanSeatLimit records the number and reports whether the org row existed', async (t) => {
  const { db, calls } = createFakeDb();
  t.equal(await upsertPlanSeatLimit(db, 'org_1', 3), true);
  t.match(calls[0].sql, /UPDATE organizations[\s\S]*plan_seat_limit = \?/);
  t.deepEqual(calls[0].values, [3, 'org_1']);
  t.end();
});

test('upsertPlanSeatLimit returns false for an unknown org', async (t) => {
  const { db } = createFakeDb({ orgExists: false });
  const wrote = await upsertPlanSeatLimit(db, 'org_missing', 3);
  t.equal(wrote, false);
  t.end();
});

test('syncSeatCap calls Clerk first with max_allowed_memberships, then records plan_seat_limit', async (t) => {
  const clerkCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const { db, calls } = createFakeDb();
  const order: string[] = [];
  const fetchFn = createFakeFetch({ calls: clerkCalls });
  const origDb = db;
  const recordingDb: ControlQueryFn = async (strings, ...values) => {
    order.push('db');
    return origDb(strings, ...values);
  };
  const wrappedFetch = (async (url: unknown, init?: RequestInit) => {
    order.push('clerk');
    return fetchFn(url as never, init);
  }) as unknown as typeof globalThis.fetch;

  await syncSeatCap(recordingDb, 'org_1', 3, {
    clerkSecretKey: 'sk_test',
    fetch: wrappedFetch,
  });

  t.deepEqual(
    order,
    ['clerk', 'db'],
    'Clerk is updated before the local record'
  );
  t.equal(clerkCalls.length, 1);
  t.match(clerkCalls[0].url, /\/v1\/organizations\/org_1$/);
  t.deepEqual(clerkCalls[0].body, { max_allowed_memberships: 3 });
  t.ok(
    calls.some((c) => c.sql.startsWith('UPDATE organizations')),
    'plan_seat_limit recorded'
  );
  t.end();
});

test('syncSeatCap logs a failed local write without throwing over a successful Clerk update', async (t) => {
  const logs: string[] = [];
  const { db } = createFakeDb({ failOn: 'update' });
  const clerkCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  await syncSeatCap(db, 'org_1', 5, {
    clerkSecretKey: 'sk_test',
    fetch: createFakeFetch({ calls: clerkCalls }),
    log: (m) => logs.push(m),
  });
  t.equal(clerkCalls.length, 1);
  t.equal(logs.length, 1);
  t.match(logs[0], /plan_seat_limit write failed/);
  t.end();
});

test('syncSeatCap throws a SeatSyncError over a Clerk failure and never writes locally', async (t) => {
  const { db, calls } = createFakeDb();
  const clerkCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  try {
    await syncSeatCap(db, 'org_1', 3, {
      clerkSecretKey: 'sk_test',
      fetch: createFakeFetch({ status: 422, calls: clerkCalls }),
    });
    t.fail('should have thrown');
  } catch (err) {
    t.ok(err instanceof SeatSyncError);
    t.match((err as Error).message, /HTTP 422/);
  }
  t.equal(
    calls.filter((c) => c.sql.startsWith('UPDATE organizations')).length,
    0,
    'no local write after a failed Clerk call'
  );
  t.end();
});

test('syncSeatCap rejects non-positive seat counts (0 means no cap in Clerk)', async (t) => {
  for (const seats of [0, -1, 2.5]) {
    const { db } = createFakeDb();
    let threw = false;
    try {
      await syncSeatCap(db, 'org_1', seats, {
        clerkSecretKey: 'sk_test',
        fetch: createFakeFetch({ calls: [] }),
      });
    } catch (err) {
      threw = err instanceof SeatSyncError;
    }
    t.ok(threw, `seats ${seats} is rejected`);
  }
  t.end();
});

test('syncSeatCap requires a secret key', async (t) => {
  const { db } = createFakeDb();
  let threw = false;
  try {
    await syncSeatCap(db, 'org_1', 3, {
      clerkSecretKey: '',
      fetch: createFakeFetch({ calls: [] }),
    });
  } catch (err) {
    threw = err instanceof SeatSyncError;
  }
  t.ok(threw);
  t.end();
});
