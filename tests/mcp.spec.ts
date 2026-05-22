import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(repoRoot, 'dist', 'index.js');

type JsonRpcMessage = { id?: number | string; method?: string; result?: unknown; error?: unknown; params?: unknown };

class McpProcess {
  readonly proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private messages: JsonRpcMessage[] = [];
  private waiters: Array<(message: JsonRpcMessage) => void> = [];

  constructor(env: NodeJS.ProcessEnv) {
    this.proc = spawn(process.execPath, [serverPath], {
      cwd: os.tmpdir(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  send(message: JsonRpcMessage) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  async request(method: string, params: unknown = {}, id = Date.now()): Promise<JsonRpcMessage> {
    this.send({ id, method, params });
    return this.next((message) => message.id === id);
  }

  async notify(method: string, params: unknown = {}) {
    this.send({ method, params });
  }

  async next(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
    const existingIndex = this.messages.findIndex(predicate);
    if (existingIndex >= 0) {
      const [message] = this.messages.splice(existingIndex, 1);
      return message;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for MCP message')), 10_000);
      const waiter = (message: JsonRpcMessage) => {
        if (!predicate(message)) {
          this.messages.push(message);
          return;
        }
        clearTimeout(timeout);
        resolve(message);
      };
      this.waiters.push(waiter);
    });
  }

  async initialize() {
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'planning-center-mcp-tests', version: '1.0.0' },
    }, 1);
    expect(init.error).toBeFalsy();
    const serverInfo = (init.result as { serverInfo?: { icons?: Array<{ src: string; mimeType?: string }> } }).serverInfo;
    expect(serverInfo?.icons?.[0]).toMatchObject({
      src: expect.stringContaining('/logo.png'),
      mimeType: 'image/png',
    });
    await this.notify('notifications/initialized');
  }

  async close() {
    this.proc.stdin.end();
    this.proc.kill('SIGTERM');
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd < 0) return;

      const line = this.buffer.subarray(0, lineEnd).toString('utf8').replace(/\r$/, '');
      this.buffer = this.buffer.subarray(lineEnd + 1);
      if (!line.trim()) continue;

      const message = JSON.parse(line) as JsonRpcMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    }
  }
}

async function startMockPco(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server did not bind to TCP');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('missing credentials exits cleanly without stdout pollution', async () => {
  const proc = spawn(process.execPath, [serverPath], {
    cwd: os.tmpdir(),
    env: { ...process.env, PCO_APP_ID: '', PCO_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  proc.stdout.on('data', (chunk) => stdout.push(chunk));
  proc.stderr.on('data', (chunk) => stderr.push(chunk));

  const exitCode = await new Promise<number | null>((resolve) => proc.on('exit', resolve));
  expect(exitCode).toBe(1);
  expect(Buffer.concat(stdout).toString('utf8')).toBe('');
  expect(Buffer.concat(stderr).toString('utf8')).toContain('PCO_APP_ID and PCO_SECRET');
});

test('lists Planning Center MCP tools over stdio', async () => {
  const mcp = new McpProcess({ PCO_APP_ID: 'test-id', PCO_SECRET: 'test-secret' });
  try {
    await mcp.initialize();
    const response = await mcp.request('tools/list', {}, 2);
    expect(response.error).toBeFalsy();
    const tools = (response.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'pco_get_service_types',
      'pco_get_plan_teams',
      'pco_search_people',
      'pco_get_attendance_summary',
      'pco_weekend_readiness',
      'pco_guest_followup',
      'pco_ministry_health_summary',
      'pco_connection_status',
      'pco_dashboard_snapshot',
      'pco_service_review_packet',
      'pco_record_service_feedback',
      'pco_capabilities_guide',
    ]));
  } finally {
    await mcp.close();
  }
});

