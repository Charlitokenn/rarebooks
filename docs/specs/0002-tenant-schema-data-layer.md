# 0002. Tenant schema & data layer

**Date**: 2026-09-03
**Status**: In Progress

## Summary

This decision applies the full accounting schema to a freshly provisioned tenant Neon project as the last step of onboarding, and builds the generic document CRUD routes that let the existing accounting UI and business logic run against a tenant's Postgres database instead of Desktop's SQLite file. Nothing changes in `../../src`, `../../models`, or `../../reports`; this is a backend only feature that proves the shared accounting core works unmodified against the new tenant boundary from feature 06.

## Context

Feature 06 provisions an empty, isolated Neon project per organization and records it as `PROJECT_CREATED`, but does not put the accounting schema into it or expose any way to read or write documents against it. Without this feature, an organization can reach the empty feature 06 dashboard but has a database with nothing in it and no route that talks to it. The accounting schema and business logic already exist and are shared between Desktop and Web by design (`fyo`, `../../models`, `../../reports`); the work here is routing, migration, and confirming Postgres flavored behavior matches SQLite flavored behavior closely enough that nothing in the shared layer needs to change.

All of that shared logic sits on one class, `../../backend/database/core.ts`'s `DatabaseCore`, the actual ORM every `db.get`/`db.insert`/`db.update`/`db.delete` call in `fyo`/`../../models`/`../../reports` goes through. Today it is hardwired for Desktop: `client: 'better-sqlite3'` in its Knex config, and a SQLite specific `typeMap` (`sqliteTypeMap`). This feature does not get to treat "point the existing queries at Postgres" as a detail; `DatabaseCore` itself needs a Postgres flavored counterpart (client config and type map) before a single tenant query can run, and Cloudflare Workers cannot open the plain TCP connection Knex's normal `pg` client expects. Spec 0001's own Follow-up flagged this exact question and left it for this spec to answer.

## Requirements

**User stories**:
- As a newly onboarded organization, I want my tenant database to have the full accounting schema so that I can immediately start creating invoices, parties, and journal entries.
- As the platform, I need a generic way to read and write any doctype against a tenant's own project so that the same UI and business logic Desktop already has works on Web without a rewrite.

**Acceptance criteria**:
- **AC-1**: The accounting schema (Party, SalesInvoice, PurchaseInvoice, Payment, JournalEntry, Item, StockLedgerEntry, Account, and RareBooks's custom doctypes) is applied to a `PROJECT_CREATED` tenant project by running `DatabaseCore`'s own `migrate()` as the final migration step, and `tenant_projects.status` only becomes `READY` once it succeeds.
- **AC-2**: Generic doc CRUD routes exist in `worker/routes/`, mirroring the actions `../../main/registerIpcMainActionListeners.ts` exposes on Desktop, each running after the tenant resolution middleware from feature 06.
- **AC-3**: No tenant project table has an `org_id` column or any tenant filter; the resolved connection is the only tenant boundary.
- **AC-4**: `../../backend/database/core.ts`'s `DatabaseCore` gets a Postgres flavored client config and type map (parallel to today's `better-sqlite3` config and `sqliteTypeMap`), runs its Knex `pg` client on `@neondatabase/serverless`'s `Pool`, and `../../models`/`../../reports` run correctly against a tenant's Neon project through it, with any further Postgres versus SQLite query differences found and fixed.
- **AC-5**: A migration runner exists that can invoke `db.migrate()` against every row in `tenant_projects`, not just one project, for future schema changes.

## Decision

**Chosen option**: Apply the standard accounting schema to each tenant project by running `DatabaseCore`'s own schema-driven `migrate()` method against it as the final provisioning step, once its Postgres flavored client config exists — not a new, hand-written SQL migration script. Desktop already builds and evolves its entire SQLite schema this same way, from the same doctype definitions `models/`/`reports/` use; a bespoke Postgres script would fork that mechanism and drift from it the first time a doctype changes. Route document CRUD through generic `worker/routes/` handlers that call the existing `fyo`/`models` layer against the resolved tenant connection. `DatabaseCore` gets a Postgres flavored client config and type map, and runs on top of `@neondatabase/serverless`'s `Pool`/`Client` (its node-postgres compatible driver, WebSocket based, distinct from the plain `neon()` tagged-template function feature 06 uses for one-shot control plane queries), not a generic `pg` package, since a raw TCP `pg` connection is not something a Cloudflare Workers isolate can open. The simplest wiring is the package alias Neon's own driver documents (`"pg": "npm:@neondatabase/serverless"`), so Knex's existing `client: 'pg'` dialect gets `@neondatabase/serverless`'s pool transparently, with no Knex fork or custom dialect needed. Workers has a native `WebSocket` global, so this needs no extra `ws` package or `neonConfig.webSocketConstructor` override in production, only in the Node based Desktop test runner if these tests ever run there. Note `DatabaseCore.connect()` currently runs `PRAGMA foreign_keys=ON`, a SQLite-only statement that will fail verbatim against Postgres (which enforces foreign keys by default, so the statement can simply be skipped on the Postgres path) — the first of, almost certainly not the only, SQLite-specific statement the Postgres client config needs to branch around.

