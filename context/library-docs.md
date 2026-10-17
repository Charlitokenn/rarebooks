<!-- Library docs: key usage patterns for the libraries in this project -->

# Library Docs

Project-specific usage patterns for every third party library in this project. This file only covers how we use each library in this specific project — rules, patterns, and constraints specific to this codebase.

Read the relevant section before implementing any feature that touches these libraries. Sections are marked **Desktop only**, **Web only**, or **Shared**.

_Verified against current docs: 2026-09-02, rechecked 2026-09-06 (via Context7 + npm)._

_2026-09-06 recheck found this file's own Hono/Clerk sections had gone stale — they still showed the pre-migration `@hono/clerk-auth` + hand-rolled `svix` pattern after the actual code had already moved to `@clerk/hono` (see `worker/routes/webhooks/organization-created.ts`'s own note on the swap, and `docs/specs/0001-web-platform-foundation-control-plane.md`, which already had it right). Fixed below. Everything else checked in this pass — `@neon/sdk`'s error envelope/pagination/retry model, PayPal's `applicationContext`/`autoRenewal` deprecation, OneSignal's `include_aliases`/`Key ` auth prefix — matched what's written here._

_2026-09-12: the OneSignal section that followed that recheck is gone — the Web target keeps ntfy and never switches providers (Charles's decision, `docs/specs/0006-ntfy-notifications.md`). The ntfy section below replaced it._

---

## Before Using Any Library

Before implementing any feature that uses a third party library:

1. **Check for a skill/AGENTS.md entry** for that library where one exists.
2. **Check if an MCP server is configured** for that library. If one is available — use it before falling back to general knowledge.
3. **Read this file** for project-specific patterns that override general library knowledge.

The order of authority is:

```
MCP server (real-time docs) → Skills → This file (project rules) → General training knowledge
```

Never rely on general training knowledge alone for library APIs — they change frequently and training data may be outdated. This is especially true for Keymint, ClickPesa, Clerk, and PayPal below, which are all fast-moving vendors.

**Target-boundary rule:** libraries marked Desktop only must never be imported from `worker/`, `rendererWeb.ts`, or `custom/web/`. Libraries marked Web only must never be imported from `main/`, `main.ts`, or `custom/licensing/`. See `architecture.md` invariants.

---

## fyo (internal ORM / platform framework) — Shared

The core client-adjacent framework managing the `Doc` abstraction, database access, and platform demux (`fyo/`).

### Usage Pattern 1 — Doc lifecycle

```typescript
const doc = fyo.doc.getNewDoc('Expense', { date, vendor, amount });
await doc.sync();

const doc = await fyo.doc.getDoc('Expense', name);
```

**Rules:**

- Always go through `fyo.db` / `fyo.doc` — never query SQLite or Neon directly from `models/` or `src/`.
- `models/**` must receive `fyo` as a constructor/function parameter — never import the singleton from `src/`.

### Usage Pattern 2 — Platform demux

```typescript
// fyo/demux/*.ts branches on platform:
// - Desktop implementation calls ipcRenderer directly
// - Web implementation (target design) calls fetch() against the Hono worker API
// All other client code stays platform-agnostic.
```

**Rules:**

- Never call `ipcRenderer` or `fetch()` against the worker API from `src/` components directly — go through the demux layer.

---

## better-sqlite3 + Knex (database) — Desktop only

Local SQLite database, one file per company, accessed via `backend/` on the main process side.

### Usage Pattern — Schema migrations ("prestige")

When a schema adds/removes columns on an existing doctype, the framework rebuilds the table (create temp table with new schema → copy data → drop old → rename). This copy step fails if it selects a column that doesn't exist in the old table.

**Rules:**

- When adding fields to an existing schema, provide a default value or write a `backend/patches/` migration rather than assuming a clean table — see `custom/EXPENSE_MIGRATION_FIX.md`.
- This limitation is Desktop/SQLite-specific — it does not apply to the Web target's Neon/Postgres backend (see below).

---

## Neon (Postgres) — Web only, target design

**Multi-tenancy model: one Neon project per tenant (silo model), not a shared database with an `org_id` column.** This is Neon's own documented "project-per-user" integration pattern for platforms building isolated databases per customer. A small shared control-plane Neon project holds the org→project mapping and billing state; every tenant's own accounting data lives only in that tenant's own Neon project.

_Note: Neon's product is now positioned as "Lakebase Postgres, from Databricks" in its own docs — same product, new parent-company branding. Doesn't change anything below, but don't be thrown by the name if it shows up in the Neon console._

**Disambiguation — two unrelated "org" concepts:** Neon's own API has its own `org_id`/`orgId` concept (which Neon account/team owns a project, for Neon's own billing and access control). This is completely separate from our Clerk organization (the tenant/customer). Set Neon's `orgId` once, statically, to our own Neon account when configuring `createNeonClient()` — never derive it per-tenant, and never confuse it with the Clerk `org_id` that identifies a customer.