test('returns a capabilities guide for onboarding', async () => {
  const mcp = new McpProcess({ PCO_APP_ID: 'test-id', PCO_SECRET: 'test-secret' });
  try {
    await mcp.initialize();
    const response = await mcp.request('tools/call', {
      name: 'pco_capabilities_guide',
      arguments: {},
    }, 9);

    expect(response.error).toBeFalsy();
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const payload = JSON.parse(content[0].text) as { success: boolean; data: { bestFirstPrompts: string[]; capabilities: Array<{ category: string }> } };
    expect(payload.success).toBe(true);
    expect(payload.data.bestFirstPrompts[0]).toContain('connection status');
    expect(payload.data.capabilities.map((capability) => capability.category)).toEqual(expect.arrayContaining([
      'Weekend readiness',
      'Dashboards + visuals',
      'Post-service review + memory',
    ]));
  } finally {
    await mcp.close();
  }
});

test('calls a tool against a mocked Planning Center API', async () => {
  const mock = await startMockPco((req, res) => {
    if (req.url?.startsWith('/people/v2/people')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        data: [
          {
            id: 'person-1',
            type: 'Person',
            attributes: { name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace' },
            relationships: { emails: { data: [{ id: 'email-1', type: 'Email' }] }, phone_numbers: { data: [] } },
          },
        ],
        included: [
          { id: 'email-1', type: 'Email', attributes: { address: 'ada@example.test', primary: true } },
        ],
        meta: { total_count: 1 },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
  });

  try {
    await mcp.initialize();
    const response = await mcp.request('tools/call', {
      name: 'pco_search_people',
      arguments: { query: 'Ada', limit: 1 },
    }, 3);

    expect(response.error).toBeFalsy();
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const payload = JSON.parse(content[0].text) as { success: boolean; data: Array<{ name: string; email_addresses: Array<{ address: string }> }> };
    expect(payload.success).toBe(true);
    expect(payload.data[0].name).toBe('Ada Lovelace');
    expect(payload.data[0].email_addresses[0].address).toBe('ada@example.test');
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('runs guest follow-up against mocked Check-Ins data', async () => {
  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url?.startsWith('/check-ins/v2/events/event-1/check_ins') && req.url.includes('first_time')) {
      res.end(JSON.stringify({
        data: [
          {
            id: 'checkin-1',
            type: 'CheckIn',
            attributes: { checked_in_at: '2026-05-01T10:00:00Z', kind: 'first_time' },
            relationships: { person: { data: { id: 'person-1', type: 'Person' } } },
          },
          {
            id: 'checkin-2',
            type: 'CheckIn',
            attributes: { checked_in_at: '2026-05-02T10:00:00Z', kind: 'first_time' },
            relationships: { person: { data: { id: 'person-2', type: 'Person' } } },
          },
        ],
        included: [
          { id: 'person-1', type: 'Person', attributes: { name: 'Grace Hopper' } },
          { id: 'person-2', type: 'Person', attributes: { name: 'Alan Turing' } },
        ],
        meta: { total_count: 2 },
      }));
      return;
    }

    if (req.url?.startsWith('/check-ins/v2/events/event-1/check_ins') && req.url.includes('regular')) {
      res.end(JSON.stringify({
        data: [
          {
            id: 'checkin-3',
            type: 'CheckIn',
            attributes: { checked_in_at: '2026-05-09T10:00:00Z', kind: 'regular' },
            relationships: { person: { data: { id: 'person-2', type: 'Person' } } },
          },
        ],
        meta: { total_count: 1 },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
  });

  try {
    await mcp.initialize();
    const response = await mcp.request('tools/call', {
      name: 'pco_guest_followup',
      arguments: {
        eventId: 'event-1',
        startDate: '2026-05-01T00:00:00Z',
        endDate: '2026-05-08T00:00:00Z',
        followUpDays: 30,
      },
    }, 5);

    expect(response.error).toBeFalsy();
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const payload = JSON.parse(content[0].text) as {
      success: boolean;
      data: {
        totals: { firstTimeVisitors: number; returned: number; needsFollowUp: number; retentionRate: string };
        needsFollowUp: Array<{ name: string }>;
        returned: Array<{ name: string }>;
      };
    };

    expect(payload.success).toBe(true);
    expect(payload.data.totals).toEqual({
      firstTimeVisitors: 2,
      returned: 1,
      needsFollowUp: 1,
      retentionRate: '50%',
    });
    expect(payload.data.needsFollowUp[0].name).toBe('Grace Hopper');
    expect(payload.data.returned[0].name).toBe('Alan Turing');
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('checks Planning Center connection status against mocked module data', async () => {
  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/people/v2/me')) {
      res.end(JSON.stringify({ data: { id: 'me-1', type: 'Person', attributes: { name: 'Test Admin' } } }));
      return;
    }

    if (url.startsWith('/services/v2/service_types')) {
      res.end(JSON.stringify({ data: [], meta: { total_count: 2 } }));
      return;
    }

    if (url.startsWith('/people/v2/people')) {
      res.end(JSON.stringify({ data: [], meta: { total_count: 120 } }));
      return;
    }

    if (url.startsWith('/groups/v2/groups')) {
      res.end(JSON.stringify({ data: [], meta: { total_count: 12 } }));
      return;
    }

    if (url.startsWith('/registrations/v2/events')) {
      res.statusCode = 403;
      res.end(JSON.stringify({ errors: [{ detail: 'forbidden' }] }));
      return;
    }

    if (url.startsWith('/check-ins/v2/events')) {
      res.end(JSON.stringify({ data: [], meta: { total_count: 4 } }));
      return;
    }

    if (url.startsWith('/giving/v2/funds')) {
      res.end(JSON.stringify({ data: [], meta: { total_count: 3 } }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
  });

  try {
    await mcp.initialize();
    const response = await mcp.request('tools/call', {
      name: 'pco_connection_status',
      arguments: {},
    }, 7);

    expect(response.error).toBeFalsy();
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const payload = JSON.parse(content[0].text) as {
      success: boolean;
      data: { connected: boolean; modules: Array<{ module: string; ok: boolean; authenticatedAs?: string }>; recommendedActions: string[] };
    };

    expect(payload.success).toBe(true);
    expect(payload.data.connected).toBe(true);
    expect(payload.data.modules.find((module) => module.module === 'Account')?.authenticatedAs).toBe('Test Admin');
    expect(payload.data.modules.find((module) => module.module === 'Registrations')?.ok).toBe(false);
    expect(payload.data.recommendedActions[0]).toContain('Registrations');
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('runs ministry health summary against mocked cross-module data', async () => {
  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/people/v2/people')) {
      const isCreatedFilter = url.includes('created_at');
      res.end(JSON.stringify({ data: [], meta: { total_count: isCreatedFilter ? 3 : 120 } }));
      return;
    }

    if (url.startsWith('/check-ins/v2/check_ins') && url.includes('first_time')) {
      res.end(JSON.stringify({ data: [], meta: { total_count: 4 } }));
      return;
    }

    if (url.startsWith('/check-ins/v2/check_ins')) {
      res.end(JSON.stringify({
        data: [
          { id: 'ci-1', type: 'CheckIn', attributes: {}, relationships: { person: { data: { id: 'p1', type: 'Person' } } } },
          { id: 'ci-2', type: 'CheckIn', attributes: {}, relationships: { person: { data: { id: 'p2', type: 'Person' } } } },
          { id: 'ci-3', type: 'CheckIn', attributes: {}, relationships: { person: { data: { id: 'p1', type: 'Person' } } } },
        ],
        meta: { total_count: 3 },
      }));
      return;
    }

    if (url.startsWith('/giving/v2/donations')) {
      res.end(JSON.stringify({
        data: [
          { id: 'd1', type: 'Donation', attributes: { amount_cents: '2500' } },
          { id: 'd2', type: 'Donation', attributes: { amount_cents: '7500' } },
        ],
        meta: { total_count: 2 },
      }));
      return;
    }

    if (url.startsWith('/groups/v2/groups')) {
      res.end(JSON.stringify({
        data: [
          { id: 'g1', type: 'Group', attributes: { name: 'Alpha', memberships_count: 10 } },
          { id: 'g2', type: 'Group', attributes: { name: 'Empty', memberships_count: 0 } },
        ],
        meta: { total_count: 2 },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
  });

  try {
    await mcp.initialize();
    const response = await mcp.request('tools/call', {
      name: 'pco_ministry_health_summary',
      arguments: { startDate: '2026-05-01T00:00:00Z', endDate: '2026-05-31T23:59:59Z' },
    }, 6);

    expect(response.error).toBeFalsy();
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const payload = JSON.parse(content[0].text) as {
      success: boolean;
      data: {
        people: { totalPeople: number; newPeople: number };
        attendance: { totalCheckIns: number; uniquePeople: number; firstTimeGuests: number };
        giving: { totalDonations: number; totalAmount: number; averageDonation: number };
        groups: { totalGroups: number; emptyGroups: number; averageGroupSize: number };
        moduleWarnings: unknown[];
      };
    };

    expect(payload.success).toBe(true);
    expect(payload.data.people).toEqual({ totalPeople: 120, newPeople: 3 });
    expect(payload.data.attendance).toEqual({ totalCheckIns: 3, uniquePeople: 2, firstTimeGuests: 4 });
    expect(payload.data.giving).toEqual({ totalDonations: 2, totalAmount: 100, averageDonation: 50 });
    expect(payload.data.groups).toMatchObject({ totalGroups: 2, emptyGroups: 1, averageGroupSize: 5 });
    expect(payload.data.moduleWarnings).toEqual([]);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('builds a service review packet against mocked Services data', async () => {
  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/items')) {
      res.end(JSON.stringify({
        data: [
          { id: 'item-1', type: 'Item', attributes: { title: 'Opening Song', item_type: 'song' } },
          { id: 'item-2', type: 'Item', attributes: { title: 'Message', item_type: 'regular' } },
        ],
        meta: { total_count: 2 },
      }));
      return;
    }

    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/team_members')) {
      res.end(JSON.stringify({
        data: [
          { id: 'tm-1', type: 'TeamMember', attributes: { name: 'Confirmed Person', status: 'C', team_position_name: 'Vocals' } },
          { id: 'tm-2', type: 'TeamMember', attributes: { name: 'Pending Person', status: 'P', team_position_name: 'Greeter' } },
        ],
        meta: { total_count: 2 },
      }));
      return;
    }

    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/plan_times')) {
      res.end(JSON.stringify({
        data: [{ id: 'time-1', type: 'PlanTime', attributes: { starts_at: '2026-05-10T16:00:00Z' } }],
        meta: { total_count: 1 },
      }));
      return;
    }

    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1')) {
      res.end(JSON.stringify({
        data: {
          id: 'plan-1',
          type: 'Plan',
          attributes: { title: 'Sunday Review', dates: 'May 10', sort_date: '2026-05-10T16:00:00Z' },
        },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
  });

  try {
    await mcp.initialize();
    const response = await mcp.request('tools/call', {
      name: 'pco_service_review_packet',
      arguments: { serviceTypeId: 'service-1', planId: 'plan-1' },
    }, 8);

    expect(response.error).toBeFalsy();
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const payload = JSON.parse(content[0].text) as {
      success: boolean;
      data: { reviewPacket: { planItems: unknown[]; volunteerStatusCounts: Record<string, number>; questions: string[] }; planningAdvice: { note: string } };
    };

    expect(payload.success).toBe(true);
    expect(payload.data.reviewPacket.planItems).toHaveLength(2);
    expect(payload.data.reviewPacket.volunteerStatusCounts).toMatchObject({ C: 1, P: 1 });
    expect(payload.data.reviewPacket.questions[0]).toContain('ministry wins');
    expect(payload.data.planningAdvice.note).toContain('No prior feedback');
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('runs weekend readiness against mocked Services data', async () => {
  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url?.startsWith('/services/v2/service_types/service-1/plans/plan-1/team_members')) {
      res.end(JSON.stringify({
        data: [
          { id: 'tm-1', type: 'TeamMember', attributes: { name: 'Confirmed Person', status: 'C', team_position_name: 'Vocals' } },
          { id: 'tm-2', type: 'TeamMember', attributes: { name: 'Needed Position', status: 'U', team_position_name: 'Drums' } },
          { id: 'tm-3', type: 'TeamMember', attributes: { name: 'Declined Person', status: 'D', team_position_name: 'Kids Check-in' } },
          { id: 'tm-4', type: 'TeamMember', attributes: { name: 'Pending Person', status: 'P', team_position_name: 'Greeter' } },
        ],
        meta: { total_count: 4 },
      }));
      return;
    }

    if (req.url?.startsWith('/services/v2/service_types/service-1/plans')) {
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      res.end(JSON.stringify({
        data: [
          {
            id: 'plan-1',
            type: 'Plan',
            attributes: {
              title: 'Sunday Morning',
              dates: 'This Sunday',
              sort_date: tomorrow.toISOString(),
            },
          },
        ],
        meta: { total_count: 1 },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
  });

  try {
    await mcp.initialize();
    const response = await mcp.request('tools/call', {
      name: 'pco_weekend_readiness',
      arguments: { serviceTypeId: 'service-1', daysAhead: 7 },
    }, 4);

    expect(response.error).toBeFalsy();
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const payload = JSON.parse(content[0].text) as {
      success: boolean;
      data: {
        totals: { plans: number; confirmed: number; pending: number; declined: number; unfilled: number; totalGaps: number };
        mostUrgent: Array<{ teamPositionName: string }>;
        recommendedActions: string[];
      };
    };

    expect(payload.success).toBe(true);
    expect(payload.data.totals).toMatchObject({
      plans: 1,
      confirmed: 1,
      pending: 1,
      declined: 1,
      unfilled: 1,
      totalGaps: 2,
    });
    expect(payload.data.mostUrgent.map((gap) => gap.teamPositionName)).toEqual(['Drums', 'Kids Check-in']);
    expect(payload.data.recommendedActions[0]).toContain('2 open/declined/pending volunteer slots');
  } finally {
    await mcp.close();
    await mock.close();
  }
});



test('blocks services write previews when allowlist is not configured', async () => {
  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/services/v2/service_types/service-1/plans')) {
      res.end(JSON.stringify({ data: [], meta: { total_count: 0 } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
  });

  try {
    await mcp.initialize();
    const response = await mcp.request('tools/call', {
      name: 'pco_preview_item_title_replace',
      arguments: {
        targetServiceTypeIds: ['service-1'],
        startDate: '2026-05-01',
        endDate: '2026-05-31',
        findText: 'KR: Teaching',
        replaceText: 'BT: Teaching [RESI]',
      },
    }, 39);

    const payload = JSON.parse((response.result as any).content[0].text) as { success: boolean; error: string | null };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('PCO_WRITABLE_SERVICE_TYPE_IDS');
  } finally {
    await mcp.close();
    await mock.close();
  }
});
test('previews and applies services item title replacement with confirmation', async () => {
  let itemTitle = 'KR: Teaching';

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/services/v2/service_types/service-1/plans?') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: [{ id: 'plan-1', type: 'Plan', attributes: { sort_date: '2026-05-10T16:00:00Z', title: 'Weekend' } }],
        meta: { total_count: 1 },
      }));
      return;
    }

    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/items/item-1') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: { id: 'item-1', type: 'Item', attributes: { title: itemTitle, item_type: 'regular', sequence: 10 } },
      }));
      return;
    }

    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/items/item-1') && req.method === 'PATCH') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: { title?: string } } };
        itemTitle = body?.data?.attributes?.title ?? itemTitle;
        res.end(JSON.stringify({
          data: { id: 'item-1', type: 'Item', attributes: { title: itemTitle } },
        }));
      });
      return;
    }

    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/items') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: [{ id: 'item-1', type: 'Item', attributes: { title: itemTitle, item_type: 'regular', sequence: 10 } }],
        meta: { total_count: 1 },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
    PCO_WRITABLE_SERVICE_TYPE_IDS: 'service-1',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_item_title_replace',
      arguments: {
        targetServiceTypeIds: ['service-1'],
        startDate: '2026-05-01',
        endDate: '2026-05-31',
        findText: 'KR: Teaching',
        replaceText: 'BT: Teaching [RESI]',
      },
    }, 40);

    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_item_title_replace',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 41);

    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { appliedCount: number; errorCount: number };
    };

    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(applyPayload.data.errorCount).toBe(0);
    expect(itemTitle).toBe('BT: Teaching [RESI]');
  } finally {
    await mcp.close();
    await mock.close();
  }
});


test('summarizes preview, audits writes, and rolls back operation', async () => {
  let itemTitle = 'KR: Teaching';

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/services/v2/service_types/service-1/plans?') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: [{ id: 'plan-1', type: 'Plan', attributes: { sort_date: '2026-05-10T16:00:00Z', title: 'Weekend' } }],
        meta: { total_count: 1 },
      }));
      return;
    }

    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/items/item-1') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: { id: 'item-1', type: 'Item', attributes: { title: itemTitle, item_type: 'regular', sequence: 10 } },
      }));
      return;
    }

    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/items/item-1') && req.method === 'PATCH') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: { title?: string } } };
        itemTitle = body?.data?.attributes?.title ?? itemTitle;
        res.end(JSON.stringify({
          data: { id: 'item-1', type: 'Item', attributes: { title: itemTitle } },
        }));
      });
      return;
    }

    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/items') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: [{ id: 'item-1', type: 'Item', attributes: { title: itemTitle, item_type: 'regular', sequence: 10 } }],
        meta: { total_count: 1 },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
    PCO_WRITABLE_SERVICE_TYPE_IDS: 'service-1',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_item_title_replace',
      arguments: {
        targetServiceTypeIds: ['service-1'],
        startDate: '2026-05-01',
        endDate: '2026-05-31',
        findText: 'KR: Teaching',
        replaceText: 'BT: Teaching [RESI]',
      },
    }, 50);

    const previewPayload = JSON.parse((preview.result as any).content[0].text) as { data: { previewToken: string } };

    const summary = await mcp.request('tools/call', {
      name: 'pco_get_services_preview_summary',
      arguments: { previewToken: previewPayload.data.previewToken },
    }, 51);
    const summaryPayload = JSON.parse((summary.result as any).content[0].text) as { success: boolean; data: { summary: { totalChanges: number } } };
    expect(summaryPayload.success).toBe(true);
    expect(summaryPayload.data.summary.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_item_title_replace',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 52);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as { data: { operationId: string } };

    const audit = await mcp.request('tools/call', {
      name: 'pco_get_services_write_audit_log',
      arguments: { limit: 5 },
    }, 53);
    const auditPayload = JSON.parse((audit.result as any).content[0].text) as { success: boolean; data: { operations: Array<{ operationId: string }> } };
    expect(auditPayload.success).toBe(true);
    expect(auditPayload.data.operations.some((op) => op.operationId === applyPayload.data.operationId)).toBe(true);

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_services_write_operation',
      arguments: {
        operationId: applyPayload.data.operationId,
        confirmPhrase: 'ROLLBACK_CHANGES',
      },
    }, 54);

    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as { success: boolean; data: { rolledBackCount: number } };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(itemTitle).toBe('KR: Teaching');
  } finally {
    await mcp.close();
    await mock.close();
  }
});


