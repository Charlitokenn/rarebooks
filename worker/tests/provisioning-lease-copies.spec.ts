/**
 * The provisioning lease length is defined once per runtime, in three files
 * that cannot share an import (worker/, the root CJS migration runner, and
 * the plain ESM operator scripts). This keeps the three byte identical.
 *
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md
 * (Lease; AC-3, AC-8, AC-10)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COPIES = [
  'worker/db/control.ts',
  'custom/web/db/tenantMigrationRunner.ts',
  'scripts/lib/provisioningLease.mjs',
];

function leaseLine(relativePath: string): string {
  const source = readFileSync(
    resolve(__dirname, '../..', relativePath),
    'utf8'
  );
  const lines = source
    .split(/\r?\n/)
    .filter((line) => line.includes('PROVISIONING_LEASE_SQL ='));
  expect(
    lines,
    `${relativePath} defines PROVISIONING_LEASE_SQL exactly once`
  ).toHaveLength(1);
  return lines[0];
}

describe('PROVISIONING_LEASE_SQL copies', () => {
  it('are byte identical across the three runtimes', () => {
    const [first, ...rest] = COPIES.map(leaseLine);
    expect(first).toBe(
      `export const PROVISIONING_LEASE_SQL = "interval '20 minutes'";`
    );
    for (const line of rest) {
      expect(line).toBe(first);
    }
  });
});
