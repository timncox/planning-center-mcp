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

test('summarizes giving against mocked Giving donations', async () => {
  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/giving/v2/donations')) {
      res.end(JSON.stringify({
        data: [
          {
            id: 'donation-1',
            type: 'Donation',
            attributes: { amount_cents: 5000, payment_method: 'card', received_at: '2026-05-04T12:00:00Z' },
          },
          {
            id: 'donation-2',
            type: 'Donation',
            attributes: { amount_cents: 10000, payment_method: 'ach', received_at: '2026-05-05T12:00:00Z' },
          },
          {
            id: 'donation-3',
            type: 'Donation',
            attributes: { amount_cents: 2500, payment_method: 'card', received_at: '2026-05-06T12:00:00Z' },
          },
        ],
        meta: { total_count: 3 },
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
      name: 'pco_get_giving_summary',
      arguments: { startDate: '2026-05-01', endDate: '2026-05-31' },
    }, 60);

    expect(response.error).toBeFalsy();
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const payload = JSON.parse(content[0].text) as {
      success: boolean;
      data: {
        totalDonations: number;
        totalAmount: number;
        averageDonation: number;
        byPaymentMethod: Record<string, { count: number; total: number }>;
      };
    };

    expect(payload.success).toBe(true);
    expect(payload.data.totalDonations).toBe(3);
    expect(payload.data.totalAmount).toBe(175);
    expect(payload.data.averageDonation).toBe(58.33);
    expect(payload.data.byPaymentMethod.card).toEqual({ count: 2, total: 75 });
    expect(payload.data.byPaymentMethod.ach).toEqual({ count: 1, total: 100 });
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('lists groups and flags groups without a leader against mocked Groups data', async () => {
  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/groups/v2/groups/group-1/memberships')) {
      res.end(JSON.stringify({ data: [{ id: 'm-1', type: 'GroupMembership', attributes: { role: 'leader' } }], meta: { total_count: 1 } }));
      return;
    }

    if (url.startsWith('/groups/v2/groups/group-2/memberships')) {
      res.end(JSON.stringify({ data: [], meta: { total_count: 0 } }));
      return;
    }

    if (url.startsWith('/groups/v2/groups')) {
      res.end(JSON.stringify({
        data: [
          {
            id: 'group-1',
            type: 'Group',
            attributes: { name: 'Sunday AM Bible Study', memberships_count: 8, enrollment_strategy: 'open' },
          },
          {
            id: 'group-2',
            type: 'Group',
            attributes: { name: 'Wednesday Youth', memberships_count: 22, enrollment_strategy: 'request' },
          },
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

    const listResponse = await mcp.request('tools/call', {
      name: 'pco_list_groups',
      arguments: { limit: 10 },
    }, 62);
    expect(listResponse.error).toBeFalsy();
    const listPayload = JSON.parse((listResponse.result as any).content[0].text) as {
      success: boolean;
      data: Array<{ id: string; name: string }>;
    };
    expect(listPayload.success).toBe(true);
    expect(listPayload.data.map((g) => g.id).sort()).toEqual(['group-1', 'group-2']);

    const leaderlessResponse = await mcp.request('tools/call', {
      name: 'pco_get_groups_without_leader',
      arguments: {},
    }, 63);
    expect(leaderlessResponse.error).toBeFalsy();
    const leaderlessPayload = JSON.parse((leaderlessResponse.result as any).content[0].text) as {
      success: boolean;
      data: Array<{ id: string; name: string }>;
    };
    expect(leaderlessPayload.success).toBe(true);
    expect(leaderlessPayload.data).toHaveLength(1);
    expect(leaderlessPayload.data[0].id).toBe('group-2');
    expect(leaderlessPayload.data[0].name).toBe('Wednesday Youth');
  } finally {
    await mcp.close();
    await mock.close();
  }
});

// ============================================================
// PHASE 1 — People writes (agent: worktree-agent-a20f5ca45554b056d)
// ============================================================

// =============================================================================
// People write tools — preview / apply / rollback per tool pair (Phase 1)
// =============================================================================

test('people add_note: preview → apply → rollback round-trip', async () => {
  type Note = { id: string; note: string };
  const notes: Map<string, Note> = new Map();
  let nextNoteId = 1;

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/people/v2/people/person-1') && !url.includes('/notes') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: { id: 'person-1', type: 'Person', attributes: { name: 'Ada Lovelace' } },
      }));
      return;
    }
    if (url.startsWith('/people/v2/people/person-1/notes') && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: { note?: string } } };
        const id = `note-${nextNoteId++}`;
        notes.set(id, { id, note: body?.data?.attributes?.note ?? '' });
        res.end(JSON.stringify({ data: { id, type: 'Note', attributes: { note: notes.get(id)!.note } } }));
      });
      return;
    }
    const deleteMatch = url.match(/^\/people\/v2\/people\/person-1\/notes\/([^/?]+)/);
    if (deleteMatch && req.method === 'DELETE') {
      notes.delete(deleteMatch[1]);
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
    PCO_PEOPLE_WRITES_ENABLED: 'true',
  });

  try {
    await mcp.initialize();

    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_add_note',
      arguments: { personId: 'person-1', noteCategoryId: 'cat-1', text: 'Followed up by phone' },
    }, 100);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as { success: boolean; data: { previewToken: string; totalChanges: number } };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_add_note',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 101);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as { success: boolean; data: { operationId: string; appliedCount: number } };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(notes.size).toBe(1);

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_people_write_operation',
      arguments: { operationId: applyPayload.data.operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 102);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as { success: boolean; data: { rolledBackCount: number } };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(notes.size).toBe(0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('people update_person_field: preview → apply → rollback round-trip', async () => {
  let nickname: string | null = 'Adie';

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/people/v2/people/person-1') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: { id: 'person-1', type: 'Person', attributes: { name: 'Ada Lovelace', nickname } },
      }));
      return;
    }
    if (url.startsWith('/people/v2/people/person-1') && req.method === 'PATCH') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: { nickname?: string } } };
        nickname = body?.data?.attributes?.nickname ?? null;
        res.end(JSON.stringify({ data: { id: 'person-1', type: 'Person', attributes: { name: 'Ada Lovelace', nickname } } }));
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
    PCO_PEOPLE_WRITES_ENABLED: 'true',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_update_person_field',
      arguments: { personId: 'person-1', field: 'nickname', value: 'Ada Lou' },
    }, 110);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as { success: boolean; data: { previewToken: string; totalChanges: number } };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_update_person_field',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 111);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as { success: boolean; data: { operationId: string; appliedCount: number } };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(nickname).toBe('Ada Lou');

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_people_write_operation',
      arguments: { operationId: applyPayload.data.operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 112);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as { success: boolean; data: { rolledBackCount: number } };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(nickname).toBe('Adie');
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('people add_to_list: preview → apply → rollback round-trip', async () => {
  const members = new Map<string, { id: string; personId: string }>();
  let nextId = 1;

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/people/v2/people/person-1') && !url.includes('/notes') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: { id: 'person-1', type: 'Person', attributes: { name: 'Ada Lovelace' } },
      }));
      return;
    }
    if (url.startsWith('/people/v2/lists/list-1/list_results') && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { relationships?: { person?: { data?: { id?: string } } } } };
        const id = `lr-${nextId++}`;
        const personId = body?.data?.relationships?.person?.data?.id ?? 'unknown';
        members.set(id, { id, personId });
        res.end(JSON.stringify({ data: { id, type: 'ListResult', attributes: {} } }));
      });
      return;
    }
    const delMatch = url.match(/^\/people\/v2\/lists\/list-1\/list_results\/([^/?]+)/);
    if (delMatch && req.method === 'DELETE') {
      members.delete(delMatch[1]);
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
    PCO_PEOPLE_WRITES_ENABLED: 'true',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_add_to_list',
      arguments: { listId: 'list-1', personId: 'person-1' },
    }, 120);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as { success: boolean; data: { previewToken: string; totalChanges: number } };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_add_to_list',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 121);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as { success: boolean; data: { operationId: string; appliedCount: number } };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(members.size).toBe(1);

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_people_write_operation',
      arguments: { operationId: applyPayload.data.operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 122);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as { success: boolean; data: { rolledBackCount: number } };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(members.size).toBe(0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('people remove_from_list: preview → apply → rollback round-trip', async () => {
  // Starts with member present; remove then rollback should re-add.
  const members = new Map<string, { id: string; personId: string }>([
    ['lr-existing', { id: 'lr-existing', personId: 'person-1' }],
  ]);
  let nextId = 100;

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/people/v2/lists/list-1/list_results') && req.method === 'GET') {
      const matches = Array.from(members.values()).filter((m) => m.personId === 'person-1');
      const data = matches.map((m) => ({ id: m.id, type: 'ListResult', attributes: {} }));
      res.end(JSON.stringify({ data, meta: { total_count: data.length } }));
      return;
    }
    if (url.startsWith('/people/v2/lists/list-1/list_results') && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { relationships?: { person?: { data?: { id?: string } } } } };
        const id = `lr-${nextId++}`;
        const personId = body?.data?.relationships?.person?.data?.id ?? 'unknown';
        members.set(id, { id, personId });
        res.end(JSON.stringify({ data: { id, type: 'ListResult', attributes: {} } }));
      });
      return;
    }
    const delMatch = url.match(/^\/people\/v2\/lists\/list-1\/list_results\/([^/?]+)/);
    if (delMatch && req.method === 'DELETE') {
      members.delete(delMatch[1]);
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
    PCO_PEOPLE_WRITES_ENABLED: 'true',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_remove_from_list',
      arguments: { listId: 'list-1', personId: 'person-1' },
    }, 130);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as { success: boolean; data: { previewToken: string; totalChanges: number } };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_remove_from_list',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 131);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as { success: boolean; data: { operationId: string; appliedCount: number } };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(members.size).toBe(0);

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_people_write_operation',
      arguments: { operationId: applyPayload.data.operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 132);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as { success: boolean; data: { rolledBackCount: number } };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(members.size).toBe(1);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('people create_workflow_card: preview → apply → rollback rejects as irreversible', async () => {
  let createdCardId: string | null = null;

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/people/v2/people/person-1') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: { id: 'person-1', type: 'Person', attributes: { name: 'Ada Lovelace' } },
      }));
      return;
    }
    if (url.startsWith('/people/v2/people/assignee-1') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: {
          id: 'assignee-1',
          type: 'Person',
          attributes: { name: 'Pat Pastor' },
          relationships: { emails: { data: [{ id: 'e-1', type: 'Email' }] } },
        },
        included: [{ id: 'e-1', type: 'Email', attributes: { address: 'pat@example.test', primary: true } }],
      }));
      return;
    }
    if (url.startsWith('/people/v2/workflows/wf-1') && !url.includes('/cards') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: { id: 'wf-1', type: 'Workflow', attributes: { name: 'Guest Follow-up' } },
      }));
      return;
    }
    if (url.startsWith('/people/v2/workflows/wf-1/cards') && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        createdCardId = 'card-1';
        res.end(JSON.stringify({ data: { id: createdCardId, type: 'WorkflowCard', attributes: {} } }));
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
    PCO_PEOPLE_WRITES_ENABLED: 'true',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_create_workflow_card',
      arguments: { workflowId: 'wf-1', personId: 'person-1', assigneeId: 'assignee-1', note: 'Call this week' },
    }, 140);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as { success: boolean; data: { previewToken: string; summary: { assigneeEmail?: string } } };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.summary.assigneeEmail).toBe('pat@example.test');

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_create_workflow_card',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 141);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as { success: boolean; data: { operationId: string; appliedCount: number; irreversible: boolean } };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(applyPayload.data.irreversible).toBe(true);
    expect(createdCardId).toBe('card-1');

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_people_write_operation',
      arguments: { operationId: applyPayload.data.operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 142);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as { success: boolean; error: string | null };
    expect(rollbackPayload.success).toBe(false);
    expect(rollbackPayload.error).toMatch(/irreversible/i);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('people update_household_membership (set_primary): preview → apply → rollback round-trip', async () => {
  let primaryId = 'person-2';

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url.startsWith('/people/v2/households/h-1') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: {
          id: 'h-1',
          type: 'Household',
          attributes: { name: 'Lovelace Household' },
          relationships: { primary_contact: { data: { id: primaryId, type: 'Person' } } },
        },
      }));
      return;
    }
    if (url.startsWith('/people/v2/households/h-1') && req.method === 'PATCH') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { relationships?: { primary_contact?: { data?: { id?: string } } } } };
        const newPrimary = body?.data?.relationships?.primary_contact?.data?.id;
        if (newPrimary) primaryId = newPrimary;
        res.end(JSON.stringify({
          data: {
            id: 'h-1',
            type: 'Household',
            attributes: { name: 'Lovelace Household' },
            relationships: { primary_contact: { data: { id: primaryId, type: 'Person' } } },
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
    PCO_PEOPLE_WRITES_ENABLED: 'true',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_update_household_membership',
      arguments: { householdId: 'h-1', personId: 'person-1', pending: 'set_primary' },
    }, 150);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as { success: boolean; data: { previewToken: string; totalChanges: number } };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_update_household_membership',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 151);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as { success: boolean; data: { operationId: string; appliedCount: number } };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(primaryId).toBe('person-1');

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_people_write_operation',
      arguments: { operationId: applyPayload.data.operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 152);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as { success: boolean; data: { rolledBackCount: number } };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(primaryId).toBe('person-2');
  } finally {
    await mcp.close();
    await mock.close();
  }
});

