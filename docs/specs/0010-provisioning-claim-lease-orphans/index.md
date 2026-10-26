# 0010. Provisioning claim lease & orphan tracking

**Date**: 2026-10-26
**Status**: In Progress

_Build contract only; the decision history (Context, Options considered, Rationale, References) is in [rationale.md](rationale.md)._

## Summary

Today a new organization's Neon project is created and migrated inside the Clerk webhook request itself, and that work takes longer than the webhook is allowed to run. If the request dies partway, the org stays stuck "being set up" forever, and a retry can quietly create a second, billed Neon project that nothing points at. This spec moves provisioning onto a Cloudflare Queue (a background job line with built in retries), gives each provisioning claim a 20 minute lease (a timed hold another attempt may take over once it expires), and makes every attempt reuse or adopt an existing project before it creates one. Anything that still slips through is recorded in a small orphan ledger and cleaned up by an operator script, one project at a time.

## Requirements

Amends spec [0001](../0001-web-platform-foundation-control-plane.md) (feature 06): its AC-2 and its failure scenario ("set to `FAILED`, not left `PROVISIONING` indefinitely") stand; this spec is how they now hold. Closes the first two Major findings in [docs/reviews/2026-10-26-main.md](../../reviews/2026-10-26-main.md). The client side endless spinner (the third finding) is out of scope.

**User stories**:
- As a new customer, I want my organization's database to finish setting up even if one attempt crashes, so that I am never stuck on "still being set up".
- As the operator, I want every Neon project the system creates to be accounted for, so that I never pay for a database nothing uses and can investigate any that went wrong.
- As the operator, I want a FAILED org to say why it failed and to be retryable with one command.

**Acceptance criteria**:
- **AC-1**: The `organization.created` webhook, after verifying the signature, records the org (`insertOrganization`) and sends `{ orgId }` to the provisioning queue, then answers 200. It answers 200 the same way for an org that already exists or is already `READY`, since the consumer drops those. It makes no Neon call, runs no migration, and never reads the tenant row. If either write fails it answers 500, so Svix retries.
- **AC-2**: The queue consumer provisions the org end to end with no manual step: it ends `READY`, with exactly one Neon project named `rarebooks-tenant-<orgId>` recorded in `tenant_projects`. The consumer reads nothing from Clerk.
- **AC-3**: The claim is a lease. A consumer claims a row with `provisioning_claim_id = <queue message id>` and `provisioning_claimed_at = now()`. A message may take the claim when the row has no claim, when the claim is its own (a redelivery of the same message resumes at once), or when `provisioning_claimed_at` is NULL or older than 20 minutes. A message that meets a live claim held by a different message changes nothing and calls `msg.retry` with a delay of the lease's remaining seconds plus 60, so a stranded row is always picked up again.
- **AC-4**: Every write the consumer makes after claiming (record the project, mark `READY`, record a failure) includes `provisioning_claim_id = <its claim id>` in its `WHERE`. A run whose claim was taken over changes nothing; it acks and stops without retrying. No unfenced writer of `tenant_projects.status` remains in the Worker.
- **AC-5**: An attempt that finds no project recorded on the row (`neon_project_id = ''`) first searches Neon (every page) for projects named exactly `rarebooks-tenant-<orgId>`. If any exist, it adopts the oldest (by `created_at`) instead of creating one, and records every other exact match in `neon_project_orphans` with reason `DUPLICATE_NAME`. Only when none exist does it call `createAndConnect`.
- **AC-6**: Retrying a `FAILED` row never blanks `neon_project_id`, `connection_string`, or `region`. The claim moves a `FAILED` row back to `PROVISIONING`. When `neon_project_id <> ''`, the attempt skips creation and applies the schema to that same project, so the row stays `PROVISIONING` (never usable in the shell) until it is `READY`.
- **AC-7**: Retries are bounded by queue deliveries. A failed attempt records `provisioning_last_error` and releases the claim in one guarded statement, then retries after 1, 5, 15, then 30 minutes (indexed by `msg.attempts`). The 5th delivery's failure marks the row `FAILED` and acks. A crash also uses up a delivery. A message that dead letters is caught by the dead letter consumer: it marks the row `FAILED` once no live lease remains, and on its own final retry it marks `FAILED` whatever the lease says. No row stays `PROVISIONING` or `PROJECT_CREATED` once its messages are spent.
- **AC-8**: `npm run provision:retry -- <orgId>` sends a fresh `{ orgId }` message for an org whose row is `FAILED`, or `PROVISIONING` / `PROJECT_CREATED` with no live lease, or which has an `organizations` row but no `tenant_projects` row. It refuses `READY`, `SUSPENDED`, an unknown org, or a live lease, and says which. The fresh message starts again at `msg.attempts = 1`, by design.
- **AC-9**: `npm run reconcile:tenants` (report only by default) lists every Neon project named `rarebooks-tenant-*` and at least 1 hour old that no `tenant_projects` row points at, and records each in `neon_project_orphans` (`NO_TENANT_ROW` or `MISMATCHED_TENANT_ROW`, defined below). It also lists stuck rows (at least 1 hour old, no live lease, not `READY` / `SUSPENDED`) and `FAILED` rows with their `provisioning_last_error`. `-- --delete <neonProjectId>` deletes one ledgered, undeleted project at least 1 hour old, only after checking again that no `tenant_projects.neon_project_id` equals it, then stamps `deleted_at`. A Neon 404 counts as deleted. An id already stamped is a no op that says so.
- **AC-10**: `npm run migrate:tenants -- --include-project-created` takes its own lease (a random claim id, same predicate) on each `PROJECT_CREATED` row before migrating it, and marks it `READY` guarded by that claim. A row whose lease it cannot take is skipped and reported as skipped (provisioning in flight).
- **AC-11**: Rows stuck before this change (`provisioning_claim_id` set, `provisioning_claimed_at` NULL) count as expired, so a new message or `provision:retry` can claim them.
- **AC-12**: The consumer writes one JSON log line per event (`event`, `orgId`, `attempt` = `msg.attempts`, `errorClass` where relevant). The events are: `provisioning.ready`, `provisioning.adopted_project`, `provisioning.duplicate_projects`, `provisioning.already_done`, `provisioning.deferred_live_claim`, `provisioning.claim_lost` (all `console.log`), plus `provisioning.attempt_failed`, `provisioning.failed`, and `provisioning.dead_lettered` (all `console.error`). Neither these lines nor `provisioning_last_error` ever contain a connection string, API key, or other secret.

