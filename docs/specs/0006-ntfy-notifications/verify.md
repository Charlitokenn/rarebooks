# Verify: Web notifications (ntfy) · spec 0006 · updated 2026-09-13
_Steps derived from spec 0006 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual
- [ ] Local (`npm run dev:web:full`, sign in to a READY tenant via Clerk, open `/settings`) → the Settings page loads (no "not ready" screen), the two fields show the tenant's current values → AC-2
- [ ] `/settings`: enable notifications, enter a topic you subscribe to with an ntfy app on your phone → Save → reload the page → values persist; confirm they land in THAT tenant's Neon project only (a second tenant's `/settings` shows its own empty values, never the first's) → AC-2, AC-4 (topic masked as password until Show)
- [ ] `/settings` with notifications enabled and a topic containing a character outside `[A-Za-z0-9_-]` (e.g. a space or `ü`) → inline invalid message appears, Save stays disabled → AC-4 (matches `src/utils/ntfy.ts`'s validation)
- [ ] `/settings` → "Send test notification" → the message arrives in your subscribed ntfy app; the page uses the real `sendNtfyNotification` (`src/utils/ntfy.ts`), not a copy → AC-3 (in-app path)
- [ ] Full event path: with notifications enabled and subscribed, submit a POS SalesInvoice (or close a POS shift, if the POS forms are reachable on the web build for your tenant) → "New Sale!" / EOD summary arrives via ntfy; a network failure to ntfy.sh never blocks the submit → AC-1 (shared triggers), AC-3
- [ ] Edge, delivery enabled + wrong topic saved (e.g. one with a space, if saved before validation existed): submit an invoice → invoice submits fine, nothing arrives, browser console shows the fail-soft error only → AC-1 (fail-soft invariant holds on web)
- [ ] Edge, different tenant, same event: notifications disabled for tenant B → B's invoice submit publishes nothing → AC-2 (per-tenant enablement)

## Commands
- [ ] `npm run check:ntfy` → "AC-3 evidence: PASS" (Chromium on the deployed `https://app.rarebooks.cc` origin, POST to a fresh random topic returns HTTP 200 and the exact message is observed in the topic's event stream) → AC-3, AC-4
- [ ] `bash scripts/runner.sh ./node_modules/.bin/electron --require ts-node/register --require tsconfig-paths/register ./node_modules/.bin/tape tests/restockNotification.spec.ts` → 8/8 pass → AC-1, AC-5
- [ ] Same command for `tests/ntfyNotification.spec.ts` → test 1 currently fails on a pre-existing (HEAD) stub-restoration race; confirm it is NOT a web-path regression (the fire-and-forget `sendPOSNotification` must settle before the assertion) → AC-5
- [ ] Same command for `tests/paymentMethodNotification.spec.ts` → currently fails asserting a `Receiving Account:` line the trigger has always emitted as `Paid Via:`; pre-existing at HEAD, route to /debug → AC-5
- [ ] `npm run build:web && npm --prefix worker run typecheck` → both clean (new `src/web/boot.ts`, `src/pages/web/Settings.vue` add no errors; the web entry bundle must not statically import the Desktop-fyo chunk) → AC-1

## Acceptance-criteria coverage
- AC-1: command re-runs of the three specs (no delivery code touched) + in-app test button + fail-soft edge → covered
- AC-2: Settings page manual steps, cross-tenant persistence check → covered
- AC-3: `check:ntfy` origin+arrival evidence, in-app test button, real invoice submit → covered
- AC-4: masked topic field, topic validation, random per-run topics in the check script → covered
- AC-5: all three specs re-run unmodified (two known pre-existing failures documented, not fixed by touching delivery) → covered