// ============================================================
// PHASE 2 — Services writes extension (agent: worktree-agent-adbb7ea26084216a6)
// ============================================================

// =====================================================================
// Phase 2 — Services writes extension: 6 preview/apply pairs (12 tools)
// =====================================================================

test('previews, applies, and rolls back add_song_to_plan (DELETE rollback)', async () => {
  const createdItems: Array<{ id: string; song_id: string; sequence: number; arrangement_id?: string; key_name?: string }> = [];
  const deletedItemIds: string[] = [];

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    // Preview-time GET of existing items (paginated)
    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/items?') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: [
          { id: 'existing-1', type: 'Item', attributes: { title: 'Welcome', item_type: 'header', sequence: 1 } },
          { id: 'existing-2', type: 'Item', attributes: { title: 'Closing', item_type: 'header', sequence: 2 } },
        ],
        meta: { total_count: 2 },
      }));
      return;
    }

    // Apply: POST creates a new item
    if (url === '/services/v2/service_types/service-1/plans/plan-1/items' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: any; relationships?: any } };
        const created = {
          id: `new-item-${createdItems.length + 1}`,
          song_id: body?.data?.relationships?.song?.data?.id ?? '',
          sequence: Number(body?.data?.attributes?.sequence ?? 0),
          arrangement_id: body?.data?.relationships?.arrangement?.data?.id,
          key_name: body?.data?.attributes?.key_name,
        };
        createdItems.push(created);
        res.statusCode = 201;
        res.end(JSON.stringify({
          data: { id: created.id, type: 'Item', attributes: { item_type: 'song', sequence: created.sequence, key_name: created.key_name } },
        }));
      });
      return;
    }

    // Rollback: DELETE the created item
    const deleteMatch = url.match(/^\/services\/v2\/service_types\/service-1\/plans\/plan-1\/items\/(new-item-\d+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      deletedItemIds.push(deleteMatch[1]);
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
    PCO_WRITABLE_SERVICE_TYPE_IDS: 'service-1',
  });

  try {
    await mcp.initialize();

    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_add_song_to_plan',
      arguments: {
        serviceTypeId: 'service-1',
        planId: 'plan-1',
        songId: 'song-42',
        position: 3,
        key: 'G',
      },
    }, 1001);

    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_add_song_to_plan',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 1002);

    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number; skippedCount: number; errorCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(applyPayload.data.errorCount).toBe(0);
    expect(createdItems).toHaveLength(1);
    expect(createdItems[0].song_id).toBe('song-42');
    expect(createdItems[0].sequence).toBe(3);

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_services_write_operation',
      arguments: {
        operationId: applyPayload.data.operationId,
        confirmPhrase: 'ROLLBACK_CHANGES',
      },
    }, 1003);

    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(deletedItemIds).toEqual(['new-item-1']);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('previews, applies, and rolls back reorder_plan_items (PATCH sequences)', async () => {
  const sequences: Record<string, number> = { 'item-a': 1, 'item-b': 2, 'item-c': 3 };

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    // Items list (paginated for preview)
    if (url.startsWith('/services/v2/service_types/service-1/plans/plan-1/items?') && req.method === 'GET') {
      res.end(JSON.stringify({
        data: [
          { id: 'item-a', type: 'Item', attributes: { item_type: 'regular', sequence: sequences['item-a'] } },
          { id: 'item-b', type: 'Item', attributes: { item_type: 'regular', sequence: sequences['item-b'] } },
          { id: 'item-c', type: 'Item', attributes: { item_type: 'regular', sequence: sequences['item-c'] } },
        ],
        meta: { total_count: 3 },
      }));
      return;
    }

    const patchMatch = url.match(/^\/services\/v2\/service_types\/service-1\/plans\/plan-1\/items\/(item-[abc])$/);
    if (patchMatch && req.method === 'PATCH') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: { sequence?: number } } };
        sequences[patchMatch[1]] = Number(body?.data?.attributes?.sequence ?? sequences[patchMatch[1]]);
        res.end(JSON.stringify({
          data: { id: patchMatch[1], type: 'Item', attributes: { sequence: sequences[patchMatch[1]] } },
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
    PCO_WRITABLE_SERVICE_TYPE_IDS: 'service-1',
  });

  try {
    await mcp.initialize();

    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_reorder_plan_items',
      arguments: {
        serviceTypeId: 'service-1',
        planId: 'plan-1',
        itemIdsInOrder: ['item-c', 'item-a', 'item-b'],
      },
    }, 1101);

    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    // item-c: 3 -> 1, item-a: 1 -> 2, item-b: 2 -> 3 (all change)
    expect(previewPayload.data.totalChanges).toBe(3);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_reorder_plan_items',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 1102);

    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(3);
    expect(sequences).toEqual({ 'item-c': 1, 'item-a': 2, 'item-b': 3 });

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_services_write_operation',
      arguments: {
        operationId: applyPayload.data.operationId,
        confirmPhrase: 'ROLLBACK_CHANGES',
        requireCurrentValueMatch: false,
      },
    }, 1103);

    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(3);
    expect(sequences).toEqual({ 'item-a': 1, 'item-b': 2, 'item-c': 3 });
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('previews, applies, and rolls back set_item_key_or_tempo', async () => {
  let itemState: { key_name: string; length: number; item_type: string; sequence: number } = {
    key_name: 'C',
    length: 240,
    item_type: 'song',
    sequence: 5,
  };

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url === '/services/v2/service_types/service-1/plans/plan-1/items/item-song' && req.method === 'GET') {
      res.end(JSON.stringify({
        data: { id: 'item-song', type: 'Item', attributes: { ...itemState } },
      }));
      return;
    }

    if (url === '/services/v2/service_types/service-1/plans/plan-1/items/item-song' && req.method === 'PATCH') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: any } };
        if (body?.data?.attributes?.key_name !== undefined) itemState.key_name = body.data.attributes.key_name;
        if (body?.data?.attributes?.length !== undefined) itemState.length = body.data.attributes.length;
        res.end(JSON.stringify({
          data: { id: 'item-song', type: 'Item', attributes: { ...itemState } },
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
    PCO_WRITABLE_SERVICE_TYPE_IDS: 'service-1',
  });

  try {
    await mcp.initialize();

    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_set_item_key_or_tempo',
      arguments: {
        serviceTypeId: 'service-1',
        planId: 'plan-1',
        itemId: 'item-song',
        key: 'G',
        length: 300,
      },
    }, 1201);

    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_set_item_key_or_tempo',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 1202);

    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(itemState.key_name).toBe('G');
    expect(itemState.length).toBe(300);

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_services_write_operation',
      arguments: {
        operationId: applyPayload.data.operationId,
        confirmPhrase: 'ROLLBACK_CHANGES',
        requireCurrentValueMatch: false,
      },
    }, 1203);

    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(itemState.key_name).toBe('C');
    expect(itemState.length).toBe(240);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('schedule_position applies but rollback refuses with irreversibility error', async () => {
  const createdPlanPeople: Array<{ id: string; team_id: string; person_id: string; position_name: string }> = [];

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url === '/people/v2/people/person-99' && req.method === 'GET') {
      res.end(JSON.stringify({
        data: { id: 'person-99', type: 'Person', attributes: { name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe' } },
      }));
      return;
    }

    if (url === '/services/v2/service_types/service-1/plans/plan-1' && req.method === 'GET') {
      res.end(JSON.stringify({
        data: { id: 'plan-1', type: 'Plan', attributes: { sort_date: '2026-06-07T16:00:00Z', title: 'Sunday Morning' } },
      }));
      return;
    }

    if (url === '/services/v2/service_types/service-1/plans/plan-1/team_members' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: any; relationships?: any } };
        const created = {
          id: 'pp-1',
          team_id: body?.data?.relationships?.team?.data?.id ?? '',
          person_id: body?.data?.relationships?.person?.data?.id ?? '',
          position_name: body?.data?.attributes?.team_position_name ?? '',
        };
        createdPlanPeople.push(created);
        res.statusCode = 201;
        res.end(JSON.stringify({
          data: { id: created.id, type: 'PlanPerson', attributes: { team_position_name: created.position_name, status: 'U' } },
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
    PCO_WRITABLE_SERVICE_TYPE_IDS: 'service-1',
  });

  try {
    await mcp.initialize();

    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_schedule_position',
      arguments: {
        serviceTypeId: 'service-1',
        planId: 'plan-1',
        teamId: 'team-7',
        personId: 'person-99',
        positionName: 'Vocals',
      },
    }, 1301);

    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number; summary: { irreversible?: boolean; recipient?: string } };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);
    expect(previewPayload.data.summary.irreversible).toBe(true);
    expect(previewPayload.data.summary.recipient).toBe('Jane Doe');

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_schedule_position',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 1302);

    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number; irreversible?: boolean };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(applyPayload.data.irreversible).toBe(true);
    expect(createdPlanPeople).toHaveLength(1);
    expect(createdPlanPeople[0].person_id).toBe('person-99');
    expect(createdPlanPeople[0].position_name).toBe('Vocals');

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_services_write_operation',
      arguments: {
        operationId: applyPayload.data.operationId,
        confirmPhrase: 'ROLLBACK_CHANGES',
      },
    }, 1303);

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