**Migration runner invocation (decided 2026-09-12)**: the AC-5 runner is a one-off operator script, `scripts/migrate-tenants.ts` behind `npm run migrate:tenants` (`scripts/migrate-tenants.sh`), not an HTTP route on the Worker and not a Cron Trigger. Rejected as an HTTP route: it iterates every tenant's decrypted connection string, so exposing it over HTTP means standing up a second, stronger authorization surface (super admin at minimum) for an action that only ever runs between deploys, when an operator is watching. Rejected as a Cron Trigger: a schema rollout is a deliberate, observed, sequenced event (canary one tenant, confirm, then fan out), and an unattended scheduled run against a `SUSPENDED` tenant, or one still being provisioned, is exactly the accident a manual gate prevents. Flags: `--dry-run` (list what would migrate, touch nothing), `--org=<clerkOrgId>` (single tenant, the canary or repair path), `--include-project-created` (the recovery path for a provisioning webhook that died between `PROJECT_CREATED` and its own schema step; advances the tenant to `READY` on success, via a conditional `UPDATE ... WHERE status = 'PROJECT_CREATED'` so a concurrent webhook is never stomped). It reads the same `CONTROL_DATABASE_URL` and `TENANT_ENCRYPTION_KEY` values as the Worker secrets, from the environment, the root `.env`, or `worker/.dev.vars`, and exits 1 if any tenant failed; one failing tenant is recorded in the summary and the rollout continues with the rest. The module (`custom/web/db/tenantMigrationRunner.ts`) sits outside `worker/` and imports nothing from it, because `worker/` is its own ESM package the root's CJS ts-node pipeline cannot require; it reuses `DatabaseCore`, `getSchemas`, and a copy of `worker/lib/encryption.ts`'s AES-256-GCM decrypt against the same on-disk envelope (both copies must change together). Unlike the migration that runs at provisioning time, it reads the tenant's own `CustomField` rows before building the schema map, the `DatabaseManager.setRawCustomFields` mirror `applyTenantSchema.ts` could not do on a fresh, empty project.

**Implementation skills**: none installed relevant to this decision.

## Rationale

Reusing the existing schema and business logic unmodified is the entire point of keeping `fyo/demux/*.ts` as the only platform aware layer; rewriting `../../models`/`../../reports` for Web would defeat that design. Postgres's `ALTER TABLE ADD COLUMN` is safe for additive changes, unlike SQLite's rebuild based "prestige" migration Desktop has to work around, but because there is one project per tenant instead of one shared database, any schema change must be applied by a runner that iterates every tenant project rather than a single statement.

Keeping Knex, instead of writing a second, Knex-free `DatabaseBase` implementation for Web, is the smaller and safer change: every existing query in `../../models`/`../../reports` already goes through Knex's query builder, and swapping only its underlying client keeps that surface identical, so this feature stays a driver and type map change, not a rewrite of the ORM layer. The runner up, a hand written Postgres `DatabaseBase` implementation using `@neondatabase/serverless`'s tagged-template `neon()` function directly, was rejected: it would mean re-implementing Knex's query building and, more importantly, its transaction handling, by hand, for a large and already working call surface, for no benefit over pointing Knex at a compatible driver.

## Options considered

**Option A: Knex, retargeted to Postgres via `@neondatabase/serverless`'s `Pool` (chosen)**
- Pro: reuses every existing `../../models`/`../../reports` query unchanged; Knex's own transaction handling keeps working; smallest change.
- Con: still depends on Knex's `pg` dialect behaving well against a driver it was not written for, even though that driver targets node-postgres compatibility; worth a focused smoke test early in the build plan, not assumed.

**Option B: A hand written Postgres `DatabaseBase` on `@neondatabase/serverless`'s `neon()` function**
- Pro: no dependency on Knex's dialect internals matching a compatibility shim.
- Con: reimplements query building and transactions by hand for the entire existing call surface; the exact class of rewrite this feature is trying to avoid; much larger and riskier than Option A for no clear benefit.

**Option C: A different Postgres ORM entirely (Drizzle, Kysely) for the Web target only**
- Pro: modern, edge friendly tooling with first party support for Neon's driver.
- Con: `../../models`/`../../reports` are written against Knex's query builder API today; adopting a second ORM for Web only means every shared query needs a second, parallel implementation, splitting the "one accounting core, two targets" design this whole migration depends on. Rejected outright, not a close second.

## Feature design

**Data model sketch**: The tenant project schema is the existing accounting schema, unchanged in shape from what SQLite holds today, plus the existing custom additions: `Expense` (`name`, `numberSeries`, `date`, `vendor`, `expense_account`, `amount`, `description`), the `NumberSeries` extension for `Expense`'s numbering, and `Party.birth_date`. No new fields are introduced by this feature.

