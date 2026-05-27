#!/usr/bin/env node
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { and, eq, isNull } from 'drizzle-orm';
import axios from 'axios';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import dotenv from 'dotenv';
import { PlanningCenterClient } from './client.js';
import { getDb } from './db/index.js';
import { connectorTokens, pcoConnections } from './db/schema.js';
import { NeonFeedbackStore } from './feedback.js';
import { createPlanningCenterMcpServer } from './mcp.js';

dotenv.config();

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const PCO_AUTHORIZE_URL = 'https://api.planningcenteronline.com/oauth/authorize';
const PCO_TOKEN_URL = 'https://api.planningcenteronline.com/oauth/token';
const DEFAULT_PCO_SCOPES = 'people services groups check_ins registrations giving calendar';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.resolve(__dirname, '../public/logo.png');

type PcoConnectionRow = {
  id: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  expires_at: string | null;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function encryptionKey() {
  return crypto.createHash('sha256').update(requiredEnv('TOKEN_ENCRYPTION_KEY')).digest();
}

function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decrypt(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split('.');
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid encrypted token format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateConnectorToken() {
  return `pco_${crypto.randomBytes(32).toString('base64url')}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function signState(payload: string) {
  return crypto.createHmac('sha256', requiredEnv('OAUTH_STATE_SECRET')).update(payload).digest('base64url');
}

function createState() {
  const payload = JSON.stringify({ nonce: crypto.randomBytes(16).toString('base64url'), ts: Date.now() });
  const encoded = Buffer.from(payload).toString('base64url');
  return `${encoded}.${signState(encoded)}`;
}

function verifyState(state: string | null) {
  if (!state) return false;
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return false;
  const expected = signState(encoded);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { ts: number };
    return typeof parsed.ts === 'number' && Date.now() - parsed.ts < 15 * 60_000;
  } catch {
    return false;
  }
}

const HSTS_HEADER = 'max-age=31536000; includeSubDomains';
const HTML_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Last-Event-ID',
    'Strict-Transport-Security': HSTS_HEADER,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Strict-Transport-Security': HSTS_HEADER,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': HTML_CSP,
  });
  res.end(html);
}

function sendLogo(res: ServerResponse) {
  if (!fs.existsSync(LOGO_PATH)) {
    sendJson(res, 404, { error: 'Logo not found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(LOGO_PATH).pipe(res);
}

function pageHead(title: string) {
  return `<head>
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/png" href="/logo.png" />
    <meta property="og:title" content="${title}" />
    <meta property="og:image" content="${PUBLIC_BASE_URL}/logo.png" />
  </head>`;
}

async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const response = await axios.post<TokenResponse>(PCO_TOKEN_URL, new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: requiredEnv('PCO_REDIRECT_URI'),
    client_id: requiredEnv('PCO_CLIENT_ID'),
    client_secret: requiredEnv('PCO_CLIENT_SECRET'),
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return response.data;
}

// In-process coalescing: if a refresh for this connection is already in flight,
// concurrent callers await the same Promise instead of racing PCO + the DB,
// which would invalidate the earlier refresh_token and break the loser's session.
// Single Render instance today; if scaled horizontally, replace with a DB lock.
const refreshInFlight = new Map<string, Promise<string>>();

async function refreshAccessToken(connection: PcoConnectionRow): Promise<string> {
  if (connection.expires_at && new Date(connection.expires_at).getTime() > Date.now() + 60_000) {
    return decrypt(connection.encrypted_access_token);
  }
  if (!connection.encrypted_refresh_token) return decrypt(connection.encrypted_access_token);

  const existing = refreshInFlight.get(connection.id);
  if (existing) return existing;

  const refreshPromise = doRefresh(connection).finally(() => {
    refreshInFlight.delete(connection.id);
  });
  refreshInFlight.set(connection.id, refreshPromise);
  return refreshPromise;
}

async function doRefresh(connection: PcoConnectionRow): Promise<string> {
  const refreshToken = decrypt(connection.encrypted_refresh_token!);
  const response = await axios.post<TokenResponse>(PCO_TOKEN_URL, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: requiredEnv('PCO_CLIENT_ID'),
    client_secret: requiredEnv('PCO_CLIENT_SECRET'),
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const token = response.data;
  const expiresAt = token.expires_in
    ? new Date(Date.now() + token.expires_in * 1000)
    : null;

  await getDb()
    .update(pcoConnections)
    .set({
      encryptedAccessToken: encrypt(token.access_token),
      encryptedRefreshToken: token.refresh_token
        ? encrypt(token.refresh_token)
        : connection.encrypted_refresh_token,
      expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(pcoConnections.id, connection.id));

  return token.access_token;
}

async function connectionForConnectorToken(rawToken: string): Promise<PcoConnectionRow | null> {
  const rows = await getDb()
    .select({
      id: pcoConnections.id,
      encrypted_access_token: pcoConnections.encryptedAccessToken,
      encrypted_refresh_token: pcoConnections.encryptedRefreshToken,
      expires_at: pcoConnections.expiresAt,
    })
    .from(connectorTokens)
    .innerJoin(pcoConnections, eq(connectorTokens.pcoConnectionId, pcoConnections.id))
    .where(and(eq(connectorTokens.tokenHash, hashToken(rawToken)), isNull(connectorTokens.revokedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    encrypted_access_token: row.encrypted_access_token,
    encrypted_refresh_token: row.encrypted_refresh_token,
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

async function handleOAuthStart(_req: IncomingMessage, res: ServerResponse) {
  const state = createState();
  const url = new URL(PCO_AUTHORIZE_URL);
  url.searchParams.set('client_id', requiredEnv('PCO_CLIENT_ID'));
  url.searchParams.set('redirect_uri', requiredEnv('PCO_REDIRECT_URI'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', process.env.PCO_SCOPES ?? DEFAULT_PCO_SCOPES);
  url.searchParams.set('state', state);
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

async function handleOAuthCallback(url: URL, res: ServerResponse) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !verifyState(state)) {
    sendHtml(res, 400, '<h1>Planning Center connection failed</h1><p>Missing code or invalid state.</p>');
    return;
  }

  const token = await exchangeCodeForToken(code);
  const pcoClient = PlanningCenterClient.withAccessToken(token.access_token);
  const me = await pcoClient.get<any>('/people/v2/me');
  const person = pcoClient.flatten(me.data);
  const connectorToken = generateConnectorToken();
  const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;
  const db = getDb();

  const personName = typeof person.name === 'string' ? person.name : null;
  const [connection] = await db
    .insert(pcoConnections)
    .values({
      pcoPersonId: person.id,
      pcoPersonName: personName,
      encryptedAccessToken: encrypt(token.access_token),
      encryptedRefreshToken: token.refresh_token ? encrypt(token.refresh_token) : null,
      expiresAt,
    })
    .returning({ id: pcoConnections.id });

  await db.insert(connectorTokens).values({
    pcoConnectionId: connection.id,
    tokenHash: hashToken(connectorToken),
    name: `Claude connector for ${personName ?? person.id}`,
  });

  const mcpUrl = `${PUBLIC_BASE_URL}/mcp/${connectorToken}`;
  const revokeUrl = `${PUBLIC_BASE_URL}/revoke/${connectorToken}`;
  const displayName = escapeHtml(String(person.name ?? person.id ?? ''));
  sendHtml(res, 200, `<!doctype html>
<html>${pageHead('Planning Center Connected')}
<body style="font-family: system-ui; max-width: 760px; margin: 40px auto; line-height: 1.5;">
  <img src="/logo.png" alt="Planning Center" width="72" height="72" style="border-radius:16px;" />
  <h1>Planning Center connected</h1>
  <p>Connected as <strong>${displayName}</strong>.</p>
  <p>Copy this Remote MCP server URL into Claude &rarr; Settings &rarr; Connectors &rarr; Add custom connector:</p>
  <pre style="background:#f5f5f5;padding:16px;white-space:pre-wrap;word-break:break-all;">${escapeHtml(mcpUrl)}</pre>
  <p><strong>Security:</strong> treat this URL like a password. Anyone with it can use this connector until revoked.</p>
  <p>Lost control of this URL? <a href="${escapeHtml(revokeUrl)}">Revoke it here</a>.</p>
  <h2>Try these prompts in Claude</h2>
  <ol>
    <li>Check my Planning Center connection status.</li>
    <li>What can this Planning Center connector do?</li>
    <li>List our active weekend service types.</li>
    <li>What might break this Sunday?</li>
    <li>Create a dashboard snapshot for this month and render it visually.</li>
    <li>Pull a service review packet for our most recent weekend service.</li>
  </ol>
</body></html>`);
}

async function revokeConnectorToken(rawToken: string): Promise<boolean> {
  const result = await getDb()
    .update(connectorTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(connectorTokens.tokenHash, hashToken(rawToken)), isNull(connectorTokens.revokedAt)))
    .returning({ id: connectorTokens.id });
  return result.length > 0;
}

async function handleRevokeGet(res: ServerResponse, connectorToken: string) {
  // The token in the URL is itself the credential — anyone who knows it is authorized
  // to revoke it. We show a confirm page so prefetchers and casual link-clicks don't
  // accidentally revoke. The POST goes to the same /revoke/<token> path.
  const formAction = `/revoke/${escapeHtml(connectorToken)}`;
  sendHtml(res, 200, `<!doctype html>
<html>${pageHead('Revoke Planning Center connector')}
<body style="font-family: system-ui; max-width: 640px; margin: 40px auto; line-height: 1.5;">
  <img src="/logo.png" alt="Planning Center" width="72" height="72" style="border-radius:16px;" />
  <h1>Revoke this connector?</h1>
  <p>Confirming will permanently disable this MCP connector URL. Claude will lose access to your Planning Center data through this connector immediately.</p>
  <p>You can always reconnect at <a href="/connect/planning-center">/connect/planning-center</a> to get a fresh URL.</p>
  <form method="post" action="${formAction}">
    <button type="submit" style="background:#b00020;color:white;border:none;padding:12px 20px;border-radius:6px;font-size:16px;cursor:pointer;">Revoke connector</button>
  </form>
</body></html>`);
}

async function handleRevokePost(res: ServerResponse, connectorToken: string) {
  const revoked = await revokeConnectorToken(connectorToken);
  const status = revoked ? 200 : 404;
  const heading = revoked ? 'Connector revoked' : 'Already revoked or unknown';
  const body = revoked
    ? '<p>This connector URL no longer grants access to Planning Center. You can <a href="/connect/planning-center">reconnect</a> to get a new one.</p>'
    : '<p>No active connector matched this URL. It may already be revoked.</p>';
  sendHtml(res, status, `<!doctype html>
<html>${pageHead(heading)}
<body style="font-family: system-ui; max-width: 640px; margin: 40px auto; line-height: 1.5;">
  <img src="/logo.png" alt="Planning Center" width="72" height="72" style="border-radius:16px;" />
  <h1>${heading}</h1>
  ${body}
</body></html>`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, connectorToken: string) {
  const connection = await connectionForConnectorToken(connectorToken);
  if (!connection) {
    sendJson(res, 401, { error: 'Invalid or revoked connector token' });
    return;
  }

  const accessToken = await refreshAccessToken(connection);
  const pcoClient = PlanningCenterClient.withAccessToken(accessToken);
  const mcpServer = createPlanningCenterMcpServer(pcoClient, {
    connectionId: connection.id,
    feedbackStore: new NeonFeedbackStore(getDb()),
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('finish', () => {
    void mcpServer.close().catch((err) => console.error('Error closing MCP server:', err));
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
}

async function route(req: IncomingMessage, res: ServerResponse) {
  try {
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, null);
      return;
    }

    const url = new URL(req.url ?? '/', PUBLIC_BASE_URL);

    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true, name: 'planning-center-mcp-remote' });
      return;
    }

    if (url.pathname === '/logo.png' || url.pathname === '/favicon.png') {
      sendLogo(res);
      return;
    }

    if (url.pathname === '/' || url.pathname === '/setup') {
      sendHtml(res, 200, `<!doctype html><html>${pageHead('Planning Center MCP')}
      <body style="font-family: system-ui; max-width: 760px; margin: 40px auto; line-height: 1.5;">
        <img src="/logo.png" alt="Planning Center" width="72" height="72" style="border-radius:16px;" />
        <h1>Planning Center MCP</h1>
        <p>Connect Planning Center to Claude with a remote MCP connector.</p>
        <p><a href="/connect/planning-center">Connect Planning Center</a></p>
        <h2>What this connector can do</h2>
        <ul>
          <li>Weekend readiness and volunteer gap checks</li>
          <li>First-time guest follow-up</li>
          <li>Visual dashboard snapshots for Claude artifacts</li>
          <li>Post-service review packets and remembered feedback</li>
          <li>Planning Center cleanup and module diagnostics</li>
        </ul>
      </body></html>`);
      return;
    }

    if (url.pathname === '/connect/planning-center') {
      await handleOAuthStart(req, res);
      return;
    }

    if (url.pathname === '/oauth/planning-center/callback') {
      await handleOAuthCallback(url, res);
      return;
    }

    const mcpMatch = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (mcpMatch && ['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
      await handleMcp(req, res, mcpMatch[1]);
      return;
    }

    const revokeMatch = url.pathname.match(/^\/revoke\/([^/]+)$/);
    if (revokeMatch) {
      if (req.method === 'GET') {
        await handleRevokeGet(res, revokeMatch[1]);
        return;
      }
      if (req.method === 'POST') {
        await handleRevokePost(res, revokeMatch[1]);
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Remote MCP error:', err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal server error' });
  }
}

http.createServer((req, res) => void route(req, res)).listen(PORT, () => {
  console.error(`Planning Center remote MCP listening on ${PUBLIC_BASE_URL}`);
});
