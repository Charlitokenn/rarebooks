# 0009. Web accounting setup wizard

**Date**: 2026-09-18
**Status**: In Progress

## Summary

Web has no equivalent of Desktop's company and accounting setup step, so a signed in tenant reaches an app with no chart of accounts, no currency, and no fiscal year, and real accounting doctypes have nothing to validate against. This decision ports Desktop's `setupInstance.ts` logic to Web as a small client side wizard, reusing the same helper functions, the same form component, and the same generic API path the Web shell already runs on. No new server route is needed.

## Requirements

**User stories**:
- As a new org admin, I want to enter my country, currency, bank name, chart of accounts template, and fiscal year once, so my org has a working set of accounts before I start recording transactions.
- As a non admin member of a brand new org, I want a clear message if my org is not set up yet, so I understand why I cannot use the app yet.
- As the platform, I want existing tenants left alone by this change, so nothing already in production gets an unexpected setup prompt.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: A signed in Clerk org admin or owner whose org has `AccountingSettings.setupComplete` false is routed to the setup wizard before reaching the shell.
- **AC-2**: A signed in member who is not an org admin or owner, in an org whose setup is not complete, sees a blocking message telling them to ask their admin to finish setup, not the wizard and not the shell.
- **AC-3**: The wizard collects exactly five fields: country, currency, bank name, chart of accounts template, and fiscal year start and end. Company name, full name, and email are read from the signed in Clerk organization and user, never asked again.
- **AC-4**: Submitting the wizard creates the same records Desktop's `setupInstance.ts` creates for these inputs, currency records for every world currency, the selected chart of accounts under `Account`, the default bank, discount, write off, and round off accounts, default `NumberSeries` per doctype, and `InventorySettings` defaults, using the same client side `doc.sync()` calls the Web shell already runs through `/api/db/call`. No new Worker route is added.
- **AC-5**: Completing the wizard sets `AccountingSettings.setupComplete` to true and the shell becomes reachable immediately, with no page reload, consistent with the boot epoch pattern spec 0008 already built.
- **AC-6**: If an admin's submission is interrupted partway through (for example the tab closes while the server writes are still running), returning to the wizard shows a blank form again, and resubmitting is safe: records already created are not duplicated, matching the existing `checkAndCreateDoc` idempotency check every one of these writes already goes through.
- **AC-7**: Every tenant already `READY` before this feature ships has `AccountingSettings.setupComplete` backfilled to true by a one time operator step, so the blocking redirect only ever applies to orgs created after this ships.

## Decision

**Chosen option**: Option 1: Client side port through shared helpers and the existing form component.

Web gets its own thin setup entry point that calls the same exported helper functions Desktop's `setupInstance.ts` already contains, driven by a Web hosted copy of the `SetupWizard` form trimmed to five fields, writing through the client side Fyo path the Web shell already uses for every other doctype.

## Feature design

**Data model sketch**: No new entities. This reuses schemas already present in every tenant's migrated database:
- `AccountingSettings` (singleton): sets `country`, `bankName`, `fiscalYearStart`, `fiscalYearEnd`, `companyName`, `fullname`, `email`, and finally `setupComplete`.
- `SystemSettings` (singleton): sets `country`, `currency`, `locale`, `countryCode`, `instanceId`.
- `Currency`: one record per world currency (`name`, `fraction`, `fractionUnits`, `smallestValue`, `symbol`), matching Desktop.
- `Account`: the selected chart of accounts tree, plus the default bank account, a discount account, and write off and round off accounts.
- `NumberSeries` and the `Defaults` singleton: one series per doctype that declares a `numberSeries` field.
- `InventorySettings` (singleton): valuation method and default stock accounts and location.
- `SetupWizard`: the existing virtual form doctype (`schemas/app/SetupWizard.json`) already migrated to every tenant, unused until now. Web renders only its `country`, `currency`, `bankName`, `chartOfAccounts`, `fiscalYearStart`, `fiscalYearEnd` fields; `logo`, `companyName`, `fullname`, `email` stay in the schema but are not shown, since those values come from Clerk instead.

