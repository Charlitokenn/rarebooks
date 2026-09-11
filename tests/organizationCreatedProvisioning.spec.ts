import test from 'tape';
import {
  handleOrganizationCreated,
  type HandleOrgCreatedEnv,
  type NeonProvisioningClient,
} from '../custom/web/auth/handleOrganizationCreated';
import type { ControlDb, TenantProjectRow } from '../worker/db/control';

const env: HandleOrgCreatedEnv = {
  CONTROL_DATABASE_URL: 'unused-in-tests',
  TENANT_ENCRYPTION_KEY: btoa('\0'.repeat(32)),
};

interface ControlDbState {
  organizations: Set<string>;
  readyWriteFailuresRemaining: number;
  tenant: TenantProjectRow | null;
}

function createControlDb(options: { readyWriteFailures?: number } = {}): {
  db: ControlDb;
  state: ControlDbState;
} {
  const state: ControlDbState = {
    organizations: new Set(),
    readyWriteFailuresRemaining: options.readyWriteFailures ?? 0,
    tenant: null,
  };

  const db = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Array<Record<string, string>>> => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();

    if (sql.startsWith('INSERT INTO organizations')) {
      state.organizations.add(values[0] as string);
      return [];
    }

    if (sql.startsWith('INSERT INTO tenant_projects')) {
      const orgId = values[0] as string;
      const claimId = values[1] as string;
      if (state.tenant && state.tenant.status !== 'FAILED') {
        return [];
      }

      state.tenant = {
        org_id: orgId,
        neon_project_id: '',
        connection_string: '',
        region: '',
        provisioning_claim_id: claimId,
        status: 'PROVISIONING',
        created_at: new Date().toISOString(),
      };
      return [{ org_id: orgId }];
    }

    if (sql.includes("SET status = 'FAILED'")) {
      const orgId = values[0] as string;
      const claimId = values[1] as string;
      if (
        state.tenant?.org_id !== orgId ||
        state.tenant.status !== 'PROVISIONING' ||
        state.tenant.provisioning_claim_id !== claimId
      ) {
        return [];
      }

      state.tenant.status = 'FAILED';
      state.tenant.provisioning_claim_id = null;
      return [{ org_id: orgId }];
    }

    if (sql.includes('SET provisioning_claim_id = ?')) {
      const claimId = values[0] as string;
      const orgId = values[1] as string;
      if (
        state.tenant?.org_id !== orgId ||
        state.tenant.status !== 'PROJECT_CREATED' ||
        state.tenant.provisioning_claim_id !== null
      ) {
        return [];
      }

      state.tenant.provisioning_claim_id = claimId;
      return [{ connection_string: state.tenant.connection_string }];
    }

    if (sql.includes('SET provisioning_claim_id = NULL')) {
      const orgId = values[0] as string;
      const claimId = values[1] as string;
      if (
        state.tenant?.org_id !== orgId ||
        state.tenant.status !== 'PROJECT_CREATED' ||
        state.tenant.provisioning_claim_id !== claimId
      ) {
        return [];
      }

      state.tenant.provisioning_claim_id = null;
      return [{ org_id: orgId }];
    }

    if (sql.startsWith('UPDATE tenant_projects SET status = ?')) {
      const status = values[0] as TenantProjectRow['status'];
      const orgId = values[1] as string;
      if (status === 'READY' && state.readyWriteFailuresRemaining > 0) {
        state.readyWriteFailuresRemaining -= 1;
        throw new Error('transient READY status write failure');
      }
      if (state.tenant?.org_id === orgId) {
        state.tenant.status = status;
        state.tenant.provisioning_claim_id = null;
      }
      return [];
    }

    if (sql.startsWith('UPDATE tenant_projects')) {
      const orgId = values[4] as string;
      const claimId = values[5] as string;
      if (
        state.tenant?.org_id !== orgId ||
        state.tenant.status !== 'PROVISIONING' ||
        state.tenant.provisioning_claim_id !== claimId
      ) {
        return [];
      }

      state.tenant.neon_project_id = values[0] as string;
      state.tenant.connection_string = values[1] as string;
      state.tenant.region = values[2] as string;
      state.tenant.status = 'PROJECT_CREATED';
      state.tenant.provisioning_claim_id = values[3] as string;
      return [{ org_id: orgId }];
    }

    throw new Error(`Unexpected control-plane query: ${sql}`);
  }) as unknown as ControlDb;

  return { db, state };
}

