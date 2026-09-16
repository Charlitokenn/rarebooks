# Verify: Subscription gating & seat sync · spec 0003 · updated 2026-09-12

_Steps derived from spec 0003 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Prerequisites (staging/dev)

- [x] A real Neon/Postgres control plane with the `worker/db/schema.sql` tables applied — probed live 2026-09-15 (`organizations`, `subscriptions`, `tenant_projects` all present and queryable)
- [x] Clerk instance with `CLERK_SECRET_KEY` + `CONTROL_DATABASE_URL` available (env, root `.env`, or `worker/.dev.vars`) — present; seed's Clerk call succeeded live. Note: `.dev.vars` pairs a `pk_test_` publishable key with an `sk_live_` secret (two different instances); confirm which is intended before relying on local sign-in
- [x] One test Clerk org, signed in via the web client, with its tenant project provisioned — done 2026-09-16 against the LIVE instance (app.rarebooks.cc): signed in with the owner's account, switched the active org to `org_3JJnw703AdpNkjf7EE7gsNLmGtR` ("Verify 0607 Test", tenant READY), and walked the denial, status, and seat-cap checks there. Note: the account was added to this org as a member for the walk and left in it; remove via Clerk Dashboard if unwanted.
- **Schema drift (blocking, found during /develop 2026-09-12):** the staging control plane's `subscriptions` table was created from an older schema.sql: it has no `UNIQUE (org_id)` constraint (the seed upsert's `ON CONFLICT (org_id)` cannot work without it) and its status CHECK omits `SUSPENDED`. The operator applies these deliberately (DDL against shared infra):
  - [x] `ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_org_id_key UNIQUE (org_id);` — live probe 2026-09-15: `subscriptions_org_id_key` present
  - [x] `ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check; ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('ACTIVE','PAST_DUE','EXPIRED','PENDING_REVIEW','SUSPENDED','CANCELLED'));` — live probe: CHECK includes `SUSPENDED`
  - [x] SUPERSEDED 2026-09-16: spec 0004's operator migration `worker/db/migrations/0004-subscription-ladder.sql` was applied to the live control plane with the operator's explicit approval (full pre-migration row backup taken first). This adds the ladder columns (`plan`, `pending_cancel`, `stage_ends_at`), swaps the status CHECK to the ladder rungs, and backfills every org with no row (and every seeded ACTIVE PayPal placeholder) to a 14-day TRIAL, exactly as the file prescribes. It also fixed a live outage: the deployed worker was already running the ladder-aware status read (`SELECT status, plan, current_period_end, stage_ends_at ...`) against a plane that lacked those columns, so every signed-in tenant call returned the fail-closed 503 until the migration ran.

## Commands

- [x] `npm --prefix worker test` → 23 pass observed 2026-09-15 (gate allow/deny/missing/503, resolver-not-called, ordering, status route; count grew past 16 when 0004's ladder tests landed in the same file) → AC-1, AC-2, AC-3, AC-8
- [x] `npm test -- custom/web/billing/tests/billing.spec.ts` → 27 assertions pass (seat sync ordering, status read) → AC-5. Note: the `npm test` wrapper shells through `scripts/runner.sh`, whose shebang needs `zsh` (not installed on this machine); the identical electron-node tape bootstrap was run directly and passed clean.
- [x] `npm run seed:subscription -- --org=<testOrgId> --seats=3` → exit 0, logs subscription ACTIVE + seat cap synced → AC-7. Ran against the live test org `org_3JJnw703…` with `--seats=5` (its existing cap, a no-op change on Clerk): exit 0, both log lines, live row confirmed `ACTIVE`/`paypal` with fresh `updated_at`, Clerk `maxAllowedMemberships=5` verified via Backend API, `plan_seat_limit=5` verified in DB.
- [x] `npm run seed:subscription -- --org=<testOrgId>` (no `--seats`) → exit 1 with the "required" error → AC-7
- [x] `npm run seed:subscription -- --org=<testOrgId> --dry-run` → exit 0, touches nothing → AC-7
- [x] `cd worker && npm run typecheck` → 118 `error TS` lines observed, exactly the pre-existing set (0 new) → AC-9
- [x] `npm run build:web` → exit 0, Billing.vue chunk in output (chunk-size warnings only) → AC-4

## UI / manual

- [ ] Org with no subscription row: dashboard's tenant data call → 402 → app lands on `/billing` showing the "Choose a plan" card with the MISSING note → AC-1, AC-2, AC-4
- [ ] Run the seed command for that org, refresh `/billing` → now shows the green "Active" card with "Back to dashboard"; dashboard data calls succeed → AC-7, AC-8
- [ ] `UPDATE subscriptions SET status='PAST_DUE' WHERE org_id=...` (psql), then hit a tenant data route → 402 body is exactly `{"error":"Subscription is not active","code":"SUBSCRIPTION_INACTIVE","status":"PAST_DUE"}` and `/billing` shows the yellow payment problem card → AC-2, AC-4
- [ ] Point `CONTROL_DATABASE_URL` at a dead host, `wrangler dev`, call `/api/db/call` → 503 body `{"error":"Subscription status temporarily unavailable","code":"CONTROL_PLANE_UNAVAILABLE","status":"UNAVAILABLE"}`; on the client this surfaces as a plain error/retry, never a redirect to /billing; opening `/billing` shows the "could not reach the billing service" retry card → AC-2, AC-4
- [ ] `/billing` cold load (fresh tab, no prior denial) while PAST_DUE → renders from `GET /api/subscription/status` alone → AC-8
- [ ] Clerk Dashboard, test org: after the seed with `--seats=3`, organization's member cap shows 3, and inviting a 4th member is blocked by Clerk itself → AC-5, AC-6
- [x] Unauthenticated `curl localhost:8787/api/db/call` → 401 (not 402); authenticated but no active org → 403 with the existing clerk-auth body → AC-2. Ran against live `wrangler dev` on 8787 2026-09-15: `POST /api/db/call` and `GET /api/db/schema` both returned `401 {"error":"Unauthenticated"}`. The no-active-org 403 half was proven in the gate suite (test "still rejects an unauthenticated session with 401, and no org with 403, before the gate"), not by a live signed-in session.
- [x] grep confirms no new file imports or references `custom/licensing` → AC-9. Grep over `worker/ custom/web/ scripts/ src/ fyo/ utils/ main/ backend/` finds only comment mentions ("must never import"), zero import/require statements. Also: `grep -i seat worker/middleware/` matches only the comment pointing at Clerk as the enforcer (AC-6).
- [ ] `GET /api/subscription/status` with a valid session → `{status, code}` JSON, `Cache-Control: no-store` → AC-8. Partial 2026-09-15: against live `wrangler dev` an unauthenticated call returns 401 (route mounted and reachable), and the `c.header('Cache-Control','no-store')` plus the session requirement are covered by the gate suite's status-route tests; the full authenticated body and header check still wants a signed-in browser session.

## Acceptance-criteria coverage

- AC-1 covered by: first manual 402 step + worker tests (deny before resolver) · AC-2 by: 402/503 body assertions (tests + curl/past-due step) · AC-3 by: all three /api/db routes in the loop tests + `git diff worker/routes/db.ts` shows the single `use` and no inline args · AC-4 by: redirect steps + outage step (client shows retry, not billing) · AC-5 by: seed + Clerk Dashboard cap check + tape ordering tests · AC-6 by: grep `worker/middleware/` shows no seat counting (Clerk enforces) · AC-7 by: three command steps · AC-8 by: cold-load + status route steps · AC-9 by: lint/typecheck clean + grep audit
