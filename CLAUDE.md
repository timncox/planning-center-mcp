---
status: active
last_touched: 2026-05-22
deploy: git push origin neon-swap   # Render auto-deploys; for env-var changes use Render dashboard or API
---

# planning-center-mcp

Hosted multi-tenant MCP that lets anyone with a Planning Center account OAuth in and get a per-user connector URL for claude.ai.

**Distinct from the local stdio MCP** at `~/mcpfactory/servers/planning-center/` — that one uses Tim's Personal Access Token and acts as Tim. This one OAuths each user into their own PCO org.

Live at **https://pco-mcp-j34h.onrender.com**.

## Architecture in one diagram

```
User                Claude.ai             pco-mcp-j34h          PCO API
  │                     │                       │                  │
  ├─ visit /connect ────▶                       │                  │
  │                     ├─ redirect to PCO OAuth ─────────────────▶│
  │◀───────────────── PCO consent screen ──────────────────────────│
  ├─ approve ───────────────────────────────────▶                  │
  │                     │              /api/auth/pco/callback      │
  │                     │                       ├─ exchange code ─▶│
  │                     │                       │◀─ access+refresh │
  │                     │                       ├─ encrypt + store in Neon
  │                     │                       ├─ mint pco_xxxxx token
  │◀───────────────── show /mcp/pco_xxxxx URL ──┤                  │
  ├─ paste into Claude connectors ──▶│          │                  │
  │                     ├─ MCP requests to /mcp/pco_xxxxx ────────▶│
  │                     │                       ├─ look up token, decrypt PCO tokens, refresh if expired
  │                     │                       ├─ build per-request McpServer with PCO-scoped tools
  │                     │                       ├─ tool calls ─────▶ PCO API
```

Two transports in one codebase:
- `src/index.ts` — stdio entry (local install with `PCO_APP_ID` + `PCO_SECRET` PAT). **Untouched by the fork.**
- `src/remote.ts` — vanilla Node `http.createServer` for the hosted variant. PCO OAuth + path-token MCP. This is what runs on Render.

## Stack
- Node 22 + TypeScript (`tsc` to `dist/`)
- pnpm 11
- `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`
- `@neondatabase/serverless` + `drizzle-orm` (was Supabase upstream; see "Fork relationship" below)
- `axios` for PCO API calls
- AES-256-GCM for token encryption at rest
- HMAC-SHA256 for OAuth state signing
- SHA-256 for path-token hashing (not bcrypt — high-entropy tokens make this fine)

## Hosted environment
- **Render service**: `srv-d88dj8e7r5hc73fi6ks0` (region oregon, plan free, branch `neon-swap`, autodeploy on)
- **Neon project**: `pco-mcp` under org `Tim` (`org-small-unit-61968516`), Postgres 17
- **PCO OAuth app**: "Planning Center MCP" owned by Trinity Grace Church PCO org. Confidential app type (has client_secret). Development mode — ~50 user authorization cap until submitted for review.
- **Required env vars** (all live in Render's env config, none committed):
  `NODE_VERSION` (22), `PUBLIC_BASE_URL`, `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `OAUTH_STATE_SECRET`, `PCO_CLIENT_ID`, `PCO_CLIENT_SECRET`, `PCO_REDIRECT_URI`, `PCO_SCOPES`

## Database (4 tables, drizzle)
- `pco_connections` — one row per OAuth'd user (encrypted access + refresh tokens, expires_at, PCO person id/name)
- `connector_tokens` — SHA-256 hashes of the `pco_*` path-tokens; cascade-deletes on connection removal
- `mcp_audit_logs` — every tool invocation (tool_name, success, execution_ms)
- `service_feedback` — Services post-mortem memory (wins/issues/do_again/avoid; gin index on tags)

Schema canonical source: `src/db/schema.ts`. Migrations in `drizzle/`. Apply with `pnpm db:push` against the target `DATABASE_URL`.

## Fork relationship

Forked from **paulyerrick/planning-center-mcp** (MIT). Upstream remote tracked at `upstream/main`.

**Our delta vs upstream** lives in three places:
- `src/db/{schema,index}.ts` — new (drizzle + Neon HTTP client)
- `src/feedback.ts` — `SupabaseFeedbackStore` → `NeonFeedbackStore`, same `FeedbackStore` interface
- `src/remote.ts` — 4 Supabase call sites swapped for drizzle queries; same control flow
- `package.json` — drop `@supabase/supabase-js`, add `@neondatabase/serverless` + `drizzle-orm` + `drizzle-kit`; bump `NODE_VERSION` (Node 22)
- `REMOTE_DEPLOY.md` — rewritten for Neon
- `supabase/schema.sql` — deleted (replaced by `drizzle/0000_remarkable_hex.sql`)

**Upstream rebase command**: `git fetch upstream && git rebase upstream/main`. The five files above are the only conflict-prone ones; everything else (the bulk of the codebase: PCO client, all the tool implementations) merges cleanly.

## Why Render not Vercel

Break from the tim-os norm (sheaf, ctca-crm, weft, sfmagic, rsclark all run hosted MCP on Vercel + Neon). Paul's `src/remote.ts` is a 365-line vanilla `http.createServer` with manual routing. Porting it to Next.js App Router would have been ~3-4 hours of code-shuffling that didn't pay off for the immediate use case. Render serves long-running Node HTTP servers directly with `node dist/remote.js` — no port required.

If this ever scales beyond the friends-and-colleagues phase or needs to integrate deeper with other tim-os projects, the Vercel port becomes worth doing.

## What's read-ready vs write-ready

**Reads**: all 7 PCO products covered (People, Services, Giving, Groups, Check-Ins, Calendar, Publishing, Registrations) via paul's dedicated tools + `pco_request` escape hatch.

**Writes**: only Services has a built-out write surface with the preview→apply→audit→rollback pattern. Other products' writes are only available via the raw `pco_request` escape hatch. See `TODO.md` Milestone 4 for the deferred plan to expand writes across People / Services / Groups / Calendar (21 tools, 42 functions).

**Decision (2026-05-22)**: every new write tool MUST follow paul's preview / apply / audit / rollback pattern. No raw write tools that skip preview.

## How to deploy + redeploy

Code changes: push to `origin/neon-swap` — Render auto-deploys.

Env var changes only: use the Render dashboard at https://dashboard.render.com/web/srv-d88dj8e7r5hc73fi6ks0 OR Render's REST API at `https://api.render.com/v1/services/$SERVICE_ID/env-vars/$KEY` (PUT with `{value}`, bearer auth). After env update, trigger a redeploy via `POST /v1/services/$SERVICE_ID/deploys`.

The parked Render MCP at `~/.claude/mcp-servers-parked.json` (revive with `/mcp-revive render`) gives Claude direct tool access to Render service management.

## Related
- [[project-planning-center-mcp]] (memory entry mirrors this file's resource IDs)
- `REMOTE_DEPLOY.md` — exact deploy steps for a new fork
- `INSTALL.md` — local stdio install (paul's original — applies to `src/index.ts` path)
- `TODO.md` — open work, Milestone 4 = write tools expansion roadmap
