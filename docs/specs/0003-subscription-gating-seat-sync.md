# 0003. Subscription gating & seat sync

**Date**: 2026-09-12
**Status**: In Progress

## Summary

This decision replaces what Keymint does on Desktop (device bound license enforcement) with two separate, simpler checks on Web: a subscription status gate in front of every tenant data route, and Clerk's own native per organization member cap for seats. The gate runs as Hono middleware against the control plane's `subscriptions` table and denies unpaid states with 402 and control plane outages with 503; the client routes a 402 to a billing prompt. Because the payment features that would populate `subscriptions` (specs 0004 and 0005) build later, this feature ships an operator seed command so the gate, the prompt, and the Clerk seat cap are all demonstrable end to end now.

## Context

Desktop enforces access through Keymint, a device bound license with an offline grace period. That model does not fit Web: there is no device to bind, and Web already requires connectivity, so there is no need for an offline grace period either. What Web actually needs is: is this organization's subscription currently paid up, and has it hit its seat limit. An earlier draft of this plan treated seat limits as a custom check (compare Clerk's live membership count against an app level `seat_limit` column on every request). That was corrected after confirming Clerk organizations already have a native, enforced member cap (`maxAllowedMemberships`) that Clerk itself blocks over cap invitations against, making a custom per request seat check redundant and a source of drift.

The code this feature bolts onto already exists. `worker/middleware/clerk-auth.ts` resolves the verified Clerk session to an `orgId`, `worker/db/resolve-tenant.ts` decrypts and returns the tenant's connection string (with a 30 second cache keyed on org), and `worker/routes/db.ts` is the one tenant data surface so far (schema, call, bespoke); its three routes each pass `requireOrgSession` inline as a per-route argument. The control plane schema (spec 0001) already defines `subscriptions` (statuses `ACTIVE`, `PAST_DUE`, `EXPIRED`, `PENDING_REVIEW`, `SUSPENDED`, `CANCELLED`; `provider` constrained to `paypal` or `lipa_namba`) and `organizations.plan_seat_limit`, but no code writes a subscription row yet: spec 0004 (PayPal) and spec 0005 (Lipa Namba) populate it later. Since this gate fails closed when no row exists, and 0004 and 0005 build after it, the gap is closed with a seed command (confirmed with the engineer) rather than by deferring the wiring: the feature ships as a live, demonstrable slice.

A packaging constraint shapes where the new server logic lives. `worker/` is its own npm package; root `scripts/` (the `ts-node` bootstrap `migrate-tenants` uses) cannot import from it, and `@clerk/backend` and the `neon()` helper resolve only inside `worker/`. The spec 0002 precedent puts shared server logic in `custom/web/`, which both sides can consume: the root script imports it directly, the worker wraps it thinly (the way `organization-created.ts` stays thin over `custom/web/auth/`). Everything reusable therefore lands in `custom/web/billing/`.

The denial response shape was previously named "the established 402/403 billing response" but nothing established it. It is now fixed: 402 for not paid, 503 for the control plane being unreachable, and 403 kept for what `clerk-auth.ts` already uses it for (a session with no active organization). A cross-check pass against the code caught the mount ordering and seed path problems recorded in this draft.

## Requirements

**User stories**:
- As the platform, I need to block tenant data access when an organization's subscription is not active, so that unpaid customers cannot keep using the product.
- As an organization admin, I want my plan's seat count to be enforced so that I cannot accidentally invite more members than I am paying for.
- As an operator building before the payment features exist, I need one command to mark a dev or test org's subscription active so the gate, the prompt, and the seat cap can be exercised now.
- As a paying customer during a control plane outage, I want to be told to retry, not told my billing is broken.

