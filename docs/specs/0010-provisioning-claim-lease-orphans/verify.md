# Verify: Provisioning claim lease & orphan tracking · spec 0010 · updated 2026-10-26
_Steps derived from spec 0010 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Before any live step: Workers Paid is active, the four queues exist for the env under test (`rarebooks-provisioning[-env]`, `rarebooks-provisioning-dlq[-env]`), and `worker/db/migrations/0010-provisioning-lease.sql` is applied to that env's control plane. Use staging, never production, for the failure drills.

## UI / manual
- [x] Create a new Clerk organization in staging → the webhook answers 200 within a second (Clerk dashboard, Webhooks, message attempts), and the Worker log shows no Neon call from the webhook request → AC-1
- [x] Same org, a few seconds later → `tenant_projects` row is `READY`, `neon_project_id` set, `provisioning_claim_id`, `provisioning_claimed_at`, `provisioning_last_error` all NULL; Neon has exactly one project named `rarebooks-tenant-<orgId>` → AC-2
- [x] Worker logs for that org → exactly one `{"event":"provisioning.ready","orgId":…,"attempt":1}` line, no connection string anywhere → AC-12
- [x] Replay the same `organization.created` message from the Clerk dashboard → 200 again, a `provisioning.already_done` log line, nothing changes in the row or in Neon → AC-1
- [ ] Sign in as the new org right after creation → dashboard shows "still being set up" (202) until the row is `READY`, then loads after a reload (client polling is out of scope) → AC-6

## Commands
- [x] `cd worker && npx vitest run` → all pass (consumer, webhook, lease copies, operator scripts) → AC-1 to AC-12
- [x] `cd worker && CONTROL_TEST_DATABASE_URL=<Neon dev branch URL> npx vitest run tests/provisioning-sql.spec.ts` → 13 pass against real Postgres (claim, refusal, fence, failure record, DLQ, legacy row, runner lease) → AC-3, AC-4, AC-6, AC-7, AC-10, AC-11
- [x] `npx wrangler deploy --dry-run --env staging` (and `--env production`, and top level) in worker/ → each lists `env.PROVISIONING_QUEUE` bound to its own suffixed queue → AC-1, AC-2
- [ ] Live lease deferral: on a staging row, `UPDATE tenant_projects SET provisioning_claim_id='drill', provisioning_claimed_at=now() - interval '2 minutes' WHERE org_id=<org>` with status `PROVISIONING`, then `npm run provision:retry -- <org>` → refused "live lease"; after 18 minutes → sent, and the row ends `READY` → AC-3, AC-8
- [ ] Legacy row: set `provisioning_claimed_at = NULL` with a claim id on a non READY staging row → `npm run provision:retry -- <org>` sends, and the consumer claims it at once → AC-11
- [ ] Exhaustion drill: point one staging org's row at a project whose migrate fails (for example revoke its role's CREATE) → five deliveries spaced about 1, 5, 15, 30 minutes; the row ends `FAILED` with a `provisioning_last_error` that contains no `postgres://`; log shows four `provisioning.attempt_failed` then one `provisioning.failed` → AC-7, AC-12
- [x] FAILED reuse: fix the cause, `npm run provision:retry -- <org>` → row goes `PROVISIONING` (dashboard 202), the same `neon_project_id` ends `READY`, no new Neon project → AC-6, AC-8
- [x] `npm run provision:retry -- <a READY org>` → exit 1, "tenant is READY"; with an unknown org id → exit 1, "unknown org" → AC-8
- [x] `npm run reconcile:tenants` → lists every `rarebooks-tenant-*` project at least 1 hour old with no tenant row pointing at it, and each now appears in `neon_project_orphans` (expect the three `org_3JS04zFKkheMd4PFHmZi0K4OEu7` projects and the `org_probe` / `org_verify_r2_0915` test projects seen on 2026-10-26) → AC-9
- [x] `npm run reconcile:tenants -- --delete <id referenced by tenant_projects>` → exit 1, not deleted; `--delete <ledgered stray>` → deleted and `deleted_at` stamped; the same id again → "already deleted", exit 0 → AC-9
- [x] `npm run migrate:tenants -- --include-project-created` while a consumer holds a live lease on a `PROJECT_CREATED` row → that org reported "skipped: provisioning in flight" → AC-10

## Value sourcing checks
- [x] Claim id is the queue message id: during a run, `provisioning_claim_id` equals the message id in the Worker log's queue invocation → Value sourcing (claim id)
- [ ] Retry delay comes from `msg.attempts`, not the row's `provisioning_attempts`: retry an org whose `provisioning_attempts` is already 5 → the fresh message still gets delays 60, 300, … and is not failed at once → Value sourcing (delivery number)
- [x] Deferral delay comes from Postgres time: with a claim 2 minutes old, the `deferred_live_claim` line shows `delaySeconds` about 1140 → Value sourcing (live claim delay)
- [x] Project name is derived from the org id: Neon shows `rarebooks-tenant-<exact Clerk org id>` → Value sourcing (project name)
- [ ] Adopted project's connection string comes from its single database and owner role: an adopted project's tenant opens normally in the app → Value sourcing (adopted connection string)
- [ ] `region` is the project's `region_id`, including an adopted project in another region → Value sourcing (region)
- [x] Oldest duplicate wins: with two same name projects, the one with the earlier `created_at` is recorded, the other is ledgered `DUPLICATE_NAME` → Value sourcing (which duplicate)
- [ ] `provisioning_last_error` is sanitized: class, Neon HTTP status, first 200 characters, connection strings redacted → Value sourcing (last error)
- [ ] DLQ final delivery at `attempts >= 4` forces `FAILED` even under a live lease → Value sourcing (DLQ last delivery)
- [ ] `provision:retry` sends to the queue named by `CLOUDFLARE_PROVISIONING_QUEUE_ID` for the env you target (check the message arrives on that env's consumer) → Value sourcing (queue to send to)
- [ ] `reconcile:tenants` orphan `org_id` is the name suffix after `rarebooks-tenant-`, and its stray list uses Neon `created_at` at least 1 hour old → Value sourcing (stray list, orphan org_id)
- [x] Runner claim id is a fresh random UUID per row (visible in `provisioning_claim_id` mid run) → Value sourcing (runner claim id)

## Acceptance-criteria coverage
- AC-1 webhook enqueue, 200/500, no Neon: UI 1 and 4, dry run, `organization-created.spec.ts`
- AC-2 consumer to READY, one project: UI 2, `provisioning-consumer.spec.ts` happy path and concurrency
- AC-3 lease claim and deferral: live lease drill, SQL suite, consumer takeover and deferral cases
- AC-4 fenced writes: SQL suite takeover case, consumer takeover case
- AC-5 adopt before create, duplicates ledgered: consumer crash and duplicate cases, value sourcing (oldest duplicate)
- AC-6 FAILED reuse, nothing blanked: FAILED reuse drill, SQL suite, consumer case
- AC-7 bounded retries, DLQ backstop: exhaustion drill, SQL suite DLQ case, consumer DLQ cases
- AC-8 provision:retry: retry refusals and sends, `provisioning-operator-scripts.spec.ts`
- AC-9 reconcile:tenants: report and delete steps, operator scripts spec
- AC-10 runner lease: migrate:tenants step, `tests/tenantMigrationRunner.spec.ts` (tape), SQL suite
- AC-11 legacy rows: legacy row drill, SQL suite, consumer case
- AC-12 structured logs, no secrets: UI 3, exhaustion drill, every consumer test asserts no secret in any log line
