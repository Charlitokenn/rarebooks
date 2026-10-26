/**
 * A brand new org lands on the shell while its tenant is still
 * PROVISIONING (spec 0010 provisions on a queue, so this is the normal
 * first answer). The shell must re-check on its own and boot once the
 * tenant turns READY, instead of spinning until the user reloads
 * (spec 0008 AC-5), and must stop re-checking once the org it was
 * checking for is no longer the active one (AC-9).
 *
 * src/web/shell.ts imports the live Clerk singleton and the web router,
 * neither of which can load outside a browser, so both are swapped for
 * stand-ins in the require cache before shell.ts is loaded. Only
 * setTimeout/clearTimeout are faked, so promises still resolve normally.
 *
 * Shell and boot state are module singletons, and a READY boot is cached
 * per org, so every test uses its own org id.
 */
import sinon from 'sinon';
import test from 'tape';
import { Fyo } from '../fyo';
import { DatabaseHandler } from '../fyo/core/dbHandler';
import { DocHandler } from '../fyo/core/docHandler';

const RECHECK_MS = 2000;

function stubModule(specifier: string, exports: unknown): void {
  const path = require.resolve(specifier);
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports,
  } as NodeModule;
}

const fakeClerk: {
  session: object | null;
  organization: { id: string } | null;
  user: null;
  addListener: () => void;
} = {
  session: {},
  organization: null,
  user: null,
  addListener: () => undefined,
};

stubModule('src/web/clerk', { clerk: fakeClerk });
stubModule('src/router', {
  default: {
    replace: async () => undefined,
    currentRoute: { value: { meta: {} } },
  },
});

/** Let every pending promise chain run (setImmediate is not faked). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Harness {
  /** What /api/dashboard answers next. */
  status: string;
  /** While set, /api/dashboard hangs until it resolves. */
  gate: Promise<void> | null;
  fetchCount: () => number;
  clock: sinon.SinonFakeTimers;
  restore: () => void;
}

function setup(orgId: string): Harness {
  fakeClerk.session = {};
  fakeClerk.organization = { id: orgId };

  const harness = {
    status: 'PROVISIONING',
    gate: null,
  } as Harness;

  const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async () => {
    if (harness.gate) {
      await harness.gate;
    }
    const status = harness.status;
    return {
      status: status === 'READY' ? 200 : 202,
      json: async () => ({ status }),
    } as Response;
  });
  const connectStub = sinon
    .stub(DatabaseHandler.prototype, 'connectToDatabase')
    .callsFake(async function (this: DatabaseHandler) {
      this.dbPath = 'web';
      return 'READY';
    });
  const initializeStub = sinon
    .stub(Fyo.prototype, 'initializeAndRegister')
    .resolves();
  const getDocStub = sinon
    .stub(DocHandler.prototype, 'getDoc')
    .callsFake(async function (this: DocHandler, schemaName: string) {
      this.fyo.singles[schemaName] = { setupComplete: true } as never;
      return {} as never;
    });
  const clock = sinon.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout'],
  });

  harness.fetchCount = () => fetchStub.callCount;
  harness.clock = clock;
  harness.restore = () => {
    clock.restore();
    fetchStub.restore();
    connectStub.restore();
    initializeStub.restore();
    getDocStub.restore();
  };
  return harness;
}

/** Fire the pending re-check and let the boot it starts finish. */
async function nextRecheck(h: Harness): Promise<void> {
  await h.clock.tickAsync(RECHECK_MS);
  await settle();
}

async function loadShell() {
  const { ensureShellReady } = await import('../src/web/shell');
  const { shellState } = await import('../src/web/shellState');
  return { ensureShellReady, shellState };
}

test('AC-5: a PROVISIONING tenant is re-checked and the shell boots once it is READY, with no reload', async (t) => {
  const h = setup('org-provisioning-to-ready');
  const { ensureShellReady, shellState } = await loadShell();
  try {
    await ensureShellReady();
    t.equal(shellState.value.kind, 'booting', 'shows the setup loader first');
    t.equal(h.fetchCount(), 1);

    h.status = 'READY';
    await nextRecheck(h);

    t.equal(h.fetchCount(), 2, 'asked /api/dashboard again on its own');
    t.equal(shellState.value.kind, 'ready', 'boots without a reload');
  } finally {
    h.restore();
  }
});

test('AC-5: keeps re-checking every two seconds for as long as the tenant stays PROVISIONING', async (t) => {
  const h = setup('org-long-provisioning');
  const { ensureShellReady, shellState } = await loadShell();
  try {
    await ensureShellReady();

    await h.clock.tickAsync(RECHECK_MS - 1);
    await settle();
    t.equal(h.fetchCount(), 1, 'does not ask again before two seconds');

    await h.clock.tickAsync(1);
    await settle();
    t.equal(h.fetchCount(), 2, 'asks again at two seconds');

    await nextRecheck(h);
    await nextRecheck(h);
    t.equal(h.fetchCount(), 4, 'one more check per interval');
    t.equal(shellState.value.kind, 'booting', 'still on the setup loader');
  } finally {
    h.restore();
  }
});

test('AC-5: a background re-check keeps the "still being set up" loader up instead of flashing a bare loader', async (t) => {
  const h = setup('org-no-flash');
  const { ensureShellReady, shellState } = await loadShell();
  try {
    await ensureShellReady();
    const before = shellState.value;
    t.deepEqual(before, {
      kind: 'booting',
      detail: 'Your account is still being set up.',
    });

    let open!: () => void;
    h.gate = new Promise<void>((resolve) => (open = resolve));
    await h.clock.tickAsync(RECHECK_MS);
    await settle();

    t.equal(h.fetchCount(), 2, 'the re-check is in flight');
    t.deepEqual(
      shellState.value,
      before,
      'the screen is unchanged while the re-check runs'
    );

    h.gate = null;
    open();
    await settle();
  } finally {
    h.restore();
  }
});

