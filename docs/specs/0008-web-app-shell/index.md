# 0008. Web app shell (desktop UI on web)

**Date**: 2026-09-15
**Status**: In Progress


_Build contract only; the decision history (Context, Options considered, Rationale) is in [rationale.md](rationale.md)._
## Summary


The signed-in web app today is a handful of standalone pages (dashboard, settings, billing) that talk to the tenant database directly. This spec mounts the real desktop bookkeeping UI inside the web client: the same sidebar, list views, and forms Electron users see, fed by the existing worker API routes. The trick is that 49 files import the desktop app instance through one module path, `src/initFyo`, which is Electron bound; the web build swaps that path for a web version at bundle time, so the desktop files keep their imports untouched. The first slice proves the shell with one record type, Customer, listed and edited end to end through the worker, with the subscription gate still enforced.

## Requirements


**User stories**:
- As a signed-in member of a READY tenant, I want the real app (sidebar, lists, forms) in a browser so that I can do bookkeeping work without installing the desktop app.
- As the operator, I want the shell to reuse the desktop components so that the two products do not drift apart.
- As a pilot tester with two organizations, I want to switch between them in the browser so that I can review each tenant's data.

**Acceptance criteria**:
- **AC-1**: A signed-in user whose tenant is READY and who opens `/` sees the app chrome (sidebar plus workspace) with the current Dashboard content (org summary, links to Settings and Billing, sign out) as the shell home. The standalone dashboard page is replaced, not kept beside it.
- **AC-2**: From the shell, navigating to Customer shows the tenant's customer list rendered by the shared desktop list components, paginated and filtered, through the existing worker routes. Data calls use only methods the worker's dispatch allowlist already carries; if the list path needs one it lacks (e.g. `count`), the build adds it to the allowlist and the gate's read/write classification, never a new route.
- **AC-3**: Creating a Customer in the web shell and editing an existing one persist through the shared code path (`Doc` sync to `POST /api/db/call`), the row exists in the tenant database after a reload, and series numbering behaves the same as desktop (the client computes the name through the shared naming code over the worker CRUD path, as desktop does).
- **AC-4**: Deleting a record from the shared list selection works on web through the same path. Server-side link protection (a Customer with linked Invoices refuses deletion) surfaces as the error display desktop already shows.
- **AC-5**: The boot guard wraps every chrome route, so opening or reloading a deep link such as `/list/Customer` directly gates on boot too. While the tenant database connects, the route shows a full page loading state. When the tenant is not READY, or connecting fails, a status screen offers tenant status, retry, and sign out. The shell never renders half-booted on any route.
- **AC-6**: Every tenant-data route stays behind the feature 08 gate unchanged: a CANCELLED or missing subscription means `402` and the existing redirect to `/billing`; a READ_ONLY tenant can still browse lists and forms and only its saves bounce. This slice ships no new gate UI.
- **AC-7**: The 49 files importing `from 'src/initFyo'` are not edited; neither are the files importing `from 'src/router'` (`src/utils/ui.ts`, `Sidebar.vue`). In the web bundle both module paths resolve to web variants (same alias mechanism), and the shell replicates App.vue's provide set (shortcuts, searcher, language direction, keys) so injected chrome works. The desktop bundle is untouched. No `ReferenceError` from the desktop singleton during web boot.
- **AC-8**: Shared-code edits (the language loader, the sidebar's external-link open, hiding Electron-only actions like list export and print) keep desktop behavior identical, guarded on the platform flag; guards read `fyo.isElectron` through the injected or aliased fyo, which keeps them declarative (what platform am I on), while the behavior itself stays behind the demux or an equivalent web-safe call, honoring the `AGENTS.md` rule that platform knowledge flows through `fyo/demux` (raw `window.ipc` calls in `src/utils/ui.ts` predate that rule; each one this slice touches moves to a demux-backed call for both platforms). The desktop build (`npm run build`) and desktop dev launch still work, and `npm run test` stays green.
- **AC-9**: The shell offers an org switcher for users in multiple Clerk organizations. Switching tears down and reboots the web instance against the new tenant (`resetWebFyo` exists) and shows the new tenant's customers. Data calls are stamped with the active org at dispatch, and results from a stale org are discarded (a monotonic boot epoch, checked before applying any list or save response), so no in-flight request from org A can land data in a booted org B. The old tenant's records are unreachable from the switched session.
- **AC-10**: Sidebar entries with no live destination yet render disabled or "coming soon"; nothing in the shell dead-ends to a broken route. The web UI ships English only in this slice; web i18n is the first Follow-up item.

## Decision


**Chosen option**: Option 1: Build-time module alias swap.

The web bundle resolves the two shared module paths the desktop chrome imports (`src/initFyo` and `src/router`) to web variants at build time; the shell mounts the existing desktop chrome (Desk plus Sidebar) with the current dashboard wrapped as the shell home, the existing worker routes under the feature 08 gate unchanged, and the org switcher riding Clerk plus `resetWebFyo`.

## Feature design


**Data model sketch**:
No new persisted entities. The shell is pure client wiring over the existing tenant schema (spec 0002) plus Clerk's existing org membership. The customer view uses the accounting schema's existing `Customer` doctype (name, fullName, email/phone/address fields, server-generated series name). Web-only client state (which org booted, boot status) lives in memory and `sessionStorage`, as today.

**State transitions** (shell boot state machine, client side):
`idle` (signed-in route, not booted) → `booting` (loader, `ensureWebFyoReady` in flight, deduped per org) → `ready` (chrome renders) → `switching` (org switch, reset then booting for the new org) and → `unavailable` (tenant not READY, connect failure, or 401: status screen with retry and sign out). A 402 from any data call routes to `/billing` through the existing global net, leaving the state machine alone.

**API surface** (all reused; worker changes limited to dispatch allowlist additions, zero new routes):
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/dashboard` | GET | active org session | tenant status, org | Clerk org session | 401, non-READY status |
| `/api/db/schema` | GET | — | schema map | Clerk org session + gate | 401, 402 |
| `/api/db/call` | POST | `method` (dispatch vocabulary: `get`, `getAll`, `getSingleValues`, `exists`, `insert`, `update`, `delete`, `deleteAll`, `rename`; `count` if the list path needs it, see task 5), args | rows, saved doc | Clerk org session + gate | 402 `SUBSCRIPTION_INACTIVE` / `SUBSCRIPTION_READ_ONLY`, `InvalidDatabaseMethodError` for non-allowlisted methods |
| `/api/db/bespoke` | POST | bespoke query name + args (read set incl. `getLastInserted`) | bespoke rows | Clerk org session + gate | 402 (read only permitted) |
| `/api/subscription/status` | GET | — | gate status | Clerk org session | — |

**Value sourcing**:
| Action | Value produced / displayed | Source |
|---|---|---|
| Boot shell for current org | which tenant database to connect | Clerk active organization (`useClerkAuth` in `src/web/`), resolved to the tenant connection by the worker control plane (spec 0001) |
| Customer list | the rows | `GET` of the tenant database scoped by the per-tenant connection (no `org_id` column; isolation is one database per org, spec 0001) |
| Status screen | tenant status | `GET /api/dashboard` response (the pre-check `ensureWebFyoReady` already calls) |
| 402 redirect | subscription state | `code` and `status` fields in the worker's 402 body (spec 0003) |
| Sidebar entry enabled state | which routes are live | client-side constant list of mounted routes, set by this build (decided here, not a data value) |
| Org switcher entries | the orgs one user belongs to | Clerk SDK `user.organizationMemberships` (client SDK data) |
| Displayed strings | translations | `rendererWeb.ts` sets `fyo.store.language = 'English'` and never installs the IPC-backed language map, so `t` falls through to the source string. English passthrough is the mechanism, not a hidden default. |
| New Customer name | the series number | existing server-side doc creation path through `/api/db/call` (same code desktop runs) |

**Key invariants**:
- Exactly one web `fyo` instance exists per booted org; an org switch resets before booting the next, so no stale schema or db handle survives a switch.
- The web bundle never evaluates Electron globals (`ipc`); after this slice, nothing under `src/` reachable from `rendererWeb.ts` imports the desktop singleton or calls `ipc` at module top level (guarded at call time).
- Every tenant-data request carries the Clerk org session and passes the same gate desktop-adjacent pages use; the shell adds no bypass.

**Security model**: Clerk session restricts the shell to org members; the worker resolves the tenant from the org claim, so the browser never chooses which tenant database it talks to (per spec 0001 isolation, unchanged). The feature 08 gate fails closed on control-plane errors (503, no billing redirect), which the shell surfaces as `unavailable`. No new roles; no regulated data leaves its tenant database. Business data is customer PII (names, phone, email): the exposure surface is identical to the standalone pages already in production.

**Configuration required**:
None. No new env vars, worker secrets, or Clerk settings beyond the existing org-membership session already configured for the standalone pages.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: signed in, READY tenant, `/` shows chrome; navigate to Customer, create one, reload, find it in the list; edit it, reload, edits persisted, verifies **AC-1**, **AC-2**, **AC-3**
- Happy path: delete an unused Customer from the list selection; it disappears after reload, verifies **AC-4**
- Failure case: tenant at `PROJECT_CREATED` (schema not applied): status screen with retry and sign out, never a half-mounted shell; recover after the tenant reaches READY, verifies **AC-5**
- Failure case: cancel the subscription, then browse (reads pass or gate bounces per spec 0003) and try a save under READ_ONLY: the redirect to `/billing` fires from inside the shell, and READ_ONLY browsing of lists keeps working, verifies **AC-6**
- Permission: switch org A to org B in the switcher; org B's list shows only org B's customers; an in-flight A request cannot land data in the B session, verifies **AC-9**
- Permission: user from an unrelated org hitting the shell: no tenant resolves, `unavailable` screen, verifies **AC-6**
- Regression: `npm run build` (desktop) succeeds, `npm run dev` desktop app launches with the language system and sidebar unchanged, `npm run test` green, verifies **AC-8**, **AC-7**

## Build plan


Ordered as a Tracer Bullet: first a thread thin enough to bend (boot, one list, one form), then thicken with the states, the switcher, and the regression proof.

1. [x] `src/createFyo.ts` (shared construction) plus the `src/initFyo` alias target for web, reusing the existing `src/initFyoWeb.ts` (already exports `fyo` and `resetWebFyo`; the web variant's contract is: export everything `src/initFyo` exports, plus `resetWebFyo`, so `src/web/boot.ts` can switch to importing from `src/initFyo` too and one module identity serves all importers on web). Second alias entry: `src/router` resolves to the web router variant for web bundles (`src/router.ts` constructs the desktop router and eagerly imports every desktop page; `src/utils/ui.ts` and `Sidebar.vue` import it directly). Both entries ordered before the broad `src` prefix alias in `vite.config.web.ts`, satisfies **AC-7**
   Built 2026-09-15. Ground corrections: `src/web/boot.ts` deliberately keeps importing `src/initFyoWeb` concretely — the alias already gives one module identity on web (both specifiers resolve to the same file), while the aliased specifier would make the ts-node test runner resolve to the desktop singleton and crash `tests/webBoot.spec.ts`. The import audit found three relative bypass specifiers, not two: `src/errorHandling.ts` (`./initFyo`, `./router`) and `Sidebar.vue` (`../router`) were switched to the aliased specifiers (desktop-resolved files unchanged). Also note: there is no standalone `Customer` doctype; the first view is `Party` (`/list/Party/Customers`, the `routeFilters.Customers` filter) — the rest of this plan's "Customer" means that Party view. AC-5's `/list/Customer` example should be read as `/list/Party/Customers`. `/architect` to amend wording; no decision changes.
2. [x] Refactor `src/utils/language.ts` to take `fyo` as a parameter (or lazy-load it), removing its top-level desktop-singleton import as its blocker comment requires, satisfies **AC-8**
   Built 2026-09-15. `setLanguageMap(fyo, ...)`; the raw `ipc.reloadWindow`/`getLanguageMap` calls moved to `fyo/demux/shell.ts` (web: English passthrough kept per AC-10, `window.location.reload`). Callers updated: `renderer.ts`, `App.vue`, `LanguageSelector.vue`.
3. [x] Mount the chrome: a web Desk route page that replicates `src/App.vue`'s provide set (keys registry, searcher, shortcuts, language direction) since App.vue is not mounted on web, renders Sidebar plus the workspace, and wraps the current Dashboard content as the shell home. The boot guard is a parent-route wrapper over all chrome children, so direct opens and reloads of `/list/Customer` gate too. Web router `/` (and the `/dashboard` redirect) mounts the shell; Customer list and edit routes reuse the desktop route shapes (`/list/:schemaName`, `/edit/:schemaName/:name`), lazily imported so the web bundle stays small, satisfies **AC-1**, **AC-5**, **AC-2**
   Built 2026-09-15 as `src/pages/web/WebShell.vue` (parent route, boot state machine, App.vue provides replicated, `#toast-container` and desktop error handlers added to the root mount in `rendererWeb.ts`), `src/pages/web/ShellHome.vue` (the old Dashboard content as shell home; the standalone page replaced, `/dashboard` redirects), `src/web/shell.ts` + `src/web/shellState.ts` (idle/booting/ready/unavailable, PROVISIONING waits, 402 routes to /billing). List/edit routes lazy, desktop shapes mirrored incl. the named `edit` view.
4. [x] Sidebar on web: replace `ipc.openLink` with `window.open` behind the platform flag, render disabled entries for routes not yet mounted, keeps Settings and Billing links pointed at the standalone pages, satisfies **AC-10**
   Built 2026-09-15: `openDocumentation` and SearchBar's `openDocs` through `fyo/demux/shell.ts`; entries whose route isn't live render muted with a "coming soon" tag and are inert (`src/utils/webLive.ts` mounted-route list; group click resolves to its first live descendant, so Customers under Sales opens); Settings/Billing links stay pointed at the standalone pages.
5. [x] Customer round trip through the shared components: check the list page's fetch path against the dispatch allowlist in `custom/web/db/tenantDatabase.ts` (`getAll`, `getSingleValues`, `exists` are listed; `count` is not, and the desktop list paginates via `getAll` limits, so this is expected to be a no-change task unless the check finds otherwise; a needed addition goes to the allowlist and the gate's read classification, never a new route). The create-name path is already web-capable: `fyo.db.getLastInserted` dispatches as a bespoke call, and `getLastInserted` is on the bespoke read allowlist (verified at spec time). Create, edit, delete, and link-protection error display, satisfies **AC-3**, **AC-4**
   Checked 2026-09-15: confirmed no-change. `fyo.db.count` is client-side over `getAll` and never dispatches `'count'`; the Party list/create/edit/delete path touches only {getAll, getSingleValues, exists} read + {insert, update, delete} write, all allowlisted; Party is `naming: manual`, so no series call crosses the wire at all.
