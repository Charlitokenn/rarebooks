# Verify: PayPal subscriptions · spec 0004 · updated 2026-09-14

_Steps derived from spec 0004 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._
_The first session (2026-09-14) built the shared billing core, the schema model plus operator migration, and the Worker gate/status half (tasks 1, 2, 7), so the ACs with runnable steps below are AC-10 (shared and Worker halves) and AC-16. The rest stay planned until their tasks build; each has its step seeded here from the spec so nothing is lost._

## Prerequisites (staging/dev)

- [ ] A real Neon/Postgres control plane with the ladder applied: run `worker/db/migrations/0004-subscription-ladder.sql` inside its BEGIN/COMMIT against `CONTROL_DATABASE_URL` (operator call, DDL on shared infra), or point local `wrangler dev` at a fresh plane where `worker/db/schema.sql` applied clean → AC-14
- [ ] A signed-in Clerk test org whose tenant is READY
- [ ] Before ANY further task: rerun the context7 lookups named in the spec's Follow-up (Create Subscription field shapes, webhook signature verify, Clerk role claims and member count read)

## Commands

- [ ] `npm --prefix worker test` → 23 pass (ladder tiering at the gate, read/write bodies, MISSING fail-closed, 503, AC-16 status shape) → AC-10, AC-16
- [ ] `npm test -- custom/web/billing/tests/ladder.spec.ts custom/web/billing/tests/bespoke-reads.spec.ts custom/web/billing/tests/billing.spec.ts` → 80 assertions pass (rung table, plan constants, bespoke classification, status read) → AC-2, AC-10, AC-16
- [ ] `psql $CONTROL_DATABASE_URL -f worker/db/migrations/0004-subscription-ladder.sql` twice → no error the second time (idempotent), `SELECT status, count(*) FROM subscriptions GROUP BY status;` shows only ladder values, `UPDATE subscriptions SET status='XYZ' WHERE org_id=...;` → rejected by the CHECK → AC-14
- [ ] `cd worker && npm run typecheck` → error set identical to the unmodified branch (118 pre-existing, 0 new) → (standing verify protocol)

## UI / manual

