# 0004. PayPal subscriptions (non Tanzania payments)

**Date**: 2026-09-13 (revised in place; originally 2026-09-03)
**Status**: Proposed

_This revision was deliberated after spec 0003 built the gate, the seat sync helper, and the Billing page it wires up, and after an independent cross-check pass closed thirteen completeness gaps (its verdict is recorded in Consequences). It replaces the original draft's plan, trial, and lifecycle design and owns the gate changes the engineer assigned to this spec._

## Summary

This spec puts real billing behind the access gate spec 0003 built. Every new organization gets a 14 day free trial the moment it is provisioned and goes straight into the app, with no PayPal involved. Customers outside Tanzania then subscribe to one of two plans, Do It Yourself (2 seats, $20 per month or $204 per year) or Done For You (5 seats, $49 per month or $500 per year), billed in USD through PayPal Subscriptions. When an entitlement ends without payment, the org slides down a fixed ladder: 7 days of full access with upgrade nudges, then 5 days read only (view and download, no adds or changes or deletes), then a hard lock to the upgrade page. One rule keeps the machine honest: PayPal webhooks can only move an org up (activation, a payment that restores access), and the hourly job is the only thing that moves an org down, and only after rechecking PayPal's live status, so a lost webhook can never wrongly lock a paying customer or leave a dead org free.

## Context

Desktop sells licenses via ClickPesa, a Tanzania only mobile money integration that does not serve customers elsewhere. PayPal Subscriptions is the chosen product for that audience. The original draft of this spec predated the built gating layer, so it never said where a seat number comes from on activation, how plan tiers exist at all (the control plane has no plan column), what a customer can do after subscribing (cancel, switch), or what happens between signup and first payment (under spec 0003's gate, a brand new org is locked out, since no subscription row exists until PayPal calls back).

The business model settled in this revision: two plans per organization, DIY and DFY, at the prices above, monthly or yearly, in USD. DFY's difference is three human services (data migration and app setup, over the shoulder training, priority support), not gated software features; the only in product difference is the seat count, and both plans run the identical app. The trial gives the full app (5 seats) from signup; the customer picks a plan when they upgrade, and upgrading mid trial starts billing immediately. After entitlement ends: 7 grace days with full access, 5 read only days, then locked.

Technical forces. PayPal's `CreateSubscriptionRequest` still marks `applicationContext` and `autoRenewal` deprecated as of the September 2026 SDK docs crosscheck, so the approval experience fields must not be built from memory. The TypeScript Server SDK has no webhook signature verification helper, and Workers has no CRC32 builtin, so verification is hand rolled WebCrypto. The staging control plane already drifts from `worker/db/schema.sql` (spec 0003's build note), so every schema change here ships as a documented operator ALTER list alongside the file update. Webhooks can be lost, reordered, or duplicated, and PayPal does not guarantee arrival order, so the design must converge to the truth from a missing event as readily as from a duplicate one.

## Requirements

**User stories**:
- As a new business owner, I want my workspace open immediately with a 14 day trial so that I can evaluate the app before paying anything.
- As a customer outside Tanzania, I want to subscribe to a named plan through PayPal so that access keeps working on a recurring schedule.
- As an organization admin, I want to start a subscription, switch plans, or cancel from inside the app, and to come back to a clear screen when PayPal approval finishes, so that I never have to find the payment provider's own site.
- As the platform, I need PayPal's billing events to move the authoritative subscription row so that gating (spec 0003) reflects reality, including the trial to grace to read only to locked ladder, and never strand a paid customer on a lost webhook.
- As a lapsing customer, I want to still see and download my books while payment is settled so that locking me out never destroys my access to my own data.

