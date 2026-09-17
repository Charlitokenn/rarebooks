# Verify: Web app shell · spec 0008 · updated 2026-09-16

_Steps derived from spec 0008 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

The first doctype is Party (the Customers view): the spec's "Customer" wording resolves to `/list/Party/Customers` (see spec build-plan task 1 note). English only, one org or two via Clerk test memberships.

## UI / manual

- [ ] Sign in (web client, `npm run dev:web:full`), land on `/` with a READY tenant → app chrome renders: sidebar + home with org name, Settings/Billing links, sign out; the old standalone `/dashboard` page is gone and `/dashboard` redirects to it → AC-1
- [ ] Reload `/`, click Settings and Billing in the home cards → both standalone pages still load; sign out → reaches `/sign-in` → AC-1
- [ ] From the shell open Sales → Customers (`/list/Party/Customers`) → the shared desktop list renders the tenant's Party rows filtered to customers, with filter and client-side pagination working → AC-2
- [ ] Reload a deep link `/list/Party/Customers` directly, and `/edit/Party/<name>` → each gates on boot: full-page loader first, chrome after, never half-mounted → AC-5
- [ ] Create a Party (Add Entry) with `role: Customer`, save, hard-reload → it appears in the list; edit a field, save, reload → persisted; the typed name is the row name (manual naming, same as desktop) → AC-3
- [ ] Delete an unused Party from the list selection → gone after reload. Try deleting a linked one (a Party with a SalesInvoice on desktop data) → the "Cannot delete … linked entries" dialog appears → AC-4
- [ ] Cancel the test org's subscription (`scripts/seed-subscription.sh` rung CANCELLED or via `/api/subscription/status` state), reload the shell → reads surface the existing 402 → redirect to `/billing` from inside the shell; set READ_ONLY → browsing lists/forms keeps working, only Save bounces to `/billing` → AC-6
- [ ] With two Clerk org memberships: switch org in the Sidebar footer dropdown → loader, then the new org's customers only; kick off a slow save and switch orgs mid-flight → the save surfaces as failed, no org-A data in the org-B list; switch back → org A's records again. Sign out from the footer → `/sign-in` → AC-9
- [ ] Walk every sidebar group on web → unmounted entries render muted with "coming soon" and do nothing on click; the Sales group opens and Customers inside it works; no entry dead-ends on a broken route → AC-10
- [ ] Desktop: `npm run dev` launches; the Customers list, export (Cmd/Ctrl+E + Export button), print, AttachImage picker, Settings language selector, Help link, and Change DB all behave exactly as before on Electron; the sidebar shows no disabled entries → AC-8, AC-10

## Commands

- [x] `npx tsc --noEmit` → same 3 pre-existing errors only (db.ts:34, misc.ts:143, device-tag.ts:276), no new ones → AC-7, AC-8
  Ran 2026-09-16: 75 errors at HEAD, byte-identical to a baseline worktree at 89071e6b (pre-change): empty diff. The "3 errors" wording is stale (the three named are among the 75; the rest pre-date the slice); the no-new-errors intent passes. → AC-7, AC-8
- [x] `npx vue-tsc --noEmit` → 109 pre-existing errors, no new files appearing in the list (compare `/tmp/vuetsc_before.txt` method) → AC-7, AC-8
  Ran 2026-09-16: 109 errors, same file set as `/tmp/vuetsc_before.txt`; only line offsets inside already-erroring edited files (e.g. AttachImage.vue 132→137). → AC-7, AC-8
- [x] `npm run build -- --nopackage` → main + renderer build green (packaging step fails identically at baseline: pre-existing `mac.notarize` electron-builder config error) → AC-8
  Ran 2026-09-16: `✓ built in 32.63s` (main + renderer). → AC-8
- [x] `npm run build:web` → green; then `grep -l "get-license-state" dist_web/assets/*.js` and `grep -l "license-state-changed" dist_web/assets/*.js` → no matches (desktop router excluded) → AC-7
  Ran 2026-09-16: build green; both greps empty. Inverse check added: `WebShell`/`rendererWeb`/`initFyoWeb` absent from `dist_electron` bundle, `get-license-state` present there (desktop bundle untouched by the alias). → AC-7
- [ ] `npm run test` → currently cannot run on this machine (pre-existing: `scripts/runner.sh` shebang `#!/usr/bin/env zsh`, zsh absent). Run on the engineer's macOS/Linux box with zsh, or after fixing the runner; must be green including `tests/webBoot.spec.ts` → AC-8
  Not run 2026-09-16: `npm run test` fails at the shebang (`env: 'zsh': No such file or directory`, pre-existing). Partial substitute: `tests/webBoot.spec.ts` run directly under node ts-node (transpile-only, moduleResolution override): 9/9 assertions green. Full suite still owed on a zsh box. → AC-8
- [x] DevTools console on web shell boot → no `ReferenceError: ipc is not defined` anywhere → AC-7
  Ran 2026-09-16 (unauthenticated; authenticated boot covered by the UI steps): headless chromium against `npm run dev:web:full` (Vite :5173 + wrangler :8787) loaded `/` and deep link `/list/Party/Customers`; zero ipc/ReferenceError console hits (only two expected 400 network logs from the unauthenticated `/api/dashboard`). Screenshots `/tmp/shell-unauth-root.png`, `/tmp/shell-unauth-deeplink.png`. → AC-7

## Value sourcing (each row of the spec's table, exercised behaviorally)

- [ ] Which tenant database to connect: sign in as a member of org A only, then org B only, then both → shell always boots the Clerk active org; switching via the footer changes which org's data appears (the browser never picks the tenant) → boot shell
- [ ] Customer list rows: create a Party in org A → it appears ONLY in org A's list, never in org B's (physical silo check from inside the shell) → Customer list
- [ ] Status screen: set the tenant to `PROJECT_CREATED` (or use a freshly provisioned org) → the shell shows the status screen with Retry and sign out, not an error stack, not chrome; seed it forward to READY → Retry enters the chrome → Status screen
- [ ] 402 `code`/`status`: with the subscription seeded CANCELLED, any list fetch redirects to `/billing` and Billing shows the denied status from its own re-read → 402 redirect
- [ ] Sidebar enabled state: entries follow the mounted-route list; add a route to `WEB_LIVE_ROUTES` (throwaway branch) → the entry lights up, prove the mechanism, revert → Sidebar entry enabled state
- [ ] Org switcher entries: a user in two orgs sees both in the dropdown; a user in one org sees no switcher confusion (single option, or hidden) → Org switcher entries
- [ ] Displayed strings: shell renders source strings (English passthrough), no `t` crashes, list labels come from the schema (e.g. "Party" label, filter labels) → Displayed strings
- [ ] New Party name: type "Test Party" → row name is exactly the typed value (manual naming end to end through `/api/db/call`) → New Customer name

## Acceptance-criteria coverage

- AC-1 covered by UI steps 1, 2, 9 · AC-2 by 3, commands (bundle check) · AC-3 by 5, sourcing (New Party name) · AC-4 by 6 · AC-5 by 4, 8, sourcing (Status screen) · AC-6 by 7, sourcing (402) · AC-7 by commands (grep, console) + UI 1 · AC-8 by UI 9 + commands (tsc, build, test) · AC-9 by UI 8 + sourcing (which tenant, list rows) · AC-10 by UI 8, 9 + sourcing (sidebar state)