test('previews, applies, and rolls back confirm_or_decline_position', async () => {
  let planPersonStatus = 'U';

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url === '/services/v2/service_types/service-1/plans/plan-1/team_members/pp-7' && req.method === 'GET') {
      res.end(JSON.stringify({
        data: {
          id: 'pp-7',
          type: 'PlanPerson',
          attributes: { status: planPersonStatus, name: 'Sam Smith', team_position_name: 'Guitar' },
        },
      }));
      return;
    }

    if (url === '/services/v2/service_types/service-1/plans/plan-1/team_members/pp-7' && req.method === 'PATCH') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: { status?: string } } };
        if (body?.data?.attributes?.status) planPersonStatus = body.data.attributes.status;
        res.end(JSON.stringify({
          data: { id: 'pp-7', type: 'PlanPerson', attributes: { status: planPersonStatus } },
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
    PCO_WRITABLE_SERVICE_TYPE_IDS: 'service-1',
  });

  try {
    await mcp.initialize();

    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_confirm_or_decline_position',
      arguments: {
        serviceTypeId: 'service-1',
        planId: 'plan-1',
        planPersonId: 'pp-7',
        status: 'C',
      },
    }, 1401);

    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_confirm_or_decline_position',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 1402);

    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(planPersonStatus).toBe('C');

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_services_write_operation',
      arguments: {
        operationId: applyPayload.data.operationId,
        confirmPhrase: 'ROLLBACK_CHANGES',
        requireCurrentValueMatch: false,
      },
    }, 1403);

    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(planPersonStatus).toBe('U');
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('previews, applies, and rolls back create_plan (DELETE rollback)', async () => {
  const createdPlans: Array<{ id: string; sort_date: string; title?: string; series_title?: string }> = [];
  const deletedPlanIds: string[] = [];

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url === '/services/v2/service_types/service-1/plans' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data?: { attributes?: any } };
        const created = {
          id: `plan-new-${createdPlans.length + 1}`,
          sort_date: body?.data?.attributes?.sort_date ?? '',
          title: body?.data?.attributes?.title,
          series_title: body?.data?.attributes?.series_title,
        };
        createdPlans.push(created);
        res.statusCode = 201;
        res.end(JSON.stringify({
          data: { id: created.id, type: 'Plan', attributes: { sort_date: created.sort_date, title: created.title, series_title: created.series_title } },
        }));
      });
      return;
    }

    const deleteMatch = url.match(/^\/services\/v2\/service_types\/service-1\/plans\/(plan-new-\d+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      deletedPlanIds.push(deleteMatch[1]);
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
    PCO_WRITABLE_SERVICE_TYPE_IDS: 'service-1',
  });

  try {
    await mcp.initialize();

    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_create_plan',
      arguments: {
        serviceTypeId: 'service-1',
        sortDate: '2026-06-14T16:00:00Z',
        title: 'Pentecost',
        seriesTitle: 'Acts',
      },
    }, 1501);

    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_create_plan',
      arguments: {
        previewToken: previewPayload.data.previewToken,
        confirmPhrase: 'APPLY_CHANGES',
      },
    }, 1502);

    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(createdPlans).toHaveLength(1);
    expect(createdPlans[0].title).toBe('Pentecost');

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_services_write_operation',
      arguments: {
        operationId: applyPayload.data.operationId,
        confirmPhrase: 'ROLLBACK_CHANGES',
      },
    }, 1503);

    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(deletedPlanIds).toEqual(['plan-new-1']);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