**State transitions**: `AccountingSettings.setupComplete`: `false` (every tenant's starting value) to `true`, set once by the wizard's submit handler. One direction only; nothing sets it back to false.

**API surface**:
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/db/call` (existing, spec 0002) | POST | `method: 'set'/'sync'` on `SetupWizard`, `AccountingSettings`, `SystemSettings`, `Currency`, `Account`, `NumberSeries`, `Defaults`, `InventorySettings` | updated docs | Clerk session, existing tenant resolution | existing generic errors, no new ones |

No new route. The only server side addition is the operator backfill script for AC-7, not a request path.

**Value sourcing** (every value each action produces, computes, or displays names where it comes from):
| Action | Value produced / displayed | Source |
|---|---|---|
| Render wizard (first visit or after an interruption) | Country field's starting value | Preselected to Tanzania, the primary target market; the admin can change it |
| Render wizard | Currency, fiscal year defaults once a country is chosen | The existing `getCountryInfo()` and `getFiscalYear()` utilities' country based defaults |
| Submit wizard | `AccountingSettings.companyName` | The signed in Clerk organization's name, already collected at org creation (`CreateOrganization.vue`) |
| Submit wizard | `AccountingSettings.fullname` | The signed in Clerk user's full name from their session |
| Submit wizard | `AccountingSettings.email` | The signed in Clerk user's primary email from their session |
| Submit wizard | Chart of accounts tree | The existing `getCOA()` loader, which already falls back to `standardCOA.json` for a country with no dedicated template |
| Submit wizard | `SystemSettings.locale`, `countryCode` | Derived from the chosen country via the existing `getCountryInfo()` / `getCountryCodeFromCountry()` utilities |
| Submit wizard | `SystemSettings.instanceId` | Generated by the existing `getRandomString()` utility |
| Gate check at boot | `AccountingSettings.setupComplete` | Added to the Web boot's loaded Singles, the same pattern `loadNotificationSingles()` already uses for `POSSettings` |
| Gate redirect | Whether the signed in user is an org admin or owner | The Clerk organization membership role already read for the billing checkout guard in spec 0004 |

**Key invariants**:
- Every tenant has exactly one `AccountingSettings.setupComplete` value; once true it is never reset by this feature.
- Every write this feature makes reuses the existing `checkAndCreateDoc` style idempotency check, so re running the wizard after a partial attempt never creates a duplicate `Currency`, `Account`, or `NumberSeries` row.
- This feature never writes to the control plane project or to `subscriptions`; it is entirely tenant database local and unrelated to the entitlement ladder spec 0004 built.

**Security model**: The completion gate is enforced only in the Web client (the shell's boot and router logic), the same way Desktop treats its own setup gate, since this is the org's own private data, not a system wide security boundary; the actual tenant isolation and subscription gate (spec 0003) are unaffected and still enforce the real boundary. The admin only restriction on who sees and can submit the wizard is also enforced at the UI level only, not by a new server side role check. This is a deliberate difference from spec 0004's billing checkout, which does enforce admin only server side with a 403, because billing controls real money and entitlements while this feature only writes accounting configuration inside data the org's own members can already read and write through the existing generic route. See Follow up for when that assumption should be revisited. A non admin's blocking screen keeps the existing org switcher reachable, since they may belong to another, already set up org and should not be fully stuck.

**Configuration required**: None. No new environment variables or credentials.

**Critical test scenarios** (each maps to an acceptance criterion in ## Requirements):
- Happy path: a new org's admin signs in, is routed to the wizard, submits all five fields, and lands in the shell immediately with a full chart of accounts, currency, and fiscal year in place. Verifies **AC-1, AC-3, AC-4, AC-5**.
- Resume case: an admin's tab closes while the submit action's writes are still running, after the currency records are created but before the chart of accounts import finishes; returning to the wizard shows a blank form, and resubmitting does not duplicate the currency records already created. Verifies **AC-6**.
- Auth/permission: a non admin member of an unconfigured org sees the blocking message, never the wizard, never the shell. Verifies **AC-2**.
- Backfill: a tenant that was already `READY` before this feature shipped is not redirected to the wizard on its next sign in. Verifies **AC-7**.

## Build plan

Tracer Bullet (project default): tasks 1 through 4 stand up a thin, complete setup thread end to end for a brand new org, then tasks 5 and 6 add the resume and legacy tenant behavior around it.

1. Export the constituent helper functions from `src/setup/setupInstance.ts` (`createCurrencyRecords`, `createAccountRecords`, `createRegionalRecords`, `createDefaultNumberSeries`, `updateInventorySettings`, `updateAccountingSettings`, `updateSystemSettings`, `completeSetup`) without changing Desktop's own default export or behavior. Satisfies the foundation for **AC-4**.
2. Add `AccountingSettings` to the Web boot's loaded Singles, extending the pattern `loadNotificationSingles()` already uses in `src/web/boot.ts`. Satisfies the read side of **AC-1, AC-2**.
3. Build a Web setup entry point that composes the exported helpers, skipping the Electron only pieces (`initializeDatabase`'s `dbPath` step, since the schema is already applied by `applyTenantSchema.ts`; `createDefaultEntries()`'s UOM and Location seeding, since `seedDefaultEntries()` already covers that at provisioning; `updatePrintSettings()` and the print template step, since logo is out of scope here), and sourcing `companyName`, `fullname`, and `email` from the Clerk organization and user instead of form input. Satisfies **AC-3, AC-4**.
4. Port `SetupWizard.vue` to a new Web route, trimmed to the five fields, calling the new setup entry point on submit. Satisfies **AC-3, AC-4, AC-5**.
5. Add the shell boot and router guard: redirect an admin whose org is not set up to the wizard route; show a non admin member the blocking message instead. Satisfies **AC-1, AC-2, AC-5**.
6. Confirm resume behavior end to end: a second submission after a partial first attempt does not duplicate records, matching Desktop's own behavior, which never persists the `SetupWizard` doc's field values either. Satisfies **AC-6**.
7. Operator step: run a one time backfill setting `AccountingSettings.setupComplete = true` on every currently `READY` tenant, before this feature deploys. Satisfies **AC-7**.

## Consequences

**Positive**:
- Real accounting doctypes finally have a chart of accounts, currency, and fiscal year to validate against on Web, unblocking every feature that assumed Desktop's setup already ran.
- No new server infrastructure; the same generic route, the same demux path, and the same idempotent helpers Desktop already relies on are reused as is.
- Matches Desktop's own behavior closely enough that a support answer for one platform mostly holds for the other.

**Negative / tradeoffs**:
- The admin only restriction is UI level only; a non admin member who called the API directly could still write these records, since there is no per doctype role check. This mirrors the org's existing trust model for its own data but is a real gap if that assumption ever changes.
- Exporting functions from `src/setup/setupInstance.ts` is a small change to a file that otherwise belongs to Desktop; a future upstream change to that file needs to keep these exports in mind.
- The wizard now offers Desktop's full country list even though Tanzania and Kenya are the stated target market, so most of the inherited chart of accounts templates and regional logic have not had dedicated review for this market.

**Neutral**:
- Introduces one new Web route and one new Vue page; the `SetupWizard` schema itself already existed in every tenant's migrated database, unused until now.
- Logo and print settings stay out of scope for this wizard; an org sets those later, most likely through Settings.

## Follow-up

- [ ] Operator: run the `AccountingSettings.setupComplete` backfill against every existing `READY` tenant before this feature deploys, mirroring spec 0004's own ALTER and backfill precedent.
- [ ] No scope feature currently links this spec. Enroll one in `docs/scope/scope.md` under Phase 4: Web Migration once this spec is confirmed.
- [ ] If per doctype authorization ever becomes a real requirement beyond billing's existing admin required precedent, design a general authorization layer rather than a one off check for this feature alone.
- [ ] Decide where an org sets its logo and print settings on Web; likely Settings, not this wizard.
- [ ] Keep the exported `src/setup/setupInstance.ts` helpers in sync with Desktop if its own setup flow changes; nothing currently enforces this beyond code review.

## Rationale

Reasoning and options considered: see `rationale.md`.