- [ ] Set an org's row to `READ_ONLY` (`UPDATE subscriptions SET status='READ_ONLY', stage_ends_at=now()+interval '5 days' WHERE org_id=...`): open the app → schema loads, dashboard data reads succeed → AC-10, AC-16
- [ ] Same org, trigger a save (create an Invoice or edit a doc): the write fails with a 402 whose body is exactly `{"error":"Subscription is read only","code":"SUBSCRIPTION_READ_ONLY","status":"READ_ONLY"}`, the app shows an inline upgrade-to-edit message and never routes away → AC-10. _Planned (task 9): the typed `SubscriptionReadOnlyError` path; today the demux surfaces it as a plain DatabaseError._
- [ ] Same org at `READ_ONLY`: `curl -X POST /api/db/bespoke -d '{"method":"getCashflow","args":[...]}'` → 200; `-d '{"method":"migrateExpenseDescription","args":[]}'` → 400 invalid method (never dispatchable on Web) → AC-10
- [ ] Same org at `READ_ONLY`: `GET /api/subscription/status` → `{"status":"READ_ONLY","code":"SUBSCRIPTION_READ_ONLY","plan":...,"currentPeriodEnd":...,"stageEndsAt":...}` → AC-16
- [ ] Set the row to `TRIAL` with `stage_ends_at = now() + interval '14 days'` and `plan = NULL`: every tenant call passes; `/billing` shows the green Trial card → AC-10, AC-16
- [ ] Set the row to `GRACE`: tenant calls pass; `/billing` shows the yellow grace card → AC-10
- [ ] Set the row to `CANCELLED`: every tenant route 402s `SUBSCRIPTION_INACTIVE`; `/billing` shows the gray "Choose a plan" card → AC-10, AC-16
- [ ] Delete the row (or point `CONTROL_DATABASE_URL` at a dead host): status route returns MISSING fields null / 503 as before; the Billing retry path is unchanged → AC-16, 0003 parity
- [ ] `/billing` cold load while `TRIAL`: the card renders from `GET /api/subscription/status` alone, timestamps absent → no crash on nulls → AC-16
- [ ] grep confirms nothing still references the retired statuses (`EXPIRED`, `PENDING_REVIEW`, `SUSPENDED` as subscription states) or `getSubscriptionStatus` → clean swap
- [ ] **Planned (task 3):** checkout twice with PayPal paused → one subscription, same `PayPal-Request-Id`; create that times out → 502, later click reconciles, no second PayPal subscription; two clicks → same intent and approval URL → AC-3
- [ ] **Planned (tasks 3, 5):** sandbox happy path: provisioned org lands `TRIAL` (row written by provisioning, seat cap 5), admin checks out DFY monthly, approves on sandbox PayPal, returns to `/billing`, the poll sees `ACTIVE` + plan `dfy`, a `PAYMENT.SALE.COMPLETED` records one payments row → AC-1, AC-5, AC-6, AC-7, AC-8, AC-15
- [ ] **Planned (tasks 3, 5):** admin-only: a plain member sees no checkout or cancel buttons and their POST to `/api/payments/paypal/checkout` gets 403 `SUBSCRIPTION_ADMIN_REQUIRED`; a trial org checking out sees the billing starts today confirm → AC-2
- [ ] **Planned (tasks 6, 9):** ladder time travel: set `stage_ends_at` in the past, run the scheduled handler (`wrangler dev` cron or direct invoke) → rung advances exactly one step with the new `stage_ends_at` (+7d to GRACE, +5d to READ_ONLY, then CANCELLED); a bound row whose PayPal refetch says active gets repaired upward instead → AC-9; a CANCELLED org's client redirects to the upgrade page on every screen → AC-10
- [ ] **Planned (task 4):** a payload with a bad signature → 400 and zero DB writes; valid signature, unknown PayPal ID → 404; a payload `org_id` never selects the row; the same `PAYMENT.SALE.COMPLETED` twice → exactly one payments row → AC-4, AC-6, AC-7
- [ ] **Planned (tasks 3, 6):** cancel: admin cancel sets `pending_cancel = true`, status stays `ACTIVE` to `current_period_end`, then the cron ladder takes over; a fixed reason string reaches PayPal → AC-11
- [ ] **Planned (tasks 3, 8):** seat downgrade guard: a DFY org with 4 members switching to DIY → 409 `SUBSCRIPTION_SEAT_DOWNGRADE`; removing a member allows it → AC-11
- [ ] **Planned (task 10):** go-live note proves production PayPal vars and secrets exist only in `[env.production]`; `npm run build:web` bundle grep finds no `clickpesa-client` reference → AC-12, AC-13

## Value sourcing spot checks

- [ ] Banner and Billing card countdown days: derive from `stageEndsAt` / `currentPeriodEnd` from the status route (ISO, browser local display) and confirm they match `updated_at + ladder windows` in the DB. Breaks if the client ever recomputes windows itself → AC-16
- [ ] Seat cap after activation is `plans.ts` (2 or 5), never a number from a PayPal card or metadata: set `PLANS.diy.seats` aside and confirm an activation writes Clerk `maxAllowedMemberships` = plans value → AC-8
- [ ] Plan env var lookup: `planEnvVarName('dfy','yearly')` = `PAYPAL_PLAN_ID_DFY_YEARLY`; a checkout for each (plan, period) pair resolves a different var → AC-1, AC-3
- [ ] Currency: only `USD` payment events land a payments row; a non-USD verified event is logged and rejected → AC-7

## Acceptance-criteria coverage

Built and verifiable now: AC-10 (shared rung table + Worker tiering + bespoke read allowlist + structural test), AC-14 (schema + idempotent operator migration + backfill), AC-16 (status route shape and code mapping), AC-2/AC-16 shared constants, AC-13 (untouched by built code).
Planned, steps seeded above: AC-1, AC-2 (route guard half), AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-11, AC-12, AC-15.
