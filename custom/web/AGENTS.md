---
description: Web-only custom integrations for Clerk auth, subscription billing, and tenant DB utilities
globs: "custom/web/**"
alwaysApply: true
---

# custom/web

## Overview

All web-only custom code, kept isolated (like `custom/licensing/` for Electron) to stay fork-safe against upstream Frappe Books merges. Includes Clerk organization/subscription integration, billing orchestration, and tenant database utilities. Does not include notifications — Web uses the same shared ntfy delivery path as Desktop (`src/utils/ntfy.ts`).

## Key subsystems

| Subsystem | Owns |
|---|---|
| `auth/` | Clerk organization creation webhooks, tenant schema application, provisioning state transitions |
| `billing/` | Subscription status reads, seat-cap sync with Clerk, shared types and seed logic for operator CLI |
| `db/` | Per-request tenant database instance builder, control-plane client, tenant migration runner, decryption utilities |

## Key files

| File | Owns |
|---|---|
| `auth/handleOrganizationCreated.ts` | Clerk `organization.created` webhook handler — provisions a Neon project and records it as `PROJECT_CREATED` |
| `auth/applyTenantSchema.ts` | Applies the full accounting schema to a tenant project via `DatabaseCore.migrate()`, marks it `READY` on success |
| `billing/subscriptionStatus.ts` | Reads the org's subscription status from the control plane, returns the status or null |
| `billing/seatSync.ts` | Syncs Clerk's `maxAllowedMemberships` with our plan tier, via Clerk Backend API (no `@clerk/backend` dep; uses `fetch` + secret key) |
| `billing/seedSubscription.ts` | Operator CLI logic to upsert an ACTIVE subscription and run seat sync (bridging the pre-payments gap) |
| `billing/types.ts` | Shared subscription status types (`SubscriptionStatus`, `SubscriptionWireStatus`) |
| `billing/plans.ts` | Plan tier definitions and seat counts (shared between Worker and operator scripts) |
| `db/tenantDatabase.ts` | Per-request Neon/Postgres connection builder — decrypts connection string, builds Knex instance, manages lifecycle |
| `db/knexPgConfig.ts` | Knex Postgres configuration (type map, client config) mirroring `backend/database/core.ts`'s `sqliteTypeMap` |
| `db/tenantMigrationRunner.ts` | Operator script runner — fans out `DatabaseCore.migrate()` across every READY tenant, handles recovery paths |

## Conventions

- **Isolation like `custom/licensing/`**: All web-specific code lives here. Never edit core files (`src/`, `fyo/`, `models/`) for web-only logic — instead, import into them from here or wire via `fyo/demux/`.
- **No Electron-only imports**: Never import `main/`, `backend/`, `custom/licensing/`, or `Electron` APIs. Must run on Node.js (operator scripts) and in a Worker environment.
- **Operator scripts live in `scripts/`, not here**: `scripts/migrate-tenants.sh` / `.ts` and `scripts/seed-subscription.sh` / `.ts` are the entry points. This module exports reusable functions for them.
- **Shared secrets**: Reads `CONTROL_DATABASE_URL`, `NEON_API_KEY`, `NEON_ACCOUNT_ORG_ID`, `TENANT_ENCRYPTION_KEY` from environment or `.env`, same way Worker does.
- **Encryption key scope**: `TENANT_ENCRYPTION_KEY` is shared between Worker (which decrypts on every request) and `db/tenantMigrationRunner.ts` (which decrypts per migration). Both copies must change together; keep the key in `worker/.env` (for deploy) and root `.env` (for operator script runs).

## Libraries and dependencies

- **Clerk**: `@clerk/backend` API for seat-cap sync (via `fetch` + API key, not the SDK)
- **Neon**: `@neondatabase/sdk` (used by webhook handler and tenant provisioning)
- **Database**: Knex, `@neondatabase/serverless` Pool
- **Encryption**: Node.js `crypto.subtle` (AES-256-GCM, matching `worker/lib/encryption.ts`)

## Key invariants

- Keymint (`custom/licensing/`) and ClickPesa code must never be referenced here.
- Every encrypted connection string is decrypted in memory and never logged, stored, or returned to the client. Decryption happens only at the Worker (per request) or the migration runner (per operator invocation).
- Seat-cap sync to Clerk is synchronous; a failed Clerk API call propagates and halts provisioning. Local `plan_seat_limit` upsert is best-effort (logged, not re-thrown) if Clerk succeeds.

## Gotchas

- **`ts-node` cannot import Worker code**: The operator scripts run via `ts-node`, which is CJS-based. `worker/` is ESM and cannot be imported. Reusable logic must live here in `custom/web/` and be imported by both the Worker and the operator scripts.
- **CustomFields before schema apply**: The provisioning webhook (`applyTenantSchema.ts`) runs against a fresh, empty tenant database, so it cannot read the tenant's `CustomField` rows (they don't exist yet). The migration runner (`tenantMigrationRunner.ts`), which runs later, can read them. If schema changes require custom-field awareness, the runner (not the webhook) is the place to add that.

_Drafted by /sync from the introducing change, worth a quick human pass._
