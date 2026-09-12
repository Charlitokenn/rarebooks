import test from 'tape';
import { webcrypto } from 'node:crypto';
import sinon from 'sinon';
import DatabaseCore from '../backend/database/core';
import {
  decryptTenantConnectionString,
  isMigratableStatus,
  migrateTenantProject,
  runTenantMigrations,
  type ControlQueryFn,
  type TenantProjectRecord,
} from '../custom/web/db/tenantMigrationRunner';

// scripts/runner.sh runs specs on Electron 22's Node 16, where globalThis.crypto
// doesn't exist yet; the runner module uses Web Crypto (same as
// worker/lib/encryption.ts), so polyfill it from node:crypto when missing.
// @ts-ignore
globalThis.crypto ??= webcrypto;

interface FakeDb {
  db: ControlQueryFn;
  queries: string[];
  readyWrites: string[];
}

function createFakeDb(records: TenantProjectRecord[]): FakeDb {
  const queries: string[] = [];
  const readyWrites: string[] = [];
  const db = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown> => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    queries.push(sql);

    if (sql.startsWith('SELECT org_id, status, connection_string')) {
      if (sql.includes('WHERE org_id = ?')) {
        return records
          .filter((r) => r.orgId === values[0])
          .map((r) => ({
            org_id: r.orgId,
            status: r.status,
            connection_string: r.encryptedConnectionString,
          }));
      }
      return records.map((r) => ({
        org_id: r.orgId,
        status: r.status,
        connection_string: r.encryptedConnectionString,
      }));
    }

    if (sql.startsWith('UPDATE tenant_projects')) {
      const orgId = values[0] as string;
      const row = records.find((r) => r.orgId === orgId);
      if (row?.status === 'PROJECT_CREATED') {
        row.status = 'READY';
        readyWrites.push(orgId);
        return [{ org_id: orgId }];
      }
      return [];
    }

    throw new Error(`Unexpected control-plane query: ${sql}`);
  }) as unknown as ControlQueryFn;

  return { db, queries, readyWrites };
}

const secrets = {
  controlDatabaseUrl: 'unused-in-tests',
  tenantEncryptionKey: 'unused-in-tests',
};

test('only READY tenants migrate; PROJECT_CREATED needs the recovery flag', (t) => {
  t.equal(isMigratableStatus('READY', false), true);
  t.equal(isMigratableStatus('PROJECT_CREATED', false), false);
  t.equal(isMigratableStatus('PROJECT_CREATED', true), true);
  t.equal(isMigratableStatus('PROVISIONING', true), false);
  t.equal(isMigratableStatus('SUSPENDED', true), false);
  t.equal(isMigratableStatus('FAILED', true), false);
  t.end();
});

test('missing secrets fail fast with an actionable error', async (t) => {
  for (const missing of [
    { controlDatabaseUrl: '', tenantEncryptionKey: 'k' },
    { controlDatabaseUrl: 'u', tenantEncryptionKey: '' },
  ]) {
    let err: unknown;
    try {
      await runTenantMigrations(missing, {
        includeProjectCreated: false,
        dryRun: false,
      });
    } catch (e) {
      err = e;
    }
    t.ok(
      (err as Error)?.message?.includes('is not set'),
      'names the unset variable rather than crashing downstream'
    );
  }
  t.end();
});

test('a dry run touches nothing and reports what would migrate', async (t) => {
  const { db } = createFakeDb([
    {
      orgId: 'org-ready',
      status: 'READY',
      encryptedConnectionString: 'blob',
    },
    {
      orgId:
        'org-project-created',
      status: 'PROJECT_CREATED',
      encryptedConnectionString: 'blob',
    },
  ]);
  let migrateCount = 0;

  const summary = await runTenantMigrations(
    secrets,
    { includeProjectCreated: false, dryRun: true },
    {
      controlDb: db,
      migrateTenantProject: async () => {
        migrateCount += 1;
      },
    }
  );

  t.equal(migrateCount, 0, 'no tenant was migrated');
  t.equal(summary.scanned, 2);
  t.equal(summary.wouldMigrate, 1, 'only the READY tenant is a candidate');
  t.equal(summary.skipped.length, 1);
  t.equal(summary.skipped[0].orgId, 'org-project-created');
  t.end();
});

test('--org limits the run to one tenant, and a missing org errors', async (t) => {
  const { db } = createFakeDb([
    { orgId: 'org-a', status: 'READY', encryptedConnectionString: 'blob' },
    { orgId: 'org-b', status: 'READY', encryptedConnectionString: 'blob' },
  ]);
  const migrated: string[] = [];

  const summary = await runTenantMigrations(
    secrets,
    { orgId: 'org-a', includeProjectCreated: false, dryRun: false },
    {
      controlDb: db,
      decrypt: async (connectionString) => connectionString,
      migrateTenantProject: async (orgId) => {
        migrated.push(orgId);
      },
    }
  );
  t.deepEqual(migrated, ['org-a'], 'only the named tenant ran');
  t.equal(summary.migrated, 1);

  let err: unknown;
  try {
    await runTenantMigrations(
      secrets,
      { orgId: 'org-missing', includeProjectCreated: false, dryRun: false },
      { controlDb: db, migrateTenantProject: async () => undefined }
    );
  } catch (e) {
    err = e;
  }
  t.ok(
    (err as Error)?.message?.includes('no tenant_projects row'),
    'a typo org id errors instead of silently doing nothing'
  );
  t.end();
});

