---
description: Web platform shell initialization, routing, and state management
globs: "src/web/**"
alwaysApply: true
---

# src/web

## Overview

Web-only shell initialization, routing, and client state for the browser-based RareBooks app. Bootstraps the web platform, manages the Fyo instance for the signed-in tenant, handles organization switching, and exposes the web-specific router that mounts the desktop UI inside the web client.

## Key files

| File | Owns |
|---|---|
| `boot.ts` | Initializes `Fyo` instance against the tenant database, loads schemas, registers models, boots SingleDocTypes (AccountingSettings, POSSettings, SystemSettings) |
| `router.ts` | Web router configuration (alias for `src/router` at build time); mounts pages, chrome routes, and deep links with boot guards |
| `shell.ts` | Shell state machine orchestration (boot, ready, switching, unavailable states) — manages the lifecycle across org switches |
| `shellBootState.ts` | Boot state machine types and logic (idle → booting → ready → switching/unavailable) |
| `shellState.ts` | Shared shell state (current org, boot status, boot epoch for stale-response discard) — lives in memory + sessionStorage |
| `clerk.ts` | Clerk auth client initialization and user/organization context |
| `subscription.ts` | Subscription status read and local caching for the billing prompt |
| `webLive.ts` | Reactive Fyo instance bindings (doc changes trigger UI reactivity) |

## Conventions

- **Build-time alias swap**: The web build has `vite.config.web.ts` configured to swap `src/initFyo` and `src/router` to their web variants at build time. The source files (`src/router.ts`) are never edited; the aliases handle the split between Desktop and Web. This means 49 files importing `from 'src/initFyo'` work unchanged on both targets.
- **Boot state machine**: Routes are guarded by the boot state machine. Opening any chrome route (dashboard, list, form) while booted against one org, then switching orgs, tears down and reboots the Fyo instance. Deep links (e.g., `/list/Party/Customers` on first load) are gated by the boot guard too.
- **Org switching**: The org switcher in the sidebar (from `src/components/Sidebar.vue`, shared code) triggers `resetWebFyo()`, which clears the old tenant state, runs the boot state machine again against the new org's tenant, and re-renders the app chrome.
- **Stale response discard**: Every data call includes a boot epoch (a monotonic counter incremented on org switch). Responses from stale organizations are discarded before they can pollute the current org's state. This is crucial for preventing in-flight requests from org A landing data in org B after a switch.
- **Platform knowledge**: Files here stay aware they're web-only (Clerk client, Neon connections via Worker). Platform checks read `fyo.isElectron` (which is false) or use `fyo/demux/` for platform-agnostic calls. Raw `window.ipc` is never used here.

## Integration points

- **Desktop boot isolation**: Desktop's `src/initFyo.ts` is entirely separate from this web variant. At build time, `src/initFyo` is aliased to point to `src/initFyoWeb` (this module's entry point) for the web build, and stays pointing to the original for the desktop build. Both export a compatible `Fyo` instance.
- **Shared UI components**: The 49 files using `from 'src/initFyo'` (sidebar, list views, forms) are shared code. They never know which platform they're on; platform details flow through `fyo/demux/` or the injected Fyo instance (`fyo.isElectron`, `fyo.auth` via web demux).
- **Clerk organization context**: The org is determined by the signed-in Clerk session. Switching orgs means picking a different Clerk org context and running the boot sequence for that org's tenant.

## Libraries and dependencies

- **Clerk**: `@clerk/vue` (auth, org context, session management)
- **Vite**: `rendererWeb.ts` is the browser entry point, built via `vite.config.web.ts`
- **Routing**: Vue Router 4 (shared router config, web variant swapped at build time)
- **Fyo**: Custom Doc/ORM framework (shared, reused identically from Desktop)

## Key invariants

- No direct import of Worker routes or API paths. All data calls go through `fyo/demux/db.ts`, which handles the HTTP routing to `/api/db/...` routes.
- Org/tenant identity comes from Clerk session only. Never accept `org_id` or `tenant_id` as route parameters or query strings.
- The boot guard wraps every chrome route, so deep links to lists and forms are safe even on first load or hard refresh.
- Keymint (`custom/licensing/`) is never imported here; Clerk replaces it entirely for the web platform.

## Gotchas

- **Language loader and i18n**: The desktop language loader reads from `translations/` CSV files and caches them at boot. The web boot has to run against a browser environment where those files aren't bundled the same way. The loader was refactored to be lazy; ensure any web-specific i18n changes don't re-import the entire translations setup at module level.
- **Boot concurrency**: `ensureWebFyoReady()` is deduped per org, so concurrent requests for the same org during boot don't spawn multiple boot sequences. Org switches (reset → boot) are synchronous and block new boot attempts until ready.

_Drafted by /sync from the introducing change, worth a quick human pass._
