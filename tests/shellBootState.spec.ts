import test from 'tape';
import { deriveBootShellState } from '../src/web/shellBootState';
import type { WebFyoBoot } from '../src/web/boot';
import { Fyo } from '../fyo';

// deriveBootShellState only reads `status`/`error` off the boot result, so
// a bare object cast stands in for the real `fyo` field — no need to boot
// an actual Fyo instance for this test.
function boot(status: WebFyoBoot['status'], error?: string): WebFyoBoot {
  return { fyo: {} as Fyo, status, error };
}

test('deriveBootShellState: READY boots the shell', (t) => {
  t.deepEqual(deriveBootShellState(boot('READY')), { kind: 'ready' });
  t.end();
});

test('deriveBootShellState: PROVISIONING keeps the loader, not an error', (t) => {
  const state = deriveBootShellState(boot('PROVISIONING'));
  t.equal(state.kind, 'booting');
  t.end();
});

test('deriveBootShellState: PROJECT_CREATED is unavailable but flagged as still provisioning, not a hard failure', (t) => {
  const state = deriveBootShellState(boot('PROJECT_CREATED'));
  t.equal(state.kind, 'unavailable');
  if (state.kind === 'unavailable') {
    t.equal(
      state.stillProvisioning,
      true,
      'must be distinguishable from a genuine failure so the UI does not ' +
        'show the alarming "Not connected" title for it'
    );
    t.ok(state.detail.length > 0);
  }
  t.end();
});

test('deriveBootShellState: FAILED is a genuine dead end, not still provisioning', (t) => {
  const state = deriveBootShellState(boot('FAILED', 'connection refused'));
  t.equal(state.kind, 'unavailable');
  if (state.kind === 'unavailable') {
    t.notOk(state.stillProvisioning);
    t.equal(state.detail, 'connection refused');
  }
  t.end();
});

test('deriveBootShellState: SUSPENDED and UNKNOWN are also genuine dead ends', (t) => {
  for (const status of ['SUSPENDED', 'UNKNOWN'] as const) {
    const state = deriveBootShellState(boot(status));
    t.equal(state.kind, 'unavailable');
    if (state.kind === 'unavailable') {
      t.notOk(state.stillProvisioning, `${status} must not read as recoverable`);
    }
  }
  t.end();
});
