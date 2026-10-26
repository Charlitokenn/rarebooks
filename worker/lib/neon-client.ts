/**
 * Wraps @neon/sdk to provision one Neon project per tenant.
 *
 * @neon/sdk (not @neondatabase/api-client) is the confirmed choice: it's
 * fetch-based, zero-dependency, ESM-only, and explicitly documented to
 * run in edge/Workers runtimes, unlike the older axios-based
 * @neondatabase/api-client. This resolves the "confirm the exact
 * Workers-compatible client" follow-up noted in docs/specs/0001.
 *
 * neon.projects.createAndConnect() provisions the project AND polls Neon's
 * async provisioning operation to completion AND returns a ready-to-use
 * connection string, all in one call — matching the ergonomic single
 * function assumed in docs/specs/0001's Build plan.
 *
 * findProjectsByName and getConnectionString back spec 0010's adopt before
 * create: a project Neon already has under the tenant's name is reused, not
 * created a second time. The SDK's pagination helpers always use the result
 * envelope (never throwOnError), so those errors are rethrown here.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md
 * Spec: docs/specs/0010-provisioning-claim-lease-orphans/index.md (AC-5)
 */
import { createNeonClient } from '@neon/sdk';
import {
  ProvisioningNotReadyError,
  type NeonProvisioningClient,
} from '../../custom/web/auth/handleOrganizationCreated';
import type { WorkerEnv } from '../types';

const UNFINISHED_OPERATION_STATUSES = new Set([
  'scheduling',
  'running',
  'cancelling',
]);

export function createNeonProvisioningClient(
  env: WorkerEnv
): NeonProvisioningClient {
  const neon = createNeonClient({
    apiKey: env.NEON_API_KEY,
    orgId: env.NEON_ACCOUNT_ORG_ID,
    throwOnError: true,
  });

  return {
    async createAndConnect({ name }) {
      const { project, connectionString } =
        await neon.projects.createAndConnect({ name });

      return {
        neonProjectId: project.id,
        connectionString,
        region: project.region_id,
      };
    },

    async findProjectsByName(name) {
      // `search` is a substring match, so `rarebooks-tenant-<orgId>x` comes
      // back too; keep exact matches only.
      const { data, error } = await neon.projects.list({ search: name }).all();
      if (error) {
        throw error;
      }
      return data
        .filter((project) => project.name === name)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((project) => ({
          id: project.id,
          createdAt: project.created_at,
          region: project.region_id,
        }));
    },

    async getConnectionString(projectId) {
      const branch = await neon.branches.getDefault(projectId);

      const { data: operations, error } = await neon.operations
        .list(projectId)
        .page();
      if (error) {
        throw error;
      }
      if (
        operations.items.some((op) =>
          UNFINISHED_OPERATION_STATUSES.has(op.status)
        )
      ) {
        throw new ProvisioningNotReadyError(
          `project ${projectId} still has unfinished operations`
        );
      }

      const endpoints = await neon.postgres.endpoints.listByBranch(
        projectId,
        branch.id
      );
      const endpoint = endpoints.find(
        (e) => e.type === 'read_write' && !e.disabled
      );
      if (!endpoint || endpoint.current_state === 'init') {
        throw new ProvisioningNotReadyError(
          `project ${projectId} has no ready read_write endpoint`
        );
      }

      const databases = await neon.postgres.databases.list(
        projectId,
        branch.id
      );
      if (databases.length !== 1) {
        throw new ProvisioningNotReadyError(
          `project ${projectId} has ${databases.length} databases, expected exactly 1`
        );
      }
      const [database] = databases;

      return neon.postgres.connectionString({
        projectId,
        branchId: branch.id,
        endpointId: endpoint.id,
        databaseName: database.name,
        roleName: database.owner_name,
      });
    },
  };
}