6. [x] Fresh-tenant precondition check: confirm a READY tenant provisioned by the spec 0001 flow carries the records AC-3's creation path needs (Company, the `CU` NumberSeries row). If provisioning seeds none, add the seeding to the tenant migration path (spec 0002's `DatabaseCore.migrate()` runner / `npm run migrate:tenants`), because Customer creation cannot pass without it, satisfies **AC-3**
   Checked 2026-09-15: the premise is wrong against the code, no seeding needed. There is no `Company` doctype (company identity is `AccountingSettings.companyName`) and no `CU` NumberSeries exists or is needed (Party naming is manual). Provisioning (`applyTenantSchema.ts` → `DatabaseCore.migrate()`) seeds Single defaults and zero doc rows, and Party create tolerates that (currency has a schema default; `exists('Account','Debtors')` returning false is handled). A web `setupInstance` equivalent (accounts, currencies, series) stays a real need for later doctypes (SalesInvoice), tracked as scope work, not this slice.
7. [x] Electron-only actions in shared components (list export, print, file dialogs) hidden behind the platform flag, with the underlying call moved to a demux or web-safe equivalent per AC-8; zero new dialogs on web, satisfies **AC-8**, **AC-10**
   Built 2026-09-15: list Export button and the Cmd/Ctrl+E shortcut are Electron-only; print button Electron-only (no `/print` route on web); `ui.ts` selectFile/getSavePath/deleteFile/getOpenFilePath/showItemInFolder, ExportWizard's `saveData`, AttachImage's picker, and `errorHandling.ts` sendError/showError/reportIssue all moved behind `fyo/demux/shell.ts` for both platforms (web: DOM file input, blob download, console fallbacks).
