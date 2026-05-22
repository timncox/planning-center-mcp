# Remote MCP Deployment

This guide gets a hosted Claude Custom Connector running. Adapted from paulyerrick's original — swapped to Neon Postgres (was Supabase) while keeping the rest of the architecture intact.

Claude connector URL format:

```text
https://YOUR-HOST/mcp/YOUR_CONNECTOR_TOKEN
```

## 1. Neon Setup

1. Open [Neon](https://console.neon.tech/) and create a new project (free tier is fine).
2. Copy the connection string (it looks like `postgresql://user:pass@ep-foo.region.neon.tech/neondb?sslmode=require`) — this becomes `DATABASE_URL`.
3. From a local checkout of this repo with `DATABASE_URL` set in `.env`, run the migration:

```bash
pnpm install
pnpm db:push   # or: pnpm db:migrate
```

This creates `pco_connections`, `connector_tokens`, `mcp_audit_logs`, and `service_feedback`.

Alternative: paste `drizzle/0000_remarkable_hex.sql` into the Neon SQL Editor.

## 2. Planning Center OAuth App

1. Open <https://api.planningcenteronline.com/oauth/applications>.
2. Click **Register your application here**.
3. **Application type: Confidential** (the form's default; do NOT pick Public — that disables `client_secret`).
4. Application name: something users will recognize (e.g. `Planning Center MCP`).
5. Authorization callback URLs:

```text
https://YOUR-HOST/oauth/planning-center/callback
http://localhost:3000/oauth/planning-center/callback
```

6. Save, then copy:
   - Client ID → `PCO_CLIENT_ID`
   - Client Secret → `PCO_CLIENT_SECRET`

Note: only Org Admins can register a developer app. New apps start in Development mode (~50 user cap); submit for review when you outgrow it.

## 3. Render Setup

1. Go to Render.
2. Click **New → Web Service**.
3. Connect your fork of this GitHub repo.
4. Use these settings:

```text
Name: pco-mcp
Environment: Node
Region: closest to you
Branch: main
Build Command: npx -y pnpm@11.0.9 install --frozen-lockfile && npx -y pnpm@11.0.9 run build
Start Command: node dist/remote.js
```

5. Add environment variables:

```env
NODE_VERSION=22
PUBLIC_BASE_URL=https://YOUR-HOST
DATABASE_URL=your_neon_connection_string
TOKEN_ENCRYPTION_KEY=generate_a_long_random_secret
OAUTH_STATE_SECRET=generate_a_long_random_secret
PCO_CLIENT_ID=your_planning_center_oauth_client_id
PCO_CLIENT_SECRET=your_planning_center_oauth_client_secret
PCO_REDIRECT_URI=https://YOUR-HOST/oauth/planning-center/callback
PCO_SCOPES=people services groups check_ins registrations giving calendar
```

Generate secrets locally with:

```bash
openssl rand -base64 48
```

Use a different value for `TOKEN_ENCRYPTION_KEY` and `OAUTH_STATE_SECRET`.

6. Deploy.
7. Render will give you a URL like `https://pco-mcp.onrender.com`. Hit `/health`:

```json
{"ok":true,"name":"planning-center-mcp-remote"}
```

## 4. Custom Domain (optional)

If you want a vanity host (e.g. `pco.example.com`) instead of `*.onrender.com`:

1. In your DNS provider, add a CNAME for the chosen subdomain pointing at your Render hostname (no `https://`).
2. In Render → Service → **Settings → Custom Domains**, add the subdomain.
3. Wait for DNS/SSL verification, then update `PUBLIC_BASE_URL` and `PCO_REDIRECT_URI` env vars (and the PCO OAuth app's callback URL) accordingly.

## 5. First Hosted Connection Test

Open:

```text
https://YOUR-HOST/connect/planning-center
```

You'll be redirected to Planning Center. After approving, you'll see a page with a Remote MCP server URL like:

```text
https://YOUR-HOST/mcp/pco_xxxxx
```

Copy that URL.

## 6. Add to Claude Custom Connector

In Claude:

1. Open **Settings → Connectors → Add custom connector**.
2. Name: `Planning Center`.
3. Remote MCP server URL: paste the `/mcp/pco_xxxxx` URL.
4. Save.

## 7. Test in Claude

Try prompts like:

- Check my Planning Center connection status.
- List our Planning Center service types.
- What might break this Sunday?

## Alpha Security Notes

- The MCP URL contains a secret connector token. Treat it like a password.
- Revoke a connector by setting `revoked_at = now()` for its row in `connector_tokens`.
- Access and refresh tokens are AES-256-GCM encrypted at rest (`TOKEN_ENCRYPTION_KEY`).
- Raw connector tokens are not stored; only SHA-256 hashes are.
- This is a private alpha flow, not a full multi-tenant SaaS account system yet.