### Usage Pattern 1 — Provisioning a tenant project on org creation

```typescript
// worker/routes/webhooks/organization-created.ts
import { createNeonClient } from '@neon/sdk';

const neon = createNeonClient({
  apiKey: env.NEON_API_KEY,
  orgId: env.NEON_ACCOUNT_ORG_ID, // OUR Neon account's org — static, not per-tenant
});

const { data, error } = await neon.projects.createAndConnect(
  { name: `tenant-${clerkOrgId}`, region_id: 'aws-us-east-2' },
  { pooled: true } // default true — use the pooled connection string for a Workers-runtime app
);
if (error) throw error; // typed NeonError — see error handling below

const { project, connectionString } = data;

// Encrypt connectionString (AES-256-GCM, same pattern as Desktop's Keymint cache)
// and store it, alongside project.id, in the control-plane project's `tenant_projects` table.
// Record the fresh project as PROJECT_CREATED; feature 07 applies the accounting
// schema migration before advancing it to READY for tenant data access.
```

`createAndConnect()` polls provisioning operations to completion automatically for this specific call (the client-wide `waitForReadiness` default is `false`, but `projects.create`/`createAndConnect` and `branches.create`/`createAndConnect` turn it on for themselves) — it only resolves once the project can actually accept connections, so don't add a manual polling loop around it.

### Usage Pattern 2 — Resolving and querying a tenant's project per request

```typescript
// worker/middleware/resolve-tenant.ts
// 1. Get org_id (Clerk) from the verified Clerk session (never from client input)
// 2. Look up (and short-TTL cache) the org's connection details from the
//    control-plane project's `tenant_projects` table, decrypting connection_string
// 3. Open a connection to THAT project for this request only

const tenantConn = await resolveTenantConnection(clerkOrgId); // control-plane lookup + decrypt
const rows = await tenantSql`SELECT * FROM "SalesInvoice" WHERE name = ${name}`;
// no org_id WHERE clause needed or present — the project itself is the boundary
```

**Rules:**

