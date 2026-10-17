---
description: Hono API on Cloudflare Workers for the web platform
globs: "worker/**"
alwaysApply: true
---

# worker

## Overview

Hono API running on Cloudflare Workers, the backend for the web platform. Handles authentication via Clerk, tenant-project resolution (control plane lookup), subscription status gates, and generic document CRUD routes that route to per-tenant Neon databases. Entirely web-only; nothing here touches the Electron target or Keymint licensing.

## Key subsystems

| Subsystem | Owns |
|---|---|
| `routes/` | HTTP endpoint handlers (authentication callback, doc CRUD, subscription status, payments) |
| `middleware/` | Clerk session verification, tenant-project resolution, subscription status checks |
| `db/control.ts` | Fixed control-plane Neon client (organization → tenant project mapping) |
| `db/resolve-tenant.ts` | Per-request tenant connection resolver and short-TTL cache |
| `db/schema.sql` | Control-plane schema (organizations, tenant_projects, subscriptions, payments) |
| `lib/encryption.ts` | AES-256-GCM encryption/decryption for tenant connection strings at rest |
| `wrangler.toml` | Cloudflare Workers configuration and secrets |
| `tsconfig.json` | Worker-specific TypeScript configuration with root path aliases |

## Conventions

- **Module boundaries**: `worker/` is web-only. Never import from `main/`, `backend/`, or `custom/licensing/` — these are Electron-only. Imports from `schemas/`, `fyo/`, `models/`, `utils/`, `custom/web/` are OK.
- **Connection management**: Tenant connection strings are looked up from the control plane (fixed connection `CONTROL_DATABASE_URL`), decrypted in memory (via `AES-256-GCM` with `TENANT_ENCRYPTION_KEY`), and used to build a short-TTL cached Knex instance. No connection is left open across requests; each request builds and uses its own instance.
- **Database client**: Knex with `@neondatabase/serverless`'s `Pool` (WebSocket-based, Worker-compatible) aliased as `pg`. No plain TCP connections (Workers cannot open them).
- **Tenant isolation**: Every Neon query runs against that specific org's tenant project, never the control plane (which is read-only from routes), never another org's project. The tenant connection is the sole tenant boundary; no `org_id` column filtering.
- **Auth model**: Verified Clerk session (via `@clerk/hono` middleware) is the only source of tenant identity. Client never supplies `org_id` or tenant ID. Session org/user/role are Clerk provided, never user input.
- **Webhook security**: Inbound webhooks (Clerk `organization.created`, PayPal events) are verified via `@clerk/hono/webhooks` or equivalent (Svix + signature check) before any state change.
- **Error responses**: Fixed, stable shapes per layer (402 for unpaid, 503 for control-plane unavailable, 400 for bad input, 500 for internal errors) so the client can reliably decode and route appropriately.

## Libraries and dependencies

- **Framework**: Hono (HTTP router on Workers)
- **Auth**: `@clerk/hono` (Clerk middleware + webhook verification)
- **Database clients**: Knex (query builder), `@neondatabase/serverless` (Pool for Neon, aliased as `pg`)
- **Neon SDK**: `@neondatabase/sdk` (control-plane tenant project provisioning)
- **Encryption**: Node.js `crypto.subtle` (AES-256-GCM)
- **Testing**: vitest (16+ worker tests in `worker/tests/`)

## Secrets (Cloudflare Workers `wrangler.toml`)

- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET` — Clerk API + webhook auth
- `NEON_API_KEY`, `NEON_ACCOUNT_ORG_ID` — Neon tenant-project provisioning
- `CONTROL_DATABASE_URL` — fixed connection to the shared control-plane project
- `TENANT_ENCRYPTION_KEY` — 32-byte AES-256-GCM key for encrypting `tenant_projects.connection_string`

## Key invariants

- No tenant query ever touches the control-plane project (which is fixed, read-only from routes, and contains global state like subscription status).
- The worker-side dispatch allowlist (mirroring `backend/helpers.ts`'s `databaseMethodSet`) gates which doc methods are reachable. Add new methods to the allowlist explicitly; `close` is deliberately excluded (connection lifecycle is owned per-request).
- Keymint (`custom/licensing/`) and ClickPesa code must never be imported here.

## Gotchas

- **Connection pool exhaustion**: Each request builds a new Knex instance on the tenant connection. Ensure the pool is small (connection count is bounded) and closed after the request. The pool configuration is set in the Worker secret; the per-request lifecycle is enforced in `custom/web/db/tenantDatabase.ts`.
- **SQLite vs. Postgres**: Queries written for Desktop's SQLite may fail verbatim on Postgres. See `backend/database/core.ts` notes on PRAGMA differences, foreign-key enforcement, and transaction semantics. The Postgres path branches around SQLite specifics.

_Drafted by /sync from the introducing change, worth a quick human pass._