test('one failing tenant does not abort the rollout, and failures land in the summary', async (t) => {
  const { db } = createFakeDb([
    { orgId: 'org-a', status: 'READY', encryptedConnectionString: 'blob' },
    { orgId: 'org-b', status: 'READY', encryptedConnectionString: 'blob' },
    { orgId: 'org-c', status: 'READY', encryptedConnectionString: 'blob' },
  ]);
  const migrated: string[] = [];

  const summary = await runTenantMigrations(
    secrets,
    { includeProjectCreated: false, dryRun: false },
    {
      controlDb: db,
      decrypt: async (connectionString) => connectionString,
      log: () => undefined,
      migrateTenantProject: async (orgId) => {
        if (orgId === 'org-b') {
          throw new Error('simulated tenant failure');
        }
        migrated.push(orgId);
      },
    }
  );

  t.deepEqual(migrated, ['org-a', 'org-c'], 'the run continued past org-b');
  t.equal(summary.migrated, 2);
  t.equal(summary.failed.length, 1);
  t.equal(summary.failed[0].orgId, 'org-b');
  t.equal(summary.failed[0].error, 'simulated tenant failure');
  t.end();
});

test('the recovery flag migrates PROJECT_CREATED tenants and advances them to READY', async (t) => {
  const records: TenantProjectRecord[] = [
    {
      orgId: 'org-stranded',
      status: 'PROJECT_CREATED',
      encryptedConnectionString: 'blob',
    },
  ];
  const { db, readyWrites } = createFakeDb(records);

  const summary = await runTenantMigrations(
    secrets,
    { includeProjectCreated: true, dryRun: false },
    {
      controlDb: db,
      decrypt: async (connectionString) => connectionString,
      log: () => undefined,
      migrateTenantProject: async () => undefined,
    }
  );

  t.equal(summary.migrated, 1);
  t.deepEqual(readyWrites, ['org-stranded'], 'the status write targeted it');
  t.equal(records[0].status, 'READY', 'conditional UPDATE advanced the row');
  t.end();
});

test('only an absent CustomField table is ignored during migration', async (t) => {
  let customFieldError: Error & { code?: string } = Object.assign(
    new Error('relation "CustomField" does not exist'),
    { code: '42P01' }
  );
  const connect = sinon
    .stub(DatabaseCore.prototype, 'connect')
    .callsFake(async function (this: DatabaseCore) {
      this.knex = (async () => {
        throw customFieldError;
      }) as never;
    });
  const close = sinon.stub(DatabaseCore.prototype, 'close').resolves();
  const setSchemaMap = sinon.stub(DatabaseCore.prototype, 'setSchemaMap');
  const migrate = sinon.stub(DatabaseCore.prototype, 'migrate').resolves();

  try {
    await migrateTenantProject('org-a', 'postgres://unused', () => undefined);
    t.equal(migrate.callCount, 1, 'missing CustomField table still migrates');

    customFieldError = Object.assign(new Error('permission denied'), {
      code: '42501',
    });
    let error: unknown;
    try {
      await migrateTenantProject('org-a', 'postgres://unused', () => undefined);
    } catch (caught) {
      error = caught;
    }
    t.equal(error, customFieldError, 'permission errors are rethrown');
    t.equal(migrate.callCount, 1, 'permission errors stop before db.migrate');
    t.equal(close.callCount, 2, 'connections close after either outcome');
    t.equal(connect.callCount, 2, 'both attempts connect before querying');
    t.equal(
      setSchemaMap.callCount,
      1,
      'only the missing-table case sets schemas'
    );
  } finally {
    sinon.restore();
  }
  t.end();
});

test('the decrypt reads the AES-256-GCM envelope worker/lib/encryption.ts writes', async (t) => {
  // Same on-disk format (base64(iv || ciphertext || tag), 12-byte IV)
  // produced here with Web Crypto, the way the Worker's encrypt() does it.
  const key = new Uint8Array(32).fill(7);
  const rawKey = Buffer.from(key).toString('base64');
  const iv = new Uint8Array(12).fill(3);
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, [
    'encrypt',
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    new TextEncoder().encode('postgres://tenant:secret@host/db')
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  const encoded = Buffer.from(combined).toString('base64');

  t.equal(
    await decryptTenantConnectionString(encoded, rawKey),
    'postgres://tenant:secret@host/db',
    'the runner decrypts exactly what the Worker encrypts'
  );
  let keyErr: unknown;
  try {
    await decryptTenantConnectionString(encoded, Buffer.alloc(31).toString('base64'));
  } catch (e) {
    keyErr = e;
  }
  t.ok(
    /must decode to 32 bytes/.test((keyErr as Error)?.message ?? ''),
    'a malformed key is rejected with a clear message'
  );
  t.end();
});