- Never query a tenant's accounting data through the control-plane project's connection, and never query the control-plane's `organizations`/`subscriptions`/`payments` tables through a tenant project's connection — these are two distinct Neon projects with two distinct connection strings, never mixed.
- `tenant_projects.connection_string` is encrypted at rest in the control-plane project; decrypt only in-memory, per-request, never log it.
- Cache resolved tenant connections briefly (e.g. in a short-TTL in-memory/KV cache) to avoid a control-plane round-trip on every single request, but never cache across requests for different orgs, and never let a stale cached connection outlive a project's credentials being rotated. Use `neon.postgres.roles.resetPassword(projectId, branchId, roleName)` to rotate a tenant's DB credentials if a rotation is ever needed — it returns the new password on the `Role` result.
- Use parameterized queries exclusively — never string-interpolate raw values into SQL, in either the control-plane or tenant connections.
- Postgres `ALTER TABLE ADD COLUMN` is safe for additive schema changes (unlike SQLite's "prestige" rebuild — see `custom/EXPENSE_MIGRATION_FIX.md`, which is Desktop-only) — still provide sane defaults for existing rows. Because there's one project per tenant, a schema change must be applied by a migration runner that iterates every row in `tenant_projects`, not a single `ALTER TABLE` statement against one shared database.
- For very high tenant counts, Neon's own guidance is to branch from a template project instead of creating a full project per tenant (branches share storage with the parent until the tenant writes data, and provision faster via `neon.branches.createAndConnect()`) — note this as a future scaling option, but the current decision is full projects per tenant, not branches, so don't switch to branch-per-tenant without an explicit decision to do so.

### Usage Pattern 3 — Control-plane queries (org/subscription/payment bookkeeping)

```typescript
// worker/db/control.ts — a single, fixed connection to the one shared control-plane project
const org = await controlSql`SELECT * FROM organizations WHERE id = ${orgId}`;
const pending = await controlSql`SELECT * FROM payments WHERE status = 'PENDING_REVIEW'`;
```

**Rules:**

- The control-plane connection string is a single Worker secret (`CONTROL_DATABASE_URL`), unlike tenant connections which are looked up dynamically — see `code-standards.md` → Environment Variables.
- `payments`/`subscriptions` queries (e.g. the super-admin Lipa Namba review view) always go through this single control-plane connection, since they span all orgs by design.

### Error handling and retries (confirmed against current SDK docs)

`@neon/sdk` returns a `{ data, error }` envelope by default (opt into `throwOnError: true` per-client or per-call to throw instead). `error` is one of a typed hierarchy discriminated by `.kind`: `api` (any non-2xx), `not_found` (404), `auth` (401/403), `rate_limit` (429, after retries are exhausted), `operation` (an awaited provisioning operation failed), `timeout`, `network`, or `client` (SDK-side, e.g. an ambiguous connection-string selection). The client retries automatically on `423`/`429`/`503` responses, 2 retries by default (configurable via the `retries` client option) — don't build your own retry loop on top of this for the ergonomic namespace methods.

```typescript
const { data, error } = await neon.projects.get(projectId);
if (error?.kind === 'not_found') {
  // this tenant's project is gone — surface distinctly from a generic failure
}
```

---

## @neon/sdk (Neon Platform API client) — Web only, target design

The official TypeScript client for the Neon API — projects, branches, Postgres data-plane resources, object storage, functions, and Managed Better Auth, all through one typed client. Fetch-based, replaces the deprecated Axios-based `@neondatabase/api-client`.

```typescript
import { createNeonClient } from '@neon/sdk';
const neon = createNeonClient({ apiKey: env.NEON_API_KEY, orgId: env.NEON_ACCOUNT_ORG_ID });

// Every method returns { data, error } by default (or throws with throwOnError: true)
const { data, error } = await neon.projects.list().all();
```

**Rules:**

- `createNeonClient` covers common workflows (projects, branches, Postgres resources, snapshots, and more) but not every Platform API operation — for anything without an ergonomic wrapper, use the `raw` layer (`import { raw } from '@neon/sdk'`, or a specific tree-shakeable function from `@neon/sdk/raw`) rather than hand-rolling a fetch call.
- Retries on `423`/`429`/`503` are built in (2 by default, configurable via the client's `retries` option) — don't add a manual retry loop around ergonomic-namespace calls.
- `NEON_API_KEY` is a platform-level secret (can create/delete/manage every tenant project) — treat it with the same care as `CLERK_SECRET_KEY`, never expose it to the client, never log it.
- `neon.projects.list()` (and other list methods) return a lazily-paginated result — call `.all()` for every page, `.page()` for just the first, or iterate with `for await` to stream — don't assume a plain array comes back.

---

## Postgres driver for the Workers runtime — Web only, target design

A Postgres/Neon client compatible with the Workers V8-isolate runtime is needed for actual query execution against both the control-plane and tenant connections (separate concern from `@neon/sdk`, which is for project *management*, not querying). Confirm the exact package (e.g. `@neondatabase/serverless`) before adding it — do not assume a generic `pg` driver works unmodified in a Workers isolate.

---

## Hono (API framework on Cloudflare Workers) — Web only, target design

The Web target's backend API, replacing Electron's IPC layer.

### Usage Pattern — Route + middleware structure

```typescript
// worker/index.ts
import { Hono } from 'hono';
import { clerkMiddleware, getAuth } from '@clerk/hono';

const app = new Hono<{ Bindings: Env }>();

app.use('*', clerkMiddleware());

app.use('*', async (c, next) => {
  const auth = getAuth(c);
  if (!auth?.userId) return c.json({ error: 'Unauthorized' }, 401);
  // resolve org from auth.orgId, check subscription status + seat limit here
  await next();
});

app.post('/api/doc/:schema', async (c) => { /* ... */ });

export default app;
```

**Rules:**

- Use the official `@clerk/hono` middleware for session verification — do not hand-roll JWT/JWKS verification. **Correction (2026-09-06 crosscheck, via Context7 + npm):** the actual worker code migrated from `@hono/clerk-auth` (the community package in the `honojs/middleware` monorepo — still on npm, still works, but not Clerk's first-party SDK) to `@clerk/hono` (Clerk's own official Hono package, in the `clerk/javascript` monorepo alongside `@clerk/nextjs`/`@clerk/express`/etc., actively published). This file's example still showed the old package; updated to match what's actually shipped — see `worker/middleware/clerk-auth.ts` and the note in `worker/routes/webhooks/organization-created.ts`.
- Every route handler that touches tenant data must run after the org-resolution + subscription-status middleware; never bypass it for a "quick" route.
- Keep route handlers thin — delegate to `models/`/`fyo` for business logic, matching how `main/registerIpcMainActionListeners.ts` stays thin on Desktop.
- Return `{ success: boolean, data?, error? }` shaped JSON, consistent with the project's API convention in `code-standards.md`.

---

## Clerk (auth + organizations) — Web only, target design

Handles user authentication and multi-tenant organization management for the Web target.

### Usage Pattern — Session + org resolution in Hono

```typescript
import { getAuth } from '@clerk/hono';

app.get('/api/me', (c) => {
  const auth = getAuth(c);
  return c.json({ userId: auth?.userId, orgId: auth?.orgId, orgRole: auth?.orgRole });
});
```

**Rules:**

- `@clerk/hono` works natively on Cloudflare Workers (built on `@clerk/backend`, designed for V8 isolates) — no Node-only Clerk SDK. Confirmed via npm (published, actively maintained, part of the official `clerk/javascript` monorepo — not a community package) — its own README documents exactly this `clerkMiddleware`/`getAuth` shape, plus a `/webhooks` subpath (see Webhook verification below). Still worth a fresh check at build time since it's a young, fast-moving package (early 0.1.x line).
- Security: a real CVE (CVE-2026-34076) affects `@clerk/hono` `>= 0.1.0, < 0.1.5` (also hit `@clerk/express`, `@clerk/backend`, `@clerk/fastify` in their own affected ranges) — confirm the installed version is `>= 0.1.5` before relying on it. `worker/package.json` currently pins `^0.1.76`, which is unaffected.
- The active organization (`auth.orgId`) is the tenant boundary for every Neon query — see Neon section above.
- Config: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` env vars (Worker secrets, never committed).
- The Web "super admin" role (for reviewing Lipa Namba payment claims) is a RareBooks-level authorization check on top of Clerk, not a Clerk built-in role — implement it as an explicit allow-list or a custom Clerk metadata flag checked in `worker/middleware/`.

### Usage Pattern — Seat limits: use Clerk's own `maxAllowedMemberships`, don't reinvent one

**Correction from an earlier draft of this plan:** seat enforcement should NOT be a custom "compare Clerk's live membership count against our own `seat_limit` column on every request" check. Clerk organizations already have a native, enforced member cap:

```typescript
// Set (or update) an org's member cap directly via Clerk's Backend API —
// call this whenever a subscription's plan/tier changes, not on every request.
await clerkClient.organizations.updateOrganization(orgId, {
  maxAllowedMemberships: planSeatCount, // e.g. 5 for Basic, 20 for Pro
});
```

Clerk itself then blocks new invitations once an org hits its cap — the check happens on Clerk's side, not in `worker/middleware/`. `worker/middleware/` still needs to check **subscription status** (active/past-due/expired, from the control-plane `subscriptions` table — Clerk has no idea about our PayPal/Lipa Namba billing), just not seat count.

**Rules:**

- Default `maxAllowedMemberships` per org is 5; can be set up to 20 without Clerk's paid "B2B Authentication" add-on, and unlimited with it. **If any planned subscription tier needs more than 20 seats, that add-on is a prerequisite** — confirm this against the current Clerk pricing page before committing to a tier structure, since add-on availability/pricing changes.
- Setting `maxAllowedMemberships: 0` means unlimited for that org.
- There is no per-user cap on how many organizations a user can belong to — only the per-org member cap above.
- Sync `maxAllowedMemberships` to Clerk on every subscription activation, plan change, and cancellation/downgrade — a stale value left over-provisioned after a downgrade is a real gap (Clerk won't shrink existing membership, but will block new invites once back under the new cap).

### Usage Pattern — Webhook verification (org creation, membership events)

Clerk webhooks are delivered via Svix (Standard Webhooks). Clerk's own `verifyWebhook` helper is no longer Next.js-only — it now ships per-framework (`@clerk/nextjs/webhooks`, `@clerk/astro/webhooks`, `@clerk/express/webhooks`, `@clerk/fastify/webhooks`) plus a framework-agnostic `@clerk/backend/webhooks`, and — confirmed via npm, 2026-09-06 — `@clerk/hono` ships its own `@clerk/hono/webhooks` too, which takes the Hono context directly instead of a raw `Request`:

```typescript
import { verifyWebhook } from '@clerk/hono/webhooks';

organizationCreatedRoute.post('/', async (c) => {
  const evt = await verifyWebhook(c, { signingSecret: c.env.CLERK_WEBHOOK_SIGNING_SECRET });
  // evt.type === 'organization.created' → provision a tenant Neon project (see Neon section)
});
```

**Correction from an earlier draft of this plan:** that earlier draft called for hand-rolling verification with the `svix` package directly (shown further down in this file's history) — `@clerk/hono/webhooks`' `verifyWebhook` does the same Svix verification plus parses the payload in one call, and is what's actually shipped in `worker/routes/webhooks/organization-created.ts`. Don't reintroduce a manual `svix` integration; it was already tried once and swapped out. Note `verifyWebhook` reads the request body itself (`c.req.text()` internally) — don't consume the body via `c.req.text()`/`c.req.json()` before calling it, since a request body can only be read once.

Relevant event types, confirmed current: `organization.created`, `organization.updated`, `organization.deleted`, `organization_membership.created/updated/deleted`, `organization_invitation.created/accepted/revoked`.

**Rules:**

- Never process a Clerk webhook payload before `verifyWebhook()` succeeds — same rule as PayPal's webhook signature verification below.
- `CLERK_WEBHOOK_SIGNING_SECRET` is a separate secret from `CLERK_SECRET_KEY` — found per-endpoint in the Clerk Dashboard, not the same value. Pass it explicitly as `signingSecret` in Workers — there's no `process.env` fallback to rely on there, unlike Node-based frameworks.
- Separately, and unrelated to which package does the verifying: `@clerk/backend`'s `verifyWebhook` had a real signature-verification bypass, CVE-2025-53548, patched at `@clerk/backend@2.4.0`. `worker/package.json` pins `@clerk/backend@^3.17.1`, well past the fix — confirm this stays true if the pin ever changes.

---

## Keymint.dev (licensing) — Desktop only

Device-bound license activation/validation for the Electron app, used via direct REST calls in `custom/licensing/api/keymint-client.ts`.

**This library is Desktop-only and must not be ported to, imported by, or referenced from the Web target.** The Web target has no license-key concept — access is gated purely by Clerk org + subscription status (see Clerk and Neon sections above).

### Usage Pattern — Validate/activate a key (Desktop)

```typescript
const res = await fetch('https://api.keymint.dev/...', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEYMINT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ productId: KEYMINT_PRODUCT_ID, licenseKey, hostId: deviceId }),
});
```

**Rules:**

- Online validation happens through `custom/licensing/validation/online-validator.ts`; failures/timeouts fall back to `offline-validator.ts` + the encrypted cache.
- Device binding = machine ID + MAC address → SHA-256 (`fingerprint/device-id.ts`). Never send raw MAC/machine ID to the renderer or logs.
- Grace period is 7 days offline; warn the user once < 2 days remain (`GRACE_EXPIRING` state).
- License cache is AES-256-GCM encrypted, key stored in Electron `safeStorage`.
- Config: `KEYMINT_API_URL`, `KEYMINT_ACCESS_TOKEN`, `KEYMINT_PRODUCT_ID`, `ENABLE_LICENSING`.

---

## ClickPesa (mobile-money payments) — Desktop only

Collects license purchase payments via USSD Push to Tanzania mobile money, used in `custom/licensing/api/clickpesa-client.ts`.

**This library is Desktop-only and must not be ported to, imported by, or referenced from the Web target.** The Web target replaces ClickPesa entirely with PayPal Subscriptions (non-Tanzania users) and manual Lipa Namba instructions (Tanzania users) — see below.

### Usage Pattern — Preview then initiate a USSD push (Desktop)

```typescript
POST https://api.clickpesa.com/third-parties/payments/preview-ussd-push-request
{ amount, currency: "TZS", orderReference, phoneNumber }

