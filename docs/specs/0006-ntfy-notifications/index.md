# 0006. Web notifications (ntfy)

**Date**: 2026-09-03
**Updated**: 2026-09-12 — decision reversed from the drafted OneSignal port to keeping ntfy on Web (Charles's call). File renamed from `0006-onesignal-notifications.md`; the port design it recorded is superseded, not extended.
**Status**: In Progress

## Summary

The Web target does not switch notification providers. Restock and payment notifications on Web use the same ntfy delivery path Desktop already uses — the same `src/utils/ntfy.ts`, the same model-layer triggers, and the same `POSSettings`-based topic configuration. What remains for this feature is verification that the shared path works in the web renderer, not a port.

Decision record (Context, Options considered, Rationale) lives in [rationale.md](rationale.md).

## Requirements

**User stories**:
- As a tenant user of the web app, I want restock and payment notifications delivered to my ntfy subscribers — phone, desktop, or web — exactly as on Desktop, without setting up or depending on an additional provider account.

**Acceptance criteria**:
- **AC-1**: Delivery and triggering reuse `src/utils/ntfy.ts` and the existing model hooks unchanged; no new delivery mechanism is introduced, and no notification code is added under `custom/web/`.
- **AC-2**: Enablement and targeting remain `POSSettings.enableMobileNotifications` and `POSSettings.messageChannel` (the topic), stored per tenant in its own Neon project and edited through the shared Settings surface — no new schema, no Worker route, and no Worker secret for notifications.
- **AC-3**: Publishes originate from the browser renderer; the CORS path is confirmed against ntfy.sh from the deployed web origin (a publish observed to arrive, not just the preflight) before this ships.
- **AC-4**: The topic is treated as a password-equivalent secret (the public server's own model: "there is no sign-up, the topic is essentially a password"): unguessable per organization, never logged or displayed outside its own Settings field.
- **AC-5**: The three existing notification specs continue to pass unmodified on the web build configuration; no web-only delivery duplicate is added to keep them passing.

## Decision

**Chosen option**: Web keeps ntfy. The shared `src/utils/ntfy.ts` delivery path and the existing model-layer triggers are reused unchanged on both targets; feature 11 shrinks from a delivery port to a verification slice (Settings reachable from the web shell, browser-origin publish observed to work).

## Feature design

**Data model sketch**: No new tables. `POSSettings` (a Single) already carries both fields; on Web it is tenant data in each org's own Neon project, same doctype as Desktop.

**API surface**: No RareBooks-owned endpoints. The only external call is the existing one in `src/utils/ntfy.ts`:

| Endpoint | Method | Key inputs | Auth | Failure behavior |
|---|---|---|---|---|
| `https://ntfy.sh/<topic>` | POST | message body; `Title`, `Tags`, `Priority`, `Markdown` headers | none — the topic is the credential | logged via `console.error`, never thrown at the caller (fire-and-forget, 8s timeout) |

**Value sourcing**:
| Action | Value produced / displayed | Source |
|---|---|---|
| Restock alert / New Sale / shift summary | message, title, tags, priority | existing trigger logic in `SalesInvoice.ts` and `POSClosingShift.ts`, unchanged |
| Delivery target | topic | `POSSettings.messageChannel`, set per organization in Settings, same as Desktop |

**Key invariants**:
- One shared delivery function: both targets must never have separate notification delivery code (`custom/web/notifications/` is explicitly not built).
- No notification Worker route and no notification Worker secret.
- `sendNtfyNotification` stays fail-soft: a delivery failure never blocks invoice submission or shift close (already its behavior; the web build must not "fix" this into throwing).

**Security model**: The public server is unauthenticated by design — knowing a topic is knowing its password. Anyone who can guess or learn a tenant's topic can publish fake notifications to that tenant's subscribers and see message content (item names, sale totals), exactly as on Desktop today; the mitigation is the same and is AC-4: unguessable per-org topics. If an organization ever needs stronger guarantees, the answer is a self-hosted ntfy server — note `src/utils/ntfy.ts` currently hardcodes the `https://ntfy.sh` base, so a configurable base URL would be a small new change on both targets, out of scope here.

**Configuration required**: None server-side. No `wrangler secret put` entry, no `wrangler.toml` variable. Tenant-side setup is the same two Settings fields Desktop uses.

**Critical test scenarios**:
- Happy path from a browser: a SalesInvoice submitted in the hosted web app publishes to the org's configured topic and arrives at a subscribed ntfy client. Verifies **AC-3** (and **AC-1** by non-regression).
- Existing specs against the web build: `restockNotification.spec.ts`, `paymentMethodNotification.spec.ts`, `ntfyNotification.spec.ts` pass unchanged (disabled settings → no call; invalid topic → rejected before fetch; content shape). Verifies **AC-1, AC-5**.
- Settings reachability: with a tenant signed in on Web, `enableMobileNotifications`/`messageChannel` are editable and persist to that tenant's Neon project only. Verifies **AC-2**.

## Build plan

1. When the web app shell exposes the shared Settings surface (rides along with feature 07+ work; no separate notification module), confirm both `POSSettings` fields are reachable and persist per tenant. Satisfies **AC-2**.
   _Built 2026-09-13: `src/web/boot.ts` (web fyo boot against the tenant DB) + `src/pages/web/Settings.vue` mounted at `/settings`. Live per-tenant round trip pending a test account against `wrangler dev`; see scope feature 11._
2. From a deployed (or `wrangler dev`-served) web origin, run the browser-origin publish check against a real test topic and observe delivery; record the result here or in the tracker so AC-3 is closed on evidence, not on the 2026-09-12 preflight alone. Satisfies **AC-3, AC-4**. [x] 2026-09-13: `npm run check:ntfy` (`scripts/ntfy-web-publish-check.mjs`, Playwright Chromium) published from the deployed `https://app.rarebooks.cc` origin to a fresh random topic `rarebooks-web-check-…` (HTTP 200) and observed the exact message in the topic's `/json?poll=1` event stream. AC-4 honored: topic random per run, printed only in the operator's terminal.
3. Re-run the three existing notification specs under the web build configuration. Satisfies **AC-1, AC-5**.
   _Re-run 2026-09-13 (specs unmodified): restock 8/8 pass; ntfyNotification and paymentMethodNotification each fail one assertion for a reason pre-existing at HEAD, unrelated to this feature: the first a stub-restoration race (passes with the fire-and-forget notification settled), the second asserts a `Receiving Account:` line `sendPOSNotification` has never produced (it says `Paid Via:`). To fix via /debug (test race) and /architect (spec wording) — not by touching delivery code, which AC-1 forbids._

## Consequences

**Positive**:
- No OneSignal (or other push-vendor) account to provision, no Worker secrets, no Worker notification code — the Worker bundle stays what it was already scoped to be.
- Identical notification behavior across Desktop and Web, backed by the same already-passing trigger specs.
- Browser egress means ntfy's per-IP rate limits apply per user rather than platform-wide, which was a real weakness of the rejected Worker-proxy option.

**Negative / tradeoffs**:
- The public ntfy.sh server stays a third-party availability and rate-limit dependency for hosted customers, not just Desktop ones; its exact anonymous-publish limits were not published on the docs pages checked 2026-09-12 and must be re-verified before relying on notification volume.
- Topic-as-password means careless topic sharing (pasting it around an org) is a spoofing and content-disclosure risk, now across a larger, multi-tenant web user base. AC-4's guidance mitigates but cannot technically prevent it without a self-hosted server.
- No first-party browser push: users get notifications through an ntfy client (app or web), not a RareBooks-originated permission prompt. Accepted, since parity with Desktop is the requirement.

**Neutral**:
- Spec 0007's secrets checklist and feature 12's deploy wording lose OneSignal; the dependency chain (11 depends on 07) is unchanged.
- The OneSignal API research recorded in the 2026-09-03 crosscheck pass becomes historical; it was accurate then and is simply no longer on the build path.

## Follow-up

- [ ] Re-verify ntfy.sh's current CORS posture and anonymous rate/size limits against its docs (and the live check from step 2) before GA.
- [ ] If any tenant needs private or high-volume delivery, add a configurable ntfy base URL (self-hosted server support) to `src/utils/ntfy.ts` as its own small change — it would apply to Desktop too.
- [ ] If first-party browser push ever becomes a requirement, raise a new spec; do not revive OneSignal under this one.
