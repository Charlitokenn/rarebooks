# 0003 rationale: subscription gating & seat sync

_Decision history for spec 0003, split from index.md when /develop promoted the spec to a directory. The build contract (Requirements, Decision, Feature design, Build plan, Consequences, Follow-up) lives in [index.md](index.md)._

## Context


Desktop enforces access through Keymint, a device bound license with an offline grace period. That model does not fit Web: there is no device to bind, and Web already requires connectivity, so there is no need for an offline grace period either. What Web actually needs is: is this organization's subscription currently paid up, and has it hit its seat limit. An earlier draft of this plan treated seat limits as a custom check (compare Clerk's live membership count against an app level `seat_limit` column on every request). That was corrected after confirming Clerk organizations already have a native, enforced member cap (`maxAllowedMemberships`) that Clerk itself blocks over cap invitations against, making a custom per request seat check redundant and a source of drift.

The code this feature bolts onto already exists. `worker/middleware/clerk-auth.ts` resolves the verified Clerk session to an `orgId`, `worker/db/resolve-tenant.ts` decrypts and returns the tenant's connection string (with a 30 second cache keyed on org), and `worker/routes/db.ts` is the one tenant data surface so far (schema, call, bespoke); its three routes each pass `requireOrgSession` inline as a per-route argument. The control plane schema (spec 0001) already defines `subscriptions` (statuses `ACTIVE`, `PAST_DUE`, `EXPIRED`, `PENDING_REVIEW`, `SUSPENDED`, `CANCELLED`; `provider` constrained to `paypal` or `lipa_namba`) and `organizations.plan_seat_limit`, but no code writes a subscription row yet: spec 0004 (PayPal) and spec 0005 (Lipa Namba) populate it later. Since this gate fails closed when no row exists, and 0004 and 0005 build after it, the gap is closed with a seed command (confirmed with the engineer) rather than by deferring the wiring: the feature ships as a live, demonstrable slice.

A packaging constraint shapes where the new server logic lives. `worker/` is its own npm package; root `scripts/` (the `ts-node` bootstrap `migrate-tenants` uses) cannot import from it, and `@clerk/backend` and the `neon()` helper resolve only inside `worker/`. The spec 0002 precedent puts shared server logic in `custom/web/`, which both sides can consume: the root script imports it directly, the worker wraps it thinly (the way `organization-created.ts` stays thin over `custom/web/auth/`). Everything reusable therefore lands in `custom/web/billing/`.

The denial response shape was previously named "the established 402/403 billing response" but nothing established it. It is now fixed: 402 for not paid, 503 for the control plane being unreachable, and 403 kept for what `clerk-auth.ts` already uses it for (a session with no active organization). A cross-check pass against the code caught the mount ordering and seed path problems recorded in this draft.

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

## Rationale


Checking subscription status before resolving the tenant connection avoids wasting a Neon decryption and lookup on a request that is about to be denied. Delegating seat enforcement entirely to Clerk removes an entire category of custom logic and the drift risk of a locally cached seat count disagreeing with Clerk's actual membership count; Clerk's own cap is authoritative and already enforced on Clerk's side. Wiring the gate now (over building it dark) follows the project's Tracer Bullet rule that each feature is a thin complete slice through every layer: the seed command is a small, honest bridge over the empty `subscriptions` table, and it doubles as the acceptance exercise for the sync helper. Two denial codes rather than one because a control plane outage is not a billing problem: telling a paying customer their billing is broken, when it is our database that blinked, is a support incident per occurrence, while 503 with honest retry copy is self healing. The single 402 body shape (one constant message, machine-read `code` and `status`) exists because nothing established a billing response before now, and one code means one client branch to handle; 403 already carries a different meaning in `clerk-auth.ts` and keeps it. Shared logic lives in `custom/web/billing/`, not `worker/`, because the root seed script physically cannot import the worker package, and the spec 0002 precedent already routes shared server logic that way.

