# Scope: RareBooks Web Platform

RareBooks is a bookkeeping app for small and medium businesses, forked from Frappe Books, today shipping as an Electron desktop app. This scope covers migrating it to a hosted, multi tenant web platform for the East African (Tanzania and Kenya) market. Phase and feature numbers below mirror `context/build-plan.md`, the project's own build plan, so the two stay in sync.

**Build approach:** Tracer Bullet (each feature built as a thin, complete vertical slice through every layer, working end to end, before the next one starts).
**Workflow:** GA (after `/develop`: `/check verify`, then `/test`, then a fresh model `/check review`, then `/document`). The project default level of rigor, since this plan touches payments, auth, and multi tenant data. `/architect` is the recommended first stop for a feature with a real decision, but skippable when you already know the build. Any feature can carry its own tag (e.g. `· GA`) to do more or less.

_These are recommendations to keep your build orderly, not requirements. Skip anything that does not fit: if you already know how to build a feature, use `/develop` and skip `/architect`. You decide when a feature is `done`._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 01 | Keymint hybrid licensing | Phase 1: Commercial Foundation | existing |
| 02 | ClickPesa payment integration | Phase 1: Commercial Foundation | existing |
| 03 | Default super admin auto-provisioning | Phase 2: Onboarding & Access | existing |
| 04 | Expense tracking, full feature | Phase 3: Accounting Extensions | existing |
| 05 | Inventory & payment notifications | Phase 3: Accounting Extensions | existing |
| 06 | Web platform foundation & control plane | Phase 4: Web Migration | in-progress |
| 07 | Tenant schema & data layer | Phase 4: Web Migration | in-progress |
| 08 | Subscription gating & seat sync | Phase 4: Web Migration | in-progress |
| 15 | Web accounting setup wizard | Phase 4: Web Migration | in-progress |
| 14 | Web app shell (desktop UI on web) | Phase 4: Web Migration | in-progress |
| 09 | PayPal subscriptions (non Tanzania payments) | Phase 4: Web Migration | in-progress |
| 10 | Lipa Namba manual payments (Tanzania payments) & admin review | Phase 4: Web Migration | planned |
| 11 | Web notifications (ntfy) | Phase 4: Web Migration | in-progress |
| 12 | Deploy & cutover readiness | Phase 4: Web Migration | planned |
| 13 | Legal & compliance pages | Phase 4: Web Migration (addition) | planned |

## Existing

### 01. Keymint hybrid licensing · existing
Device bound license activation and validation for the Electron app, with an offline grace period. Desktop only; never ported to Web. code in `custom/licensing/`

### 02. ClickPesa payment integration · existing
USSD push mobile money payment for license purchase, Tanzania only. Desktop only; replaced on Web by features 09 and 10, not extended. code in `custom/licensing/api/clickpesa-client.ts`

### 03. Default super admin auto-provisioning · existing
Auto-creates a super admin user on first company setup if none exists. code in `custom/setup/createDefaultSuperAdmin.ts`

### 04. Expense tracking, full feature · existing
Custom `Expense` doctype (schema, model, numbered series) with a documented migration recovery path. code in `custom/schemas/Expense.json`

### 05. Inventory & payment notifications · existing
Restock notifications (with item image support) and payment method notifications, delivered via ntfy through the shared `src/utils/ntfy.ts` — the same trigger and delivery code the Web target keeps (feature 11). code in `custom/` notification handlers, `models/` triggers

## Phase 4: Web Migration

Move from a single machine Electron app to a multi tenant web architecture: Cloudflare Workers, Neon, Clerk, Hono backend. The platform foundation and provisioning code now exist; the tenant data layer, billing, notifications, and production cutover remain to be implemented. The work is sequenced so the platform foundation lands before any payment integration, since payments need somewhere to record subscription status against.