8. Gate behavior check from inside the shell: reproduce the 402 read-only and inactive cases against staging with the seed script, no code changes expected, satisfies **AC-6**
   Not ticked: no code changes were needed (the 402 net, gate classification, and READ_ONLY read/write split all pass through unchanged; the shell routes through the same gated `/api/db/*` calls), but the staging reproduction itself is a live check for `/check verify`.
9. [x] Org switcher: Clerk membership list in the chrome; switching increments a boot epoch, stamps dispatched data calls with the active org, resets via `resetWebFyo`, reboots guarded, and discards responses whose stamp is stale (AC-9's rule); an in-flight save during a switch is surfaced as failed rather than silently retried against the old tenant, satisfies **AC-9**
   Built 2026-09-15: switcher select + sign out in the Sidebar footer (web block where Desktop shows Change DB), `utils/db/bootEpoch.ts` bumped before `clerk.setActive`, checked before/after every web `/api/db` fetch in `fyo/demux/db.ts` (stale response discarded as `BootSwitchedError`, in-flight saves surface as failed), reboot rides `ensureWebFyoReady`'s per-org reset.
10. Desktop regression pass: `npm run build`, desktop dev launch, `npm run test`, and a shared-component smoke of the desktop list view; fixes land in the same PR, satisfies **AC-7**, **AC-8**
    Partial 2026-09-15: desktop renderer + main builds green (`npm run build -- --nopackage`), `tsc`/`vue-tsc` add zero new errors (109 → 109, all pre-existing), changed files lint clean. Pre-existing breakages found, untouched by this slice: electron-builder's packaging step fails on a `mac.notarize` config schema error (identical at baseline, needs a `package.json`/config fix), `npm run test` cannot run on this machine at all (`scripts/runner.sh` shebang is zsh, not installed; the tape specs under node also hit a pre-existing `Invoice.ts` TS2352 + an Electron-node-16 `fetch` stub gap in `webBoot.spec.ts`, both present at baseline), and the desktop dev-launch smoke is pending (needs a GUI session). Live web smoke (the round trip itself) pending too; that is `/check verify`'s job.
11. `/check verify` against every AC, then the GA workflow (`/test`, `/check review`, `/document`), satisfies **all ACs**

## Consequences


**Positive**:
- The real product becomes browsable in a browser immediately after this slice, which unblocks feature 11's settings-in-a-shell assumption and gives feature 10's admin review page a place to mount.
- One component tree stays one tree: every future desktop page mounted on web is a route plus a guard, not a rewrite.
- The alias mechanism, once proven, makes the later "retire the standalone pages" question cheap.

**Negative / tradeoffs**:
- Shared desktop files get edited (language, sidebar, list view guards): every change is a desktop regression candidate, mitigated by guards and the task 9 pass, not eliminated.
- The build-time alias hides module identity from readers and type resolution in editors; a second `src/initFyo`-style specifier added ad hoc later can resolve inconsistently unless the rule is recorded (it goes to `/sync` as a follow-up).
- English only, one doctype, and standalone Billing and Settings pages outside the chrome mean the shell is visibly a skeleton until features 09 to 11 land; the desktop `/settings` route name collides with the web standalone `/settings`, so that path needs care when the standalone page eventually moves in.

**Neutral**:
- No schema change, no worker change (unless task 5's doc-method check finds a gap), no new secrets.
- `src/router.ts` (desktop) stays untouched; the web router grows the two desktop-shaped routes lazily.

## Follow-up


- [ ] Serve the translation map to the web client (HTTP endpoint or static bundle) and give `rendererWeb.ts` a real language store instead of the English passthrough.
- [ ] Decide where standalone Billing and Settings finally live: mounted inside the chrome (with the desktop `/settings` name collision resolved) or kept as web-only pages.
- [ ] Record the `src/initFyo` and `src/router` alias rule in the project context files via `/sync` so no second desktop-bound module path is introduced outside it.
- [ ] When a third desktop page mounts on web, evaluate the Option 3 dependency injection refactor against the accumulated alias pattern.
