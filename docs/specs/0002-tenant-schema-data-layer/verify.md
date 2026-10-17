# Verify: tenant schema & data layer · spec 0002

Runtime verification for feature 07, run 2026-09-15 against live Neon projects
and a locally booted Worker. No mocks on the data path. The full ledger (the
harness, the dry run, the unauthenticated route probes, and the outputs) is in
this session's report; this file is the durable tick list `/test` reads next.

Two ways the tenant path was exercised:

1. Live data-layer harness (plain node + ts-node, mirroring
   `scripts/migrate-tenants.sh`, never Electron so better-sqlite3 is not
   loaded): read `tenant_projects` on the live control plane, AES-GCM-decrypt
   a stored connection string (the exact envelope `worker/lib/encryption.ts`
   writes), then drive `custom/web/db/tenantDatabase.ts`'s three exports
   against the decrypted tenant Postgres, the same calls `worker/routes/db.ts`
   makes once the tenant is resolved and the gate passes.
2. Live Worker (`wrangler dev`, `.dev.vars` secrets), to prove the routes are
   mounted behind the session and gate middleware.

## Commands

- [x] `node .../verify07-live-harness.ts` (control plane read + decrypt +
      full Party CRUD cycle) against the Acme Corp tenant → `[1]` resolved a
      real `postgresql://…` URL, `[7]`–`[13]` insert, get, getAll, update,
      bespoke, migrate-rejected, delete, `exists()=false`, all green. → AC-1,
      AC-2, AC-4
- [x] Same harness, schema introspection on the live tenant → `[3]` 64 tables,
      all 9 spec-named doctypes present (incl. custom Expense), `[4]` 120 real
      FK constraints. → AC-1
- [x] Same harness, `information_schema.columns WHERE column_name='org_id'` →
      `[5]` count 0. → AC-3
- [x] Same harness, second tenant (Exmile) → `[14]` its own 64-table schema,
      marker absent from it. → AC-3 (isolation)
- [x] `npm run migrate:tenants -- --dry-run` → `scanned 7, would migrate 7,
      skipped 0, failed 0`, exit 0, against the live control plane; touches
      nothing. → AC-5
- [x] `npm --prefix worker run dev` (`wrangler dev`), `GET /api/health` →
      `200 {ok:true}`; server boots clean.
- [x] `GET /api/db/schema`, `POST /api/db/call`, `POST /api/db/bespoke` with no
      session → all `401 Unauthenticated`, proving each route is mounted behind
      `requireOrgSession`. → AC-2
- [x] `POST /webhooks/organization-created` with a bogus and with an absent
      signature → `400 Invalid webhook signature`. → AC-1 entry path
- [x] `npm --prefix worker test` (vitest) → 23 passed. `tape
      tests/tenantMigrationRunner.spec.ts custom/web/db/tests/knexPgConfig.spec.ts`
      → 45 passed. → AC-4, AC-5 (unit)

## Acceptance-criteria coverage

- AC-1 · accounting schema applied to a live tenant via `DatabaseCore.migrate()`,
  `PROJECT_CREATED` → `READY` on success: MET (live tenant has the full schema,
  all 7 live tenants are `READY`, the FAILED-on-throw branch is in place in
  `handleOrganizationCreated.ts`).
- AC-2 · generic doc CRUD routes in `worker/routes/` after tenant resolution:
  MET (routes mounted behind the gate on the live Worker, and the handler
  functions run a full CRUD cycle against live Postgres).
- AC-3 · no `org_id` column, connection is the only boundary: MET (count 0 on a
  live tenant; two tenants resolve to distinct connections and do not see each
  other's rows).
- AC-4 · `DatabaseCore` Postgres client config on `@neondatabase/serverless`,
  with the SQLite-specific statements branched and the `pg` bundler-stub bug
  fixed: MET (the whole harness runs `DatabaseCore` over the Neon-backed Knex
  `pg` dialect against live Postgres; `PRAGMA foreign_keys` is guarded by
  `#isSqlite`; `knexPgConfig.spec.ts` 45 assertions green).
- AC-5 · a runner invoking `db.migrate()` over every `tenant_projects` row: MET
  (real dry-run fan-out over the live 7 tenants; unit suite covers the
  single-tenant, recovery-flag, and failure-continues paths).

## Not exercised this run (blocked, not failed)

- One fully authenticated HTTP round trip (`/api/db/call` with a real Clerk
  session JWT through the live Worker). Needs a test Clerk login
  (`E2E_EMAIL`/`E2E_PASSWORD`, plus a 2FA code on this instance). Its two
  halves are each proven above independently (the route is mounted and gated,
  and the handler works on live data), and `verify-0002-e2e.mjs` drives exactly
  this leg with `E2E_BASE` pointed at the deployed app or `dev:web:full`. Run
  that once you have the creds to close the loop end to end over HTTP.