### 06. Web platform foundation & control plane · in-progress
Stand up the Hono API, Clerk auth, and the control plane Neon project. No accounting features yet, just: can a user sign in, create an organization, get a tenant project provisioned, and see an empty dashboard.
**Done when:** creating an organization auto provisions a dedicated Neon tenant project, the control plane project records the org, its tenant pointer, and subscription status, and a signed in user with a `PROJECT_CREATED` tenant reaches an empty dashboard shell. Feature 07 later advances that tenant to `READY` after applying the accounting schema.
- [x] Design it (spec): `/architect web platform foundation & control plane`
- [x] Build it: `/develop web platform foundation & control plane`
    - [x] `worker/` scaffold: Hono app, `@clerk/hono` middleware, `wrangler.toml`
    - [x] Control plane Neon project: `organizations`, `tenant_projects`, `subscriptions`, `payments` tables — schema written (`worker/db/schema.sql`), not yet applied to a real Neon project
    - [x] `../../worker/routes/webhooks/organization-created.ts`: provisions a tenant Neon project on org creation, stores the encrypted connection string
    - [x] `worker/db/control.ts` and `worker/db/resolve-tenant.ts`
    - [x] `fyo/demux/*.ts` web implementation + `rendererWeb.ts` entry point, plus the sign-in/sign-up/org-creation/dashboard UI (`src/pages/web/`, `src/web/router.ts`)
- [x] Verify it: `/check verify web platform foundation & control plane`
- [ ] Test it: `/test web platform foundation & control plane`
- [ ] Review it: `/check review web platform foundation & control plane`
- [ ] Document it: `/document web platform foundation & control plane`
  Spec 0001. code in `worker/`, `custom/web/auth/`, `fyo/demux/`, `src/pages/web/`, `src/web/`, `rendererWeb.ts`