**Acceptance criteria**:
- **AC-1**: Provisioning an organization writes its `subscriptions` row as `status = 'TRIAL'` with `stage_ends_at = created 14 days` and calls the 0003 seat sync with the trial seat count (5), so a signed in member reaches the app immediately with zero PayPal contact, and the app shows an upgrade nudge from trial day 8.
- **AC-2**: The Billing page renders both plan cards (DIY: 2 seats, $20 monthly or $204 yearly; DFY: 5 seats, $49 monthly or $500 yearly, listing its three service perks) from one shared plans module, checkout and cancel are restricted to Clerk organization owners and admins (buttons absent for plain members, Worker routes reject them with 403 and the fixed body `code: 'SUBSCRIPTION_ADMIN_REQUIRED'`), and a trial org checking out sees a one line "billing starts today, your remaining trial days are not extended" confirm.
- **AC-3**: Every checkout attempt persists a durable intent with a unique, stable `PayPal-Request-Id` and an owned state machine: the create call's success marks it `CREATED` (storing the PayPal subscription ID and approval URL), `BILLING.SUBSCRIPTION.ACTIVATED` marks it `DONE`, switching plan or period closes the open intent as `FAILED` and opens a new one, `BILLING.SUBSCRIPTION.ACTIVATION.CANCELLED` or an intent abandoned over 24 hours marks it `FAILED`, and a retry of an open intent reconciles by refetching the stored PayPal subscription (pending approval returns the stored URL, already active applies the activation, gone or cancelled fails the intent and starts fresh). A create call that times out returns 502 without a second PayPal subscription ever existing, and no org has two open intents.
- **AC-4**: No webhook field is trusted before signature verification against PayPal's verify webhook signature endpoint (manual REST, WebCrypto CRC32, `PAYPAL_WEBHOOK_ID`); a bad or missing signature returns 400 and performs no database write.
- **AC-5**: For lifecycle events, after verification the handler refetches the subscription via `GET /v2/subscriptions/{id}` and derives status, `current_period_end`, and pending cancel state from that response, not from the payload; the payload contributes only the event type, the PayPal subscription ID, and the payment amount, currency, and transaction reference for the payment row.
- **AC-6**: A PayPal subscription ID resolves to exactly one local row: the checkout route writes `subscriptions.paypal_subscription_id` when the create call returns, so the first `ACTIVATED` finds its row; if no `subscriptions` row matches yet, the handler falls back to the durable intent table to find the org and bind the ID there. Unknown or ambiguous IDs return 404, any `org_id` in the payload is ignored, and late events for a superseded ID (after a re-subscribe overwrote it) 404 harmlessly.
- **AC-7**: Each verified `PAYMENT.SALE.COMPLETED` persists one `payments` row in a single transaction protected by the unique `(provider, provider_event_id)` index: `provider = 'paypal'`, `status = 'SUCCESS'`, `amount` and `currency` from the payload amount (currency must be `USD`, otherwise the event is logged and rejected), `reference` set to the transaction ID, `provider_event_id` set to the notification ID; redelivery of the same event cannot create a duplicate payment.
- **AC-8**: Webhooks move rows up or refresh fields, never down the ladder. `BILLING.SUBSCRIPTION.ACTIVATED`: `ACTIVE`, records the `plan`, stores `current_period_end` from the refetch, syncs the seat cap to the plan's seat count (never below live member headcount), marks the intent `DONE`. `PAYMENT.SALE.COMPLETED`: records the payment, refreshes `current_period_end`, and restores `ACTIVE` from `PAST_DUE` or from a ladder rung before `CANCELLED` (clearing `stage_ends_at` and `pending_cancel`); a row already `CANCELLED` requires a fresh checkout instead. `SUSPENDED`, `CANCELLED`, `EXPIRED`, `PAYMENT.FAILED`, and `ACTIVATION.CANCELLED` refetch and refresh stored fields (`pending_cancel`, period end, intent status) but change no rung.
- **AC-9**: The hourly Workers cron is the only demoter: `TRIAL` past `stage_ends_at` goes to `GRACE` (7 days), then `READ_ONLY` (5 days), then `CANCELLED` (hard lock); an `ACTIVE` or `PAST_DUE` row past `current_period_end + 1 day`, or past a `stage_ends_at` it is carrying, advances likewise. Before any demotion the cron refetches the bound PayPal subscription and syncs the row to its live status instead when PayPal says billing is actually active (a lost `ACTIVATED` or lost `PAYMENT.FAILED` both converge within an hour). A `NULL current_period_end` on a row with a bound PayPal subscription means no trustworthy clock: the cron refetches and repairs it; a row with no binding (seeded) falls back to `now()` and logs. Every rung write is a conditional update compare and swap on `id`, `status`, and `stage_ends_at`; zero rows affected means a webhook got there first, so the cron skips and logs. A missed hour self heals on the next pass, and a trial past `stage_ends_at` keeps full access until that pass runs (up to about an hour, intended).
- **AC-10**: The tenant data gate enforces the ladder: `TRIAL`, `ACTIVE`, `PAST_DUE`, and `GRACE` pass fully; `READ_ONLY` passes reads (`GET /api/db/schema`, the read methods `get`, `getAll`, `getSingleValues`, `exists` on `/api/db/call`, and all of `/api/db/bespoke`) and refuses the write methods `insert`, `update`, `delete`, `deleteAll`, `rename` with HTTP 402 and the fixed body `{ error: 'Subscription is read only', code: 'SUBSCRIPTION_READ_ONLY', status: 'READ_ONLY' }`; `CANCELLED` or a missing row keeps the existing 402 `SUBSCRIPTION_INACTIVE` denial; a control plane failure keeps the existing 503. A structural test enumerates every `BespokeQueries` entry and fails if any is not a pure read, so the bespoke pass through can never quietly become a write door. The client shows a persistent banner per rung, a refused write in `READ_ONLY` surfaces an inline "upgrade to edit" message and never routes away, and a `CANCELLED` org's every screen redirects to the upgrade page.
- **AC-11**: An admin cancel action calls PayPal `POST /v2/subscriptions/{id}/cancel` with a fixed reason constant (no admin typed input) and sets `pending_cancel = true`; access continues `ACTIVE` until `current_period_end`, then the cron's ladder takes over. Switching plans is cancel plus a fresh checkout of the other plan (PayPal has no in-place swap), and the new checkout is refused with 409 `SUBSCRIPTION_SEAT_DOWNGRADE` when the org's live Clerk member count exceeds the target plan's seats.
- **AC-12**: The staging worker uses sandbox credentials and sandbox plan IDs against `api-m.sandbox.paypal.com`; live credentials exist only in the production Worker environment, configured at an explicit go live step, so a dev branch can never reach production PayPal. Secrets (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`) and vars (`PAYPAL_API_BASE`, four plan ID vars) are each set per env, staging and production, exactly once per environment.
- **AC-13**: This feature never imports, references, or bundles `custom/licensing/api/clickpesa-client.ts`; PayPal fully replaces ClickPesa on Web.
- **AC-14**: `worker/db/schema.sql` carries the final model (six state ladder CHECK, nullable `provider`, `plan`, `pending_cancel`, `stage_ends_at`, `payments.currency`, the `subscription_checkout_intents` table with its open intent partial unique index), and the spec's migration note lists the exact operator ALTERs plus the backfill for the live staging control plane: every org with no subscription row, or a seeded `ACTIVE` row with no PayPal binding, becomes `TRIAL` with `stage_ends_at = now() + 14 days`, since DDL and data fixes against shared infra remain a human call (per 0003's precedent).
- **AC-15**: The checkout create request carries the app's own `return_url` (`/billing`) and `cancel_url` (`/billing?checkout=cancelled`) via the non deprecated fields current PayPal docs prescribe; after PayPal redirects back, Billing polls `GET /api/subscription/status` every 3 seconds for up to 120 seconds, renders success only when the polled status reads `ACTIVE` with the new plan (never by optimistic client state), and on timeout shows "activation is processing, reload in a moment" with the AC-9 reconcile pass as the backstop.
- **AC-16**: `GET /api/subscription/status` returns `code: null` for `TRIAL`, `ACTIVE`, `PAST_DUE`, and `GRACE`, `code: 'SUBSCRIPTION_READ_ONLY'` for `READ_ONLY`, and `code: 'SUBSCRIPTION_INACTIVE'` for `CANCELLED` or a missing row; the added `plan`, `currentPeriodEnd`, and `stageEndsAt` fields are `null` when no row exists, so the banner can distinguish nudge from block from lock on this response alone.

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

## Decision

**Chosen option**: Option 1: PayPal Subscriptions (two products, four plans: DIY and DFY, each monthly and yearly, all USD, sandbox until go live), own clock trial opened by provisioning, a six state status ladder where verified webhooks only promote and the hourly cron alone demotes (each demotion preceded by a live status refetch, each rung write conditional), durable checkout intents with stable `PayPal-Request-Id` and an owned state machine, checkout, plan switch, and cancel in-app, organization admins only, and an approval return flow that polls the server for truth.

## Rationale

PayPal Subscriptions is the standard recurring product for the outside Tanzania audience, and its event set maps onto the ladder without owning the ladder itself (basis: September 2026 SDK docs crosscheck, and the original 0004 draft's same conclusion). The trial clock is RareBooks's own because the product promise (instant app access from signup) cannot ride a PayPal trial, which only exists post approval (basis: the engineer's signup flow requirement; `handleOrganizationCreated` is already the provisioning hook). The promote and demote split exists because webhooks are both untrusted until verified and unreliable in delivery: letting only the cron move rows down, and only after PayPal's live API confirms it, makes every lost event converge safely (wrong direction impossible: billing stays on for a paying org; tolerable delay: a lapsed org's lockout slips to the next pass) (basis: distributed systems idempotent reconciliation, and the cross-check pass's finding 2). Writing the PayPal subscription ID at checkout time (not at `ACTIVATED`) breaks the first activation chicken and egg: the binding exists before the lookup needs it, re-subscription overwrites cleanly, and superseded IDs 404 as noise (basis: cross-check finding 1). Verify then refetch, rather than trusting the payload, because the create request schema already changed once during planning and the API surface keeps moving (basis: the deprecated fields found September 2026). Two plan IDs plus a seat map in code beats PayPal metadata seats for two fixed tiers: fewer sources of truth, and seats must exist before any PayPal call anyway for the trial (basis: engineer's plan model). The mid trial forfeiture is accepted consciously; billing anchors to approval with no future start time games (a pending future start subscription adds states the ladder does not need). Manual REST instead of the TypeScript SDK for all PayPal calls: the SDK ships no webhook verification helper (September 2026 doc search found none) and its Workers compatibility is unproven, while the integration needs a handful of endpoints (basis: Workers runtime constraints; runner up is the SDK if more PayPal surface grows later).

## Feature design

**Data model sketch** (control plane Neon, `worker/db/schema.sql`):
- `organizations`: unchanged (`plan_seat_limit` keeps its record of intent role, spec 0003).
- `subscriptions` (one row per org, `org_id` UNIQUE): `id` uuid pk; `org_id` text NOT NULL UNIQUE → `organizations`; `provider` text NULL CHECK (`'paypal'`, `'lipa_namba'`) (now nullable: a trial row predates any provider); `status` text NOT NULL CHECK (`'TRIAL'`, `'ACTIVE'`, `'PAST_DUE'`, `'GRACE'`, `'READ_ONLY'`, `'CANCELLED'`) (replaces the old six; `EXPIRED`, `SUSPENDED`, `PENDING_REVIEW` retired, see Follow-up for spec 0005); `plan` text NULL CHECK (`'diy'`, `'dfy'`) (NULL through the trial); `paypal_subscription_id` text UNIQUE NULL (written by the checkout create, overwritten by re-subscription); `current_period_end` timestamptz NULL; `pending_cancel` boolean NOT NULL DEFAULT false; `stage_ends_at` timestamptz NULL (when the cron advances this org one rung; NULL on a healthy `ACTIVE`); `updated_at`.
- `payments`: adds `currency` text NULL. PayPal rows: `status = 'SUCCESS'` (only written state), `reference` = transaction ID, `provider_event_id` = notification ID. Existing unique `(provider, provider_event_id)` partial index stands.
- `subscription_checkout_intents` (new): `id` uuid pk; `org_id` text NOT NULL → `organizations`; `plan` text NOT NULL CHECK (`'diy'`, `'dfy'`); `period` text NOT NULL CHECK (`'monthly'`, `'yearly'`); `status` text NOT NULL CHECK (`'PENDING'`, `'CREATED'`, `'FAILED'`, `'DONE'`) with writers named in AC-3; `paypal_request_id` text NOT NULL UNIQUE; `paypal_subscription_id` text UNIQUE NULL (stored when create returns); `approval_url` text NULL; `created_at`, `updated_at`. Unique partial index on `org_id` where `status IN ('PENDING','CREATED')` (one open intent per org).
- Shared constants module `custom/web/billing/plans.ts` (the single source both client and Worker read): `TRIAL_DAYS = 14`, `GRACE_DAYS = 7`, `READ_ONLY_DAYS = 5`, `TRIAL_SEATS = 5`, and per plan: seats (DIY 2, DFY 5), USD price (DIY 20 monthly / 204 yearly, DFY 49 / 500), and card copy incl. DFY's three perks (data migration and app setup, over the shoulder software use training, priority support).

**State transitions** (the ladder; webhooks promote or refresh, the cron demotes; `stage_ends_at` marks the next rung):

```
(signup) ─▶ TRIAL ─▶ GRACE ─▶ READ_ONLY ─▶ CANCELLED
             │         ▲          ▲            │
             │         │          │            │ (fresh checkout rebinds
   [checkout + ACTIVATED]          │            │  the same row, back in)
             ▼         │          │            ▼
            ACTIVE ◀───┴──────────┴───────  ACTIVE
             │  ▲ (PAYMENT.SALE.COMPLETED restores, before CANCELLED)
             │  │
             ├──┴── [PAYMENT.FAILED → PAST_DUE (refresh only);
             │       cron demotes to GRACE once entitlement end + 1 day passes]
             └── [in app cancel: pending_cancel=true, stays ACTIVE
                  to current_period_end; the cron then starts the ladder]
```

PayPal `SUSPENDED`, `EXPIRED`, and `CANCELLED` events refresh fields; the cron's refetch sees the live state and starts the ladder at entitlement end. A live status refetched as genuinely `ACTIVE` by the cron (renewal PayPal completed without an event reaching us) repairs the row upward instead. Mid trial upgrade: billing starts at approval, remaining trial days are forfeited (accepted, see Rationale).

**API surface**:
| Endpoint / surface | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `worker/routes/payments/paypal-checkout.ts` → `POST /api/payments/paypal/checkout` | POST | `plan`, `period` (session org); intent state machine per AC-3; writes the `subscriptions` binding on create; Clerk member count guard per AC-11 | `approval_url`, intent status | Clerk session, org admin | 403 `SUBSCRIPTION_ADMIN_REQUIRED`; 409 `SUBSCRIPTION_SEAT_DOWNGRADE`; 502 PayPal error or timeout (intent reconciles on retry) |
| `worker/routes/payments/paypal-cancel.ts` → `POST /api/payments/paypal/cancel` | POST | none (session org); fixed reason constant | `pendingCancel: true` | Clerk session, org admin | 400 no active PayPal subscription; 502 PayPal error |
| `worker/routes/payments/paypal-webhook.ts` → `POST /webhooks/paypal` | POST | PayPal event payload (7 event types, see Configuration) | 200 processed or replay | PayPal webhook signature, then subscriptions row, then intent fallback (AC-6) | 400 bad signature; 404 unknown subscription (PayPal redelivers on non 2xx, redelivery window confirmed at build time); 409 ambiguous mapping |
| `worker/routes/subscription-status.ts` (extends 0003 AC-8) | GET | session | `{ status, code, plan, currentPeriodEnd, stageEndsAt }` with the AC-16 code mapping | Clerk session | 503 unchanged |
| `worker/index.ts` scheduled handler (Workers cron trigger, hourly, `wrangler.toml [triggers]`) | scheduled | none | rung demotions (AC-9: refetch first, conditional update, log skipped), lost event reconciliation, abandoned intent `FAILED` | none (platform invoked) | control plane or PayPal failure: log, retry next hour (idempotent) |
| `custom/web/auth/handleOrganizationCreated.ts` (extends provisioning) | hook | new Clerk org | trial row + seat sync 5 | (webhook verified path, 0001) | Clerk failure: logged, 0003 ordering |
| Shared: `custom/web/payments/paypal-client.ts` (token, create, cancel, get, verify REST calls), `custom/web/billing/plans.ts`, `custom/web/billing/types.ts` (new status union, new wire constants), `custom/web/billing/subscriptionGate.ts` (`gateDecision(status, callKind)` returning allow / readOnly / block, used by the middleware) | | | | | |
| `src/pages/web/Billing.vue` (replaces the disabled CTA): plan cards, admin gated checkout and cancel buttons, trial billed today confirm, return polling card per AC-15; nudge banner + `CANCELLED` router lock + read only inline refusal handling in the web shell | client | | | | |

**Value sourcing**:
| Action | Value produced / displayed | Source |
|---|---|---|
| Checkout: resolve PayPal plan | one of 4 plan IDs | env var selected by the (plan, period) pair from the intent (`PAYPAL_PLAN_ID_DIY_MONTHLY`, `_DIY_YEARLY`, `_DFY_MONTHLY`, `_DFY_YEARLY`) |
| Checkout: idempotency | `PayPal-Request-Id` | the durable intent's unique `paypal_request_id`, reused across retries of that intent |
| Checkout: admin check | allow or 403 | Clerk session organization role claim (owner or admin; exact claim name confirmed against Clerk docs via context7 at build time) |
| Checkout: binding | `subscriptions.paypal_subscription_id` | the create response's subscription ID, written in the same transaction that marks the intent `CREATED` (AC-6) |
| Checkout: return and cancel URLs | where PayPal sends the payer back | app origin route constants `/billing` and `/billing?checkout=cancelled` (AC-15) |
| Plan switch: seat guard | allow or 409 | Clerk live member count for the org vs the target plan's `plans.ts` seats (AC-11) |
| Activation: seat cap | 2 or 5 | `plans.ts` keyed by the activated plan; `paypal_subscription_id` from the refetch or the checkout binding, never from a card or metadata (AC-8) |
| Trial: seat cap + end | 5; `created + 14d` | `plans.ts` TRIAL_SEATS / TRIAL_DAYS; row written by provisioning (AC-1) |
| Webhook and cron: trusted status, period end, cancel state | current values | `GET /v2/subscriptions/{id}` response after signature verification (AC-5, AC-8, AC-9) |
| Payment row: amount, currency, reference, event ID | payment facts | verified `PAYMENT.SALE.COMPLETED` payload only, mapped per AC-7 (currency validated `USD`) |
| Webhook: which org to update | local `org_id` | unique lookup of the PayPal subscription ID in `subscriptions.paypal_subscription_id`, then the intent table fallback (AC-6) |
| Ladder rung timing | next `stage_ends_at` | `GRACE_DAYS` / `READ_ONLY_DAYS` in `plans.ts`, added to the rung entry time (AC-9) |
| Cancel: reason sent to PayPal | cancellation note | fixed constant string (AC-11), no user input |
| Poll after return: success | `ACTIVE` + plan | `GET /api/subscription/status` only, never client optimism (AC-15) |
| Plan cards: name, seats, prices, perks | displayed copy | `plans.ts` constants (AC-2); yearly prices match the PayPal plan setup values ($204, $500) |
| Banner: days left | countdown | `stageEndsAt` / `currentPeriodEnd` from `GET /api/subscription/status` (AC-16); rendered in browser local time (display only; the cron compares `timestamptz` server side) |

**Key invariants**:
- No `subscriptions` or `payments` update ever happens from an unverified payload; no lifecycle fact is applied from payload content that the refetch contradicts (the refetch wins).
- Webhooks promote and refresh; only the cron demotes, and only after refetching PayPal's live status (AC-8, AC-9). Every rung write (cron or webhook) is conditional compare and swap on the row's `status` and `stage_ends_at`; zero rows affected is a benign skip, logged, not an error.
- One org, one subscription row (UNIQUE `org_id`), one PayPal subscription mapping (UNIQUE `paypal_subscription_id`, written at checkout, overwritten only by that org's own re-subscription), one open checkout intent (unique partial index).
- Payment webhook processing is transactional and replay safe: the event ID row and the status/period update commit together.
- Every rung transition writes `updated_at` and the new `stage_ends_at` in the same statement; the cron only acts on rows whose `stage_ends_at` or entitlement timestamp has passed, so a missed hour self heals.
- `READ_ONLY` blocks every write the Worker can dispatch: the method allowlist split plus the structural pure-read test over `BespokeQueries` (AC-10); reads and downloads never break for a non `CANCELLED` org.
- The gate, the cron, and the client all read the same status union, wire codes, and ladder constants from `custom/web/billing/` (shared code rule from 0003: the seed script and the Worker both consume it; `worker/` is never imported into root code).
- Sandbox base `api-m.sandbox.paypal.com` unless the Worker env is production with live credentials (AC-12); `custom/licensing/api/clickpesa-client.ts` stays untouched by Web code (AC-13).

**Security model**: Checkout and cancel routes act only on the session's own org, and require the Clerk org owner or admin role; nothing is client selectable. The webhook route is unauthenticated HTTP, so trust is layered: signature verification (with the hand rolled CRC32 over WebCrypto, since Workers has no builtin and the SDK ships no helper) gates everything; the refetch gates status facts; the unique DB mapping (checkout binding, intent fallback) gates org identity; payload `org_id` is ignored. PayPal credentials live only in Worker secrets (`wrangler secret put`), plan IDs and API base in per env `[vars]`. Payment events append to `payments` (an immutable audit trail of who paid what when); plan changes and cancellations are recorded in `subscriptions` columns; no card data ever touches RareBooks (PayPal hosted approval). Compliance scope: PCI DSS SAQ A posture (hosted redirect, no card data), same as the original draft.

**Configuration required**:
- Secrets (`wrangler secret put`, per staging and production env): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`
- Vars (`wrangler.toml [vars]`, per env): `PAYPAL_API_BASE` (sandbox vs live), `PAYPAL_PLAN_ID_DIY_MONTHLY`, `PAYPAL_PLAN_ID_DIY_YEARLY`, `PAYPAL_PLAN_ID_DFY_MONTHLY`, `PAYPAL_PLAN_ID_DFY_YEARLY`
- Triggers: `[triggers] crons = ["0 * * * *"]` (the first cron entry on this Worker)
- One time PayPal setup (not per request): PayPal business account, 2 catalog products (DIY, DFY), 4 billing plans (2 per product, monthly and yearly, USD, no trial period on the plans), 1 webhook per env subscribed to seven event types: `Billing Subscription Activated`, `Suspended`, `Cancelled`, `Expired`, `Payment Failed`, `Activation Cancelled`, plus `Payment Sale Completed`; the webhook URL is `https://app.rarebooks.cc/webhooks/paypal` (staging registers against the staging route; the worker.dev preview is not usable).

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: new org is provisioned, lands in the app instantly as `TRIAL` with seat cap 5; an admin checks out DFY monthly (binding + approval URL land), approves on sandbox PayPal, returns to Billing, the poll sees `ACTIVE` with plan `dfy` and seat cap 5; a `PAYMENT.SALE.COMPLETED` records the payment row. Verifies **AC-1, AC-3, AC-5, AC-6, AC-7, AC-8, AC-15**.
- Ladder: a trial that never upgrades is advanced by the cron to `GRACE` at day 14, to `READ_ONLY` at day 21 (a `/api/db/call` `insert` returns 402 `SUBSCRIPTION_READ_ONLY` while `getAll`, `/bespoke`, and schema still succeed), to `CANCELLED` at day 26 where every tenant route 402s `SUBSCRIPTION_INACTIVE` and the router lands the member on the upgrade page. Verifies **AC-9, AC-10**.
- Lost event reconciliation: an `ACTIVATED` dropped in transit leaves the row `TRIAL`; the next cron pass refetches the bound subscription, sees it live on PayPal, and repairs the row to `ACTIVE` instead of demoting. A lost `PAYMENT.FAILED` likewise cannot strand a row `ACTIVE` past `current_period_end`: the reconcile pass demotes from the refetched truth. Verifies **AC-9**.
- Failure case: `BILLING.SUBSCRIPTION.PAYMENT.FAILED` refreshes fields only (row stays `ACTIVE` to period end per PayPal's own entitlement), then the cron arms `PAST_DUE`/`GRACE` from the refetched state; next month's `PAYMENT.SALE.COMPLETED` restores `ACTIVE`. Verifies **AC-8, AC-9**.
- Security: a payload with a bad signature 400s and writes nothing; a valid signature but an unknown PayPal ID 404s; a payload `org_id` never selects the row. Verifies **AC-4, AC-6**.
- Replay and ordering: the same `PAYMENT.SALE.COMPLETED` delivered twice leaves exactly one `payments` row; a `SALE.COMPLETED` that arrives before `ACTIVATED` resolves through the intent fallback, applies activation effects, then records the payment. Verifies **AC-7, AC-6, AC-8**.
- Checkout retry: two clicks on DIY monthly return the same intent and approval URL; a create that times out 502s and a later click reconciles; switching to DFY yearly fails the old intent and opens a new one with a new `PayPal-Request-Id`; a payer who closes the PayPal tab gets `ACTIVATION.CANCELLED` failed intent and can start over. Verifies **AC-3**.
- Auth/permission: a plain member calling checkout or cancel gets 403 `SUBSCRIPTION_ADMIN_REQUIRED` and sees no buttons on Billing. Verifies **AC-2**.
- Cancel and switch: admin cancels (fixed reason); status stays `ACTIVE` with `pending_cancel` until period end, then the cron starts the ladder; a DFY org with 4 members switching to DIY gets 409 `SUBSCRIPTION_SEAT_DOWNGRADE` until members are removed. Verifies **AC-11**.
- Backfill: staging seed rows and unbound rows become `TRIAL` with `stage_ends_at = now() + 14d` under the operator migration note; the trial passes until its cron pass. Verifies **AC-14, AC-9**.

## Build plan

Tracer Bullet (project default): tasks 1 through 5 stand up a thin trial to upgrade to paid thread through every layer, then the ladder and the client thicken it. Task 1's operator ALTER and backfill list runs before task 4 tests hit staging.

1. Schema change in `worker/db/schema.sql` plus the documented operator ALTER and backfill note (new CHECK, nullable provider, `plan`, `pending_cancel`, `stage_ends_at`, `payments.currency`, `subscription_checkout_intents` with the partial unique indexes; seed and unbound rows to `TRIAL`). Satisfies **AC-14** (foundation for AC-1, AC-3, AC-6, AC-9).
2. Shared billing core: `plans.ts` (tiers, prices, seats, ladder windows), the six state status union and wire types update in `custom/web/billing/types.ts` (incl. `SUBSCRIPTION_READ_ONLY_*` and `SUBSCRIPTION_ADMIN_REQUIRED` constants), and `gateDecision` in `custom/web/billing/subscriptionGate.ts`, with the root tape suite extended. Satisfies **AC-2** (shared half), **AC-10** (shared half), **AC-16** (constants).
3. PayPal client and checkout: `custom/web/payments/paypal-client.ts` (token, create with `return_url`/`cancel_url`, cancel, get, verify REST), the checkout route with the full intent state machine (AC-3 writers), the create time binding (AC-6), the admin guard, and the member count downgrade guard, against sandbox. Satisfies **AC-3, AC-6** (binding), **AC-11** (guards), **AC-12** (sandbox), **AC-15** (URLs), **AC-2** (Worker guard half).
4. Webhook route: verify (WebCrypto CRC32 path), refetch, resolve (subscriptions row then intent fallback), then the promote handlers (`ACTIVATED`, restoring `SALE.COMPLETED` with the AC-7 column mapping) and the refresh handlers (`SUSPENDED`, `CANCELLED`, `EXPIRED`, `PAYMENT.FAILED`, `ACTIVATION.CANCELLED`), transactional and replay safe. Satisfies **AC-4, AC-5, AC-6** (resolution), **AC-7, AC-8**.
5. Provisioning trial: `handleOrganizationCreated` writes the `TRIAL` row and syncs 5 seats. A test org can: signup into trial, click checkout, approve in sandbox PayPal, come back `ACTIVE`. Satisfies **AC-1** (closing the thin thread).
6. Hourly cron: demotion ladder with refetch first, the reconciliation repair pass, conditional rung writes, and abandoned intent failing, registered via `[triggers]`. Satisfies **AC-9** (plus the intent timeout writer of **AC-3**).
7. Gate tiering and status: wire `gateDecision` into `requireActiveSubscription` (method kind classification for `/api/db/call`, reads and bespoke pass, writes refuse), the bespoke pure-read structural test, the `GET /api/subscription/status` code mapping and added fields, Worker vitest coverage. Satisfies **AC-10** (Worker half), **AC-16**.
8. Billing page: plan cards from `plans.ts`, admin gated checkout buttons, the trial billed today confirm, the return polling card and cancel handling, the cancel button and pending state. Satisfies **AC-2, AC-11** (user flow), **AC-15**, and the checkout UX half of **AC-3**.
9. Web shell: nudge banner per rung (trial day 8+, past due, grace, read only), `SubscriptionReadOnlyError` in the demux path with the inline upgrade to edit message and no route change, and the `CANCELLED` router lock to the upgrade page. Satisfies **AC-10** (client half), **AC-1** (nudge), **AC-16** (client consumption).
10. Production env separation: live credentials, vars, and plan IDs as explicit go live steps against `[env.production]`, and the bundle grep proving no `clickpesa-client` reference in the Web build. Satisfies **AC-12, AC-13**.

## Consequences

**Positive**:
- The whole money path (trial, subscribe, charge, fail, cancel, lock) is one coherent machine with a safe failure direction: a lost PayPal event can only delay a lockout or be repaired within an hour, never wrongly lock a payer or strand a dead org free.
- Spec 0005 (Lipa Namba) plugs into the same ladder by writing the same columns.
- New customers experience the product before paying, and lapsing customers never lose read access to their own books.
- Seats stop being an unassigned mystery: trial start, activation, and the downgrade guard all flow through 0003's seat sync path or its Clerk source.

**Negative / tradeoffs**:
- Effective free usage is up to 21 full days (14 trial + 7 grace) plus 5 read only days, up to an hour longer per rung; that is the deliberate business choice behind the ladder.
- This spec reaches into spec 0003's just built gate and wire shapes; 0003's `/check verify` and 16 Worker tests must re-run after task 7, and 0003's status list and prompt mapping notes go stale (see Follow-up).
- PayPal's schema has already moved once during planning; hand rolled signature verification (CRC32 in WebCrypto) is the most security sensitive code this feature writes, and the cron adds a new always on moving part to a Worker that had none.
- The independent cross-check (a second model, this revision) found thirteen load bearing gaps in the first draft (first activation binding, lost event reconciliation, intent writers, return flow, NULL clock, seat policy, read only client path, ordering, lost update races, status codes, payment column mapping, bespoke trust, smaller invented values); all thirteen are closed in this text, and the honest read is that the feature is denser than its two plan cards suggest.
- Operator burden: a status CHECK swap, one new table, two new indexes, four plan IDs, three secrets, a webhook registration of seven events, and a backfill, against a staging plane that already drifts (the 0003 precedent).

**Neutral**:
- New Worker env surface: 3 secrets, 5 vars, and the first `[triggers]` cron entry in `wrangler.toml`.
- Mid trial upgrades bill immediately and forfeit unused trial days.
- DFY's service perks are commitments the team fulfills off platform; the app only displays and records the plan.

## Follow-up

- [ ] Immediately before task 3, rerun the context7 lookup for Create Subscription (current `return_url`/`cancel_url` or `user_action` field shapes), cancel, get, and verify webhook signature against current PayPal docs; the deprecated `applicationContext`/`autoRenewal` shape must not be built from this spec's summary. Also confirm PayPal's webhook non 2xx redelivery window (AC-6's 404 retry assumption).
- [ ] Confirm the Clerk session organization role claim for owner/admin and the member count read against current Clerk docs (via context7) before wiring the guards in task 3.
- [ ] Operator: apply the ALTER and backfill list from task 1 to staging before first webhook testing, and register the seven event types on the staging PayPal webhook.
- [ ] A lost `PAYMENT.SALE.COMPLETED` reconciles status via the cron but never backfills the missed `payments` row; if financial reporting needs the gap closed later, PayPal's transaction search can backfill it. Not in v1.
- [ ] Spec 0005 (Lipa Namba, planned, undesigned): it referenced the retired `PENDING_REVIEW` subscription status; when it is designed it must use this ladder (an approved claim sets `ACTIVE` with `provider = 'lipa_namba'` and a plan).
- [ ] Spec 0003: its gate, status union comment, and Billing prompt buckets note the old six states and "two fixed shapes"; run `/sync` after this feature lands so 0003's records point here for the revised ladder (0003 itself stays in progress; verify must re-run after task 7).
- [ ] Finalize DIY card copy (its perks list and support wording); DFY's three perks are confirmed.
- [ ] Set the live PayPal product and plan prices ($20/204, $49/500 USD) at the go live step; sandbox carries the same numbers for realism.

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
