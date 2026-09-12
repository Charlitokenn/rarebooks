# Verify: Subscription gating & seat sync · spec 0003 · updated 2026-09-12

_Steps derived from spec 0003 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Prerequisites (staging/dev)

- [ ] A real Neon/Postgres control plane with the `worker/db/schema.sql` tables applied
- [ ] Clerk instance with `CLERK_SECRET_KEY` + `CONTROL_DATABASE_URL` available (env, root `.env`, or `worker/.dev.vars`)
- [ ] One test Clerk org, signed in via the web client, with its tenant project provisioned
- **Schema drift (blocking, found during /develop 2026-09-12):** the staging control plane's `subscriptions` table was created from an older schema.sql: it has no `UNIQUE (org_id)` constraint (the seed upsert's `ON CONFLICT (org_id)` cannot work without it) and its status CHECK omits `SUSPENDED`. The operator applies these deliberately (DDL against shared infra):
  - [ ] `ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_org_id_key UNIQUE (org_id);`
  - [ ] `ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check; ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('ACTIVE','PAST_DUE','EXPIRED','PENDING_REVIEW','SUSPENDED','CANCELLED'));`

## Commands

- [ ] `npm --prefix worker test` → 16 pass (gate allow/deny/missing/503, resolver-not-called, ordering, status route) → AC-1, AC-2, AC-3, AC-8
- [ ] `npm test -- custom/web/billing/tests/billing.spec.ts` → 25 assertions pass (seat sync ordering, status read) → AC-5
- [ ] `npm run seed:subscription -- --org=<testOrgId> --seats=3` → exit 0, logs subscription ACTIVE + seat cap synced → AC-7
- [ ] `npm run seed:subscription -- --org=<testOrgId>` (no `--seats`) → exit 1 with the "required" error → AC-7
- [ ] `npm run seed:subscription -- --org=<testOrgId> --dry-run` → exit 0, touches nothing → AC-7
- [ ] `cd worker && npm run typecheck` → error set identical to the unmodified branch (118 pre-existing, 0 new) → AC-9
- [ ] `npm run build:web` → succeeds with Billing.vue / router / demux changes → AC-4

## UI / manual

- [ ] Org with no subscription row: dashboard's tenant data call → 402 → app lands on `/billing` showing the "Choose a plan" card with the MISSING note → AC-1, AC-2, AC-4
- [ ] Run the seed command for that org, refresh `/billing` → now shows the green "Active" card with "Back to dashboard"; dashboard data calls succeed → AC-7, AC-8
- [ ] `UPDATE subscriptions SET status='PAST_DUE' WHERE org_id=...` (psql), then hit a tenant data route → 402 body is exactly `{"error":"Subscription is not active","code":"SUBSCRIPTION_INACTIVE","status":"PAST_DUE"}` and `/billing` shows the yellow payment problem card → AC-2, AC-4
- [ ] Point `CONTROL_DATABASE_URL` at a dead host, `wrangler dev`, call `/api/db/call` → 503 body `{"error":"Subscription status temporarily unavailable","code":"CONTROL_PLANE_UNAVAILABLE","status":"UNAVAILABLE"}`; on the client this surfaces as a plain error/retry, never a redirect to /billing; opening `/billing` shows the "could not reach the billing service" retry card → AC-2, AC-4
- [ ] `/billing` cold load (fresh tab, no prior denial) while PAST_DUE → renders from `GET /api/subscription/status` alone → AC-8
- [ ] Clerk Dashboard, test org: after the seed with `--seats=3`, organization's member cap shows 3, and inviting a 4th member is blocked by Clerk itself → AC-5, AC-6
- [ ] Unauthenticated `curl localhost:8787/api/db/call` → 401 (not 402); authenticated but no active org → 403 with the existing clerk-auth body → AC-2
- [ ] `GET /api/subscription/status` with a valid session → `{status, code}` JSON, `Cache-Control: no-store` → AC-8
- [ ] grep confirms no new file imports or references `custom/licensing` → AC-9

## Acceptance-criteria coverage

- AC-1 covered by: first manual 402 step + worker tests (deny before resolver) · AC-2 by: 402/503 body assertions (tests + curl/past-due step) · AC-3 by: all three /api/db routes in the loop tests + `git diff worker/routes/db.ts` shows the single `use` and no inline args · AC-4 by: redirect steps + outage step (client shows retry, not billing) · AC-5 by: seed + Clerk Dashboard cap check + tape ordering tests · AC-6 by: grep `worker/middleware/` shows no seat counting (Clerk enforces) · AC-7 by: three command steps · AC-8 by: cold-load + status route steps · AC-9 by: lint/typecheck clean + grep audit
