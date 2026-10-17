# 0004 rationale: PayPal subscriptions (non Tanzania payments)

_Decision history for spec 0004, split from the single file when /develop promoted the spec to a
directory (the 0003 precedent). The build contract (Summary, Requirements, Decision, Feature
design, Build plan, Consequences, Follow-up) lives in [index.md](index.md)._

**Date**: 2026-09-13 (revised in place; originally 2026-09-03)
_The revision was deliberated after spec 0003 built the gate, the seat sync helper, and the
Billing page it wires up, and after an independent cross-check pass closed thirteen
completeness gaps (its verdict is recorded in Consequences in index.md). It replaces the
original draft's plan, trial, and lifecycle design and owns the gate changes the engineer
assigned to this spec._
## Context


Desktop sells licenses via ClickPesa, a Tanzania only mobile money integration that does not serve customers elsewhere. PayPal Subscriptions is the chosen product for that audience. The original draft of this spec predated the built gating layer, so it never said where a seat number comes from on activation, how plan tiers exist at all (the control plane has no plan column), what a customer can do after subscribing (cancel, switch), or what happens between signup and first payment (under spec 0003's gate, a brand new org is locked out, since no subscription row exists until PayPal calls back).

The business model settled in this revision: two plans per organization, DIY and DFY, at the prices above, monthly or yearly, in USD. DFY's difference is three human services (data migration and app setup, over the shoulder training, priority support), not gated software features; the only in product difference is the seat count, and both plans run the identical app. The trial gives the full app (5 seats) from signup; the customer picks a plan when they upgrade, and upgrading mid trial starts billing immediately. After entitlement ends: 7 grace days with full access, 5 read only days, then locked.

Technical forces. PayPal's `CreateSubscriptionRequest` still marks `applicationContext` and `autoRenewal` deprecated as of the September 2026 SDK docs crosscheck, so the approval experience fields must not be built from memory. The TypeScript Server SDK has no webhook signature verification helper, and Workers has no CRC32 builtin, so verification is hand rolled WebCrypto. The staging control plane already drifts from `worker/db/schema.sql` (spec 0003's build note), so every schema change here ships as a documented operator ALTER list alongside the file update. Webhooks can be lost, reordered, or duplicated, and PayPal does not guarantee arrival order, so the design must converge to the truth from a missing event as readily as from a duplicate one.

## Options considered


### Option 1: PayPal Subscriptions, webhook promotes, cron demotes (chosen)

Org provisioning opens the trial on RareBooks's own clock (a `TRIAL` row plus a cron); PayPal plans are plain paid plans (monthly and yearly variants of each tier); checkout, status display, cancel, and the whole ladder live in the app. Verified webhooks apply promotions (activation, payment restore) and refresh fields immediately; the hourly cron alone demotes rungs, and only after refetching PayPal's live subscription.

**Pros**:
- Signup reaches the app instantly, which is the product promise; a PayPal trial period cannot do that, since one only exists after a PayPal approval.
- A lost, reordered, or duplicated webhook converges to truth within an hour, and the direction is always safe: a missing event can never lock a paying customer, at worst it delays a lapsed org's lockout by one cron pass.
- One mechanism (status plus `stage_ends_at` plus one demoting writer) drives the gate, the cron, and the client banner.

**Cons**:
- The ladder needs the cron, the status CHECK change, and gate changes that touch spec 0003's just built, not yet verified surface.
- A lapsed org keeps full access up to about an hour longer than the exact entitlement second (the next cron pass).
- A subscriber who upgrades mid trial forfeits unused trial days (billing starts at approval).

### Option 2: PayPal trial periods with PayPal side management

Plans carry a 14 day trial; the customer must check out at signup; cancel and plan management happen on paypal.com.

**Pros**:
- No cron and no own clock; PayPal's own trial and billing events drive everything; less app surface.

**Cons**:
- Contradicts "straight to the web app on trial at signup": a PayPal subscription, and so its trial, only exists after checkout and approval.

### Option 3: PayPal Orders API with self managed recurring billing

Single use Orders/Vault payments with a self built schedule that retries charging on RareBooks's own clock.

**Pros**:
- Total control of timing and plan switching without PayPal's subscription model.