**Acceptance criteria**:
- **AC-1**: A new Hono middleware gate loads the org's single authoritative `subscriptions` row from the control plane before the tenant connection is resolved; a missing row or any status other than `ACTIVE` is rejected, and no tenant lookup is performed.
- **AC-2**: Denials use exactly two fixed shapes, both produced before tenant resolution: unpaid states (missing row or any non `ACTIVE` status) return HTTP 402 with body `{ error: 'Subscription is not active', code: 'SUBSCRIPTION_INACTIVE', status }` where `status` is the subscription's actual status or `'MISSING'` when no row exists; a control plane query failure returns HTTP 503 with body `{ error: 'Subscription status temporarily unavailable', code: 'CONTROL_PLANE_UNAVAILABLE', status: 'UNAVAILABLE' }`. Both still fail closed (the request never proceeds). 403 stays reserved for the existing no active organization case in `clerk-auth.ts`.
- **AC-3**: The gate covers all of `/api/db`: the three routes in `worker/routes/db.ts` switch from inline per-route `requireOrgSession` arguments to one `dbRoute.use(requireOrgSession, requireActiveSubscription)` registered above the route definitions (Hono runs `use` middleware registered later only for routes registered after it, so the inline arguments must go, not merely gain a `use` below them). Every current and future route under `/api/db`, including the schema map endpoint, is gated.
- **AC-4**: The web client, on a 402 with `code: 'SUBSCRIPTION_INACTIVE'`, routes to the `/billing` prompt surface; a 503 surfaces as a retry message instead, never as a billing problem. There is no offline grace period on Web.
- **AC-5**: A seat cap sync helper sets the org's Clerk `maxAllowedMemberships` (Backend API `updateOrganization`) and records the same number in `organizations.plan_seat_limit`, and is the function specs 0004 and 0005 will call on activation, plan change, and cancellation. In this feature it is exercised through the seed command.
- **AC-6**: Seat limits are never re-checked in `worker/middleware/`; Clerk's own enforcement is the only seat check.
- **AC-7**: An operator script (`npm run seed:subscription -- --org=... --seats=...`, same bootstrap pattern as `migrate:tenants`) upserts an `ACTIVE` subscription row for an org and runs the seat cap sync, so a dev or test tenant passes the gate. `--seats` is required (omitting it errors out; a `--dry-run` may omit it), because `maxAllowedMemberships: null` in Clerk means no cap at all.
- **AC-8**: A `GET /api/subscription/status` route (session required, deliberately not behind the gate) returns the org's current `{ status, code }` so the billing prompt can render correct state on a cold load or refresh, not only right after a denial.
- **AC-9**: This feature does not import or reference `../../custom/licensing` (Keymint) anywhere.

## Options considered

### Option 1: Gate middleware plus Clerk native seat cap (chosen)

A middleware covering `/api/db` queries the control plane's subscription row before tenant resolution; seat counting is delegated entirely to Clerk's `maxAllowedMemberships`, synced on plan changes. Wiring goes in now, with a seed command bridging the gap until 0004 and 0005 populate subscriptions.

**Pros**:
- Reuses every existing seam (session middleware, control plane helpers, script bootstrap), so the slice is small.
- Seat state has exactly one enforcer (Clerk), no local count to drift.
- Denial happens before the expensive tenant decryption.

**Cons**:
- Every tenant data request adds one control plane HTTP round trip (no cache in the first pass).
- Fails closed against an empty `subscriptions` table, so it needs the seed command until payments ship.

### Option 2: Fold status into tenant resolution's existing query and cache

Extend `resolve-tenant.ts`'s single control plane read to join `subscriptions.status`, reusing its 30 second cache: zero extra round trips per request.

**Pros**:
- One control plane query serves both resolution and gating; cheapest steady state.

**Cons**:
- A status change takes up to 30 seconds to take effect (stale cache denies late and, worse, allows late), and it entangles the tenant boundary resolver with billing state, making each harder to test alone. Rejected: deny immediately beats one saved round trip; the uncached per request query of Option 1 is the honest first pass, revisit only against measured latency (see Follow-up).