POST https://api.clickpesa.com/third-parties/payments/initiate-ussd-push-request
{ amount, currency: "TZS", orderReference, phoneNumber, checksum }
```

**Rules (Desktop, unchanged):**

- Currency is always `TZS`.
- Phone numbers normalized to accept `+255XXXXXXXXX`, `255XXXXXXXXX`, `0XXXXXXXXX`.
- Requests retried up to 3 attempts.
- Config: `CLICKPESA_API_URL`, `CLICKPESA_API_KEY`, `CLICKPESA_CHECKSUM_KEY`, `YEARLY_LICENSE_PRICE`.

---

## PayPal Subscriptions API — Web only, target design

Recurring subscription billing for Web users outside Tanzania. Confirmed current webhook event names (Sept 2026): `BILLING.SUBSCRIPTION.CREATED`, `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.UPDATED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`.

**Correction from an earlier draft of this plan:** the official `CreateSubscriptionRequest` schema (confirmed against PayPal's own TypeScript Server SDK docs) marks **both `applicationContext` and `autoRenewal` as DEPRECATED**. An earlier draft of this section used `application_context: { shipping_preference, user_action, return_url, cancel_url }` to control the payer redirect experience — that field still exists but is deprecated, so re-check PayPal's current recommended replacement (likely plan-level configuration or the `plan` override object) before implementing, rather than building against the deprecated shape from memory.

### Usage Pattern — Create a subscription, then handle its webhook

```typescript
// 1. One-time setup (not per-request): create a Catalog Product + a Billing Plan
//    in the PayPal dashboard or via the Catalog Products / Subscriptions REST APIs.
//    Store the resulting plan ID as a Worker secret/env var (e.g. PAYPAL_PLAN_ID).