test('calendar: previews + applies create_calendar_event and rolls back via DELETE', async () => {
  let createdEvent: { id: string; attributes: Record<string, unknown> } | null = null;
  let deletedId: string | null = null;

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url === '/calendar/v2/events' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: Record<string, unknown> } };
        createdEvent = {
          id: 'event-new-1',
          attributes: body?.data?.attributes ?? {},
        };
        res.statusCode = 201;
        res.end(JSON.stringify({ data: { id: 'event-new-1', type: 'Event', attributes: createdEvent.attributes } }));
      });
      return;
    }

    if (url.startsWith('/calendar/v2/events/event-new-1') && req.method === 'DELETE') {
      deletedId = 'event-new-1';
      res.statusCode = 204;
      res.end();
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
    PCO_CALENDAR_WRITES_ENABLED: 'true',
  });

  try {
    await mcp.initialize();

    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_create_calendar_event',
      arguments: {
        name: 'Worship Night',
        startsAt: '2026-06-01T19:00:00Z',
        endsAt: '2026-06-01T21:00:00Z',
        locationName: 'Sanctuary',
      },
    }, 200);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);
    expect(previewPayload.data.previewToken).toMatch(/^preview_/);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_create_calendar_event',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 201);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(applyPayload.data.operationId).toMatch(/^calendar_create_event_/);
    expect(createdEvent?.id).toBe('event-new-1');

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_calendar_write_operation',
      arguments: {
        operationId: applyPayload.data.operationId,
        confirmPhrase: 'ROLLBACK_CHANGES',
      },
    }, 202);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(deletedId).toBe('event-new-1');
  } finally {
    await mcp.close();
    await mock.close();
  }
});


