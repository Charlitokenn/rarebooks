/**
 * The empty dashboard shell — this feature's finish line (AC-5). No
 * accounting data yet; that starts with feature 0002. This route only
 * proves: signed in + org created + tenant project provisioned.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md
 */
import { Hono } from 'hono';
import {
  requireOrgSession,
  type AuthedVariables,
} from '../middleware/clerk-auth';
import { getControlDb, getTenantProject } from '../db/control';
import type { WorkerEnv } from '../types';

export const dashboardRoute = new Hono<{
  Bindings: WorkerEnv;
  Variables: AuthedVariables;
}>();

dashboardRoute.get('/', requireOrgSession, async (c) => {
  c.header('Cache-Control', 'no-store');
  const orgId = c.get('orgId');
  const controlDb = getControlDb(c.env);
  const tenant = await getTenantProject(controlDb, orgId);

  if (!tenant) {
    // organization.created hasn't been processed yet (webhook lag) or failed
    // before any row was written — treat the same as PROVISIONING for the UI.
    return c.json({ status: 'PROVISIONING' }, 202);
  }

  if (tenant.status === 'FAILED') {
    return c.json({ status: 'FAILED' }, 500);
  }

  if (tenant.status !== 'PROJECT_CREATED' && tenant.status !== 'READY') {
    return c.json({ status: tenant.status }, 202);
  }

  // AC-5 stops here: an empty shell, no accounting data. PROJECT_CREATED is
  // sufficient; feature 0002 advances the project to READY before tenant
  // accounting routes may resolve its database connection.
  return c.json({ status: tenant.status, orgId });
});