// 2. worker/routes/payments/paypal-create.ts
POST https://api-m.paypal.com/v1/billing/subscriptions
{
  "plan_id": PAYPAL_PLAN_ID,
  "subscriber": { "email_address": userEmail }
  // Do NOT reach for "application_context" or "auto_renewal" without first checking
  // PayPal's current docs — both are deprecated on CreateSubscriptionRequest as of
  // this crosscheck (Sept 2026); confirm the current recommended replacement first.
}
// Redirect the user to the "approve" link (HATEOAS) in the response — this part is unchanged.

// 3. worker/routes/payments/paypal-webhook.ts
// Verify the webhook signature against PayPal's
// /v1/notifications/verify-webhook-signature endpoint BEFORE trusting the payload —
// confirmed there is no official SDK helper for this (the TypeScript Server SDK's
// client explicitly has no webhook-verification code), so this must be a manual REST call.
// Then branch on event.event_type:
//   BILLING.SUBSCRIPTION.ACTIVATED  → subscriptions.status = ACTIVE
//   PAYMENT.SALE.COMPLETED          → insert a `payments` row (status COMPLETED)
//   BILLING.SUBSCRIPTION.SUSPENDED,
//   BILLING.SUBSCRIPTION.CANCELLED,
//   BILLING.SUBSCRIPTION.EXPIRED    → subscriptions.status = matching state
//   BILLING.SUBSCRIPTION.PAYMENT.FAILED → subscriptions.status = PAST_DUE
```

**Rules:**

- Never update `subscriptions`/`payments` from a webhook payload whose signature hasn't been verified.
- Use sandbox credentials/environment (`api-m.sandbox.paypal.com`) until go-live is explicitly confirmed; never point at production PayPal from a dev branch.
- Config: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PLAN_ID`, `PAYPAL_WEBHOOK_ID` (needed for signature verification) as Worker secrets.
- Treat `BILLING.SUBSCRIPTION.ACTIVATED` and `PAYMENT.SALE.COMPLETED` as the two events that actually grant/extend access — the rest are informational or revoke access.
- This is a genuinely different integration shape from ClickPesa's — do not copy ClickPesa's "preview → initiate → poll" pattern here; PayPal is create-subscription → redirect → webhook, no polling.
- Before implementing, re-fetch PayPal's current `Create Subscription` request schema — this crosscheck found two deprecated fields on the exact request shape planned above, which is a signal this API surface changes; don't treat the snippet above as final.

