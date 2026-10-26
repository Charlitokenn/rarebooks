# Provisioning lease: Queues, Workers limits, Svix, Neon facts

Research date: 2026-10-26. Sources were fetched live at that date; no archived copies.

## 1. Cloudflare Queues availability and pricing

- Available on Workers Free: yes. Free plan = 10,000 standard operations per day, 24-hour message retention (not configurable).
  - https://developers.cloudflare.com/queues/platform/pricing/
- Workers Paid: $5 USD/month minimum per account (the Queues allowance is part of that plan). Queues includes 1,000,000 operations/month, then $0.40 per additional million. Retention default 4 days, configurable up to 14 days.
  - https://developers.cloudflare.com/queues/platform/pricing/
  - https://developers.cloudflare.com/workers/platform/pricing/
- Freshness: the pricing page did not state the Free plan retention/operations in the same words as the limits page; both agree on 10,000/day and 24h.

## 2. Queue consumer limits

- Wall clock per consumer invocation: 15 minutes. https://developers.cloudflare.com/queues/platform/limits/
- CPU time per consumer invocation: default 30 seconds, configurable up to 5 minutes (300,000 ms) via `limits.cpu_ms`. The limits page says this applies to Free and Paid alike; it gives no separate Free value. https://developers.cloudflare.com/queues/platform/limits/
  - FLAG: the Free-plan CPU figure for consumers is unconfirmed. The general Workers Free limit is 10 ms per HTTP request (see section 3), which may not apply to queue consumers. Verify before relying on it.
- `max_retries`: default 3 (configure page). Maximum: 100 (limits page). https://developers.cloudflare.com/queues/configuration/configure-queues/ and https://developers.cloudflare.com/queues/platform/limits/
- Retry delay: `delaySeconds` for send or retry up to 24 hours (86,400 s). https://developers.cloudflare.com/queues/platform/limits/
- Dead letter queue: supported. Config key `dead_letter_queue` (queue name). Messages failing at least `max_retries` times are sent there; if unset, they are discarded; the named queue is auto-created if missing. https://developers.cloudflare.com/queues/configuration/configure-queues/
- `max_batch_size`: default 10 (configure page); maximum 100 (limits page).
- `max_batch_timeout`: default 5 seconds (configure page).
- `max_concurrency`: optional, no default given; unset means autoscale to the platform max (not stated numerically on the pages fetched).

## 3. Workers CPU and subrequest limits

- Free: CPU 10 ms per HTTP request; 50 subrequests per invocation; 1,000 subrequests to internal services. https://developers.cloudflare.com/workers/platform/limits/
- Paid: default CPU 30 seconds (30,000 ms); max via `limits.cpu_ms` = 5 minutes (300,000 ms), set as `cpu_ms = 300_000` under `[limits]` in wrangler.toml. Subrequests 10,000 per invocation, configurable up to 10M. https://developers.cloudflare.com/workers/platform/limits/
- Wall clock: queue consumers 15 min; cron 15 min; DO alarms 15 min; incoming HTTP no hard limit while the client stays connected (waitUntil up to 30 s after response/disconnect). https://developers.cloudflare.com/workers/platform/limits/

## 4. Svix (Clerk webhooks)

- Response timeout: 30 seconds. https://docs.svix.com/retries (fetched directly)
  - FLAG: a search summary said 15 seconds, citing the same page. The direct fetch is the primary value; re-check the page before relying on either number.
- Retry schedule after a failed delivery (each delay measured from the previous failed attempt): immediate (first attempt), then 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h. Total 8 attempts. https://docs.svix.com/retries
- Success: any 2xx (200–299). Everything else, including 3xx redirects, is failure. https://docs.svix.com/retries
- Early stop: a response containing header `webhook-delivery: abort-message` stops retries. https://docs.svix.com/retries
- Endpoint disable: if all attempts fail for 5 days (clock starts only after multiple failures within 24 h, at least 12 h apart), the endpoint is disabled and an `EndpointDisabledEvent` operational webhook fires. Can be turned off in Environment settings. https://docs.svix.com/retries

## 5. Neon API

- `GET /projects` supports `search` (string): filters by project name or ID, partial match allowed. Also: `cursor`, `limit` (1–400, default 10), `org_id` (required with a personal API key), `timeout`, `recoverable` (beta). https://api-docs.neon.tech/reference/listprojects
- `GET /projects/{project_id}/connection_uri`:
  - Path: `project_id` (required, matches `^[a-z0-9-]{1,60}$`).
  - Query required: `database_name`, `role_name`.
  - Query optional: `branch_id` (defaults to the project's default branch), `endpoint_id` (defaults to the read-write endpoint of the branch), `pooled` (boolean; adds `-pooler` suffix).
  - https://api-docs.neon.tech/reference/getconnectionuri

## Freshness notes

- All facts reflect the pages as fetched on 2026-10-26. Could not confirm any change history; pages may have been updated since.
- Unconfirmed: Queues `max_concurrency` numeric default; Queues CPU limit specifically for Free-plan consumers; Svix 15 s vs 30 s discrepancy.
- Not checked: Clerk's own webhook docs (Clerk may set its own timeout or retry rules on top of Svix).
