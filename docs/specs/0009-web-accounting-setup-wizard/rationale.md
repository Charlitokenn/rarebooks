## Context

Desktop never lets a user touch the app before `setupInstance.ts` runs: it collects company, country, currency, bank, chart of accounts, and fiscal year details through `SetupWizard.vue`, then writes a full set of `Currency`, `Account`, `NumberSeries`, and `InventorySettings` records before the first screen appears. Web has no equivalent step. `CreateOrganization.vue` only mounts Clerk's generic organization creation widget, and `applyTenantSchema.ts` (the code that turns a freshly provisioned tenant into `READY`) seeds only default units of measure and a `Stores` location, a fact its own comment already calls out as a gap: "Web has no equivalent wizard step." Spec 0008 flagged the same gap when it built the shell's first doctype view, noting a Web `setupInstance` equivalent "stays a real need for later doctypes," but no scope feature was ever enrolled for it.

The consequence of not deciding this is concrete: every accounting doctype Web will eventually expose (invoices, journal entries, payments) needs a chart of accounts and a currency to validate against, and none exists today. A tenant that reaches the shell right now has an empty ledger with no way to fill it in except through Desktop, which defeats the point of a hosted product.

The forces at play are mostly about reuse, not new design. Desktop's `setupInstance.ts` already solves this problem correctly, including idempotent record creation and country driven defaults; the question is how much of it Web can reuse without inventing a parallel implementation, and how much of Desktop's exact field set and country list still makes sense once Clerk already collects company name at org creation.

## Options considered

### Option 1: Client side port through shared helpers and the existing form component

Export `setupInstance.ts`'s constituent functions, call them from a new Web entry point that skips the Electron only steps, and port `SetupWizard.vue` as a trimmed form, writing through the same client side Fyo `doc.sync()` path the Web shell already uses for every other doctype.

**Pros**:
- No new server route or infrastructure.
- Reuses proven, already idempotent logic almost as is; one source of truth for the accounting rules both platforms follow.
- Smallest, fastest slice to ship, fitting the project's Tracer Bullet build approach.

**Cons**:
- Requires exporting previously private functions from a file that otherwise belongs to Desktop.
- The admin only restriction can only be enforced in the UI, since there is no new route to gate server side.

### Option 2: New dedicated Worker orchestration endpoint

Build one Worker route that accepts the wizard's payload and performs every write server side inside a single request, transactionally.

**Pros**:
- True atomicity: every write succeeds or none do, in one transaction.
- A natural place to add a server side admin check with a 403, matching spec 0004's billing pattern exactly.

**Cons**:
- Duplicates logic that already exists and works through the client side path; a new route to build, test, and maintain on its own.
- Buys atomicity the feature does not need, since every write here is already independently idempotent (the existing `checkAndCreateDoc` check), so a partial failure is already safe to resume without a transaction.

### Option 3: Fully isolated duplicate under `custom/web/`

Rewrite the setup logic as new, Web only code under `custom/web/setup/`, with no shared functions and a purpose built Web UI, following the isolation pattern `custom/licensing/AGENTS.md` describes for fork sensitive code.

**Pros**:
- Maximally fork safe; no risk that an upstream change to `setupInstance.ts` ever affects Web.
- Matches the project's existing convention of isolating Web specific code under `custom/web/`.

**Cons**:
- Duplicates genuinely complex, country driven business logic (chart of accounts selection, currency defaults, fiscal year defaults) that will drift the moment Desktop's version changes.
- Roughly doubles the code to write and test for behavior that already exists and works.

## Rationale

Option 1 is the only choice that ships a working slice without inventing new server infrastructure or duplicating logic that already works. The project's Tracer Bullet build approach favors a thin, complete thread end to end over a heavier build, and the Web shell already proxies every other doctype's writes through the same client side Fyo path with no doctype specific server logic, so following that same shape here is the path of least new surface area, not a shortcut.

Option 2's transactional atomicity does not solve a real problem: every write `setupInstance.ts` already makes is independently idempotent by design (`checkAndCreateDoc` checks before every insert), which is exactly why the resume behavior in AC-6 works without a transaction. Paying for a new route and a new failure mode to get atomicity nothing here needs is not a good trade.

Option 3's isolation instinct is right for code where the project has explicitly said it wants isolation, third party payment and licensing integrations that must survive a fork rebase, per `custom/licensing/AGENTS.md`. Accounting setup rules are not that: they are core business logic Desktop already got right, shared by definition across both platforms, and duplicating them under `custom/web/` would recreate the same India specific regional logic, the same country to currency defaults, and the same chart of accounts fallback behavior a second time, with no mechanism to keep the two in sync.

The one real cost of Option 1, that `src/setup/setupInstance.ts` is no longer purely Desktop's file, is small and already true elsewhere in this migration: `backend/database/core.ts`, `fyo/demux/*.ts`, and other core files were already extended, not just Desktop's `custom/` tree.
