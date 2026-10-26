/**
 * The provisioning lease length for the operator scripts (spec 0010). A byte
 * identical copy of worker/db/control.ts's; plain ESM scripts import nothing
 * from worker/, so worker/tests/provisioning-lease-copies.spec.ts keeps the
 * three copies in step. Interpolate it with `sql.unsafe(...)`.
 */
export const PROVISIONING_LEASE_SQL = "interval '20 minutes'";

/** Every tenant's Neon project is named this plus its Clerk org id. */
export const TENANT_PROJECT_PREFIX = 'rarebooks-tenant-';