**API surface**:
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/doc/:schema` | POST | doc fields per schema | created doc | Clerk session, resolved tenant, subscription active (feature 08, not yet built; treat as always allowed until 08 lands) | 422 validation |
| `/api/doc/:schema/:name` | GET | none | doc | same | 404 |
| `/api/doc/:schema/:name` | PUT | doc fields | updated doc | same | 422, 404 |
| `/api/doc/:schema/:name` | DELETE | none | 200 | same | 404 |
| `/api/doc/:schema` | GET | filters, pagination | list of docs | same | 400 invalid filter |

**Value sourcing**:
| Action | Value produced / displayed | Source |
|---|---|---|
| Any doc CRUD call | The tenant connection used | `worker/db/resolve-tenant.ts` from feature 06, keyed on the verified session's `org_id` |
| Accounting readiness | `tenant_projects.status = 'READY'` | Transitioned from feature 06's `PROJECT_CREATED` only after the schema migration against the fresh project returns success |

**Key invariants**:
- No `org_id` column or filter anywhere in tenant project tables; the resolved connection is the only tenant boundary.
- A schema change is applied by a migration runner over every `tenant_projects` row, never a single `ALTER TABLE` against one shared database.
- Route handlers stay thin, delegating to `../../models`/`fyo` for business logic, the same way `../../main/registerIpcMainActionListeners.ts` stays thin on Desktop.

**Security model**: Every doc CRUD route runs after Clerk session verification and tenant resolution (feature 06); there is no route that accepts a client supplied tenant identifier.

**Configuration required**: none beyond feature 06's existing secrets. The tenant connection string already comes from `worker/db/resolve-tenant.ts`; this feature changes what consumes that connection string (`DatabaseCore`'s Knex `pg` client instead of a one-shot `neon()` call), not where it comes from or how it is stored.

**Critical test scenarios**:
- Happy path: an org's tenant project provisions, `db.migrate()` succeeds against it, and a document can be created, read, updated, and deleted through the generic routes. Verifies **AC-1, AC-2**.
- Failure case: `db.migrate()` fails; `tenant_projects.status` moves from `PROJECT_CREATED` to `FAILED`, never `READY`, and the failure is surfaced rather than silently leaving a half-migrated tenant. Verifies **AC-1**.
- Data isolation: two different orgs' doc CRUD calls resolve to two different Neon connections and never touch each other's data. Verifies **AC-3**.

## Build plan

Tracer Bullet approach (the project default): get one document type through the whole stack, tenant Postgres to a working route, before widening to every doctype, so a wrong assumption about `DatabaseCore`'s new Postgres path surfaces on the smallest possible slice.

1. Give `DatabaseCore` a Postgres flavored client config and type map, wired to `@neondatabase/serverless`'s `Pool` via the `pg` package alias, and prove it against one simple schema (e.g. `SingleValue`) with a real tenant Neon project: connect, insert, read back. This is the load bearing assumption (Knex's `pg` dialect behaving correctly against this driver); confirming it first, before any schema or route work, is cheaper than discovering a problem after step 2 or 3 are also built on it. Satisfies **AC-4** (partial).
2. Call `DatabaseCore`'s existing `db.migrate()` against the tenant's Postgres connection and wire it into `../../worker/routes/webhooks/organization-created.ts` as the final provisioning step, advancing `PROJECT_CREATED` to `READY` only on success — no new SQL migration script to author, but expect to fix `connect()`'s SQLite-only `PRAGMA foreign_keys=ON` call and whatever else `migrate()`'s own path turns up. Satisfies **AC-1**.
3. Build generic `worker/routes/` doc CRUD handlers mirroring Desktop's IPC actions, each behind the feature 06 tenant resolution middleware. Satisfies **AC-2, AC-3**.
4. Run the rest of `models/**`/`reports/**` against a real tenant Neon project and fix any remaining Postgres versus SQLite query differences found. Satisfies **AC-4** (remaining).
5. Build a migration runner utility that calls `db.migrate()` against every row in `tenant_projects` for future schema rollouts. Satisfies **AC-5**.

## Consequences

**Positive**:
- The existing accounting UI and business logic work on Web with no rewrite, confirming the platform abstraction design holds.

**Negative / tradeoffs**:
- Every future schema change is now a fan out migration across N tenant projects instead of one shared database statement, adding operational complexity as tenant count grows.
- `DatabaseCore`'s Postgres path depends on Knex's `pg` dialect working correctly against `@neondatabase/serverless`'s compatibility layer rather than a real `pg` connection; this is a reasonable bet (that is exactly what the package alias is built for) but not a certainty until step 1 of the build plan proves it, and if it does not hold, this feature's whole approach needs revisiting before step 2 onward.

**Neutral**:
- Postgres versus SQLite query differences discovered here may require small, targeted fixes in `../../models`/`../../reports`, shared code that also runs on Desktop; any such fix must not change Desktop's behavior.

## Follow-up

- [ ] None currently identified beyond the migration runner scaling question already tracked on feature 06.
