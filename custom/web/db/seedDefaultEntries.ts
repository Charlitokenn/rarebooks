/**
 * Seeds the same default reference data Desktop's setup wizard creates via
 * src/setup/setupInstance.ts's createDefaultEntries() (backed by
 * getDefaultUOMs/getDefaultLocations in utils/defaults.ts) — but through
 * raw DatabaseCore.insert() instead of Fyo's doc.sync(), since this runs on
 * the Worker / migration-runner side where there is no Fyo instance (no
 * model layer, no i18n), only the DatabaseCore this file's callers already
 * have open. Mirrors backend/patches/addUOMs.ts, which does this same raw
 * DatabaseCore.insert() dance for UOMs on Desktop's own patch/migration
 * path — including spreading getDefaultMetaFieldValueMap() into every
 * insert. Every non-single schema gets createdBy/modifiedBy/created/
 * modified added as *required* fields (schemas/meta/base.json, applied via
 * addMetaFields() in schemas/index.ts), which DatabaseCore's
 * #buildColumnForTable turns into NOT NULL Postgres columns. Skipping
 * these here does not fail loudly at the Knex layer — newTenantKnexConfig
 * sets useNullAsDefault: true, so the missing fields quietly become NULL —
 * it fails at Postgres's own not-null constraint instead, which
 * handleOrganizationCreated.ts's caller catches and marks the tenant
 * FAILED. This must never be called without spreading these defaults in.
 *
 * Idempotent by design (checks db.exists() before each insert), so it is
 * safe to call on every schema migrate() — not just once at first
 * provisioning: custom/web/db/tenantMigrationRunner.ts re-runs this on
 * every rollout against every READY tenant, and also on the PROJECT_CREATED
 * recovery path, both of which must not fail or duplicate rows on a tenant
 * that was already seeded.
 *
 * Mirrors getDefaultUOMs/getDefaultLocations (utils/defaults.ts) directly;
 * keep these two lists in sync with that file if Desktop's defaults change.
 */
import type DatabaseCore from '../../../backend/database/core';
import { getDefaultMetaFieldValueMap } from '../../../backend/helpers';
import { ModelNameEnum } from '../../../models/types';

const DEFAULT_UOMS: { name: string; isWhole: boolean }[] = [
  { name: 'Unit', isWhole: true },
  { name: 'Kg', isWhole: false },
  { name: 'Gram', isWhole: false },
  { name: 'Meter', isWhole: false },
  { name: 'Hour', isWhole: false },
  { name: 'Day', isWhole: false },
];

const DEFAULT_LOCATIONS: { name: string }[] = [{ name: 'Stores' }];

export async function seedDefaultEntries(db: DatabaseCore): Promise<void> {
  for (const uom of DEFAULT_UOMS) {
    if (await db.exists(ModelNameEnum.UOM, uom.name)) {
      continue;
    }
    await db.insert(ModelNameEnum.UOM, {
      ...uom,
      ...getDefaultMetaFieldValueMap(),
    });
  }

  for (const location of DEFAULT_LOCATIONS) {
    if (await db.exists(ModelNameEnum.Location, location.name)) {
      continue;
    }
    await db.insert(ModelNameEnum.Location, {
      ...location,
      ...getDefaultMetaFieldValueMap(),
    });
  }
}