test('calendar: previews + applies update_event_time and rolls back via PATCH', async () => {
  let currentStart = '2026-06-10T18:00:00Z';
  let currentEnd = '2026-06-10T20:00:00Z';

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/calendar/v2/events/event-7') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: {
          id: 'event-7',
          type: 'Event',
          attributes: {
            name: 'Recurring Class',
            starts_at: currentStart,
            ends_at: currentEnd,
          },
        },
      }));
      return;
    }

    if (url.startsWith('/calendar/v2/events/event-7') && req.method === 'PATCH') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: Record<string, string> } };
        const attrs = body?.data?.attributes ?? {};
        if (typeof attrs.starts_at === 'string') currentStart = attrs.starts_at;
        if (typeof attrs.ends_at === 'string') currentEnd = attrs.ends_at;
        res.end(JSON.stringify({
          data: {
            id: 'event-7',
            type: 'Event',
            attributes: { starts_at: currentStart, ends_at: currentEnd },
          },
        }));
      });
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
    PCO_CALENDAR_WRITES_ENABLED: 'true',
  });

  try {
    await mcp.initialize();

    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_update_event_time',
      arguments: {
        eventId: 'event-7',
        startsAt: '2026-06-10T19:00:00Z',
        endsAt: '2026-06-10T21:30:00Z',
      },
    }, 210);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_update_event_time',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 211);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number; errorCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(applyPayload.data.errorCount).toBe(0);
    expect(currentStart).toBe('2026-06-10T19:00:00Z');
    expect(currentEnd).toBe('2026-06-10T21:30:00Z');

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_calendar_write_operation',
      arguments: {
        operationId: applyPayload.data.operationId,
        confirmPhrase: 'ROLLBACK_CHANGES',
      },
    }, 212);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(currentStart).toBe('2026-06-10T18:00:00Z');
    expect(currentEnd).toBe('2026-06-10T20:00:00Z');
  } finally {
    await mcp.close();
    await mock.close();
  }
});