### Option 3: Build dark, mount with 0004 or 0005

Write the middleware and seat sync with tests now, but do not mount them until a payment feature can populate the table.

**Pros**:
- No seed command or dev data ceremony; zero chance of blocking legitimate users during development.

**Cons**:
- Not a complete vertical slice: nothing is demonstrable, and mounting two layers later is exactly the deferred wiring that produces surprises. Rejected in favor of wiring now.

### Option 4: Custom per request seat check

Compare Clerk's live membership count against an app level seat number on every request.

**Pros**:
- Full control; no dependence on Clerk's cap semantics.

**Cons**:
- A cached local count disagreeing with Clerk's real membership state is a standing drift bug; Clerk already blocks over cap invites natively. Rejected by the earlier correction recorded above.

## Decision

**Chosen option**: Option 1: a subscription status middleware gate covering all of `/api/db` (registered above the route definitions, before tenant resolution), denying unpaid states with a fixed 402 and outages with a fixed 503, backed by a shared seat-cap sync helper in `custom/web/billing/`, an un-gated status endpoint for the client, and an operator seed command that bridges the pre-payments gap.

## Rationale

Checking subscription status before resolving the tenant connection avoids wasting a Neon decryption and lookup on a request that is about to be denied. Delegating seat enforcement entirely to Clerk removes an entire category of custom logic and the drift risk of a locally cached seat count disagreeing with Clerk's actual membership count; Clerk's own cap is authoritative and already enforced on Clerk's side. Wiring the gate now (over building it dark) follows the project's Tracer Bullet rule that each feature is a thin complete slice through every layer: the seed command is a small, honest bridge over the empty `subscriptions` table, and it doubles as the acceptance exercise for the sync helper. Two denial codes rather than one because a control plane outage is not a billing problem: telling a paying customer their billing is broken, when it is our database that blinked, is a support incident per occurrence, while 503 with honest retry copy is self healing. The single 402 body shape (one constant message, machine-read `code` and `status`) exists because nothing established a billing response before now, and one code means one client branch to handle; 403 already carries a different meaning in `clerk-auth.ts` and keeps it. Shared logic lives in `custom/web/billing/`, not `worker/`, because the root seed script physically cannot import the worker package, and the spec 0002 precedent already routes shared server logic that way.

## Feature design

**Data model sketch**: No new tables. Reads `subscriptions.status` (one row per org, `UNIQUE` constraint already in `worker/db/schema.sql`) and writes `organizations.plan_seat_limit` (both created by spec 0001). `plan_seat_limit` is a record of intent written by the seat sync step, never read back for enforcement. `subscriptions` rows are written in this feature only by the seed command; specs 0004 and 0005 become the real writers. Shared TypeScript type (in `custom/web/billing/types.ts`): `SubscriptionStatus = 'ACTIVE' | 'PAST_DUE' | 'EXPIRED' | 'PENDING_REVIEW' | 'SUSPENDED' | 'CANCELLED'`, and the wire union `SubscriptionWireStatus = SubscriptionStatus | 'MISSING' | 'UNAVAILABLE'`.

**State transitions**: Request handling: verified session → gate loads subscription row → `ACTIVE` → request proceeds to tenant resolution; missing row (`'MISSING'`) or any other status → 402 before tenant resolution; control plane query throws → 503 before tenant resolution (fail closed both ways; a denied paying customer retrying after an outage is recoverable, a free ride is not). Seat sync ordering: Clerk `updateOrganization` first (it is the actual enforcer), then the `plan_seat_limit` upsert best effort (it is a record of intent); a failed local write is logged and does not roll back or re-throw over a successful Clerk update.