test('concurrent organization deliveries provision one tenant project', async (t) => {
  const { db, state } = createControlDb();
  let provisionCount = 0;
  let releaseProvisioning: (() => void) | undefined;
  let markProvisioningStarted: (() => void) | undefined;
  const provisioningStarted = new Promise<void>((resolve) => {
    markProvisioningStarted = resolve;
  });
  const provisioningReleased = new Promise<void>((resolve) => {
    releaseProvisioning = resolve;
  });
  const neonClient: NeonProvisioningClient = {
    async createAndConnect() {
      provisionCount += 1;
      markProvisioningStarted?.();
      await provisioningReleased;
      return {
        neonProjectId: 'project-1',
        connectionString: 'postgres://tenant-1',
        region: 'aws-us-east-2',
      };
    },
  };
  const event = { data: { id: 'org-1', name: 'Organization 1' } };
  const applySchema = async () => undefined;

  const firstDelivery = handleOrganizationCreated(
    event,
    env,
    neonClient,
    db,
    applySchema
  );
  await provisioningStarted;
  await handleOrganizationCreated(event, env, neonClient, db, applySchema);

  t.equal(provisionCount, 1, 'only the delivery owning the claim provisions');
  releaseProvisioning?.();
  await firstDelivery;
  t.equal(state.tenant?.neon_project_id, 'project-1');
  t.equal(state.tenant?.status, 'READY');
  t.equal(state.tenant?.provisioning_claim_id, null);
  t.end();
});

test('a delivery retries an atomically reclaimed failed tenant', async (t) => {
  const { db, state } = createControlDb();
  let provisionCount = 0;
  const neonClient: NeonProvisioningClient = {
    async createAndConnect() {
      provisionCount += 1;
      if (provisionCount === 1) {
        throw new Error('transient Neon failure');
      }
      return {
        neonProjectId: 'project-after-retry',
        connectionString: 'postgres://tenant-after-retry',
        region: 'aws-us-east-2',
      };
    },
  };
  const event = { data: { id: 'org-retry', name: 'Retry Organization' } };
  const applySchema = async () => undefined;

  let firstError: unknown;
  try {
    await handleOrganizationCreated(event, env, neonClient, db, applySchema);
  } catch (error) {
    firstError = error;
  }

  t.ok(firstError instanceof Error, 'the transient failure is reported');
  t.equal(state.tenant?.status, 'FAILED', 'the failed claim is recorded');

  await handleOrganizationCreated(event, env, neonClient, db, applySchema);

  t.equal(provisionCount, 2, 'the next delivery provisions after reclaiming');
  t.equal(state.tenant?.status, 'READY');
  t.equal(state.tenant?.neon_project_id, 'project-after-retry');
  t.equal(state.tenant?.provisioning_claim_id, null);
  t.end();
});

test('a READY write failure reconciles the existing tenant project', async (t) => {
  const { db, state } = createControlDb({ readyWriteFailures: 1 });
  let provisionCount = 0;
  let migrationCount = 0;
  const neonClient: NeonProvisioningClient = {
    async createAndConnect() {
      provisionCount += 1;
      return {
        neonProjectId: 'project-ready-retry',
        connectionString: 'postgres://tenant-ready-retry',
        region: 'aws-us-east-2',
      };
    },
  };
  const applySchema = async () => {
    migrationCount += 1;
  };
  const event = {
    data: { id: 'org-ready-retry', name: 'READY Retry Organization' },
  };

  let readyError: unknown;
  try {
    await handleOrganizationCreated(event, env, neonClient, db, applySchema);
  } catch (error) {
    readyError = error;
  }
  t.equal(
    (readyError as Error)?.message,
    'transient READY status write failure',
    'the control-plane write failure is reported'
  );
  t.equal(
    state.tenant?.status,
    'PROJECT_CREATED',
    'a migrated tenant is not marked FAILED'
  );

  await handleOrganizationCreated(event, env, neonClient, db, applySchema);

  t.equal(provisionCount, 1, 'the existing project is not provisioned again');
  t.equal(migrationCount, 2, 'the idempotent schema migration is reconciled');
  t.equal(state.tenant?.status, 'READY', 'the retry advances the tenant');
  t.end();
});
