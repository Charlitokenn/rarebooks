# Tool discovery: Cloudflare Queues, Workers/Wrangler, Neon SDK

Date: 2026-10-26
Scope: read-only discovery. Nothing installed.

## Installed state
- Project skills (`npx skills list`): none found. No `.claude/skills` or `.agents/skills` directory.
- Global skills (`npx skills list -g`): architect, audit, check, context7-mcp, debug, develop, document, find-skills, scope, sync, test. None of the candidates below are installed.

## Candidates (from `npx skills find`; registry listing only, contents not inspected)

Cloudflare Queues
- jezweb/claude-skills@cloudflare-queues (339 installs)
  Install: `npx skills add jezweb/claude-skills@cloudflare-queues`
- secondsky/claude-skills@cloudflare-queues (231 installs)
  Install: `npx skills add secondsky/claude-skills@cloudflare-queues`

Cloudflare Workers / Wrangler (deployment config)
- cloudflare/skills@wrangler (129.4K installs). Official Cloudflare. Recommended.
  Install: `npx skills add cloudflare/skills@wrangler`
- cloudflare/skills@workers-best-practices (125.9K installs). Official Cloudflare.
  Install: `npx skills add cloudflare/skills@workers-best-practices`
- cloudflare/cloudflare-docs@wrangler (104 installs). Official Cloudflare docs repo.
  Install: `npx skills add cloudflare/cloudflare-docs@wrangler`

Neon (Postgres / @neon/sdk)
- neondatabase/agent-skills@neon (233K installs). Official Neon.
  Install: `npx skills add neondatabase/agent-skills@neon`
- neondatabase/agent-skills@neon-postgres (280.1K installs). Official Neon.
  Install: `npx skills add neondatabase/agent-skills@neon-postgres`
- neondatabase/neon-js@neon-js-react (32 installs). Official Neon JS SDK, React-focused.
  Install: `npx skills add neondatabase/neon-js@neon-js-react`

## Confirmation status
- Nothing installed. Every candidate is listed in the skills registry only. None has been reviewed or confirmed for this repo.

## MCP
- Cloudflare Developer Platform and Neon connectors already exist in this session. Not offered.
- No other MCP servers were searched or evaluated in this pass.