---

## Lipa Namba (manual instructions, Tanzania) — Web only, target design

**Not an API integration.** Per the migration decision, Lipa Namba on Web is informational-only — no automated USSD push like Desktop's ClickPesa flow.

### Usage Pattern

```typescript
// Billing page (Vue, src/): renders static instructions —
// business/paybill number, amount, and a required reference format —
// then collects a user-submitted transaction reference and calls:
POST /api/payments/lipa-namba-claim
{ reference: string, amount: number }
// worker route inserts a `payments` row: provider='lipa_namba', status='PENDING_REVIEW'

// Super admin review view (Web only):
GET /api/admin/payments?status=PENDING_REVIEW
POST /api/admin/payments/:id/approve   // sets payments.status='APPROVED', updates subscriptions
POST /api/admin/payments/:id/reject
```

**Rules:**

- Never auto-approve a Lipa Namba claim — every claim requires an explicit super admin action.
- The super admin route group must be behind its own authorization check (see Clerk section above), separate from normal org-scoped access.
- Keep the displayed paybill/instructions text as project configuration (env var or a simple admin-editable setting), not hardcoded in a component, since the business number/instructions may change independent of a deploy.

---

## ntfy (notifications) — Shared (both Desktop and Web)

Single delivery path for restock, payment, and POS shift-close notifications on **both** targets: `src/utils/ntfy.ts` → `sendNtfyNotification(fyo, message, title?, tags?, priority?)`, called from the shared model layer (`models/baseModels/SalesInvoice/SalesInvoice.ts`, `models/inventory/Point of Sale/POSClosingShift.ts`). There is no separate Web notification module and no Worker route for it — on Web the models run in the browser renderer, so the publish happens browser-side, same call as Desktop. The previously-planned OneSignal port (spec 0006's earlier draft) was reversed on 2026-09-12; see `docs/specs/0006-ntfy-notifications.md`.

### Usage Pattern

```
POST https://ntfy.sh/<topic>          // unauthenticated; the topic is the credential
Body: <message>
Headers (all optional except as noted):
  Title / Tags / Priority / Markdown
```

Enabled per company by `POSSettings.enableMobileNotifications` + `POSSettings.messageChannel` (the topic). Both fields are tenant data — on Web they live in the org's own Neon project via the shared Settings surface, not in the control plane.

**Rules:**

- Reuse `sendNtfyNotification` unchanged — do not add a `custom/web/notifications/` delivery module or any Worker notification route. The existing trigger logic (`tests/restockNotification.spec.ts`, `tests/paymentMethodNotification.spec.ts`, `tests/ntfyNotification.spec.ts`) is shared code and must keep passing unmodified on the web build.
- The call is **fire-and-forget**: an 8s `AbortController` timeout, failures logged via `console.error`, never thrown. A notification outage must never fail an invoice submit or a shift close — do not "fix" this into a throwing call.
- The topic is validated with `/^[A-Za-z0-9_-]+$/` and URI-encoded before the fetch; keep that validation if the base URL ever becomes configurable.
- No auth header and no API key: on the public server the topic is effectively a password ("there is no sign-up, the topic is essentially a password" — ntfy's own model). Use unguessable per-org topics and never display one outside its own Settings field.
- **No `NTFY_*` env var and no Worker secret** for this on Web. Do not reintroduce `ONESIGNAL_APP_ID` / `ONESIGNAL_API_KEY`.
- **Browser-origin publishes confirmed possible** (2026-09-12): a live CORS preflight against ntfy.sh returned `access-control-allow-origin: *`, POST in `access-control-allow-methods`, `access-control-allow-headers: *`. AC-3 in spec 0006 still wants an observed delivery from the deployed origin before GA — ntfy.sh's published anonymous rate and message-size limits were not found on the docs pages checked, so re-verify before relying on notification volume.
- If a tenant needs private or high-volume delivery, the answer is a self-hosted ntfy server plus a configurable base URL in `src/utils/ntfy.ts` (currently hardcoded to `https://ntfy.sh`) — a change that applies to Desktop too, tracked as spec 0006 Follow-up, not in scope now.

---

## Tailwind CSS v3 (postcss7-compat) + tailwindcss-rtl — Shared

Styling layer, configured via `tailwind.config.js`, tokens sourced from `colors.json`. No changes for the Web migration — see `ui-tokens.md` and `ui-rules.md`.

---

## electron-builder (packaging) — Desktop only

Builds installers for Windows (incl. MSIX), macOS, and Linux. Not used by the Web target, which deploys via Wrangler to Cloudflare Workers instead.

### Usage Pattern (Desktop)

```bash
npm run build               # current platform
npm run build -- --linux
npm run build:msix
```

---

## Wrangler (Cloudflare Workers deploy) — Web only, target design

```bash
wrangler deploy      # deploy worker/ to Cloudflare
wrangler dev         # local dev server for the Hono API
```

**Rules:**

- Secrets (`CLERK_SECRET_KEY`, `PAYPAL_CLIENT_SECRET`, Neon connection string, etc.) go through `wrangler secret put`, never committed to `wrangler.toml`. Notifications need none — Web publishes to ntfy from the browser, see the ntfy section.
- `wrangler.toml` should not exist yet in this repo as of the last inspection — confirm current state before assuming a working config is already checked in.
