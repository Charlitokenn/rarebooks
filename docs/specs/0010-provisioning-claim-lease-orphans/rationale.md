# 0010. Provisioning claim lease & orphan tracking: rationale

_Decision record. The build contract is in [index.md](index.md)._

## Context

Spec 0001 provisions a tenant inside the `organization.created` webhook request. One request claims the `tenant_projects` row, calls Neon's `createAndConnect()` (which polls Neon's operation to completion), encrypts and records the project, then runs the full accounting `DatabaseCore.migrate()` (about 100 tables over WebSocket round trips). Svix, which delivers Clerk's webhooks, gives the endpoint roughly 15 to 30 seconds, and the two Svix sources disagree on which (basis: Svix retry docs). When it times out, the client disconnects and Workers cancels the request. Isolate eviction, deploys, and CPU limits kill it the same way.

Two failures follow (review [2026-10-26-main](../../reviews/2026-10-26-main.md), Major 1 and 2):

- **Stuck claims.** `provisioning_claim_id` has no expiry. A request that dies after claiming leaves the row `PROVISIONING` (or `PROJECT_CREATED`) with a claim nobody releases. Svix's retry then finds nothing claimable, the handler returns quietly, the route answers 200, and Svix stops. The org never reaches the dashboard, and nothing alerts anyone. This contradicts 0001's own failure scenario.
- **Orphaned projects.** If anything throws after `createAndConnect` succeeds, the catch marks the row `FAILED` without recording the new project's id. And a later reclaim of a `FAILED` row blanks `neon_project_id` and makes a second project. Each orphan is a billed Neon project that nothing references, and its id is gone.

Forces: the account is on the Workers **Free** plan, which caps CPU at 10 ms and subrequests at 50 per invocation (basis: Workers limits docs). The heavy migrate can't run there whatever the design. The project already treats schema rollout as an operator action (`migrate:tenants`, never over HTTP, never on a cron) and keeps ntfy out of the Worker (spec 0006). One small team operates this. All control plane race safety lives in SQL `WHERE` clauses that no test executes today.

## Options considered

### Option 1: Fix in place (lease plus a non 2xx response on in flight claims)

Add `claimed_at` and a takeover rule, and answer 409/5xx when a duplicate delivery meets a live claim, so Svix keeps retrying (5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h).

**Pros**: smallest change, no new infrastructure.
**Cons**: every attempt still runs inside a 15 to 30 second request, so a migrate that takes longer can never finish. The lease just churns. Retry timing belongs to Svix, not to us.

### Option 2: Queue backed provisioning with a leased, fenced claim (chosen)

The webhook only records the org and enqueues. A Cloudflare Queue consumer in the same Worker gets up to 15 minutes of wall time, retries with chosen delays, and a dead letter queue (basis: Queues limits and configuration docs). The lease and claim id fencing stay in the control plane.

**Pros**: the work no longer depends on the HTTP delivery staying alive. Retry policy is ours. The `tenant_projects` row stays the single source of truth. Moderate new surface.
**Cons**: requires Workers Paid (CPU) and two queues per env. Adds queue latency. A new failure mode: a missing binding.

### Option 3: Cloudflare Workflows

A durable workflow per org, with each step checkpointed and retried.

**Pros**: step results persist, which handles "project created, then crashed" natively. Long runs are supported.
**Cons**: the workflow's step state becomes a second source of truth beside `tenant_projects`, and the dashboard gate and the runner still read the row. More new concepts to learn and test for one flow.

### Option 4: `ctx.waitUntil` in the webhook

Ack at once and continue in the background.

**Pros**: tiny change.
**Cons**: about 30 seconds of extra life and no retry, so a long migrate still dies, and nothing replays it.

## Rationale

The root cause is that minutes of work run inside a request with a hard limit of seconds. Option 1 leaves that cause in place, and Option 4 only stretches it. Between the two real fixes, Option 2 keeps the control plane row as the only state, which matters because the dashboard gate (`/api/dashboard`), the migration runner, and the new operator scripts all read that row. Option 3 would split truth between Workflows and Postgres. Queues give us exactly the missing pieces (long wall time, retry with delay, dead letter) and nothing more (basis: boring technology, single source of truth).

The lease is keyed by the queue message id so a crashed run's own redelivery resumes at once. The lease only gates takeover from a *different* message. It was first set at 15 minutes (the engineer's pick), and raised to 20 after the cross check: a lease equal to the consumer's 15 minute wall time lets a successor start in a dying run's last seconds, so two migrates could hit one tenant database, which fencing (it protects only the control plane) can't stop. Fencing every write by claim id still makes any takeover safe for the control plane (basis: fencing tokens for leases). Expiry uses Postgres `now()` so Worker clock skew can't matter.

A message meeting a live foreign claim retries after the lease instead of acking. If message ids turn out unstable across redelivery, an ack there would strand a crashed org forever: the redelivery would look like a duplicate, and nothing would ever wake the row again. The migrate runner takes the same lease for the same reason as the 20 minutes: no two migrates on one tenant database. A `FAILED` retry goes back to `PROVISIONING`, not `PROJECT_CREATED`, so the dashboard never reports a half migrated tenant as created.

For orphans, persisting the id early still leaves a crash window between `createAndConnect` returning and the write. A best effort delete never runs on a crash. Searching Neon by the deterministic name before creating closes the window from the other side: whatever an earlier attempt made gets found and adopted (basis: idempotent create via natural key). The ledger plus a manual, one at a time delete keeps irreversible deletion of accounting databases a human act, which matches the `migrate:tenants` precedent.

Free plan note: the engineer is on Workers Free and chose to upgrade instead of splitting the migrate out of the Worker. Staying on Free would force the migrate onto an operator machine, adding a manual step before every signup is usable. That's worse for a self serve product than $5 a month (basis: Workers pricing docs).

## References

**Project sources**:
- Spec [0001](../0001-web-platform-foundation-control-plane.md) (provisioning, state ladder, failure scenario)
- Spec [0002](../0002-tenant-schema-data-layer.md) (`migrate:tenants` runner, operator only invocation)
- Spec [0006](../0006-ntfy-notifications/index.md) (no ntfy secret in the Worker)
- Review `docs/reviews/2026-10-26-main.md` (Major 1, Major 2, the test gap on `control.ts`)
- `worker/db/control.ts`, `custom/web/auth/handleOrganizationCreated.ts`, `worker/routes/webhooks/organization-created.ts`, `custom/web/db/tenantMigrationRunner.ts`
- Installed skills: `wrangler`, `workers-best-practices` (`cloudflare/skills`), `neon` (`neondatabase/agent-skills`)

**Practices & standards**:
- Leases with fencing tokens
- Idempotent create via a natural key (deterministic resource name)
- Single source of truth for workflow state
- Boring technology, minimal new infrastructure
- Irreversible operations stay manual and observed

**Links** (web verified 2026-10-26):
- Cloudflare Queues pricing: https://developers.cloudflare.com/queues/platform/pricing/
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Queues limits: https://developers.cloudflare.com/queues/platform/limits/
- Cloudflare Queues configuration: https://developers.cloudflare.com/queues/configuration/configure-queues/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Svix retries: https://docs.svix.com/retries
- Neon API, list projects: https://api-docs.neon.tech/reference/listprojects
- Neon API, get connection URI: https://api-docs.neon.tech/reference/getconnectionuri
