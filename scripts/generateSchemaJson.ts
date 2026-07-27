// Run with: npx tsx scripts/generateSchemaJson.ts > schema.generated.json
// Bundles the same schema metadata the Vue app needs client-side (field types, options,
// labels, etc.) for rendering forms/lists - not just the DDL. Copy the output into
// rarebooks-api's src/db/ as a JSON import for the /api/db/schema route.
import { getSchemas } from '../schemas';

const schemas = getSchemas('-', []);
console.log(JSON.stringify(schemas));