## Decision

**Chosen option**: Option 2: Queue backed provisioning with a leased, fenced claim and adopt before create.

Move provisioning out of the webhook onto a Cloudflare Queue consumed by the same Worker, make the claim a 20 minute lease keyed by the queue message id and fenced by that id on every write, find or adopt a project by its deterministic name before creating one, and track anything left over in an orphan ledger that an operator reconciles by hand.

**Prerequisite**: the Cloudflare account moves to **Workers Paid** before this deploys (the engineer's call; the Free plan's 10 ms CPU cap cannot run the migrate).

**Implementation skills**: `wrangler` (`cloudflare/skills`, `.claude/skills/wrangler/`) · `workers-best-practices` (`cloudflare/skills`, `.claude/skills/workers-best-practices/`) · `neon` (`neondatabase/agent-skills`, `.claude/skills/neon/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model** (migration target; `worker/db/schema.sql` plus `worker/db/migrations/0010-provisioning-lease.sql`; all timestamps `timestamptz`):

`tenant_projects` (existing; three additive columns)

| Column | Type | Null | Notes |
|---|---|---|---|
| `org_id` | text | PK, FK `organizations.id` | unchanged |
| `neon_project_id`, `connection_string`, `region` | text | not null (`''` until recorded) | unchanged; never blanked once set (AC-6) |
| `provisioning_claim_id` | text | yes | now holds the queue message id (or the runner's random id) |
| `provisioning_claimed_at` | timestamptz | yes | **new**; set with the claim, cleared with it |
| `provisioning_attempts` | integer | not null, default 0 | **new**; lifetime count of successful claims, informational only, never reset, never used for retry decisions |
| `provisioning_last_error` | text | yes | **new**; sanitized; overwritten by each failure record; a claim never clears it; cleared only on `READY` |
| `status`, `created_at` | | | unchanged |

`neon_project_orphans` (new)

| Column | Type | Null | Notes |
|---|---|---|---|
| `neon_project_id` | text | PK | one entry per stray project |
| `org_id` | text | yes, **no FK** | parsed from the project name; the org may not exist |
| `reason` | text | not null | CHECK in `DUPLICATE_NAME`, `NO_TENANT_ROW`, `MISMATCHED_TENANT_ROW` |
| `detected_at` | timestamptz | not null, default `now()` | |
| `deleted_at` | timestamptz | yes | set only by `reconcile:tenants -- --delete` |

Relationships: `organizations` 1:1 `tenant_projects` (unchanged). `neon_project_orphans` points at Neon, not a row, so it has no FK. Insert with `ON CONFLICT (neon_project_id) DO NOTHING`.

Orphan reasons: `DUPLICATE_NAME` means an extra exact name match skipped during adoption. `NO_TENANT_ROW` means no `tenant_projects` row exists for the org in the name. `MISMATCHED_TENANT_ROW` means the org's row exists but its `neon_project_id` is a different project.

**Lease** (one SQL fragment, the single definition of the lease length). The literal `interval '20 minutes'` is defined once per runtime as `PROVISIONING_LEASE_SQL` in `worker/db/control.ts`, `custom/web/db/tenantMigrationRunner.ts`, and `scripts/lib/provisioningLease.mjs`. A test asserts the three copies are byte identical (they cannot share an import; see `tenantMigrationRunner.ts`'s header):

```sql
-- claimable by :claim
(provisioning_claim_id IS NULL
 OR provisioning_claim_id = :claim
 OR provisioning_claimed_at IS NULL                               -- AC-11 legacy rows
 OR provisioning_claimed_at < now() - interval '20 minutes')
```

A **live lease** means a claim set, with `claimed_at` set and within 20 minutes, held by any other caller. Lease time is always Postgres `now()`.

**Claim statement** (consumer step 1; the runner uses the same shape with `status = 'PROJECT_CREATED'` only):

```sql
UPDATE tenant_projects SET
  provisioning_claim_id   = :claim,
  provisioning_claimed_at = now(),
  provisioning_attempts   = provisioning_attempts + 1,
  status = CASE WHEN status = 'FAILED' THEN 'PROVISIONING' ELSE status END
WHERE org_id = :orgId
  AND status IN ('PROVISIONING', 'PROJECT_CREATED', 'FAILED')
  AND (<claimable by :claim>)
RETURNING status, neon_project_id, connection_string, region
```

The path after the claim keys on `neon_project_id <> ''`, not on the earlier status, so no pre update status is needed. A refused claim updates nothing (no `claimed_at` change).

**State transitions** (`tenant_projects.status`):

| From | To | Trigger |
|---|---|---|
| (no row) | `PROVISIONING` | consumer upsert before its first claim (`ON CONFLICT DO NOTHING`), always before any Neon call |
| `FAILED` | `PROVISIONING` | the claim (AC-6); project fields kept |
| `PROVISIONING` | `PROJECT_CREATED` | a project created or adopted and recorded (claim guarded) |
| `PROVISIONING` (project recorded) or `PROJECT_CREATED` | `READY` | schema applied (claim guarded); clears claim, `claimed_at`, `last_error` |
| `PROVISIONING` / `PROJECT_CREATED` | `FAILED` | 5th delivery's failure (claim guarded), or the dead letter consumer |
| `READY` / `SUSPENDED` | (none) | never claimable; messages for them ack |

**Invariants**: `FAILED` and `READY` both imply `provisioning_claim_id IS NULL` and `provisioning_claimed_at IS NULL`. Tenant data routes stay `READY` only (`resolve-tenant.ts`, unchanged).

**Consumer algorithm** (`queue()` handler; `max_batch_size = 1`, one message per invocation):

1. Upsert the `PROVISIONING` row if it's missing. If that write fails (for example the `organizations` row is absent), throw, and the delivery is retried normally. No Neon call happens before the row exists. Then run the claim statement.
2. No row returned: read the row. `READY` / `SUSPENDED`: ack (`provisioning.already_done`). A live foreign claim: `msg.retry({ delaySeconds })`, where `delaySeconds` = the lease's remaining seconds (computed in SQL) plus 60 (`provisioning.deferred_live_claim`).
3. `neon_project_id = ''`: Neon `listProjects({ search: name })` over every page (cursor), filtered to an exact name match, sorted by `created_at`. Adopt the oldest, or else `createAndConnect({ name })`. Ledger any extras (`DUPLICATE_NAME`). For an adopted project, take the database and role from `listProjectBranchDatabases` on its `default_branch_id`. If there are zero or several databases, or Neon reports the project's operations unfinished or its endpoint not ready, throw a transient error (it goes through step 6 like any failure). Encrypt with the existing `encrypt()` in `worker/lib/encryption.ts` (`TENANT_ENCRYPTION_KEY`), then write `neon_project_id` / `connection_string` / `region`, `status = 'PROJECT_CREATED'`, `claimed_at = now()` (claim guarded). This refreshes the lease right before the migrate. 0 rows means the claim was lost (step 7).
4. If the project was recorded already: `decrypt()` the claimed `connection_string`. Its lease was just set by the claim. Run `applyTenantSchema(connectionString)` (existing: `db.migrate()` plus `seedDefaultEntries`, which checks `db.exists()` before every insert).
5. Mark `READY` (claim guarded, `status IN ('PROVISIONING','PROJECT_CREATED')`, `neon_project_id <> ''`). Ack (`provisioning.ready`). 0 rows means the claim was lost (step 7).
6. On any thrown error: run **one** guarded `UPDATE` that sets `provisioning_last_error = sanitizeError(err)`, clears the claim and `claimed_at`, and sets `status = 'FAILED'` only when `msg.attempts >= 5`. If it updates 1 row: on the 5th delivery ack (`provisioning.failed`); otherwise `msg.retry({ delaySeconds: [60, 300, 900, 1800][msg.attempts - 1] })` (`provisioning.attempt_failed`). If it updates 0 rows: step 7. If it throws itself (control plane down): let it propagate. The platform redelivers, and the lease expires on its own.
7. Claim lost: ack, change nothing (`provisioning.claim_lost`).

**Dead letter consumer** (same Worker, `rarebooks-provisioning-dlq`; its message ids differ from the original, so it never matches a claim): `UPDATE ... SET status = 'FAILED', provisioning_claim_id = NULL, provisioning_claimed_at = NULL, provisioning_last_error = COALESCE(provisioning_last_error, 'dead lettered') WHERE org_id = :orgId AND status IN ('PROVISIONING','PROJECT_CREATED') AND (<no live lease>)`. If it updates 0 rows and the row still has a live lease, then before the DLQ's final delivery it calls `msg.retry({ delaySeconds: 1260 })` (just past the lease). On the final delivery (`msg.attempts >= 4`, with `max_retries = 3`) it runs the same `UPDATE` without the lease condition, because the owner is long past its 15 minute wall time. Then ack (`provisioning.dead_lettered`).

**Interface surface**:

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `POST /webhooks/organization-created` | HTTP (existing, now thin) | Svix signed `organization.created` | `200 { received: true }` | Svix signature (`verifyWebhook`) | 400 bad signature; 500 org insert or enqueue failed |
| `PROVISIONING_QUEUE` message | Queue producer to consumer | `{ orgId: string }` only | ack, retry, or dead letter | Cloudflare binding, internal only | retry with delay; DLQ after 5 deliveries |
| `rarebooks-provisioning-dlq` message | Queue consumer | `{ orgId }` | row set `FAILED` | binding, internal only | retry until the lease expires, forced on the final delivery |
| `npm run provision:retry -- <orgId>` | Operator script (local) | orgId | sent / refused + reason | operator env file | exit 1 on refuse or HTTP error |
| `npm run reconcile:tenants [-- --delete <id>]` | Operator script (local) | optional project id | report; ledger rows; one deletion | operator env file | exit 1 if the id is referenced, not ledgered, too young, or the delete fails |
| `npm run migrate:tenants` | Operator script (existing) | unchanged | adds "skipped: provisioning in flight" | unchanged | unchanged |

`GET /api/dashboard` and every other route are unchanged.

**Value sourcing**:

| Action | Value | Source |
|---|---|---|
| Webhook | `orgId`, org `name` | verified Clerk event `data.id`, `data.name` (name goes to `organizations` only, never to the message) |
| Consumer | claim id | `message.id` |
| Consumer | delivery number, last delivery test | `message.attempts` (1 based; crashes count); last when `>= 5` |
| Consumer | retry delay after a failure | `[60, 300, 900, 1800][attempts - 1]` seconds (overrides the config `retry_delay = 60`, which applies only to crash redelivery) |
| Consumer | delay on a live foreign claim | `ceil(extract(epoch from provisioning_claimed_at + interval '20 minutes' - now())) + 60`, read from the row in step 2 |
| Consumer | lease expiry | `provisioning_claimed_at` vs Postgres `now()`, using `PROVISIONING_LEASE_SQL` |
| Consumer | Neon project name | derived: `rarebooks-tenant-${orgId}` (existing convention; a Clerk org id is about 30 ASCII characters, within Neon's name limit) |
| Consumer | adopted project's connection string | `getConnectionUri` on `default_branch_id`, with `database_name` and `role_name` = the single database and its `owner_name` from `listProjectBranchDatabases` |
| Consumer | `region` | `project.region_id` (created or adopted) |
| Consumer | which duplicate to keep | earliest `project.created_at` |
| Consumer | encrypted connection string | existing `encrypt()` / `decrypt()` in `worker/lib/encryption.ts` with `TENANT_ENCRYPTION_KEY` |
| Consumer | `provisioning_last_error` | `sanitizeError(err)`: `err.name`, the Neon HTTP status if any, the first 200 characters of `err.message` with any `postgres(ql)?://\S+` replaced by `[redacted]` |
| DLQ consumer | row to fail; last delivery test | message body `orgId`; `message.attempts >= 4` |
| `provision:retry` | eligibility | `organizations` and `tenant_projects` rows read with `CONTROL_DATABASE_URL`, lease from `PROVISIONING_LEASE_SQL` |
| `provision:retry` | queue to send to | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PROVISIONING_QUEUE_ID` |
| `reconcile:tenants` | stray list | Neon `GET /projects?search=rarebooks-tenant-` (every page, exact prefix filter, `created_at` at least 1 hour ago) vs `tenant_projects.neon_project_id` |
| `reconcile:tenants` | orphan `org_id` | the name suffix after `rarebooks-tenant-` |
| `reconcile:tenants` | stuck rows | `tenant_projects` with status not in (`READY`,`SUSPENDED`), no live lease, `created_at` at least 1 hour ago |
| Runner | its claim id | `crypto.randomUUID()` per row |

**Key invariants**:
- At most one live claim per row. Every post claim write is fenced by claim id (AC-4).
- `neon_project_id`, once non empty, changes only by an operator's hand edit. No code path blanks or replaces it (AC-6).
- `FAILED` and `READY` imply no claim.
- Every project named `rarebooks-tenant-*` and older than 1 hour is either referenced by exactly one `tenant_projects` row or listed in `neon_project_orphans`, once `reconcile:tenants` has run. A residual race (a takeover while the old run is still inside `createAndConnect`) can leave a second project the Worker does not ledger. Reconcile catches it; this is accepted.
- Deleting a Neon project happens only in `reconcile:tenants -- --delete`, never in the Worker.

**Security model**: No new HTTP surface; the queue is reachable only through Worker bindings. Queue messages carry `orgId` only, never a connection string. `provision:retry` and `reconcile:tenants` run locally from an operator env file (never over HTTP, the `migrate:tenants` precedent). `CLOUDFLARE_API_TOKEN` is scoped to Queues write on this account and never set as a Worker secret. Connection strings stay AES-256-GCM encrypted at rest and are decrypted only in memory (unchanged). No regulated data is added.

**Configuration required**:
- Workers **Paid** plan on the account (prerequisite).
- `wrangler.toml`: queue bindings do not inherit across envs, so repeat this block under every env with its suffix. Example for staging:

  ```toml
  [env.staging]
  name = "rarebooks-web-staging"

  [[env.staging.queues.producers]]
  binding = "PROVISIONING_QUEUE"
  queue = "rarebooks-provisioning-staging"

  [[env.staging.queues.consumers]]
  queue = "rarebooks-provisioning-staging"
  max_batch_size = 1
  max_retries = 4                 # 5 deliveries in total
  retry_delay = 60                # crash redelivery only; explicit retries pass their own delay
  dead_letter_queue = "rarebooks-provisioning-dlq-staging"

  [[env.staging.queues.consumers]]
  queue = "rarebooks-provisioning-dlq-staging"
  max_batch_size = 1
  max_retries = 3

  [env.staging.limits]
  cpu_ms = 300_000                # ceiling; lower once measured
  ```

  The top level (dev) uses `rarebooks-provisioning` / `rarebooks-provisioning-dlq`, and production uses the `-production` suffix.
- `WorkerEnv.PROVISIONING_QUEUE: Queue<{ orgId: string }>` in `worker/types.ts`.
- Operator env file only (never committed, never a Worker secret): `CLOUDFLARE_API_TOKEN` (Queues write), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PROVISIONING_QUEUE_ID`, `CONTROL_DATABASE_URL` (both scripts), and `NEON_API_KEY` and `NEON_ACCOUNT_ORG_ID` (reconcile).

**Critical test scenarios**:
- Happy path: the webhook enqueues and answers 200 with no Neon call. The consumer creates the project, records `PROJECT_CREATED`, migrates, and ends `READY` with claim, `claimed_at`, and `last_error` cleared. Verifies **AC-1, AC-2**.
- Crash and resume: a consumer dies after `createAndConnect` but before recording the project. The redelivered message reclaims (at once with the same id, or after the lease with a new id), finds the project by name, adopts it, and ends `READY` with one project in Neon. Verifies **AC-3, AC-5**.
- Takeover: a row has a foreign claim 21 minutes old, so a new message takes it. The old run's next guarded write returns 0 rows, and it acks without retrying or changing the row. Verifies **AC-3, AC-4**.
- Live claim deferral: a second message meets a claim 2 minutes old. It calls `retry` with about 1140 seconds, and the row is untouched. Verifies **AC-3**.
- Duplicates in Neon: two exact name matches exist (plus a `rarebooks-tenant-<orgId>x` near match, which is ignored). The older is adopted, the newer is ledgered `DUPLICATE_NAME`. Verifies **AC-5**.
- Adopt not ready: the adopted project reports zero databases, so the attempt fails through step 6 and retries. Verifies **AC-5, AC-7**.
- FAILED reuse: a `FAILED` row with a recorded project is retried. It goes `PROVISIONING` (dashboard 202), the same `neon_project_id` is migrated to `READY`, no `createAndConnect` call is made, and nothing is blanked. Verifies **AC-6**.
- Partial migrate rerun: a migrate that throws partway, then reruns against the same database, ends `READY` with exactly one of each seeded UOM and the `Stores` location. Verifies **AC-6**.
- Exhaustion: migrate throws on all 5 deliveries. Delays of 60, 300, 900, 1800 are requested, then `FAILED` with no claim and a sanitized `last_error` (a thrown message containing `postgres://user:pw@host` is stored redacted). Verifies **AC-7, AC-12**.
- Failure write throws: the step 6 `UPDATE` throws, so the error propagates and nothing acks. Verifies **AC-7**.
- Dead letter backstop: a DLQ message meets a live lease and retries. After expiry the row goes `FAILED`. On the final DLQ delivery it goes `FAILED` even with a lease. Verifies **AC-7**.
- Legacy row: `PROVISIONING` with a claim id and NULL `claimed_at` is claimable. Verifies **AC-11**.
- Operator scripts: `provision:retry` refuses `READY` and a live lease, and sends for `FAILED` and for an org with no tenant row. `reconcile:tenants` ledgers a 2 hour old stray, ignores a 10 minute old one, refuses `--delete` for a referenced id, and treats a Neon 404 as deleted. Verifies **AC-8, AC-9**.
- Runner: a `PROJECT_CREATED` row with a live consumer lease is skipped. A row the runner claims cannot be claimed by a consumer until the runner marks it `READY`. Verifies **AC-10**.
- Lease copies: the three `PROVISIONING_LEASE_SQL` copies are byte identical. Verifies **AC-3, AC-8, AC-10**.
- SQL for real: the claim, refusal, fence, failure record, and DLQ statements run against a real Postgres (a Neon dev branch via `CONTROL_TEST_DATABASE_URL`, skipped when unset), not only mocked `control.ts`. This closes the review's "race safety never executes" gap. Verifies **AC-3, AC-4, AC-6, AC-7, AC-11**.

## Build plan

Tracer Bullet: the first slice threads webhook to queue to consumer to `READY` through every layer, and later slices thicken the failure handling.

1. **Prerequisites**: move the account to Workers Paid. `wrangler queues create` the provisioning queue and its DLQ per env. Add the per env queue blocks and `[limits]` to `wrangler.toml`, and `PROVISIONING_QUEUE` to `WorkerEnv`. Satisfies **AC-1, AC-2**.
2. **Migration**: write `worker/db/migrations/0010-provisioning-lease.sql` (additive: three nullable or defaulted columns plus the new table; idempotent `IF NOT EXISTS`; a pre flight count of stuck rows in the 0004 file's style) and mirror it into `worker/db/schema.sql`. Extend `TenantProjectRow`. Satisfies **AC-3, AC-7, AC-9, AC-11**.
3. **Thin thread**: make the webhook route insert the org and `send({ orgId })`, with 500 on failure, and delete its `FAILED` status branch. Export `{ fetch: app.fetch, queue }` from `worker/index.ts`. Turn `handleOrganizationCreated` into the consumer entry `provisionTenant(orgId, message, deps)`: upsert, claim, create, record, migrate, mark `READY`. Delete `claimTenantProject`, `claimTenantProjectMigration`, `releaseTenantProjectMigration`, `insertTenantProject`, `failTenantProjectClaim`, and `setTenantProjectStatus` from `worker/db/control.ts`, replacing them with the guarded statements here. Satisfies **AC-1, AC-2, AC-4**.
4. **Lease**: add `PROVISIONING_LEASE_SQL`, the claim statement with the `FAILED` remap, the live claim deferral, and the `READY` / `SUSPENDED` ack. Satisfies **AC-3, AC-6, AC-11**.
5. **Orphan prevention**: add `findProjectsByName` (every page, exact match), `getConnectionString(projectId)` (with the database count and readiness checks), and the duplicate ledger write to `NeonProvisioningClient` (`worker/lib/neon-client.ts`), and adopt before create in `provisionTenant`. Satisfies **AC-5, AC-6**.
6. **Bounded retries**: add the single statement failure recorder with `sanitizeError`, backoff via `msg.retry`, `FAILED` on the 5th delivery, the DLQ handler with its forced final delivery, and every log event. Satisfies **AC-7, AC-12**.
7. **Runner**: give `tenantMigrationRunner.ts` its `PROVISIONING_LEASE_SQL` copy, a per row claim for `PROJECT_CREATED`, the skip on refusal, and `markTenantProjectReady` guarded by its claim. Satisfies **AC-10**.
8. **Operator scripts**: `scripts/provision-retry.mjs` (Cloudflare Queues HTTP `POST .../queues/{id}/messages`) and `scripts/reconcile-tenants.mjs` (Neon REST plus `@neondatabase/serverless`), sharing `scripts/lib/provisioningLease.mjs`. They're plain ESM like `scripts/ntfy-web-publish-check.mjs`, import nothing from `worker/`, and are wired as `provision:retry` and `reconcile:tenants` in `package.json`. Satisfies **AC-8, AC-9**.
9. **Tests**: update `worker/tests/organization-created.spec.ts` and `tests/organizationCreatedProvisioning.spec.ts` for the new flow. Add consumer unit tests for every scenario above, the lease copy check, and the real Postgres SQL suite. Satisfies **AC-1 to AC-12**.

## Migration plan

**Strategy**: additive schema first, then code. No feature flag: the webhook path switches in one deploy, and the old synchronous path is deleted.
**Phases**:
1. Upgrade the plan and create the queues (no code change; nothing consumes yet).
2. Apply `0010-provisioning-lease.sql` to the live control plane by hand, in a transaction (the 0004 precedent). Old code ignores the new columns.
3. Deploy the Worker (webhook enqueues; consumers live).
4. Run `npm run reconcile:tenants` and record the strays. Run `npm run provision:retry -- <orgId>` for each stuck or `FAILED` org it lists. Review the ledger before any `--delete`.
**Rollback**: redeploy the previous Worker. The added columns and table are harmless to old code. Messages left in the queue are dropped once the consumer binding is gone (or retried on redeploy; the consumer is idempotent).
**Risks**: a queue binding missing in one env (the webhook then 500s there, and Svix keeps retrying for up to about 27 hours, so it is recoverable). Phase 4 retrying an org whose earlier project held partial data (migrate and seeding are idempotent, and covered by the partial rerun test).

## Consequences

**Positive**:
- No org stays stuck: every path ends `READY` or `FAILED` with a reason, normally within about 51 minutes of retry delays plus run time (longer only when a dead lettered row waits out a lease).
- No silent Neon spend: a project is reused, adopted, or ledgered, never forgotten.
- The webhook answers in milliseconds, well inside Svix's timeout.
- The claim SQL gets real database tests for the first time, and no unfenced status writer remains.

**Negative / tradeoffs**:
- New monthly cost (Workers Paid) and a new moving part (two queues per env) to configure, monitor, and keep in step across `wrangler.toml` envs.
- A crashed attempt waits up to 20 minutes when its redelivery gets a new message id. With a stable id it resumes at once.
- A duplicate message keeps retrying until the row settles, which uses queue operations (cheap, but not free).
- Signup to `READY` gains queue latency (usually seconds), and the client still has no polling (out of scope), so a fresh org still needs a reload until that fix lands.
- Adopt by name trusts the `rarebooks-tenant-*` naming. Anyone creating a project with that name by hand in the Neon console would be adopted.
- Orphan cleanup is manual on purpose: strays cost money until the operator deletes them, and the lease SQL lives in three copies held in step only by a test.

**Neutral**:
- `handleOrganizationCreated.ts` becomes the consumer's logic. The webhook route no longer calls it.
- `migrate:tenants` now takes leases on `PROJECT_CREATED` rows.
- Operators need a Cloudflare API token in their local env file.

## Follow-up

- [ ] Measure the consumer's real CPU and subrequest count per migrate on staging. Lower `[limits] cpu_ms` from 300,000 to about twice the observed CPU peak, and confirm subrequests stay well under the Paid limit.
- [ ] Check on staging whether `message.id` stays the same across a redelivery. Either way it's safe now (an unstable id only means waiting out the 20 minute lease), but it shapes the real recovery time.
- [ ] Svix timeout: one source says 15 seconds, another 30. Moot after this change, but fix spec 0001's wording if it cites one.
- [ ] Client polling for `PROVISIONING` (review finding 3) needs its own fix. Until then the new org path still needs a manual reload.
- [ ] Add a one line "see 0010" pointer under spec 0001's failure scenario so readers of 0001 find the new mechanism.
- [ ] Spec 0007 (cutover): add "Workers Paid active, queues created per env, `reconcile:tenants` clean" to its readiness checklist.
- [ ] The `wrangler`, `workers-best-practices`, and `neon` skills were installed in this session (`.claude/skills/`, `.agents/skills/`) and aren't yet listed in `AGENTS.md`. Their conventions are area specific (`worker/AGENTS.md`), not root.
- [ ] The picked Queues skill `jezweb/claude-skills@cloudflare-queues` no longer exists. `secondsky/claude-skills@cloudflare-queues` does, if you want a Queues specific skill.
