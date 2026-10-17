/**
 * The AC-10 structural test: every `BespokeQueries` member must be
 * deliberately classified, and only pure reads may ever be dispatched over
 * /api/db/bespoke. A bespoke pass-through during READ_ONLY is the one door
 * the rung keeps open, so the Worker's dispatch allowlist
 * (`BESPOKE_READ_METHODS` in subscriptionGate.ts, enforced again by
 * callTenantBespokeMethod) and this test can never quietly grow a write
 * door: adding a method to BespokeQueries without extending the read set
 * fails here.
 *
 * Runs in the root tape suite (like 0002's backend/database tests), which
 * resolves the repo's tsconfig paths; the Worker vitest run deliberately
 * never evaluates backend/.
 *
 * Spec: docs/specs/0004-paypal-subscriptions.md (AC-10)
 */
import test from 'tape';
// eslint-disable-next-line no-restricted-imports
import { BespokeQueries } from 'backend/database/bespoke';
import {
  BESPOKE_READ_METHODS,
  WRITE_DB_METHODS,
  READ_DB_METHODS,
} from '../subscriptionGate';

/**
 * BespokeQueries members that mutate. They exist for Desktop's own repair
 * paths (fyo/core/dbHandler.ts's migrateExpenseDescription, run at Desktop
 * startup via custom/setup/migrateExpenseTable.ts) and are excluded from the
 * Web dispatch surface entirely, so they must never join the read set.
 */
const DESKTOP_ONLY_BESPOKE_WRITES: ReadonlySet<string> = new Set([
  'migrateExpenseDescription',
]);

function bespokeMembers(): string[] {
  return Object.getOwnPropertyNames(BespokeQueries).filter(
    (name) =>
      !['length', 'name', 'prototype'].includes(name) &&
      !name.startsWith('#') &&
      typeof (BespokeQueries as unknown as Record<string, unknown>)[name] ===
        'function'
  );
}

test('every BespokeQueries member is classified as read or desktop-only write', (t) => {
  const unclassified = bespokeMembers().filter(
    (name) =>
      !BESPOKE_READ_METHODS.has(name) && !DESKTOP_ONLY_BESPOKE_WRITES.has(name)
  );
  t.deepEqual(
    unclassified,
    [],
    `new or unclassified bespoke entries (add reads to BESPOKE_READ_METHODS, never writes): ${unclassified.join(
      ', '
    )}`
  );
  t.end();
});

test('the read set names only members that exist on BespokeQueries', (t) => {
  const members = new Set(bespokeMembers());
  const stale = [...BESPOKE_READ_METHODS].filter((name) => !members.has(name));
  t.deepEqual(stale, [], 'BESPOKE_READ_METHODS has no removed entries');
  t.end();
});

test('no mutating bespoke query is dispatchable over the web surface', (t) => {
  for (const name of DESKTOP_ONLY_BESPOKE_WRITES) {
    t.notOk(
      BESPOKE_READ_METHODS.has(name),
      `${name} stays out of the web read allowlist`
    );
  }
  t.end();
});

test('the db read and write method sets split databaseMethodSet exactly', (t) => {
  // backend/helpers.ts's databaseMethodSet minus 'close' (custom/web/db/
  // tenantDatabase.ts owns connect/close) must equal read ∪ write.
  // Hardcoded here, not imported: backend/helpers.ts pulls in fs.
  const allDocMethods = [
    'insert',
    'get',
    'getAll',
    'getSingleValues',
    'rename',
    'update',
    'delete',
    'deleteAll',
    'exists',
  ];
  t.deepEqual(
    [...READ_DB_METHODS, ...WRITE_DB_METHODS].sort(),
    [...allDocMethods].sort(),
    'read ∪ write is the whole dispatched surface'
  );
  for (const name of READ_DB_METHODS) {
    t.notOk(WRITE_DB_METHODS.has(name), `${name} is not in both sets`);
  }
  t.end();
});