All 5 milestones are code-complete and typecheck clean (verified against real, currently-published package versions and types — `@neon/sdk`, `@clerk/vue` — not assumed from memory; two real bugs were caught and fixed this way: svix's `verify()` doesn't parse the payload, and `@neon/sdk`'s `orgId` is client-level config, not a per-call field). A later commit swapped `@hono/clerk-auth` (deprecated) for `@clerk/hono`, and the hand rolled `svix` webhook verification for `@clerk/hono/webhooks`' `verifyWebhook`, which also fixed the payload parsing bug above; `../../worker/routes/webhooks/organization-created.ts` documents the swap.

`/check verify` (2026-09-05) confirmed, running the worker locally (`npm install`, `tsc --noEmit`, `wrangler dev --local` with placeholder secrets): typecheck is clean; the server boots and `GET /` returns `200`; `/api/me` and `/api/dashboard` correctly return `401 Unauthenticated` with no session; `POST /webhooks/clerk/organization-created` correctly returns `400 Invalid webhook signature` for an unverified payload (AC-4's rejection path). All client side surfaces from the build plan exist (`fyo/demux/{auth,config,db}.ts` use `fetch()`, no `ipcRenderer`; `src/pages/web/{SignIn,SignUp,CreateOrganization,Dashboard}.vue`; `src/web/router.ts`; `rendererWeb.ts`), and `src/` has no direct import of `worker/` (one code comment mentions the path, not an import), holding the client/server invariant.

Still blocked, not yet provable from the build/verify environment used: AC-1's actual sign up/sign in (needs a live Clerk instance), AC-2's real provisioning path and AC-3's tables (needs a live Neon project; `worker/db/schema.sql` is still unapplied to any real Neon project), and AC-5's `PROJECT_CREATED` dashboard gate for a real authenticated session. Charles confirmed local `.env`/secrets are in place on his own machine, but that hasn't yet been exercised in an environment with outbound access to Cloudflare, Neon, or Clerk, so `Verify it` stays unticked below. Before `Verify it` can be closed: confirm the Neon, Clerk, and Cloudflare accounts/projects are live, apply `worker/db/schema.sql` to the real control plane project, and run `wrangler dev` (or `wrangler deploy`) end to end against them.

### 07. Tenant schema & data layer · in-progress
Apply the accounting schema to freshly provisioned tenant projects, and route doc CRUD through the correct per tenant connection, so the same doctypes and forms Desktop already has work through the Web stack.
**Done when:** a newly provisioned tenant project has the full accounting schema applied and marked `READY`, and generic doc CRUD routes read and write against the signed in org's own tenant project with no `org_id` column anywhere.
- [x] Design it (spec): `/architect tenant schema & data layer`
- [ ] Build it: `/develop tenant schema & data layer` (in progress, partial)
    - [x] `backend/database/core.ts`'s `DatabaseCore`: Postgres flavored client config, on `@neondatabase/serverless`'s `Pool` via the `pg` package alias in root `package.json`; fixed `connect()`'s SQLite-only `PRAGMA foreign_keys=ON`, table/foreign-key introspection, `truncate()`, and a real ordering bug `migrate()` never hit on SQLite (a fresh multi-table migrate creates tables in schemaMap order, not dependency order; Postgres validates a foreign key's target table at DDL time, SQLite doesn't — fixed with a two-phase create-then-constrain pass on Postgres only). No separate type map was needed — `sqliteTypeMap`'s values are Knex's own portable schema builder method names, not raw SQL types, so it already works on `pg` too. Proven against a real local Postgres: `migrate()` across all 74 schemas, then insert/getAll/update/delete, including a real foreign-key-bearing doctype (Party). Not yet proven against `@neondatabase/serverless`'s actual Pool specifically (no live Neon project or Neon's local proxy available in this build environment) — only against a real Postgres via the unaliased driver, which validates the SQL/schema logic but not that specific compatibility layer.
    - [x] Wired `DatabaseCore.migrate()` into `handleOrganizationCreated.ts` (new `custom/web/auth/applyTenantSchema.ts`) as the final provisioning step, `PROJECT_CREATED` → `READY` on success, `FAILED` on failure. Confirmed the actual Wrangler/esbuild bundle builds successfully with this wired in (real `wrangler deploy --dry-run`, not just typecheck).
    - [x] Generic doc CRUD routes in `worker/routes/` (`worker/routes/db.ts`: `GET /api/db/schema`, `POST /api/db/call`, `POST /api/db/bespoke`), behind feature 06's tenant resolution middleware. The flagged risk above turned out not to apply: these routes mirror `backend/database/manager.ts`'s `DatabaseManager.call()`/`callBespoke()`/`getSchemaMap()`, dispatching straight onto a per request `DatabaseCore` instance (new `custom/web/db/tenantDatabase.ts`), the same way `main/registerIpcMainActionListeners.ts` stays thin on Desktop — never through `fyo`'s `Doc`/model layer, so the `fyo/model/doc.ts` → `src/utils/erpnextSync.ts` import is never reached from this path and the tree-shaking question doesn't need answering here. Also fixed a real gap found while building this: `worker/db/resolve-tenant.ts` was still returning a one-shot `neon()` tagged-template function (feature 06's shape for control-plane lookups); nothing had called it yet, so it now resolves to the decrypted connection string instead, which `tenantDatabase.ts` uses to build the Knex backed `DatabaseCore` the spec's Decision actually calls for. `fyo/demux/db.ts`'s web branch (`getSchemaMap`, `call`, `callBespoke`) had been throwing `NotImplemented` pointing at this exact feature since feature 06 shipped the client first — replaced with real `fetch()` calls to the new routes. Method dispatch is checked against an allow list mirroring `backend/helpers.ts`'s `databaseMethodSet` (redefined locally to avoid pulling that file's `fs`/`fs/promises` imports into the Workers bundle); `close` is deliberately excluded from the list since this module opens and closes the connection itself around each call. Confirmed: worker package typechecks at the same 123 pre-existing errors as the unmodified branch (all pre-existing Electron/Vue-resolution noise, none newly introduced), and `wrangler deploy --dry-run` bundles successfully with the new imports. Not yet confirmed: an actual insert/get/update/delete round trip against a real tenant Postgres connection — no live Neon project or local Postgres available in this build environment (the sandbox's package mirror 404'd on `postgresql`), so this repeats the same unproven-driver gap already flagged on the migration step above, now for the CRUD path too.
    - [x] Migration runner utility over every `tenant_projects` row — built as a one-off operator script (`scripts/migrate-tenants.ts` behind `npm run migrate:tenants`), invocation mechanism decided 2026-09-12 (recorded in spec 0002's Decision): not an HTTP route (it touches every tenant's decrypted connection; a rollout is operator-driven between deploys, not client-reachable), not a Cron Trigger (a schema fan-out is a deliberate, observed event; unattended runs must not touch `SUSPENDED`/half-provisioned tenants). Core in `custom/web/db/tenantMigrationRunner.ts`: migrates `READY` tenants, `--org=` for a canary/repair, `--include-project-created` to recover a webhook that died mid-provisioning (conditional `PROJECT_CREATED -> READY` advance), `--dry-run` to list first; one tenant's failure is recorded and skipped, the run continues, exit code 1 if any failed. Reads the tenant's own `CustomField` rows before building the schema map (what `applyTenantSchema.ts` could not do on a fresh project). Unit-tested in `tests/tenantMigrationRunner.spec.ts` (26 assertions, faked control plane; real-Neon round trip still pending like the rest of feature 07's unproven-driver gap).
    - [x] `worker/tsconfig.json` gained `baseUrl`/`paths` matching root's and `"dom"` in `lib` — needed once any worker file reaches into `backend/`/`schemas/`/`fyo/`'s bare-specifier imports, which nothing did before this feature. Typecheck-only; doesn't change what actually ships.
      Depends on 06.
- [x] Verify it: `/check verify tenant schema & data layer`
- [ ] Test it: `/test tenant schema & data layer`
- [ ] Review it: `/check review tenant schema & data layer`
- [ ] Document it: `/document tenant schema & data layer`
  Spec 0002. code in `../../backend/database/core.ts`, `worker/routes/`, `../../worker/routes/webhooks/organization-created.ts`, `custom/web/db/tenantDatabase.ts`, `worker/db/resolve-tenant.ts`, `fyo/demux/db.ts`

Spec updated 2026-09-06, cross-checked against the actual `backend/database/core.ts` (not assumed from memory or from feature 06's shape): `DatabaseCore` is Knex, hardwired to `better-sqlite3`; the accounting schema is applied by its own existing `migrate()` (schema-driven, from the same doctype definitions Desktop uses), not a hand-written SQL file the way feature 06's tiny control-plane schema is — the original draft's "write a migration script" assumed the feature-06 shape and was wrong. Also resolved spec 0001's open Follow-up item on the Workers-compatible Postgres driver: `@neondatabase/serverless`'s `Pool`/`Client` (node-postgres compatible, via the `"pg": "npm:@neondatabase/serverless"` package alias), confirmed via Context7 + npm, not the plain `neon()` tagged-template function feature 06 uses. A same-model cross-check pass (no subagent tool available in this session to get a genuinely independent model; noting the gap rather than skipping the check) is what caught the migration-script assumption — worth another look from whoever runs `/develop` on this, given the gap in how it was caught here.

### 08. Subscription gating & seat sync · in-progress
Implement access control, the thing that replaces Keymint on Web: subscription status gating plus Clerk's native per org seat cap.
**Done when:** a request against tenant data is blocked before the tenant connection is even resolved when the org's subscription status is not `ACTIVE`, and `maxAllowedMemberships` on Clerk is kept in sync with the org's plan tier on every activation, plan change, and cancellation.
- [x] Design it (spec): `/architect subscription gating & seat sync`
  Spec [0003](../specs/0003-subscription-gating-seat-sync/index.md), updated in place 2026-09-12 after a cross-check against the actual `worker/` code (caught: the Hono `use`-after-inline-middleware ordering bug, and that the seed script physically cannot import the `worker/` package, so shared logic goes in `custom/web/billing/`).
- [x] Build it: `/develop subscription gating & seat sync`
    - [x] Shared core in `custom/web/billing/` (status read, seat sync, wire types), satisfies AC-5, AC-9
    - [x] Gate middleware + `dbRoute.use` remount + worker-side tests, satisfies AC-1, AC-2, AC-3
    - [x] `npm run seed:subscription` operator CLI (fixed upsert, required `--seats`), satisfies AC-7
    - [x] `GET /api/subscription/status` + client 402 redirect + `/billing` prompt page, satisfies AC-4, AC-8
      Depends on 07. Must never import or reference `custom/licensing/` (Keymint) anywhere in this phase.
      Built 2026-09-12. The spec's open runner question settled on vitest: `npm --prefix worker test` (16 gate/status tests, mocked Clerk auth + control plane + tenant resolver). Root tape suite covers the shared core (25 assertions, `npm test -- custom/web/billing/tests/billing.spec.ts`). Note: the live staging control plane predates `worker/db/schema.sql`'s current `subscriptions` definition — it is missing the `UNIQUE (org_id)` constraint the seed upsert's `ON CONFLICT` needs, and its status CHECK lacks `SUSPENDED`; the operator must apply those two ALTERs before first use (DDL against shared infra was left as a human call).
- [ ] Verify it: `/check verify subscription gating & seat sync`
- [ ] Test it: `/test subscription gating & seat sync`
- [ ] Review it: `/check review subscription gating & seat sync`
- [ ] Document it: `/document subscription gating & seat sync`
  Spec 0003. code in `custom/web/billing/`, `worker/middleware/subscription-gate.ts`, `worker/routes/subscription-status.ts`, `worker/routes/db.ts`, `worker/index.ts`, `scripts/seed-subscription.ts`, `src/pages/web/Billing.vue`, `src/web/subscription.ts`, `src/web/router.ts`, `fyo/demux/db.ts`, `fyo/utils/errors.ts`, `utils/ipc/types.ts`, `rendererWeb.ts`

### 15. Web accounting setup wizard · in-progress
Company and accounting setup step for Web, porting Desktop's `setupInstance.ts` (currency records, chart of accounts, fiscal year, default bank account, number series, inventory defaults) as a client side wizard. Web currently seeds only default UOMs and a Stores location and has no equivalent step, so real accounting doctypes have nothing to validate against.
**Done when:** a newly provisioned org's admin is routed to the wizard before reaching the shell, submitting it creates the same records Desktop's setup creates, `AccountingSettings.setupComplete` flips to true and the shell unlocks immediately, and tenants already `READY` before this ships are left alone.
- [x] Design it (spec): `/architect web accounting setup wizard`
  Spec [0009](../specs/0009-web-accounting-setup-wizard/index.md).
- [x] Build it: `/develop web accounting setup wizard`
  Depends on 07.
    - [x] Export the shared setup helpers from `src/setup/setupInstance.ts`, satisfies foundation for AC-4
    - [x] Add `AccountingSettings` to the web boot's loaded Singles, satisfies AC-1, AC-2 (read side)
    - [x] Web setup entry point composing the exported helpers, Electron only steps skipped, company name/full name/email sourced from Clerk, satisfies AC-3, AC-4
    - [x] Port `SetupWizard.vue` to a new web route, trimmed to 5 fields, satisfies AC-3, AC-4, AC-5
    - [x] Shell boot/router guard (admin redirect, non admin blocking screen with the org switcher still reachable), satisfies AC-1, AC-2, AC-5
    - [ ] Operator backfill: `AccountingSettings.setupComplete = true` on every existing `READY` tenant before deploy, satisfies AC-7
  code in `src/setup/setupInstance.ts`, `src/web/boot.ts`, `src/web/setupWeb.ts`, `src/pages/web/SetupWizard.vue`, `src/web/router.ts`, `src/web/shell.ts`
- [ ] Verify it: `/check verify web accounting setup wizard`
- [ ] Test it: `/test web accounting setup wizard`
- [ ] Review it: `/check review web accounting setup wizard`
- [ ] Document it: `/document web accounting setup wizard`

### 14. Web app shell (desktop UI on web) · in-progress
Mount the desktop bookkeeping UI inside the web client, so a signed in tenant browses the real app (navigation, list and form views) instead of the standalone pages. First slice: the shell plus one doctype view working end to end through the worker. Enrolled 2026-09-15 because nothing on the plan owned it, while feature 11's Settings work already assumes a shell exists to expose it, and Charles wants to explore the UI in a browser.
**Done when:** a signed in user with a `READY` tenant reaches the app shell, navigates to one doctype, and sees its records listed and editable through the same shared components Desktop uses, with the feature 08 subscription gate still enforced.
- [x] Design it (spec): `/architect web app shell`
  Spec [0008](../specs/0008-web-app-shell/index.md), written 2026-09-15 (build-time module alias swap for `src/initFyo` and `src/router`; an independent cross-check closed six completeness gaps before acceptance). Depends on 07 and 08. Does not depend on 09 or 10. `rendererWeb.ts` documents why `src/renderer.ts` and `src/utils/language.ts` cannot be reused as is (Electron `ipc` globals, the desktop `fyo` singleton); the shell slice has to answer the same question for the rest of the desktop chrome.
- [ ] Build it: `/develop web app shell`
    - [x] Alias swap, `src/router` web variant, App.vue provider set, language loader refactor, satisfies AC-7, AC-8
      Built 2026-09-15. boot.ts keeps its concrete `src/initFyoWeb` import (the alias unifies module identity on web anyway; the aliased specifier would crash the ts-node test runner against the desktop singleton); three relative bypass specifiers were fixed, not two (`errorHandling.ts` ×2, `Sidebar.vue` ×1).
    - [x] Shell mount: guarded chrome routes, dashboard as shell home, Customer list and edit routes, satisfies AC-1, AC-2, AC-5
      Built 2026-09-15. Note: the first doctype is `Party` (the Customers sidebar entry routes to `/list/Party/Customers`; there is no standalone Customer doctype), list/edit routes mirror the desktop shapes and are lazy.
    - [ ] Customer create, edit, delete round trip; fresh-tenant Company and NumberSeries precondition check; gate behavior from inside the shell, satisfies AC-3, AC-4, AC-6
      Round-trip wiring landed with the shell mount; the allowlist check (spec task 5) and the fresh-tenant precondition check (task 6) both resolved no-change (Party is manual-named, seeds nothing it needs). The live 402/READ_ONLY reproduction against staging (spec task 8) is pending for `/check verify`.
    - [x] Org switcher with boot epoch and stale-response discard, satisfies AC-9
      Built 2026-09-15: Sidebar footer switcher + sign out, `utils/db/bootEpoch.ts` checked around every web db fetch (`BootSwitchedError` discards stale responses and surfaces in-flight saves as failed).
    - [ ] Platform guards on Electron-only actions, disabled sidebar entries, desktop regression pass, satisfies AC-8, AC-10, AC-7
      Guards and disabled entries built 2026-09-15 (all touched raw `ipc` moved to `fyo/demux/shell.ts`). Regression partial: desktop renderer+main build green, typecheck/lint add zero new errors; `npm run test` cannot run on this machine (pre-existing: `scripts/runner.sh` needs zsh, and the specs hit pre-existing TS/fetch issues at baseline), full `npm run build` stops in electron-builder on a pre-existing `mac.notarize` config error; desktop dev-launch and live web smoke pending.
      code in `src/createFyo.ts`, `src/initFyoWeb.ts`, `src/web/router.ts`, `src/web/shell.ts`, `src/web/shellState.ts`, `src/pages/web/WebShell.vue`, `src/pages/web/ShellHome.vue`, `src/utils/webLive.ts`, `fyo/demux/shell.ts`, `utils/db/bootEpoch.ts`, edits in `vite.config.web.ts`, `rendererWeb.ts`, `src/initFyo.ts`, `src/errorHandling.ts`, `src/utils/ui.ts`, `src/utils/language.ts`, `src/components/Sidebar.vue`, `src/components/SearchBar.vue`, `src/components/Controls/AttachImage.vue`, `src/components/Controls/LanguageSelector.vue`, `src/pages/ListView/ListView.vue`, `src/pages/CommonForm/CommonForm.vue`, `fyo/demux/db.ts`, `fyo/utils/errors.ts`, `src/App.vue`, `src/renderer.ts`
- [ ] Verify it: `/check verify web app shell`
- [ ] Test it: `/test web app shell`
- [ ] Review it: `/check review web app shell`
- [ ] Document it: `/document web app shell`

### 09. PayPal subscriptions (non Tanzania payments) · in-progress
Recurring subscription billing for tenants outside Tanzania, plus the full entitlement ladder (14 day own clock trial, 7 day grace, 5 day read only, then locked) that spec 0003's gate enforces.
**Done when:** a tenant outside Tanzania can subscribe through PayPal, get charged on a recurring schedule, and the control plane's subscription and payments records update correctly from verified PayPal webhook events.
- [x] Design it (spec): `/architect paypal subscriptions`
  Spec [0004](../specs/0004-paypal-subscriptions/index.md), revised in place 2026-09-13 (DIY/DFY two plan model, own clock trial, webhook promote / cron demote ladder, gate and client changes 0003 deferred here); an independent cross-check pass closed thirteen completeness gaps before acceptance.
  Depends on 08. Must never import or reference `custom/licensing/api/clickpesa-client.ts` (ClickPesa); PayPal fully replaces it on Web, not alongside it.
- [ ] Build it: `/develop paypal subscriptions`
    - [x] Control plane schema + shared billing core (plans.ts, status union, gateDecision) + operator ALTER/backfill note, satisfies AC-14, AC-2/AC-10 (shared halves), AC-16 (constants)
    - [ ] Thin thread end to end: sandbox PayPal client, checkout route with durable intents and binding, verifying webhook route with promote/refresh handlers, provisioning trial row, satisfies AC-1, AC-3 to AC-8, AC-12, AC-15
    - [ ] Hourly ladder cron (refetch first, conditional rung writes, reconciliation) + gate tiering with read only refusals and status endpoint extension, satisfies AC-9, AC-10 (Worker half), AC-11 (guards), AC-16
    - [ ] Client: Billing plan cards with checkout/cancel and return polling, nudge banners, read only inline refusal, CANCELLED router lock, satisfies AC-2, AC-10 (client half), AC-11, AC-15
    - [ ] Production env separation and go live steps + no clickpesa bundle check, satisfies AC-12, AC-13
- [ ] Verify it: `/check verify paypal subscriptions`
- [ ] Test it: `/test paypal subscriptions`
- [ ] Review it: `/check review paypal subscriptions`
- [ ] Document it: `/document paypal subscriptions`

### 10. Lipa Namba manual payments (Tanzania payments) & admin review · needs a decision
Manual mobile money payment instructions for Tanzania tenants, with no live payment API integration, verified by a super admin. Includes the super admin payment review page (the only admin surface currently in scope).
**Done when:** a Tanzania tenant sees Lipa Namba payment instructions, submits a payment reference, a super admin can list, approve, or reject the pending claim, and an approved claim updates the org's subscription the same way a PayPal payment would.
- [ ] Design it (spec): `/architect lipa namba manual payments`
  Depends on 08.

### 11. Web notifications (ntfy) · in-progress
Web keeps ntfy — no provider switch. The restock/payment triggers and `src/utils/ntfy.ts` delivery are shared code the web renderer already runs; a drafted OneSignal port was reversed on 2026-09-12 before any of it was built. What's left is a verification slice, not a port.
**Done when:** a restock or payment event submitted in the hosted web app reaches the org's ntfy subscribers via the same shared code path Desktop uses — Settings fields editable per tenant on Web, a browser-origin publish observed arriving from the deployed origin, and the three existing notification specs passing unmodified on the web build.
- [x] Design it (spec): spec [0006](../specs/0006-ntfy-notifications/index.md), rewritten in place 2026-09-12 from the OneSignal port to keeping ntfy (Charles's decision)
- [ ] Build it: `/develop web notifications`
    - [ ] `POSSettings.enableMobileNotifications` / `messageChannel` reachable and persisting per tenant through the web Settings surface, satisfies AC-2 (code-complete 2026-09-13, see note below; the live per-tenant confirm is the remaining half)
    - [x] Browser-origin publish observed arriving at a subscribed ntfy client from the deployed web origin (the 2026-09-12 CORS preflight pass is necessary, not sufficient), satisfies AC-3, AC-4
    - [ ] `restockNotification.spec.ts`, `paymentMethodNotification.spec.ts`, `ntfyNotification.spec.ts` re-run on the web build configuration, satisfies AC-1, AC-5
      Depends on 07 (needs the tenant Settings round trip). No `custom/web/notifications/` module, no Worker route, no Worker secret — building any of those would be re-litigating spec 0006.
      Built 2026-09-13. AC-2: `src/web/boot.ts` boots the web `fyo` against the tenant DB (schema fetch + model registration + the two Singles), `src/pages/web/Settings.vue` mounted at `/settings` (linked from Dashboard); save goes through the shared `Doc.sync()` → demux → `POST /api/db/call` round trip feature 0002 built. Not yet confirmed: the same round trip observed from a live signed-in tenant session (needs a Clerk test account; the page itself renders and redirects to Clerk correctly in a headless check). AC-3/AC-4: `npm run check:ntfy` (Playwright Chromium, `scripts/ntfy-web-publish-check.mjs`) published from the deployed `app.rarebooks.cc` origin to a fresh random topic, HTTP 200, message observed arriving in the topic's event stream. AC-1: no notification code added or changed; delivery and triggers verified shared. AC-5: re-run of the three specs (unmodified): restock 8/8 pass; ntfyNotification test 1 and paymentMethodNotification fail one assertion each for reasons pre-existing at HEAD, unrelated to this feature: a stub-restoration race on the fire-and-forget `sendPOSNotification` (both pass with the async settled) and an assert on a `Receiving Account:` line `sendPOSNotification` has never produced (it emits `Paid Via:`). Those two, not the web path, need `/debug` (race) and possibly `/architect` (the spec's claimed "passing" state vs reality).
      Spec 0006. code in `src/web/boot.ts`, `src/pages/web/Settings.vue`, `src/web/router.ts`, `scripts/ntfy-web-publish-check.mjs` (shared delivery path unchanged: `src/utils/ntfy.ts`, `models/` triggers)

### 12. Deploy & cutover readiness · needs a decision
Operational readiness: production deploy pipeline and a final check that the invariants hold before onboarding real customers.
**Done when:** `wrangler deploy` ships the worker with production secrets configured, no Keymint or ClickPesa code is present in the deployed bundle, and a load or smoke test confirms multi tenant query scoping holds under concurrent tenants.
- [ ] Design it (spec): `/architect deploy & cutover readiness`
  Depends on 09, 10, 11, and 13 (legal pages should be live before real customers are onboarded). See also "Note on better-sqlite3 vs. Electron 22" below — unrelated to this feature's web-deploy scope, but tracked here since Desktop packaging is the other place a deploy-readiness check would apply.

### 13. Legal & compliance pages
Terms of Service, Privacy Policy, and basic compliance content, needed once real payments and tenant data are live. Not part of the original `context/build-plan.md` sub-phase list; added because Charles confirmed it in scope during planning.
**Done when:** ToS and Privacy Policy pages are published and linked from signup and billing flows.
- [ ] Build it: `/develop legal & compliance pages`

## Note on file & image storage

An earlier pass of this plan included a "tenant file & image storage" feature using Neon's S3 compatible object storage, per a preference Charles stated at the time. `context/architecture.md`'s Storage section says no shared storage bucket exists in either target currently, and that if one is ever needed it would likely be Cloudflare R2, not Neon storage, since Neon does not do blob storage. This is a real conflict between what was decided in this scope session and what the project's own architecture doc says. Dropped from this scope pass pending a decision; raise it with `/architect` (as its own feature) once you have picked a direction.

## Note on better-sqlite3 vs. Electron 22

`better-sqlite3` is pinned to `^13.0.3` (bumped during dependency work to fix an `npm install` failure on a modern host Node). That version compiles with `NAPI_VERSION=10`, which Node's own N-API version matrix confirms requires Node v22.14.0+ — Electron 22 bundles Node 16.17.1, which tops out at N-API version 8. This is a hard technical ceiling, not a soft support-policy warning: the `electron-rebuild` step targeting Electron 22 will not produce a working binary as currently pinned.

Checked every `better-sqlite3` release between the original `9.2.2` and current `13.0.3`: there is no version that is simultaneously N-API-based (needed for the host install to succeed on modern Node) and capped at N-API ≤8 (needed for Electron 22). The only two real fixes are downgrading `better-sqlite3` (which reintroduces the original, confirmed-broken host install failure) or upgrading Electron itself (a large, separate migration — Electron 22 is EOL, and `npm audit` surfaces real CVEs against it independent of this issue). Neither is minimal, so neither has been applied.

Dormant for now: nothing built or tested so far touches this, since the whole web migration (features 06 onward) never uses `better-sqlite3` at all — it's Desktop/Electron-only, for local SQLite storage. This will surface the moment `npm run dev` or a desktop package build is actually run. Worth resolving as part of whichever feature ends up owning the Electron version bump, or before then if Desktop development resumes first.

## Legend

**The decision box.** Every feature carries exactly one, the sub-task whose label ends with `(spec)`. Its wording varies, so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Feature lifecycle**: the scope updates as a feature moves; each row is what it shows and who sets it:

| State | Set by | The feature shows |
|---|---|---|
| `planned` · needs a decision | `/scope` | one box: `Design it (spec): /architect <feature>` |
| `in-progress` (designed) | `/architect` at spec capture | `Design it` ticked; spec linked; `Build it: /develop <feature>` + 2 to 5 milestones; the tier's closing boxes (`Verify it`, `Test it`, `Review it` + `Document it` for GA); any surfaced follow-up enrolled |
| `in-progress` (building) | `/develop` | milestone sub-boxes tick one by one; code pointer filled |
| `in-progress` (verified) | `/check verify` | `Build it` + milestones ticked; `Verify it` ticked |
| `done` | you, when you decide it is (any skill sets it when you say so); `/sync` reconciles | boxes you ran ticked, skipped ones marked skipped; GA's last stage (after `/document`) is the suggested point to call it done |

- **Next step** = the first unticked box (always a command or a tracked milestone).
- **needs a decision** = run `/architect` first; otherwise straight to `/develop`.
- **Atomic build tasks live in the spec's `## Build plan`, not here**: the scope carries only the milestone rollup.
- **Status** `planned` → `in-progress` → `done`, plus `existing` (pre-workflow) and `dropped` (de-scoped, kept for history).
- **Workflow tier tag** beside a heading (e.g. `· GA`, `· Prototype`) sets that one feature's rigor above or below the project default (GA); none carry an override tag here, all inherit GA.