// ============================================================
// PHASE 3 — Groups writes (agent: worktree-agent-a0cc788b24e6ba897)
// ============================================================

// ---------------------------------------------------------------------------
// Groups write-tool tests (Phase 3)
// ---------------------------------------------------------------------------

test('groups add_to_group: preview → apply → rollback (and allowlist rejection)', async () => {
  const memberships = new Map<string, { id: string; role: string; personId: string }>();
  let nextMembershipId = 100;

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    // POST membership
    const postMatch = url.match(/^\/groups\/v2\/groups\/([^/]+)\/memberships$/);
    if (postMatch && method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data: { attributes: { role: string }; relationships: { person: { data: { id: string } } } } };
        const id = `mem-${nextMembershipId++}`;
        memberships.set(id, {
          id,
          role: body.data.attributes.role,
          personId: body.data.relationships.person.data.id,
        });
        res.end(JSON.stringify({
          data: { id, type: 'GroupMembership', attributes: { role: body.data.attributes.role } },
        }));
      });
      return;
    }

    // DELETE membership
    const delMatch = url.match(/^\/groups\/v2\/groups\/([^/]+)\/memberships\/([^/?]+)$/);
    if (delMatch && method === 'DELETE') {
      memberships.delete(delMatch[2]);
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
    PCO_WRITABLE_GROUP_IDS: 'group-1',
  });

  try {
    await mcp.initialize();

    // Rejection case: non-allowlisted group
    const rejected = await mcp.request('tools/call', {
      name: 'pco_preview_add_to_group',
      arguments: { groupId: 'group-99', personId: 'person-1' },
    }, 1001);
    const rejectedPayload = JSON.parse((rejected.result as any).content[0].text) as { success: boolean; error: string };
    expect(rejectedPayload.success).toBe(false);
    expect(rejectedPayload.error).toContain('group-99');

    // Preview
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_add_to_group',
      arguments: { groupId: 'group-1', personId: 'person-1', role: 'leader' },
    }, 1002);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    // Apply
    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_add_to_group',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 1003);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number; errorCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(applyPayload.data.errorCount).toBe(0);
    expect(memberships.size).toBe(1);

    // Rollback
    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_groups_write_operation',
      arguments: { operationId: applyPayload.data.operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 1004);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(memberships.size).toBe(0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('groups remove_from_group: preview reads current → apply DELETE → rollback POSTs back', async () => {
  const memberships = new Map<string, { role: string; personId: string }>([
    ['mem-1', { role: 'leader', personId: 'person-1' }],
  ]);
  let postCount = 0;

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    const getOne = url.match(/^\/groups\/v2\/groups\/([^/]+)\/memberships\/([^/?]+)(\?|$)/);
    if (getOne && method === 'GET') {
      const m = memberships.get(getOne[2]);
      if (!m) {
        res.statusCode = 404;
        res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
        return;
      }
      res.end(JSON.stringify({
        data: {
          id: getOne[2],
          type: 'GroupMembership',
          attributes: { role: m.role },
          relationships: { person: { data: { type: 'Person', id: m.personId } } },
        },
      }));
      return;
    }

    if (getOne && method === 'DELETE') {
      memberships.delete(getOne[2]);
      res.statusCode = 204;
      res.end();
      return;
    }

    const post = url.match(/^\/groups\/v2\/groups\/([^/]+)\/memberships$/);
    if (post && method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data: { attributes: { role: string }; relationships: { person: { data: { id: string } } } } };
        postCount++;
        const id = `mem-restored-${postCount}`;
        memberships.set(id, {
          role: body.data.attributes.role,
          personId: body.data.relationships.person.data.id,
        });
        res.end(JSON.stringify({
          data: { id, type: 'GroupMembership', attributes: { role: body.data.attributes.role } },
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
    PCO_WRITABLE_GROUP_IDS: 'group-1',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_remove_from_group',
      arguments: { groupId: 'group-1', membershipId: 'mem-1' },
    }, 1101);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; changes: Array<{ beforeAttributes: { role: string; personId: string } }> };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.changes[0].beforeAttributes.role).toBe('leader');
    expect(previewPayload.data.changes[0].beforeAttributes.personId).toBe('person-1');

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_remove_from_group',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 1102);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(memberships.has('mem-1')).toBe(false);

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_groups_write_operation',
      arguments: { operationId: applyPayload.data.operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 1103);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(postCount).toBe(1);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('groups log_group_attendance: preview → apply → rollback', async () => {
  const attendances = new Map<string, { attended: boolean; personId: string }>();
  let nextAttendanceId = 1;

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    // Look up event → resolve group
    if (url.match(/^\/groups\/v2\/events\/event-1(\?|$)/) && method === 'GET') {
      res.end(JSON.stringify({
        data: {
          id: 'event-1',
          type: 'Event',
          attributes: { starts_at: '2026-05-22T18:00:00Z' },
          relationships: { group: { data: { type: 'Group', id: 'group-1' } } },
        },
      }));
      return;
    }

    if (url.match(/^\/groups\/v2\/events\/event-1\/attendances$/) && method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data: { attributes: { attended: boolean }; relationships: { person: { data: { id: string } } } } };
        const id = `att-${nextAttendanceId++}`;
        attendances.set(id, {
          attended: body.data.attributes.attended,
          personId: body.data.relationships.person.data.id,
        });
        res.end(JSON.stringify({
          data: { id, type: 'Attendance', attributes: { attended: body.data.attributes.attended } },
        }));
      });
      return;
    }

    const delMatch = url.match(/^\/groups\/v2\/events\/event-1\/attendances\/([^/?]+)$/);
    if (delMatch && method === 'DELETE') {
      attendances.delete(delMatch[1]);
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
    PCO_WRITABLE_GROUP_IDS: 'group-1',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_log_group_attendance',
      arguments: { eventId: 'event-1', personIds: ['person-1', 'person-2'], attendance: true },
    }, 1201);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(2);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_log_group_attendance',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 1202);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(2);
    expect(attendances.size).toBe(2);

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_groups_write_operation',
      arguments: { operationId: applyPayload.data.operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 1203);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(2);
    expect(attendances.size).toBe(0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('groups send_group_email: preview lists recipients; apply returns not-supported; rollback refuses', async () => {
  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (url.startsWith('/groups/v2/groups/group-1/memberships') && method === 'GET') {
      res.end(JSON.stringify({
        data: [
          {
            id: 'mem-1',
            type: 'GroupMembership',
            attributes: { role: 'leader' },
            relationships: { person: { data: { id: 'person-1', type: 'Person' } } },
          },
          {
            id: 'mem-2',
            type: 'GroupMembership',
            attributes: { role: 'member' },
            relationships: { person: { data: { id: 'person-2', type: 'Person' } } },
          },
        ],
        included: [
          { id: 'person-1', type: 'Person', attributes: { name: 'Ada Lovelace', email: 'ada@example.test' } },
          { id: 'person-2', type: 'Person', attributes: { name: 'Grace Hopper', email: 'grace@example.test' } },
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
    PCO_WRITABLE_GROUP_IDS: 'group-1',
    PCO_GROUP_EMAIL_ENABLED: 'true',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_send_group_email',
      arguments: {
        groupId: 'group-1',
        subject: 'Hello group',
        body: 'See you Sunday',
      },
    }, 1301);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: {
        previewToken: string;
        summary: { recipientCount: number; recipients: Array<{ name: string; email: string }>; irreversible: boolean };
      };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.summary.recipientCount).toBe(2);
    expect(previewPayload.data.summary.recipients[0].name).toBe('Ada Lovelace');
    expect(previewPayload.data.summary.recipients[0].email).toBe('ada@example.test');
    expect(previewPayload.data.summary.irreversible).toBe(true);

    // Apply: PCO API doesn't support; expect toolError
    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_send_group_email',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 1302);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as { success: boolean; error: string };
    expect(applyPayload.success).toBe(false);
    expect(applyPayload.error).toContain('mass-email');

    // Audit log should contain an irreversible entry
    const audit = await mcp.request('tools/call', {
      name: 'pco_get_groups_write_audit_log',
      arguments: { limit: 5 },
    }, 1303);
    const auditPayload = JSON.parse((audit.result as any).content[0].text) as {
      success: boolean;
      data: { operations: Array<{ kind: string; irreversible: boolean; operationId: string }> };
    };
    expect(auditPayload.success).toBe(true);
    const emailOps = auditPayload.data.operations.filter((op) => op.kind === 'groups_send_group_email');
    expect(emailOps.length).toBeGreaterThanOrEqual(1);
    expect(emailOps[0].irreversible).toBe(true);

    // Rollback should refuse
    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_groups_write_operation',
      arguments: { operationId: emailOps[0].operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 1304);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as { success: boolean; error: string };
    expect(rollbackPayload.success).toBe(false);
    expect(rollbackPayload.error).toMatch(/irreversible|mass-email|public API/i);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test('groups create_group_meeting: preview → apply → rollback deletes event', async () => {
  const events = new Map<string, Record<string, unknown>>();
  let nextEventId = 500;

  const mock = await startMockPco((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    const post = url.match(/^\/groups\/v2\/groups\/([^/]+)\/events$/);
    if (post && method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { data: { attributes: Record<string, unknown> } };
        const id = `evt-${nextEventId++}`;
        events.set(id, body.data.attributes);
        res.end(JSON.stringify({
          data: { id, type: 'Event', attributes: body.data.attributes },
        }));
      });
      return;
    }

    const del = url.match(/^\/groups\/v2\/groups\/([^/]+)\/events\/([^/?]+)$/);
    if (del && method === 'DELETE') {
      events.delete(del[2]);
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
    PCO_WRITABLE_GROUP_IDS: 'group-1',
  });

  try {
    await mcp.initialize();
    const preview = await mcp.request('tools/call', {
      name: 'pco_preview_create_group_meeting',
      arguments: {
        groupId: 'group-1',
        startsAt: '2026-06-01T18:00:00Z',
        endsAt: '2026-06-01T20:00:00Z',
        name: 'June Kickoff',
        locationName: 'Living Room',
      },
    }, 1401);
    const previewPayload = JSON.parse((preview.result as any).content[0].text) as {
      success: boolean;
      data: { previewToken: string; totalChanges: number };
    };
    expect(previewPayload.success).toBe(true);
    expect(previewPayload.data.totalChanges).toBe(1);

    const apply = await mcp.request('tools/call', {
      name: 'pco_apply_create_group_meeting',
      arguments: { previewToken: previewPayload.data.previewToken, confirmPhrase: 'APPLY_CHANGES' },
    }, 1402);
    const applyPayload = JSON.parse((apply.result as any).content[0].text) as {
      success: boolean;
      data: { operationId: string; appliedCount: number };
    };
    expect(applyPayload.success).toBe(true);
    expect(applyPayload.data.appliedCount).toBe(1);
    expect(events.size).toBe(1);

    const rollback = await mcp.request('tools/call', {
      name: 'pco_rollback_groups_write_operation',
      arguments: { operationId: applyPayload.data.operationId, confirmPhrase: 'ROLLBACK_CHANGES' },
    }, 1403);
    const rollbackPayload = JSON.parse((rollback.result as any).content[0].text) as {
      success: boolean;
      data: { rolledBackCount: number };
    };
    expect(rollbackPayload.success).toBe(true);
    expect(rollbackPayload.data.rolledBackCount).toBe(1);
    expect(events.size).toBe(0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

// ============================================================
// PHASE 4 — Calendar writes (agent: worktree-agent-a37a9ab0deffed09a)
// ============================================================


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
