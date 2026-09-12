---
description: Rules and context for AI agents building Rarebooks
globs: "*"
alwaysApply: true
---

# RareBooks — Agent Configuration

## Read Before Anything Else

Read the context files in this exact order before writing any code:

1. `context/project-overview.md`
2. `context/architecture.md`
3. `context/ui-tokens.md`
4. `context/ui-rules.md`
5. `context/ui-registry.md`
6. `context/code-standards.md`
7. `context/library-docs.md`
8. `context/build-plan.md`
9. `context/progress-tracker.md`

## Overview

Simple bookkeeping app for small and medium businesses, forked from Frappe Books. Ships today as an Electron desktop app (Vue 3 + TypeScript + SQLite). This branch also contains the hosted web foundation: the Vue web client, Cloudflare Worker and Hono API, Clerk authentication, Neon control-plane integration, and per-organization tenant provisioning. The accounting-schema migration, tenant CRUD layer, and its one-off migration runner (`npm run migrate:tenants`) are now built on this branch; subscription and payment flows, notifications, and production cutover remain planned.

## Stack

- **Language**: TypeScript (strict mode), Vue 3 SFCs
- **Framework**: Electron (main + renderer process), Vue Router 4
- **Database**: SQLite via better-sqlite3, Knex query builder
- **Key dependencies**: Vue 3, Knex, Luxon (dates), Bree (job scheduling), Tailwind CSS
- **Package manager**: npm (`package-lock.json` is authoritative since the web migration; `yarn.lock` was removed. Yarn Classic is optional and can run the same package scripts if you already have it installed.)

## Build approach

Tracer Bullet (each feature built as a thin, complete vertical slice through every layer, working end to end, before the next one starts). Recorded in `docs/scope/scope.md`.

## Commands

```bash
# Install
npm install
npm run postinstall   # rebuilds native modules (better-sqlite3) for Electron

# Dev server
npm run dev

# Build
npm run build
npm run build -- --linux
npm run build -- --windows
npm run build -- --mac

# Web (this branch)
npm run dev:web          # Vite dev server (proxies /api and /webhooks to the worker)
npm run dev:web:full     # Vite + `wrangler dev` together
npm run build:web        # Vite production build into dist_web/
npm run deploy:web       # build:web + wrangler deploy

# Tenant schema rollout (spec 0002 AC-5, one-off operator script)
npm run migrate:tenants -- --dry-run   # list tenants a schema change would migrate
npm run migrate:tenants --             # fan out DatabaseCore.migrate() to every READY tenant

# Test
npm run test           # mocha + tape, server-side
npm run uitest          # UI tests
npm run lint
npm run format
```

## Specs

`docs/specs/`: 0001 web platform foundation & control plane (in progress) · 0002 tenant schema & data layer · 0003 subscription gating & seat sync · 0004 PayPal subscriptions · 0005 Lipa Namba manual payments & admin review · 0006 OneSignal notifications · 0007 deploy & cutover readiness. See `docs/scope/scope.md` for the full plan (features 01-05 existing, 06 in progress, and 07-13 planned) and `context/build-plan.md` for the original, more detailed sub-phase writeups these specs were captured from.

## Rules

- Strict client/server separation: `src`, `fyo`, `models`, `reports` are client(-adjacent); `main`, `backend`, `schemas`, `scripts`, `translations` are server-side. Client code never imports server code and vice versa.
- All platform-specific (Electron vs. browser) calls go through `fyo/demux/*.ts` only — no other client file should know which platform it's running on.
- `models/**` must not import Vue or the `src` singleton `Fyo` globally (breaks mocha tests); use dynamic `await import('...')` if frontend code is genuinely needed, and pass `fyo` in as a parameter.
- `**/types.ts` files are side-agnostic and import only other type files.
- Tests live in `**/tests/*.spec.ts`, run server-side via mocha/tape, never imported at runtime.
- TypeScript strict mode; ESLint + Prettier enforced (`no-floating-promises`, `no-misused-promises` as warnings).
- Absolute imports via tsconfig `paths` (`src/*`, `backend/*`, `custom/*`, etc.) instead of deep relative paths.

## Context files

- [custom/licensing/AGENTS.md](custom/licensing/AGENTS.md) (Licensing, subscription, and payment provider integration for the Electron app)

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