test('AC-5: PROJECT_CREATED shows the setup card, keeps it up during re-checks, and recovers to ready', async (t) => {
  const h = setup('org-project-created');
  h.status = 'PROJECT_CREATED';
  const { ensureShellReady, shellState } = await loadShell();
  try {
    await ensureShellReady();
    const card = shellState.value;
    t.equal(card.kind, 'unavailable');
    t.ok(
      card.kind === 'unavailable' && card.stillProvisioning,
      'flagged as still provisioning, not "Not connected"'
    );

    await nextRecheck(h);
    t.equal(h.fetchCount(), 2, 're-checked on its own');
    t.deepEqual(shellState.value, card, 'card stays, no loader flash');

    h.status = 'READY';
    await nextRecheck(h);
    t.equal(shellState.value.kind, 'ready', 'recovers without a click');
  } finally {
    h.restore();
  }
});

test('AC-5: a brand new org passing PROVISIONING, then PROJECT_CREATED, then READY reaches the shell on its own', async (t) => {
  const h = setup('org-full-path');
  const { ensureShellReady, shellState } = await loadShell();
  try {
    await ensureShellReady();
    t.equal(shellState.value.kind, 'booting');

    h.status = 'PROJECT_CREATED';
    await nextRecheck(h);
    t.equal(shellState.value.kind, 'unavailable', 'moves to the setup card');

    h.status = 'READY';
    await nextRecheck(h);
    t.equal(shellState.value.kind, 'ready', 'polling did not stop on the card');
  } finally {
    h.restore();
  }
});

test('AC-5: no re-check is scheduled once the tenant is READY', async (t) => {
  const h = setup('org-ready-at-once');
  h.status = 'READY';
  const { ensureShellReady, shellState } = await loadShell();
  try {
    await ensureShellReady();
    t.equal(shellState.value.kind, 'ready');

    await nextRecheck(h);
    await nextRecheck(h);
    t.equal(h.fetchCount(), 1, 'asked only once');
  } finally {
    h.restore();
  }
});

for (const deadEnd of ['FAILED', 'SUSPENDED', 'UNKNOWN']) {
  test(`AC-5: stops re-checking when the tenant reaches the dead end ${deadEnd}`, async (t) => {
    const h = setup(`org-dead-end-${deadEnd.toLowerCase()}`);
    const { ensureShellReady, shellState } = await loadShell();
    try {
      await ensureShellReady();
      h.status = deadEnd;
      await nextRecheck(h);
      t.equal(shellState.value.kind, 'unavailable', 'shows the status screen');
      t.notOk(
        shellState.value.kind === 'unavailable' &&
          shellState.value.stillProvisioning,
        'not presented as still provisioning'
      );

      const countAtDeadEnd = h.fetchCount();
      await nextRecheck(h);
      await nextRecheck(h);
      t.equal(h.fetchCount(), countAtDeadEnd, 'no further checks');
    } finally {
      h.restore();
    }
  });
}

test('AC-5: a network error while re-checking shows the status screen and stops polling', async (t) => {
  const h = setup('org-network-error');
  const { ensureShellReady, shellState } = await loadShell();
  try {
    await ensureShellReady();
    (globalThis.fetch as sinon.SinonStub).rejects(new Error('offline'));

    await nextRecheck(h);
    t.deepEqual(shellState.value, { kind: 'unavailable', detail: 'offline' });

    const count = h.fetchCount();
    await nextRecheck(h);
    t.equal(h.fetchCount(), count, 'waits for Retry instead of hammering');
  } finally {
    h.restore();
  }
});

test('AC-5: Retry while a re-check is pending does not start a second polling loop', async (t) => {
  const h = setup('org-retry-mid-wait');
  const { ensureShellReady } = await loadShell();
  try {
    await ensureShellReady();
    await h.clock.tickAsync(RECHECK_MS / 2);

    await ensureShellReady(); // what the Retry path calls
    t.equal(h.fetchCount(), 2);

    // The first timer was cancelled: only the new one fires, two seconds
    // after the retry, so there is one check here and not two.
    await h.clock.tickAsync(RECHECK_MS / 2);
    await settle();
    t.equal(h.fetchCount(), 2, 'the old timer did not fire');

    await h.clock.tickAsync(RECHECK_MS / 2);
    await settle();
    t.equal(h.fetchCount(), 3, 'the new timer fired once');
  } finally {
    h.restore();
  }
});

test('AC-9: a pending re-check is dropped when the user switches to another org', async (t) => {
  const h = setup('org-switched-from');
  const { ensureShellReady } = await loadShell();
  try {
    await ensureShellReady();
    fakeClerk.organization = { id: 'org-switched-to' };

    await nextRecheck(h);
    t.equal(h.fetchCount(), 1, 'no check for the org the user left');
  } finally {
    h.restore();
  }
});

test('AC-9: a pending re-check is dropped when the user signs out', async (t) => {
  const h = setup('org-signed-out');
  const { ensureShellReady } = await loadShell();
  try {
    await ensureShellReady();
    fakeClerk.session = null;

    await nextRecheck(h);
    t.equal(h.fetchCount(), 1, 'no tenant check without a session');
  } finally {
    h.restore();
  }
});