**API surface**:
| Component | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `worker/middleware/subscription-gate.ts` (`requireActiveSubscription`) | middleware, registered via `dbRoute.use(requireOrgSession, requireActiveSubscription)` above the route definitions in `worker/routes/db.ts` (inline per-route `requireOrgSession` arguments removed) | session `orgId` (never client supplied) | pass through, or 402/503 JSON | Clerk session | 402 `SUBSCRIPTION_INACTIVE`, 503 `CONTROL_PLANE_UNAVAILABLE` |
| `custom/web/billing/subscriptionStatus.ts` | shared control plane read: `getSubscriptionStatus(controlDb, orgId)` returning `SubscriptionStatus \| null` | orgId | status or null | n/a | query error propagates (middleware maps to 503) |
| `custom/web/billing/seatSync.ts` | shared seat sync: update Clerk `maxAllowedMemberships` via Clerk REST (`fetch` + `CLERK_SECRET_KEY`, no `@clerk/backend` dependency so root can run it), then upsert `plan_seat_limit` | orgId, seat count | Clerk updated; local record best effort | Clerk secret key | Clerk API error thrown to caller; local write error logged |
| `worker/routes/subscription-status.ts` → `GET /api/subscription/status` | thin route (session required, not behind the gate): calls the shared status read and returns `{ status, code }` with the same code constants | session `orgId` | `'ACTIVE'`/actual status/`'MISSING'`, or 503 on query failure | Clerk session | 503 `CONTROL_PLANE_UNAVAILABLE` |
| `custom/web/billing/seedSubscription.ts` + `scripts/seed-subscription.ts` (+ `.sh` wrapper, `npm run seed:subscription`) | operator CLI | `--org=` (req), `--seats=` (req unless `--dry-run`), `--dry-run` | upserted `ACTIVE` row + seat sync run | env secrets | non zero exit on missing flags or Clerk failure |
| `src/pages/web/Billing.vue` + `/billing` route in `src/web/router.ts` | client prompt surface | status from `GET /api/subscription/status` on mount; denial detail from sessionStorage as the immediate context | copy per bucket (below); subscribe CTA is a placeholder until 0004/0005 | Clerk session | n/a |

