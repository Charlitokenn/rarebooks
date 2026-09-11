/**
 * Applies the standard accounting schema to a freshly provisioned tenant
 * Neon project, via DatabaseCore's own schema-driven migrate() — the exact
 * mechanism Desktop already uses to build and evolve its SQLite schema, run
 * once here against Postgres instead of a hand-written SQL migration file.
 *
 * Called from handleOrganizationCreated.ts as the final provisioning step,
 * with the plaintext connection string Neon just returned (before it is
 * encrypted for storage) — this function never touches encryption or the
 * control plane itself.
 *
 * Spec: docs/specs/0002-tenant-schema-data-layer.md (AC-1, AC-4)
 */
import DatabaseCore from '../../../backend/database/core';
import { getSchemas } from '../../../schemas';

export async function applyTenantSchema(connectionString: string): Promise<void> {
  const db = new DatabaseCore({
    client: 'pg',
    connection: connectionString,
    pool: { min: 0, max: 1 },
    useNullAsDefault: true,
  });

  try {
    await db.connect();
    // A fresh project has no CustomField table yet — no custom fields to
    // layer onto the schema on this very first migrate(). Later
    // migrations (feature 07's Follow-up: the migration runner) read them
    // the same way DatabaseManager.getSchemaMap() does on Desktop.
    db.setSchemaMap(getSchemas('-', []));
    await db.migrate();
  } finally {
    await db.close();
  }
}
