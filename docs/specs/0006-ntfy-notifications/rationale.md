# 0006 · Web notifications (ntfy): rationale

## Context

Desktop fires notifications through ntfy when inventory drops low, when a sale is submitted, and at POS shift close, already covered by `restockNotification.spec.ts`, `paymentMethodNotification.spec.ts`, and `ntfyNotification.spec.ts`. An earlier draft of this spec (2026-09-03) planned to swap Web's delivery to OneSignal push: `include_aliases.external_id` fan-out to Clerk member user IDs, `ONESIGNAL_APP_ID`/`ONESIGNAL_API_KEY` Worker secrets, and a `custom/web/notifications/` module. That plan is withdrawn, for two concrete reasons found while re-examining the actual code:

1. On Web the `fyo` model layer — where the restock and payment triggers live (`SalesInvoice.ts`, `POSClosingShift.ts`) — runs in the browser renderer (`rendererWeb.ts`), the same place `sendNtfyNotification` is already invoked on Desktop. The triggers and the delivery function are shared code, not Desktop code.
2. ntfy publishing is an unauthenticated `POST https://ntfy.sh/<topic>` with plain custom headers, and a live CORS preflight against ntfy.sh (2026-09-12) returned `access-control-allow-origin: *`, POST in `access-control-allow-methods`, and `access-control-allow-headers: *` — so a browser-origin publish from the hosted app reaches ntfy.sh directly, with no Worker proxy hop.

Keeping ntfy therefore delivers identical notification behavior on both targets with zero new notification code, no vendor account, and no Worker secrets.

## Options considered

- **Keep ntfy (chosen)** — zero new code, zero new secrets, exact behavioral parity with Desktop. ntfy already reaches phones through the ntfy app and web clients with no integration work on our side.
- **OneSignal push port (the withdrawn 2026-09-03 plan)** — adds a vendor account, two Worker secrets, and a per-org Clerk-membership fan-out. That fan-out exists only because OneSignal targets per-user push registrations; with ntfy the delivery target is a topic the organization owns, so the entire targeting problem disappears. Revisit only if first-party browser push (a permission prompt, notifications without any external app) becomes a product requirement.
- **Worker-side proxy of the ntfy publish** — considered and rejected: it centralizes nothing that needs centralizing (the trigger already runs client-side on both targets), adds a route and its tenant-resolution overhead, and makes every tenant's publish traffic egress from a handful of Cloudflare IPs against ntfy.sh's per-IP rate limits, which is strictly worse than today's per-user browser egress.

## Rationale

Reusing the existing path is the smallest change that satisfies the requirement — smaller than the OneSignal plan it replaces, which had to design and test a whole fan-out mechanism (resolving an org to its current Clerk member user IDs, guarding `include_aliases` against incompatible targeting parameters) that the ntfy topic model simply doesn't have. The user-visible behavior is already correct and already tested; the only real unknown was whether a hosted-origin browser could publish, which was checked live rather than assumed.
