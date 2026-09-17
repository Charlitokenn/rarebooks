/**
 * Seeds the same default reference data Desktop's setup wizard creates via
 * src/setup/setupInstance.ts's createDefaultEntries() (backed by
 * getDefaultUOMs/getDefaultLocations in utils/defaults.ts) — but through
 * raw DatabaseCore.insert() instead of Fyo's doc.sync(), since this runs on
 * the Worker / migration-runner side where there is no Fyo instance (no
 * model layer, no i18n), only the DatabaseCore this file's callers already
 * have open.
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
    await db.insert(ModelNameEnum.UOM, uom);
  }

  for (const location of DEFAULT_LOCATIONS) {
    if (await db.exists(ModelNameEnum.Location, location.name)) {
      continue;
    }
    await db.insert(ModelNameEnum.Location, location);
  }
}
