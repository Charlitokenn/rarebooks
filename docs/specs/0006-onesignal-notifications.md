# 0006. OneSignal notifications

**Date**: 2026-09-03
**Status**: Proposed

## Summary

This decision ports the existing restock and payment method notification triggers from ntfy (Desktop) to OneSignal (Web). The triggering logic already exists and stays the same; only the delivery mechanism changes.

## Context

Desktop fires notifications through ntfy when inventory drops low or a payment method event happens, already covered by `restockNotification.spec.ts` and `paymentMethodNotification.spec.ts`. Web needs an equivalent delivery path that works for a browser based, multi tenant product. An earlier draft of this plan used `include_external_user_ids` as OneSignal's targeting parameter; that is not the current parameter. The confirmed current API uses `include_aliases` with a `target_channel`.

## Requirements

**User stories**:
- As a tenant user, I want to receive a notification when inventory is restocked or a payment method event happens, the same way Desktop already notifies me, so that I don't have to poll for these events.

**Acceptance criteria**:
- **AC-1**: The existing restock and payment method trigger logic is reused unchanged; only the delivery mechanism is swapped to OneSignal.
- **AC-2**: Organization notifications fan out server-side to the organization's current Clerk member user IDs, then send those user IDs through OneSignal's `include_aliases.external_id` with `target_channel: "push"`. Organization IDs are never used directly as user-level external IDs.
- **AC-3**: `include_aliases` is never combined with `filters`, `include_subscription_ids`, `included_segments`, or `excluded_segments` in the same request.
- **AC-4**: The `Authorization` header uses the literal `Key <api_key>` form, not `Bearer <api_key>`.
- **AC-5**: OneSignal notification specs live under `custom/web/notifications/tests/`, while implementation files remain directly under `custom/web/notifications/`, so the existing `**/tests/*.spec.ts` command discovers them without importing tests at runtime.

## Decision

**Chosen option**: OneSignal REST API, with server-side organization-member fan-out to Clerk user IDs used as `include_aliases.external_id`, reusing the existing Desktop trigger logic unchanged.

## Rationale

Reusing the existing trigger logic keeps the two targets' notification behavior identical from the user's point of view; only the transport differs, which is the smallest change that satisfies the requirement. `include_aliases` targets user-level external IDs, so an organization event first resolves the organization's current Clerk memberships server-side and fans out to those user IDs; treating an organization ID as though it were a registered user's external ID would silently miss recipients.

## Feature design

**Data model sketch**: No new tables. OneSignal registrations use Clerk user IDs as external IDs. For an organization event, the server loads current Clerk memberships and sends to the resulting member user IDs; no organization ID is registered or sent as a user-level external ID, and no OneSignal-specific identifier is stored.

**API surface**:
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `https://api.onesignal.com/notifications` | POST | `app_id`, `target_channel`, `include_aliases.external_id`, `contents` | notification ID | `Key ONESIGNAL_API_KEY` header | 400 invalid targeting combination |

**Value sourcing**:
| Action | Value produced / displayed | Source |
|---|---|---|
| Restock notification | The notification content and targets | Existing restock trigger logic (reused unchanged); the relevant org is resolved to current Clerk member user IDs server-side before calling OneSignal |
| Delivery deduplication | Idempotency | A client generated UUID per logically distinct send, used only if resending the same notification is a real risk from a retry (OneSignal deduplicates on it within a 30 day window) |

**Key invariants**:
- `include_aliases` is never combined with `filters`, `include_subscription_ids`, `included_segments`, or `excluded_segments` in one request.
- The `Authorization` header is always `Key <api_key>`, never `Bearer <api_key>`.
- `include_aliases.external_id` contains registered Clerk user IDs only; organization IDs are resolved to member user IDs and never sent directly.
- Up to 20,000 external IDs per call under `include_aliases.external_id`; this feature's per event sends are far below that limit.

**Security model**: `ONESIGNAL_API_KEY` is a Worker secret, never exposed to the client. Targeting uses server-resolved Clerk member user IDs from the triggering event's verified organization, never a client-supplied identifier or an organization ID masquerading as a user external ID.

**Configuration required**:
- `ONESIGNAL_APP_ID`, `ONESIGNAL_API_KEY`: Worker secrets for the OneSignal REST API

**Critical test scenarios**:
- Happy path: a restock event fires, and the affected org's users receive a OneSignal push with the same content Desktop's ntfy notification would have shown. Verifies **AC-1, AC-2**.
- Membership targeting: an organization notification resolves its current Clerk members, includes each member user ID, and never places the organization ID in `include_aliases.external_id`. Verifies **AC-2**.
- Failure case: a notification call accidentally combines `include_aliases` with `included_segments`; the request is rejected before send, not silently misdelivered. Verifies **AC-3**.
- Auth: a call using `Bearer` instead of `Key` fails and is caught in testing before deploy. Verifies **AC-4**.

## Build plan

1. Build implementation files directly under `custom/web/notifications/`, reusing the existing restock and payment method trigger logic, resolving organization members server-side, and swapping the delivery call to OneSignal's REST API. Satisfies **AC-1, AC-2**.
2. Confirm the request shape follows `include_aliases` + `target_channel`, with the correct `Key` authorization header. Satisfies **AC-3, AC-4**.
3. Write the OneSignal equivalent specs under `custom/web/notifications/tests/`, mirroring the existing Desktop notification specs while leaving implementation files one level above. Satisfies **AC-5**.

## Consequences

**Positive**:
- Web users get the same notification coverage Desktop users already have, with no new trigger logic to design.

**Negative / tradeoffs**:
- None significant; this is a delivery mechanism swap on top of proven trigger logic.

**Neutral**:
- Depends on feature 07 (tenant data layer) being in place, since notification triggers need to know what tenant data changed.

## Follow-up

- [ ] None currently identified.