test('calendar: previews + applies approve_resource_request as irreversible audit-only', async () => {
  let approveCalled = false;

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/calendar/v2/event_resource_requests/req-9') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: {
          id: 'req-9',
          type: 'EventResourceRequest',
          attributes: { status: 'pending', approver_notes: null },
          relationships: {
            resource: { data: { id: 'resource-3', type: 'Resource' } },
            event: { data: { id: 'event-9', type: 'Event' } },
          },
        },
      }));
      return;
    }

    if (url === '/calendar/v2/event_resource_requests/req-9/approve' && req.method === 'POST') {
      approveCalled = true;
      res.statusCode = 200;
      res.end(JSON.stringify({ data: { id: 'req-9', type: 'EventResourceRequest', attributes: { status: 'approved' } } }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });

  const mcp = new McpProcess({
    PCO_APP_ID: 'test-id',
    PCO_SECRET: 'test-secret',
    PCO_BASE_URL: mock.url,
    PCO_CALENDAR_WRITES_ENABLED: 'true',
  });

  try {
    await mcp.initialize();

    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_approve_resource_request',
      arguments: {
        eventResourceRequestId: 'req-9',
        approverNote: 'Approved for Tuesday usage',
      },
    }, 220);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_approve_resource_request',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 221);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number; irreversible: boolean };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(applyPayload.data.irreversible).toBe(true);
    expect(approveCalled).toBe(true);

    // Rollback should refuse because the operation is irreversible.
    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_calendar_write_operation',
      arguments: {
        operationId: applyPayload.data.operationId,
        confirmPhrase: 'ROLLBACK_CHANGES',
      },
    }, 222);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      error: string | null;
    };
    expect(rollbackPayload.success).toBe(false);
    expect(rollbackPayload.error).toContain('irreversible');
  } finally {
    await mcp.close();
    await mock.close();
  }
});