**Seed row values** (the table's constraints leave no room to improvise): `org_id` from `--org`, `provider = 'paypal'` (the CHECK only allows `paypal` or `lipa_namba`; the row is an access record, not a payment claim; spec 0004 overwrites `provider` and `paypal_subscription_id` when a real subscription lands), `status = 'ACTIVE'`, `paypal_subscription_id` and `current_period_end` `NULL`, and the upsert is `ON CONFLICT (org_id) DO UPDATE SET status = 'ACTIVE', provider = EXCLUDED.provider, updated_at = now()` (the column `DEFAULT now()` fires only on insert, so the update branch must set `updated_at` explicitly).

**Value sourcing**:
| Action | Value produced / displayed | Source |
|---|---|---|
| Every tenant request | Allow or deny | `getSubscriptionStatus` on the control plane, keyed on the session `org_id` set by `requireOrgSession` |
| Denial body `status` | Actual status, `'MISSING'`, or `'UNAVAILABLE'` | the queried row; `'MISSING'` when absent; `'UNAVAILABLE'` when the query threw |
| Denial body `error` | One constant per code | defined in `custom/web/billing/types.ts` as the shared wire constants; client copy is keyed off `code`/`status`, never this string |
| Billing prompt on load | Current subscription status | `GET /api/subscription/status` (AC-8); the last denial's `status` from sessionStorage only as immediate context |
| Prompt copy bucket | Which of the three messages shows | mapped from `status`: `PENDING_REVIEW` → "under review"; `CANCELLED`/`EXPIRED`/`MISSING` → "choose a plan"; other non `ACTIVE` → "payment problem, fix billing"; full tier copy deferred to spec 0004 |
| Seat cap sync | Clerk `maxAllowedMemberships` value | the seat number passed by the caller (`--seats` now; 0004/0005 plan tier mapping later) |
| `plan_seat_limit` write | Same number just synced | derived from the sync input, recorded via a new `upsertPlanSeatLimit` helper in `worker/db/control.ts` style, living in `custom/web/billing/` |

**Key invariants**:
- The gate runs before `resolveTenantConnectionString`; a denied request never decrypts a tenant connection string.
- Seat limits are Clerk's own responsibility; never re-implemented as a per request check.
- No offline grace period on Web; a 402 routes to the billing prompt, a 503 asks for a retry.
- Missing row, non `ACTIVE` status, and control plane query failure all deny (fail closed); only the code and status line distinguish them.
- Shared billing logic lives in `custom/web/billing/`; `worker/` files stay thin over it; root scripts never import from `worker/`.
- This feature never imports or references `custom/licensing`.

**Security model**: The gate and the status route read only from the verified Clerk session's `orgId` (set by `requireOrgSession`), never a client supplied value, and the gate fails closed when no authoritative subscription row exists. The status route exposes only the calling org's own status to its own session, so it leaks nothing across tenants. `maxAllowedMemberships` above 20 requires Clerk's paid B2B Authentication add on; any subscription tier planned above 20 seats needs that add on confirmed before launch. Clerk counts pending invitations against the cap, and lowering it below the current member count leaves an org with zero invite room until members are removed; specs 0004/0005 should never sync a seat number below an org's live headcount without a deliberate downgrade path.

**Configuration required**:
- Uses `CLERK_SECRET_KEY` and `CONTROL_DATABASE_URL` already configured (spec 0001); no new secrets. The seed script reads the same values from env, root `.env`, or `worker/.dev.vars`, following `scripts/migrate-tenants.ts`.

**Testing setup**: Two placements, matching the package split. Middleware, gate ordering, and status route tests run inside `worker/` with a new `npm test -w worker` script (node's built-in test runner via `tsx`, or vitest, either settled by `/develop`'s first run), stubbing the shared status read. Seed script and seat sync logic tests live root side under `custom/web/billing/tests/*.spec.ts`, in the existing mocha/tape server-side suite, with Clerk REST and the control query injected as fakes.

**Critical test scenarios** (each maps to an acceptance criterion in ## Requirements):
- Happy path: an org seeded to `ACTIVE` has its `/api/db/call` requests succeed through gate, resolution, and query. Verifies **AC-1, AC-3, AC-7**.
- Failure case: an org with `PAST_DUE`, and an org with no row, get 402 with `code: 'SUBSCRIPTION_INACTIVE'` and `status` `'PAST_DUE'`/`'MISSING'` respectively, and the middleware ordering proves the tenant resolver was never called (spy on the shared resolution path). Verifies **AC-1, AC-2, AC-3**.
- Failure case: control plane query throws; request is denied with 503 `CONTROL_PLANE_UNAVAILABLE`, and the client shows retry copy, not billing copy. Verifies **AC-2, AC-4**.
- Client behavior: a 402 from any db call redirects to `/billing`; refreshing `/billing` re-renders correct state from `GET /api/subscription/status` alone. Verifies **AC-4, AC-8**.
- Seat sync: `npm run seed:subscription -- --org=... --seats=3` sets Clerk `maxAllowedMemberships=3` and `plan_seat_limit=3`, and Clerk itself then blocks an over cap invite; omitting `--seats` (without `--dry-run`) exits non zero. Verifies **AC-5, AC-6, AC-7**.

## Build plan

Ordered as one thin end to end thread first (the project's Tracer Bullet approach), then the seat and status layers:

1. Shared core in `custom/web/billing/`: `types.ts` (status unions, the two wire code constants, the constant error messages), `subscriptionStatus.ts` (`getSubscriptionStatus`), `seatSync.ts` (Clerk REST cap update then best effort `plan_seat_limit` upsert, Clerk first). Root-side tests for the sync ordering. Satisfies **AC-5, AC-9** (foundation).
2. `requireActiveSubscription` in `worker/middleware/subscription-gate.ts` (402 unpaid, 503 query failure, both before tenant resolution), and the `dbRoute` change: one `dbRoute.use(requireOrgSession, requireActiveSubscription)` registered above the route definitions, inline per-route `requireOrgSession` arguments removed. Add the `worker/` test runner script and middleware tests (allow, deny, missing, throw, resolver-not-called spy). Satisfies **AC-1, AC-2, AC-3, AC-9**.
3. `scripts/seed-subscription.ts` + wrapper + `package.json` entry, over `custom/web/billing/seedSubscription.ts`: required `--org`/`--seats`, `--dry-run`, the fixed upsert (provider `'paypal'`, explicit `updated_at`), then `seatSync`. First usable thread: seed an org, its tenant requests pass. Satisfies **AC-7**.
4. `GET /api/subscription/status` thin route in `worker/routes/` (session required, mounted in `worker/index.ts`, not gated). Satisfies **AC-8**.
5. Client: `#fetchBackend` in `fyo/demux/db.ts` carries the body `code` onto `BackendResponse.error` (the `code` field already exists in `utils/ipc/types.ts`); `#handleDBCall`'s web path throws `SubscriptionInactiveError` (new class in `fyo/utils/errors`, carries `status`) instead of a flat `DatabaseError`; web app setup catches it, persists the last denial to `sessionStorage`, and routes to `/billing`; `Billing.vue` + route read `GET /api/subscription/status` on mount and render the three copy buckets, with 503 as retry copy. Satisfies **AC-4**.

## Consequences

**Positive**:
- Removing custom seat enforcement removes an entire class of drift bug between a locally cached count and Clerk's real membership state.
- Registering the gate on `dbRoute` means every tenant data route added by later features is gated automatically; forgetting to gate is structurally impossible within `/api/db`.
- Distinguishing 503 from 402 stops a control plane wobble from spamming customers with false billing alarms.

**Negative / tradeoffs**:
- Hard access denial with no grace period means any transient control plane outage directly blocks legitimate paying customers (with honest retry copy, but still blocked); Desktop's fail open, offline tolerant design does not carry over here by choice.
- One extra control plane HTTP round trip per tenant data request; the first pass adds no cache because correctness of the fail closed rule is cheaper to reason about without one.
- Until 0004 and 0005 ship, every dev or test org needs one seed command before tenant data works; that is the accepted cost of wiring now.
- Clerk is reached twice for a seat change by different code shapes (REST from `custom/web/billing/`, available to the root script; the worker could have used the SDK but sharing beats two implementations).

**Neutral**:
- Any subscription tier above 20 seats is gated on confirming Clerk's B2B Authentication add on before it can be sold.
- `plan_seat_limit` exists only as a record of intent after this feature; nothing reads it back for enforcement.
- The seeded `provider: 'paypal'` is a placeholder against the CHECK constraint; spec 0004 owns the real value.

## Follow-up

- [ ] Confirm Clerk's current `maxAllowedMemberships` pricing and add on requirement against the live Clerk pricing page before finalizing any tier above 20 seats.
- [ ] Confirm Clerk's invite counting semantics against the live Clerk docs: pending invitations count toward the cap, and a lowered cap below current headcount strands invites; factor into the 0004/0005 downgrade path.
- [ ] If the per request control plane round trip shows up in measured latency (not before), add a short TTL cache for the gate's status, mirroring `resolve-tenant.ts`'s 30 second pattern, and define its invalidation on status change.
- [ ] When spec 0004 (PayPal) defines plan tiers, decide the mapping from tier to seat count that its webhook handlers pass to the shared seat sync; until then the seat number is a CLI flag.
- [ ] The `/billing` subscribe CTA is a placeholder until specs 0004 and 0005 give it a real flow.
- [ ] Any new tenant data surface outside `/api/db` (reports, file upload) must mount `requireActiveSubscription` too; revisit when such routes appear.