**Cons**:
- Rebuilds dunning, card on file, retry windows, and payer UX that PayPal Subscriptions provides; far more failure modes for a two plan product.

## Rationale


PayPal Subscriptions is the standard recurring product for the outside Tanzania audience, and its event set maps onto the ladder without owning the ladder itself (basis: September 2026 SDK docs crosscheck, and the original 0004 draft's same conclusion). The trial clock is RareBooks's own because the product promise (instant app access from signup) cannot ride a PayPal trial, which only exists post approval (basis: the engineer's signup flow requirement; `handleOrganizationCreated` is already the provisioning hook). The promote and demote split exists because webhooks are both untrusted until verified and unreliable in delivery: letting only the cron move rows down, and only after PayPal's live API confirms it, makes every lost event converge safely (wrong direction impossible: billing stays on for a paying org; tolerable delay: a lapsed org's lockout slips to the next pass) (basis: distributed systems idempotent reconciliation, and the cross-check pass's finding 2). Writing the PayPal subscription ID at checkout time (not at `ACTIVATED`) breaks the first activation chicken and egg: the binding exists before the lookup needs it, re-subscription overwrites cleanly, and superseded IDs 404 as noise (basis: cross-check finding 1). Verify then refetch, rather than trusting the payload, because the create request schema already changed once during planning and the API surface keeps moving (basis: the deprecated fields found September 2026). Two plan IDs plus a seat map in code beats PayPal metadata seats for two fixed tiers: fewer sources of truth, and seats must exist before any PayPal call anyway for the trial (basis: engineer's plan model). The mid trial forfeiture is accepted consciously; billing anchors to approval with no future start time games (a pending future start subscription adds states the ladder does not need). Manual REST instead of the TypeScript SDK for all PayPal calls: the SDK ships no webhook verification helper (September 2026 doc search found none) and its Workers compatibility is unproven, while the integration needs a handful of endpoints (basis: Workers runtime constraints; runner up is the SDK if more PayPal surface grows later).

## References


**Project sources**:
- `AGENTS.md` (shared code rules: `custom/web/` for logic both Worker and scripts use; Worker env secrets pattern; Tracer Bullet default)
- `custom/licensing/AGENTS.md` (ClickPesa stays Electron only; never extend it for Web)
- Spec 0003 (`0003-subscription-gating-seat-sync/index.md`): the gate, `seatSync`, `getSubscriptionStatus`, the status route, Billing page, and the staging drift precedent this spec builds on
- Spec 0001 (`0001-web-platform-foundation-control-plane.md`): control plane tables, Clerk webhook patterns, provisioning hook
- `worker/db/schema.sql`, `worker/routes/webhooks/organization-created.ts`, `custom/web/db/tenantDatabase.ts`, `backend/database/bespoke.ts`: current constraints and the thin route delegates to `custom/web/` convention
- September 2026 crosscheck during the original draft (deprecated create request fields), this revision's SDK docs search (no webhook verification helper), and this revision's independent cross-check pass (the thirteen closed gaps)

**Practices & standards**:
- Verify, then treat the provider's API as the source of truth (webhook as a signal, not a payload of record)
- Idempotency keys for money operations (`PayPal-Request-Id` on a durable intent)
- Replay safe event ingestion via a unique provider event ID inside one transaction
- Convergent reconciliation: monotone demotion owned by one scheduled writer that refetches truth first, events only promote (lost update and lost event safety)
- Compare and swap conditional updates for concurrent row writers
- Fail closed on entitlement checks; never lock a customer out of reading their own data short of an explicit final state
- PCI DSS SAQ A posture via hosted redirect (no card data touches the platform)

**Links** (web verified via context7, September 2026):
- Create Subscription request model (shows `applicationContext` and `autoRenewal` deprecated): https://github.com/paypal/paypal-typescript-server-sdk/blob/main/doc/models/create-subscription-request.md
- Cancel subscription request model: https://github.com/paypal/paypal-typescript-server-sdk/blob/main/doc/models/cancel-subscription-request.md
- Subscriptions controller (create, get, cancel, suspend examples): https://github.com/paypal/paypal-typescript-server-sdk/blob/main/doc/controllers/subscriptions.md
