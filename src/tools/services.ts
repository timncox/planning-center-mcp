import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import { PlanningCenterClient } from '../client.js';
import { toolSuccess, toolError } from '../response.js';

type MatchMode = 'exact' | 'contains' | 'regex';
type SyncField = 'title' | 'description' | 'notes';

type PreviewOperationKind =
  | 'replace'
  | 'sync'
  | 'add_song'
  | 'reorder'
  | 'set_key_tempo'
  | 'schedule_position'
  | 'confirm_position'
  | 'create_plan';

type PreviewChange = {
  serviceTypeId: string;
  planId: string;
  planDate?: string;
  itemId: string;
  itemSequence?: number;
  itemType?: string;
  beforeAttributes: Record<string, unknown>;
  afterAttributes: Record<string, unknown>;
  reason?: string;
  // For new write kinds: how to apply / how to roll back. Optional so legacy kinds keep working.
  applyMethod?: 'PATCH' | 'POST' | 'DELETE';
  applyEndpoint?: string;
  applyBody?: Record<string, unknown>;
  rollbackMethod?: 'PATCH' | 'POST' | 'DELETE' | 'NONE';
  rollbackEndpoint?: string;
  rollbackBody?: Record<string, unknown>;
  // Captured at apply time for kinds that create resources (e.g. add_song, create_plan, schedule_position)
  createdResourceId?: string;
  createdResourceType?: string;
  // Extras shown in summary (e.g. recipient names for schedule_position).
  metadata?: Record<string, unknown>;
};

type PreviewOperation = {
  token: string;
  kind: PreviewOperationKind;
  createdAt: string;
  expiresAt: string;
  changes: PreviewChange[];
  summary: Record<string, unknown>;
};

type AppliedWriteOperation = {
  operationId: string;
  kind: PreviewOperationKind;
  appliedAt: string;
  sourcePreviewToken: string;
  applied: PreviewChange[];
  skipped: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  irreversible?: boolean;
  irreversibleReason?: string;
};

const PREVIEW_TTL_MS = 15 * 60_000;
const AUDIT_TTL_MS = 7 * 24 * 60 * 60_000;
const previewOperations = new Map<string, PreviewOperation>();
const auditOperations = new Map<string, AppliedWriteOperation>();

function prunePreviewOperations() {
  const now = Date.now();
  for (const [token, op] of previewOperations.entries()) {
    if (new Date(op.expiresAt).getTime() <= now) {
      previewOperations.delete(token);
    }
  }
}

function createPreviewOperation(kind: PreviewOperationKind, changes: PreviewChange[], summary: Record<string, unknown>) {
  prunePreviewOperations();
  const token = `preview_${crypto.randomBytes(18).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  const op: PreviewOperation = { token, kind, createdAt, expiresAt, changes, summary };
  previewOperations.set(token, op);
  return op;
}

function getPreviewOperation(token: string, kind: PreviewOperationKind) {
  prunePreviewOperations();
  const op = previewOperations.get(token);
  if (!op || op.kind !== kind) return null;
  if (new Date(op.expiresAt).getTime() <= Date.now()) {
    previewOperations.delete(token);
    return null;
  }
  return op;
}

function pruneAuditOperations() {
  const now = Date.now();
  for (const [operationId, op] of auditOperations.entries()) {
    if (new Date(op.appliedAt).getTime() + AUDIT_TTL_MS <= now) {
      auditOperations.delete(operationId);
    }
  }
}

function saveAuditOperation(operation: AppliedWriteOperation) {
  pruneAuditOperations();
  auditOperations.set(operation.operationId, operation);
}

function getAuditOperation(operationId: string) {
  pruneAuditOperations();
  return auditOperations.get(operationId) ?? null;
}

function getWritableServiceTypeAllowlist(): Set<string> | null {
  const raw = process.env.PCO_WRITABLE_SERVICE_TYPE_IDS?.trim();
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return new Set(ids);
}

function validateWritableTargets(serviceTypeIds: string[]) {
  const allowlist = getWritableServiceTypeAllowlist();
  if (!allowlist) {
    return 'Services write tools are disabled. Set PCO_WRITABLE_SERVICE_TYPE_IDS to a comma-separated allowlist of writable service type IDs.';
  }
  const disallowed = Array.from(new Set(serviceTypeIds)).filter((id) => !allowlist.has(id));
  if (disallowed.length === 0) return null;
  return `Write access denied for serviceTypeId(s): ${disallowed.join(', ')}. Allowed IDs are set by PCO_WRITABLE_SERVICE_TYPE_IDS.`;
}

function summarizePreviewChanges(changes: PreviewChange[]) {
  const byServiceType: Record<string, number> = {};
  const byPlan: Record<string, number> = {};
  const byItemType: Record<string, number> = {};

  for (const change of changes) {
    byServiceType[change.serviceTypeId] = (byServiceType[change.serviceTypeId] ?? 0) + 1;
    const planKey = `${change.serviceTypeId}/${change.planId}`;
    byPlan[planKey] = (byPlan[planKey] ?? 0) + 1;
    const itemType = change.itemType || 'unknown';
    byItemType[itemType] = (byItemType[itemType] ?? 0) + 1;
  }

  const topPlans = Object.entries(byPlan)
    .map(([plan, count]) => ({ plan, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalChanges: changes.length,
    serviceTypeBreakdown: byServiceType,
    itemTypeBreakdown: byItemType,
    topPlans,
  };
}

function matchesText(title: string, findText: string, matchMode: MatchMode, caseSensitive: boolean) {
  if (matchMode === 'regex') {
    const flags = caseSensitive ? '' : 'i';
    const regex = new RegExp(findText, flags);
    return regex.test(title);
  }

  const baseTitle = caseSensitive ? title : title.toLowerCase();
  const baseFind = caseSensitive ? findText : findText.toLowerCase();

  if (matchMode === 'exact') {
    return baseTitle === baseFind;
  }

  return baseTitle.includes(baseFind);
}

function replaceTitle(title: string, findText: string, replaceText: string, matchMode: MatchMode, caseSensitive: boolean) {
  if (matchMode === 'regex') {
    const flags = caseSensitive ? 'g' : 'gi';
    return title.replace(new RegExp(findText, flags), replaceText);
  }

  if (matchMode === 'exact') {
    return replaceText;
  }

  if (caseSensitive) {
    return title.split(findText).join(replaceText);
  }

  const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(escaped, 'gi'), replaceText);
}

function inDateRange(sortDate: string, startDate: Date, endDate: Date) {
  const target = new Date(sortDate);
  return target >= startDate && target <= endDate;
}

function normalizeDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T23:59:59.999Z`);
  return { start, end };
}

async function getPlanItems(
  client: PlanningCenterClient,
  serviceTypeId: string,
  planId: string
): Promise<Array<Record<string, unknown> & { id: string }>> {
  const { items } = await client.paginate<Record<string, unknown>>(
    `/services/v2/service_types/${serviceTypeId}/plans/${planId}/items`,
    { per_page: 100 },
    3
  );
  return items as Array<Record<string, unknown> & { id: string }>;
}

async function resolveItemBySelector(
  client: PlanningCenterClient,
  serviceTypeId: string,
  planId: string,
  selector: { byId?: string; byExactTitle?: string; bySequence?: number }
): Promise<(Record<string, unknown> & { id: string }) | null> {
  const items = await getPlanItems(client, serviceTypeId, planId);
  if (selector.byId) {
    return items.find((item) => item.id === selector.byId) ?? null;
  }
  if (selector.byExactTitle) {
    return items.find((item) => String(item.title ?? '') === selector.byExactTitle) ?? null;
  }
  if (typeof selector.bySequence === 'number') {
    return items.find((item) => Number(item.sequence ?? -1) === selector.bySequence) ?? null;
  }
  return null;
}

/** Register all Services module tools */
export function registerServicesTools(server: Server, client: PlanningCenterClient): void {
  const tools = [
    {
      name: 'pco_get_service_types',
      description:
        'Get all service types configured in Planning Center Services (e.g., "Sunday Morning," "Wednesday Night," "Online Campus"). Call this first when working with services to get the serviceTypeId values needed by other tools.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      },
    },
    {
      name: 'pco_get_upcoming_services',
      description:
        'Get upcoming service plans within a date range for a specific service type. Returns plan dates, titles, series titles, and key counts. Use get_service_types first to find the serviceTypeId.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID (from get_service_types)' },
          daysAhead: { type: 'number', description: 'Number of days ahead to look (default 14)' },
        },
        required: ['serviceTypeId'],
      },
    },
    {
      name: 'pco_get_plan_teams',
      description:
        'Get all volunteer teams and their scheduling status for a specific service plan. Shows each team\'s name, how many positions are needed, and how many are filled. Useful for identifying volunteer gaps before a service.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID (from get_service_types)' },
          planId: { type: 'string', description: 'The plan ID' },
        },
        required: ['serviceTypeId', 'planId'],
      },
    },
    {
      name: 'pco_get_unfilled_positions',
      description:
        'Find volunteer positions in upcoming services that have no one scheduled (status U for Unscheduled or D for Declined). Returns service dates, team names, and position names so staff can identify gaps and recruit volunteers.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID' },
          daysAhead: { type: 'number', description: 'Number of days ahead to look (default 14)' },
        },
        required: ['serviceTypeId'],
      },
    },
    {
      name: 'pco_get_service_attendance',
      description:
        'Get headcount attendance for a past service plan. Returns total headcount and breakdown by attendance type if available. Use serviceTypeId and planId from get_upcoming_services.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID (from get_service_types)' },
          planId: { type: 'string', description: 'The plan ID' },
        },
        required: ['serviceTypeId', 'planId'],
      },
    },
    {
      name: 'pco_search_songs',
      description:
        'Search the Planning Center song library by title or author. Returns matching songs with CCLI number, copyright info, and when each was last scheduled. Useful for music planning and licensing audits.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query (title or author)' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
        },
        required: ['query'],
      },
    },
  ];

  // Return tool list
  server.setRequestHandler(
    { method: 'tools/list' } as any,
    async () => ({ tools })
  );
}

/** Handle a services tool call — called from the main dispatcher */
export async function handleServicesTool(
  name: string,
  args: Record<string, unknown>,
  client: PlanningCenterClient
): Promise<string> {
  const start = Date.now();

  try {
    switch (name) {
      case 'pco_get_service_types': {
        const { items, totalCount } = await client.paginate(
          '/services/v2/service_types'
        );
        const result = toolSuccess(items, {
          count: items.length,
          totalCount,
          pcoEndpoint: '/services/v2/service_types',
          executionMs: Date.now() - start,
        });
        return JSON.stringify(result);
      }

      case 'pco_get_upcoming_services': {
        const schema = z.object({
          serviceTypeId: z.string(),
          daysAhead: z.number().optional().default(14),
        });
        const parsed = schema.parse(args);
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() + parsed.daysAhead);

        const endpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans`;
        const { items, totalCount } = await client.paginate(endpoint, {
          filter: 'future',
          order: 'sort_date',
        });

        const filtered = items.filter((p: any) => {
          const sortDate = new Date(p.sort_date as string);
          return sortDate <= cutoff;
        });

        const result = toolSuccess(filtered, {
          count: filtered.length,
          totalCount,
          pcoEndpoint: endpoint,
          executionMs: Date.now() - start,
        });
        return JSON.stringify(result);
      }

      case 'pco_get_plan_teams': {
        const schema = z.object({ serviceTypeId: z.string(), planId: z.string() });
        const parsed = schema.parse(args);

        const endpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}/team_members`;
        const response = await client.get<any>(endpoint, { per_page: 100 });

        const members = Array.isArray(response.data)
          ? response.data.map((r: any) => client.flatten(r))
          : [];

        // Group by team
        const teams: Record<string, { name: string; members: any[]; needed: number; scheduled: number }> = {};
        for (const m of members) {
          const teamName = (m.team_position_name as string) || 'Unassigned';
          if (!teams[teamName]) {
            teams[teamName] = { name: teamName, members: [], needed: 0, scheduled: 0 };
          }
          teams[teamName].members.push(m);
          if ((m.status as string) === 'C') {
            teams[teamName].scheduled++;
          }
        }

        const result = toolSuccess(
          { members, teamSummary: Object.values(teams) },
          {
            count: members.length,
            pcoEndpoint: endpoint,
            executionMs: Date.now() - start,
          }
        );
        return JSON.stringify(result);
      }

      case 'pco_get_unfilled_positions': {
        const schema = z.object({
          serviceTypeId: z.string(),
          daysAhead: z.number().optional().default(14),
        });
        const parsed = schema.parse(args);
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() + parsed.daysAhead);

        // Get upcoming plans
        const { items: plans } = await client.paginate(
          `/services/v2/service_types/${parsed.serviceTypeId}/plans`,
          { filter: 'future', order: 'sort_date' }
        );

        const futurePlans = plans.filter((p: any) => new Date(p.sort_date as string) <= cutoff);
        const unfilled: Array<{
          planId: string;
          planDate: string;
          planTitle: string;
          teamPositionName: string;
          name: string;
          status: string;
        }> = [];

        for (const plan of futurePlans) {
          const planId = (plan as any).id as string;
          try {
            const response = await client.get<any>(
              `/services/v2/service_types/${parsed.serviceTypeId}/plans/${planId}/team_members`,
              { per_page: 100 }
            );
            const members = Array.isArray(response.data)
              ? response.data.map((r: any) => client.flatten(r))
              : [];

            for (const m of members) {
              const status = m.status as string;
              if (status === 'U' || status === 'D') {
                unfilled.push({
                  planId,
                  planDate: (plan as any).sort_date as string,
                  planTitle: ((plan as any).title as string) || (plan as any).dates as string,
                  teamPositionName: (m.team_position_name as string) || 'Unknown Position',
                  name: (m.name as string) || 'Unassigned',
                  status,
                });
              }
            }
          } catch {
            // Skip plans we can't access
          }
        }

        const result = toolSuccess(unfilled, {
          count: unfilled.length,
          pcoEndpoint: `/services/v2/service_types/${parsed.serviceTypeId}/plans/*/team_members`,
          executionMs: Date.now() - start,
        });
        return JSON.stringify(result);
      }

      case 'pco_get_plan_items': {
        const schema = z.object({
          serviceTypeId: z.string(),
          planId: z.string(),
        });
        const parsed = schema.parse(args);

        const endpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}/items`;
        const response = await client.get<any>(endpoint, {
          include: 'song,arrangement,key',
          per_page: 100,
        });

        const items = Array.isArray(response.data)
          ? response.data.map((r: any) => {
              const flat = client.flatten(r);
              // Resolve included song if present
              const songRel = r.relationships?.song?.data;
              if (songRel && response.included) {
                const song = client.resolveIncludes(songRel.id, 'Song', response.included);
                if (song) {
                  (flat as any).song = song;
                }
              }
              // Resolve arrangement
              const arrRel = r.relationships?.arrangement?.data;
              if (arrRel && response.included) {
                const arr = client.resolveIncludes(arrRel.id, 'Arrangement', response.included);
                if (arr) {
                  (flat as any).arrangement = arr;
                }
              }
              // Resolve key
              const keyRel = r.relationships?.key?.data;
              if (keyRel && response.included) {
                const key = client.resolveIncludes(keyRel.id, 'Key', response.included);
                if (key) {
                  (flat as any).key = key;
                }
              }
              return flat;
            })
          : [];

        const result = toolSuccess(items, {
          count: items.length,
          totalCount: response.meta?.total_count,
          pcoEndpoint: endpoint,
          executionMs: Date.now() - start,
        });
        return JSON.stringify(result);
      }

      case 'pco_get_service_attendance': {
        const schema = z.object({ serviceTypeId: z.string(), planId: z.string() });
        const parsed = schema.parse(args);

        const endpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}/plan_times`;
        const response = await client.get<any>(endpoint);

        const planTimes = Array.isArray(response.data)
          ? response.data.map((r: any) => client.flatten(r))
          : [];

        const result = toolSuccess(planTimes, {
          count: planTimes.length,
          pcoEndpoint: endpoint,
          executionMs: Date.now() - start,
        });
        return JSON.stringify(result);
      }

      case 'pco_analyze_volunteer_scheduling': {
        const schema = z.object({
          serviceTypeId: z.string(),
          weeks: z.number().optional().default(12),
        });
        const parsed = schema.parse(args);

        const startDate = new Date();
        startDate.setUTCDate(startDate.getUTCDate() - parsed.weeks * 7);

        // Get past plans
        const { items: plans } = await client.paginate(
          `/services/v2/service_types/${parsed.serviceTypeId}/plans`,
          { filter: 'past', order: '-sort_date' }
        );

        const recentPlans = plans.filter((p: any) => {
          return new Date(p.sort_date as string) >= startDate;
        });

        // Aggregate volunteer stats across plans
        const volunteerStats: Record<string, {
          name: string;
          totalScheduled: number;
          confirmed: number;
          declined: number;
          unscheduled: number;
          pending: number;
          positions: Set<string>;
        }> = {};

        const teamStats: Record<string, {
          name: string;
          totalSlots: number;
          filled: number;
          unfilled: number;
        }> = {};

        for (const plan of recentPlans.slice(0, 20)) {
          const planId = (plan as any).id as string;
          try {
            const response = await client.get<any>(
              `/services/v2/service_types/${parsed.serviceTypeId}/plans/${planId}/team_members`,
              { per_page: 100 }
            );
            const members = Array.isArray(response.data)
              ? response.data.map((r: any) => client.flatten(r))
              : [];

            for (const m of members) {
              const memberName = (m as any).name as string;
              const status = (m as any).status as string;
              const position = (m as any).team_position_name as string || 'Unknown';

              if (memberName && memberName !== 'Needed Position') {
                if (!volunteerStats[memberName]) {
                  volunteerStats[memberName] = {
                    name: memberName,
                    totalScheduled: 0,
                    confirmed: 0,
                    declined: 0,
                    unscheduled: 0,
                    pending: 0,
                    positions: new Set(),
                  };
                }
                volunteerStats[memberName].totalScheduled++;
                volunteerStats[memberName].positions.add(position);
                if (status === 'C') volunteerStats[memberName].confirmed++;
                else if (status === 'D') volunteerStats[memberName].declined++;
                else if (status === 'U') volunteerStats[memberName].unscheduled++;
                else if (status === 'P') volunteerStats[memberName].pending++;
              }

              // Team stats
              if (!teamStats[position]) {
                teamStats[position] = { name: position, totalSlots: 0, filled: 0, unfilled: 0 };
              }
              teamStats[position].totalSlots++;
              if (status === 'C') teamStats[position].filled++;
              else teamStats[position].unfilled++;
            }
          } catch {
            // Skip inaccessible plans
          }
        }

        // Convert to arrays and compute reliability
        const volunteers = Object.values(volunteerStats)
          .map((v) => ({
            name: v.name,
            totalScheduled: v.totalScheduled,
            confirmed: v.confirmed,
            declined: v.declined,
            reliabilityRate: v.totalScheduled > 0
              ? `${Math.round((v.confirmed / v.totalScheduled) * 100)}%`
              : 'N/A',
            positions: Array.from(v.positions),
          }))
          .sort((a, b) => b.totalScheduled - a.totalScheduled);

        const teams = Object.values(teamStats)
          .map((t) => ({
            ...t,
            fillRate: t.totalSlots > 0
              ? `${Math.round((t.filled / t.totalSlots) * 100)}%`
              : 'N/A',
          }))
          .sort((a, b) => b.totalSlots - a.totalSlots);

        // Identify chronic no-shows (high decline rate)
        const chronicDecliners = volunteers
          .filter((v) => v.totalScheduled >= 3 && parseInt(v.reliabilityRate) < 50)
          .slice(0, 20);

        return JSON.stringify(toolSuccess(
          {
            plansAnalyzed: recentPlans.length,
            weeksSpan: parsed.weeks,
            topVolunteers: volunteers.slice(0, 30),
            teamFillRates: teams,
            chronicDecliners,
            totalUniqueVolunteers: volunteers.length,
          },
          {
            count: volunteers.length,
            pcoEndpoint: `/services/v2/service_types/${parsed.serviceTypeId}/plans/*/team_members`,
            executionMs: Date.now() - start,
          }
        ));
      }

      case 'pco_search_songs': {
        const schema = z.object({
          query: z.string(),
          limit: z.number().optional().default(20),
        });
        const parsed = schema.parse(args);

        const response = await client.get<any>('/services/v2/songs', {
          'where[title]': parsed.query,
          order: 'title',
          per_page: parsed.limit,
        });

        const songs = Array.isArray(response.data)
          ? response.data.map((r: any) => client.flatten(r))
          : [];

        const result = toolSuccess(songs, {
          count: songs.length,
          totalCount: response.meta?.total_count,
          pcoEndpoint: '/services/v2/songs',
          executionMs: Date.now() - start,
        });
        return JSON.stringify(result);
      }

      case 'pco_preview_item_title_replace': {
        const schema = z.object({
          targetServiceTypeIds: z.array(z.string()).min(1),
          startDate: z.string(),
          endDate: z.string(),
          findText: z.string().min(1),
          replaceText: z.string(),
          matchMode: z.enum(['exact', 'contains', 'regex']).optional().default('exact'),
          itemType: z.enum(['song', 'media', 'header', 'regular']).optional(),
          caseSensitive: z.boolean().optional().default(false),
          maxPlansScanned: z.number().int().positive().optional().default(200),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableTargets(parsed.targetServiceTypeIds);
        if (writableError) {
          return JSON.stringify(toolError(writableError));
        }

        const { start: startDate, end: endDate } = normalizeDateRange(parsed.startDate, parsed.endDate);
        if (endDate < startDate) {
          return JSON.stringify(toolError('endDate must be on or after startDate.'));
        }

        const pageLimit = Math.max(1, Math.ceil(parsed.maxPlansScanned / 100));
        const warnings: string[] = [];
        const changes: PreviewChange[] = [];
        let plansScanned = 0;

        for (const serviceTypeId of parsed.targetServiceTypeIds) {
          if (plansScanned >= parsed.maxPlansScanned) {
            warnings.push('Stopped scanning because maxPlansScanned was reached.');
            break;
          }

          const { items: plans } = await client.paginate<Record<string, unknown>>(
            `/services/v2/service_types/${serviceTypeId}/plans`,
            { order: 'sort_date' },
            pageLimit
          );

          for (const plan of plans) {
            if (plansScanned >= parsed.maxPlansScanned) break;
            const sortDate = String((plan as any).sort_date ?? '');
            if (!sortDate || !inDateRange(sortDate, startDate, endDate)) continue;
            plansScanned++;

            const planId = String((plan as any).id ?? '');
            if (!planId) continue;

            const items = await getPlanItems(client, serviceTypeId, planId);
            for (const item of items) {
              const title = String(item.title ?? '');
              if (!title) continue;
              if (parsed.itemType && String(item.item_type ?? '') !== parsed.itemType) continue;
              if (!matchesText(title, parsed.findText, parsed.matchMode as MatchMode, parsed.caseSensitive)) continue;

              const nextTitle = replaceTitle(title, parsed.findText, parsed.replaceText, parsed.matchMode as MatchMode, parsed.caseSensitive);
              if (nextTitle === title) continue;

              changes.push({
                serviceTypeId,
                planId,
                planDate: sortDate,
                itemId: item.id,
                itemSequence: Number(item.sequence ?? 0),
                itemType: String(item.item_type ?? ''),
                beforeAttributes: { title },
                afterAttributes: { title: nextTitle },
                reason: `Matched ${parsed.matchMode}`,
              });
            }
          }
        }

        const op = createPreviewOperation('replace', changes, {
          plansScanned,
          serviceTypes: parsed.targetServiceTypeIds,
          dateRange: { startDate: parsed.startDate, endDate: parsed.endDate },
          matchMode: parsed.matchMode,
          warnings,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          plansScanned,
          totalChanges: changes.length,
          summary: summarizePreviewChanges(changes),
          warnings,
          changes,
        }, {
          count: changes.length,
          pcoEndpoint: '/services/v2/service_types/*/plans/*/items',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_item_title_replace': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(100),
          requireCurrentValueMatch: z.boolean().optional().default(true),
        });
        const parsed = schema.parse(args);
        const op = getPreviewOperation(parsed.previewToken, 'replace');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for replace operation. Run preview again.'));
        }

        const writableError = validateWritableTargets(op.changes.map((change) => change.serviceTypeId));
        if (writableError) {
          return JSON.stringify(toolError(writableError));
        }

        if (op.changes.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Preview contains ${op.changes.length} changes, which exceeds maxChanges=${parsed.maxChanges}.`));
        }

        const applied: PreviewChange[] = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          const itemEndpoint = `/services/v2/service_types/${change.serviceTypeId}/plans/${change.planId}/items/${change.itemId}`;
          try {
            if (parsed.requireCurrentValueMatch) {
              const current = await client.get<any>(itemEndpoint);
              const currentFlat = current?.data ? client.flatten(current.data) : null;
              let mismatch = false;
              for (const [key, expected] of Object.entries(change.beforeAttributes)) {
                if ((currentFlat as any)?.[key] !== expected) {
                  mismatch = true;
                  break;
                }
              }
              if (mismatch) {
                skipped.push({ ...change, reason: 'Current value no longer matches preview baseline.' });
                continue;
              }
            }

            await client.patch(itemEndpoint, {
              data: {
                type: 'Item',
                attributes: change.afterAttributes,
              },
            });
            applied.push(change);
          } catch (err) {
            errors.push({
              ...change,
              error: PlanningCenterClient.formatError(err, 'Services'),
            });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `replace_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'replace',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped,
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          applied,
          skipped,
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/services/v2/service_types/*/plans/*/items/*',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_preview_sync_item_from_reference_plan': {
        const selectorSchema = z.object({
          byId: z.string().optional(),
          byExactTitle: z.string().optional(),
          bySequence: z.number().optional(),
        }).refine((value) => Boolean(value.byId || value.byExactTitle || typeof value.bySequence === 'number'), {
          message: 'Provide one selector: byId, byExactTitle, or bySequence.',
        });

        const schema = z.object({
          reference: z.object({
            serviceTypeId: z.string(),
            planId: z.string(),
            itemSelector: selectorSchema,
          }),
          targets: z.array(z.object({
            serviceTypeId: z.string(),
            planId: z.string(),
            itemSelector: selectorSchema,
          })).min(1),
          fields: z.array(z.enum(['title', 'description', 'notes'])).min(1).optional().default(['title']),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableTargets(parsed.targets.map((target) => target.serviceTypeId));
        if (writableError) {
          return JSON.stringify(toolError(writableError));
        }

        const referenceItem = await resolveItemBySelector(
          client,
          parsed.reference.serviceTypeId,
          parsed.reference.planId,
          parsed.reference.itemSelector
        );

        if (!referenceItem) {
          return JSON.stringify(toolError('Reference item not found using the provided selector.'));
        }

        const syncFields = parsed.fields as SyncField[];
        const refAttributes = Object.fromEntries(syncFields.map((field) => [field, referenceItem[field] ?? null]));
        const changes: PreviewChange[] = [];
        const warnings: string[] = [];

        for (const target of parsed.targets) {
          const targetItem = await resolveItemBySelector(
            client,
            target.serviceTypeId,
            target.planId,
            target.itemSelector
          );

          if (!targetItem) {
            warnings.push(`Target item not found for serviceTypeId=${target.serviceTypeId}, planId=${target.planId}.`);
            continue;
          }

          const beforeAttributes: Record<string, unknown> = {};
          const afterAttributes: Record<string, unknown> = {};
          for (const field of syncFields) {
            const before = targetItem[field] ?? null;
            const after = refAttributes[field] ?? null;
            if (before !== after) {
              beforeAttributes[field] = before;
              afterAttributes[field] = after;
            }
          }

          if (Object.keys(afterAttributes).length === 0) continue;

          changes.push({
            serviceTypeId: target.serviceTypeId,
            planId: target.planId,
            itemId: targetItem.id,
            itemSequence: Number(targetItem.sequence ?? 0),
            itemType: String(targetItem.item_type ?? ''),
            beforeAttributes,
            afterAttributes,
            reason: `Synced from reference ${parsed.reference.serviceTypeId}/${parsed.reference.planId}`,
          });
        }

        const op = createPreviewOperation('sync', changes, {
          reference: parsed.reference,
          targets: parsed.targets.length,
          fields: syncFields,
          warnings,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: changes.length,
          summary: summarizePreviewChanges(changes),
          warnings,
          referenceItem: {
            id: referenceItem.id,
            title: referenceItem.title ?? null,
            sequence: referenceItem.sequence ?? null,
          },
          changes,
        }, {
          count: changes.length,
          pcoEndpoint: '/services/v2/service_types/*/plans/*/items/*',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_sync_item_from_reference_plan': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(100),
          requireCurrentValueMatch: z.boolean().optional().default(true),
        });
        const parsed = schema.parse(args);
        const op = getPreviewOperation(parsed.previewToken, 'sync');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for sync operation. Run preview again.'));
        }

        const writableError = validateWritableTargets(op.changes.map((change) => change.serviceTypeId));
        if (writableError) {
          return JSON.stringify(toolError(writableError));
        }

        if (op.changes.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Preview contains ${op.changes.length} changes, which exceeds maxChanges=${parsed.maxChanges}.`));
        }

        const applied: PreviewChange[] = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          const itemEndpoint = `/services/v2/service_types/${change.serviceTypeId}/plans/${change.planId}/items/${change.itemId}`;
          try {
            if (parsed.requireCurrentValueMatch) {
              const current = await client.get<any>(itemEndpoint);
              const currentFlat = current?.data ? client.flatten(current.data) : null;
              let mismatch = false;
              for (const [key, expected] of Object.entries(change.beforeAttributes)) {
                if ((currentFlat as any)?.[key] !== expected) {
                  mismatch = true;
                  break;
                }
              }
              if (mismatch) {
                skipped.push({ ...change, reason: 'Current value no longer matches preview baseline.' });
                continue;
              }
            }

            await client.patch(itemEndpoint, {
              data: {
                type: 'Item',
                attributes: change.afterAttributes,
              },
            });
            applied.push(change);
          } catch (err) {
            errors.push({
              ...change,
              error: PlanningCenterClient.formatError(err, 'Services'),
            });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `sync_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'sync',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped,
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          applied,
          skipped,
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/services/v2/service_types/*/plans/*/items/*',
          executionMs: Date.now() - start,
        }));
      }

      // -----------------------------------------------------------------
      // 1. add_song — insert a song item at position N in a plan
      // -----------------------------------------------------------------
      case 'pco_preview_add_song_to_plan': {
        const schema = z.object({
          serviceTypeId: z.string(),
          planId: z.string(),
          songId: z.string(),
          position: z.number().int().positive(),
          arrangementId: z.string().optional(),
          key: z.string().optional(),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableTargets([parsed.serviceTypeId]);
        if (writableError) return JSON.stringify(toolError(writableError));

        const itemsEndpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}/items`;
        // Fetch a snapshot of current items so we can describe the insertion context.
        const existing = await getPlanItems(client, parsed.serviceTypeId, parsed.planId);
        const insertContext = {
          existingItemCount: existing.length,
          insertionPosition: parsed.position,
          previousItemAtPosition: existing.find((item) => Number(item.sequence ?? -1) === parsed.position) ?? null,
        };

        const relationships: Record<string, unknown> = {
          song: { data: { type: 'Song', id: parsed.songId } },
        };
        if (parsed.arrangementId) {
          relationships.arrangement = { data: { type: 'Arrangement', id: parsed.arrangementId } };
        }

        const applyBody: Record<string, unknown> = {
          data: {
            type: 'Item',
            attributes: {
              item_type: 'song',
              sequence: parsed.position,
              ...(parsed.key ? { key_name: parsed.key } : {}),
            },
            relationships,
          },
        };

        const change: PreviewChange = {
          serviceTypeId: parsed.serviceTypeId,
          planId: parsed.planId,
          itemId: '',
          itemSequence: parsed.position,
          itemType: 'song',
          beforeAttributes: {},
          afterAttributes: {
            item_type: 'song',
            sequence: parsed.position,
            song_id: parsed.songId,
            ...(parsed.arrangementId ? { arrangement_id: parsed.arrangementId } : {}),
            ...(parsed.key ? { key_name: parsed.key } : {}),
          },
          reason: `Insert song ${parsed.songId} at sequence ${parsed.position}`,
          applyMethod: 'POST',
          applyEndpoint: itemsEndpoint,
          applyBody,
          rollbackMethod: 'DELETE',
          // rollbackEndpoint is populated at apply time once we know createdResourceId
          metadata: { insertContext },
        };

        const op = createPreviewOperation('add_song', [change], {
          serviceTypeId: parsed.serviceTypeId,
          planId: parsed.planId,
          songId: parsed.songId,
          position: parsed.position,
          arrangementId: parsed.arrangementId ?? null,
          key: parsed.key ?? null,
          insertContext,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: { ...summarizePreviewChanges([change]), insertContext },
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: itemsEndpoint,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_add_song_to_plan': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
        });
        const parsed = schema.parse(args);
        const op = getPreviewOperation(parsed.previewToken, 'add_song');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for add_song operation. Run preview again.'));

        const writableError = validateWritableTargets(op.changes.map((change) => change.serviceTypeId));
        if (writableError) return JSON.stringify(toolError(writableError));

        const applied: PreviewChange[] = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            const result = await client.post<any>(
              change.applyEndpoint as string,
              change.applyBody
            );
            const createdId = String(result?.data?.id ?? '');
            const appliedChange: PreviewChange = {
              ...change,
              itemId: createdId || change.itemId,
              createdResourceId: createdId,
              createdResourceType: 'Item',
              rollbackEndpoint: createdId
                ? `${change.applyEndpoint}/${createdId}`
                : undefined,
              rollbackMethod: createdId ? 'DELETE' : 'NONE',
            };
            applied.push(appliedChange);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Services') });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `add_song_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'add_song',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped,
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          applied,
          skipped,
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/services/v2/service_types/*/plans/*/items',
          executionMs: Date.now() - start,
        }));
      }

      // -----------------------------------------------------------------
      // 2. reorder_plan_items — patch sequence on each item
      // -----------------------------------------------------------------
      case 'pco_preview_reorder_plan_items': {
        const schema = z.object({
          serviceTypeId: z.string(),
          planId: z.string(),
          itemIdsInOrder: z.array(z.string()).min(1),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableTargets([parsed.serviceTypeId]);
        if (writableError) return JSON.stringify(toolError(writableError));

        const existing = await getPlanItems(client, parsed.serviceTypeId, parsed.planId);
        const byId = new Map(existing.map((item) => [item.id, item]));
        const missing = parsed.itemIdsInOrder.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          return JSON.stringify(toolError(`These itemIds are not on this plan: ${missing.join(', ')}`));
        }

        const changes: PreviewChange[] = [];
        parsed.itemIdsInOrder.forEach((itemId, index) => {
          const item = byId.get(itemId)!;
          const before = Number(item.sequence ?? 0);
          const after = index + 1;
          if (before === after) return;

          const endpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}/items/${itemId}`;
          changes.push({
            serviceTypeId: parsed.serviceTypeId,
            planId: parsed.planId,
            itemId,
            itemSequence: after,
            itemType: String(item.item_type ?? ''),
            beforeAttributes: { sequence: before },
            afterAttributes: { sequence: after },
            reason: `Reorder ${itemId} from sequence ${before} to ${after}`,
            applyMethod: 'PATCH',
            applyEndpoint: endpoint,
            applyBody: { data: { type: 'Item', attributes: { sequence: after } } },
            rollbackMethod: 'PATCH',
            rollbackEndpoint: endpoint,
            rollbackBody: { data: { type: 'Item', attributes: { sequence: before } } },
          });
        });

        const op = createPreviewOperation('reorder', changes, {
          serviceTypeId: parsed.serviceTypeId,
          planId: parsed.planId,
          requestedOrder: parsed.itemIdsInOrder,
          itemsOnPlan: existing.length,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: changes.length,
          summary: summarizePreviewChanges(changes),
          changes,
        }, {
          count: changes.length,
          pcoEndpoint: `/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}/items/*`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_reorder_plan_items': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
        });
        const parsed = schema.parse(args);
        const op = getPreviewOperation(parsed.previewToken, 'reorder');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for reorder operation. Run preview again.'));

        const writableError = validateWritableTargets(op.changes.map((change) => change.serviceTypeId));
        if (writableError) return JSON.stringify(toolError(writableError));

        const applied: PreviewChange[] = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            await client.patch(change.applyEndpoint as string, change.applyBody);
            applied.push(change);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Services') });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `reorder_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'reorder',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped,
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          applied,
          skipped,
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/services/v2/service_types/*/plans/*/items/*',
          executionMs: Date.now() - start,
        }));
      }

      // -----------------------------------------------------------------
      // 3. set_item_key_or_tempo — patch a song item's key / length / arrangement
      // -----------------------------------------------------------------
      case 'pco_preview_set_item_key_or_tempo': {
        const schema = z.object({
          serviceTypeId: z.string(),
          planId: z.string(),
          itemId: z.string(),
          key: z.string().optional(),
          length: z.number().int().nonnegative().optional(),
          arrangementId: z.string().optional(),
        }).refine(
          (value) => Boolean(value.key || typeof value.length === 'number' || value.arrangementId),
          { message: 'Provide at least one of: key, length, arrangementId.' }
        );
        const parsed = schema.parse(args);

        const writableError = validateWritableTargets([parsed.serviceTypeId]);
        if (writableError) return JSON.stringify(toolError(writableError));

        const endpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}/items/${parsed.itemId}`;
        const current = await client.get<any>(endpoint);
        if (!current?.data) {
          return JSON.stringify(toolError(`Item ${parsed.itemId} not found on plan ${parsed.planId}.`));
        }
        const currentFlat = client.flatten(current.data);

        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        if (parsed.key !== undefined) {
          before.key_name = currentFlat.key_name ?? null;
          after.key_name = parsed.key;
        }
        if (parsed.length !== undefined) {
          before.length = currentFlat.length ?? null;
          after.length = parsed.length;
        }
        if (parsed.arrangementId !== undefined) {
          // For arrangement we PATCH a relationship; capture before via the current relationship snapshot.
          const rel = (current.data as any)?.relationships?.arrangement?.data;
          before.arrangement_id = rel?.id ?? null;
          after.arrangement_id = parsed.arrangementId;
        }

        if (JSON.stringify(before) === JSON.stringify(after)) {
          return JSON.stringify(toolSuccess({
            previewToken: null,
            totalChanges: 0,
            summary: { totalChanges: 0, serviceTypeBreakdown: {}, itemTypeBreakdown: {}, topPlans: [] },
            changes: [],
            note: 'No changes — item already matches requested values.',
          }, {
            count: 0,
            pcoEndpoint: endpoint,
            executionMs: Date.now() - start,
          }));
        }

        // Build apply body: PATCH attributes (key/length) and optionally relationships (arrangement)
        const attributes: Record<string, unknown> = {};
        if (parsed.key !== undefined) attributes.key_name = parsed.key;
        if (parsed.length !== undefined) attributes.length = parsed.length;
        const relationships: Record<string, unknown> = {};
        if (parsed.arrangementId !== undefined) {
          relationships.arrangement = { data: { type: 'Arrangement', id: parsed.arrangementId } };
        }
        const applyData: Record<string, unknown> = { type: 'Item', attributes };
        if (Object.keys(relationships).length > 0) applyData.relationships = relationships;

        // Rollback body: revert attributes and arrangement relationship.
        const rollbackAttributes: Record<string, unknown> = {};
        if (parsed.key !== undefined) rollbackAttributes.key_name = currentFlat.key_name ?? null;
        if (parsed.length !== undefined) rollbackAttributes.length = currentFlat.length ?? null;
        const rollbackRelationships: Record<string, unknown> = {};
        if (parsed.arrangementId !== undefined) {
          const rel = (current.data as any)?.relationships?.arrangement?.data;
          rollbackRelationships.arrangement = { data: rel ? { type: 'Arrangement', id: rel.id } : null };
        }
        const rollbackData: Record<string, unknown> = { type: 'Item', attributes: rollbackAttributes };
        if (Object.keys(rollbackRelationships).length > 0) rollbackData.relationships = rollbackRelationships;

        const change: PreviewChange = {
          serviceTypeId: parsed.serviceTypeId,
          planId: parsed.planId,
          itemId: parsed.itemId,
          itemSequence: Number(currentFlat.sequence ?? 0),
          itemType: String(currentFlat.item_type ?? ''),
          beforeAttributes: before,
          afterAttributes: after,
          reason: 'Update song item attributes',
          applyMethod: 'PATCH',
          applyEndpoint: endpoint,
          applyBody: { data: applyData },
          rollbackMethod: 'PATCH',
          rollbackEndpoint: endpoint,
          rollbackBody: { data: rollbackData },
        };

        const op = createPreviewOperation('set_key_tempo', [change], {
          serviceTypeId: parsed.serviceTypeId,
          planId: parsed.planId,
          itemId: parsed.itemId,
          fieldsChanged: Object.keys(after),
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: summarizePreviewChanges([change]),
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: endpoint,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_set_item_key_or_tempo': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
        });
        const parsed = schema.parse(args);
        const op = getPreviewOperation(parsed.previewToken, 'set_key_tempo');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for set_key_tempo operation. Run preview again.'));

        const writableError = validateWritableTargets(op.changes.map((change) => change.serviceTypeId));
        if (writableError) return JSON.stringify(toolError(writableError));

        const applied: PreviewChange[] = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            await client.patch(change.applyEndpoint as string, change.applyBody);
            applied.push(change);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Services') });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `set_key_tempo_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'set_key_tempo',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped,
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          applied,
          skipped,
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/services/v2/service_types/*/plans/*/items/*',
          executionMs: Date.now() - start,
        }));
      }

      // -----------------------------------------------------------------
      // 4. schedule_position — POST PlanPerson (IRREVERSIBLE — sends notification email)
      // -----------------------------------------------------------------
      case 'pco_preview_schedule_position': {
        const schema = z.object({
          serviceTypeId: z.string(),
          planId: z.string(),
          teamId: z.string(),
          personId: z.string(),
          positionName: z.string(),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableTargets([parsed.serviceTypeId]);
        if (writableError) return JSON.stringify(toolError(writableError));

        // Fetch person + plan + team metadata for summary (best-effort — failures don't block preview).
        let personName: string | null = null;
        let planDate: string | null = null;
        let planTitle: string | null = null;
        try {
          const personResp = await client.get<any>(`/people/v2/people/${parsed.personId}`);
          if (personResp?.data) {
            const flat = client.flatten(personResp.data);
            const composed = `${flat.first_name ?? ''} ${flat.last_name ?? ''}`.trim();
            personName = String((flat.name ?? composed) || flat.id);
          }
        } catch { /* best-effort */ }
        try {
          const planResp = await client.get<any>(`/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}`);
          if (planResp?.data) {
            const flat = client.flatten(planResp.data);
            planDate = String(flat.sort_date ?? '') || null;
            planTitle = String(flat.title ?? flat.dates ?? '') || null;
          }
        } catch { /* best-effort */ }

        const teamMembersEndpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}/team_members`;
        const applyBody = {
          data: {
            type: 'PlanPerson',
            attributes: {
              team_position_name: parsed.positionName,
            },
            relationships: {
              team: { data: { type: 'Team', id: parsed.teamId } },
              person: { data: { type: 'Person', id: parsed.personId } },
            },
          },
        };

        const recipient = personName ?? parsed.personId;
        const notificationSummary = `Schedule ${recipient} to position "${parsed.positionName}"${planDate ? ` for plan on ${planDate}` : ''}. PCO will email the volunteer.`;

        const change: PreviewChange = {
          serviceTypeId: parsed.serviceTypeId,
          planId: parsed.planId,
          itemId: '',
          beforeAttributes: {},
          afterAttributes: {
            team_id: parsed.teamId,
            person_id: parsed.personId,
            team_position_name: parsed.positionName,
          },
          reason: notificationSummary,
          applyMethod: 'POST',
          applyEndpoint: teamMembersEndpoint,
          applyBody,
          // Notification is irreversible; the team_member row could be DELETEd but the email has been sent.
          rollbackMethod: 'NONE',
          metadata: {
            recipient,
            personId: parsed.personId,
            positionName: parsed.positionName,
            planDate,
            planTitle,
          },
        };

        const op = createPreviewOperation('schedule_position', [change], {
          serviceTypeId: parsed.serviceTypeId,
          planId: parsed.planId,
          recipient,
          personId: parsed.personId,
          positionName: parsed.positionName,
          planDate,
          planTitle,
          warning: 'IRREVERSIBLE — applying will send a notification email to the volunteer.',
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: { ...summarizePreviewChanges([change]), recipient, positionName: parsed.positionName, planDate, irreversible: true, notificationSummary },
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: teamMembersEndpoint,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_schedule_position': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
        });
        const parsed = schema.parse(args);
        const op = getPreviewOperation(parsed.previewToken, 'schedule_position');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for schedule_position operation. Run preview again.'));

        const writableError = validateWritableTargets(op.changes.map((change) => change.serviceTypeId));
        if (writableError) return JSON.stringify(toolError(writableError));

        const applied: PreviewChange[] = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];
        const recipientsNotified: string[] = [];

        for (const change of op.changes) {
          try {
            const result = await client.post<any>(change.applyEndpoint as string, change.applyBody);
            const createdId = String(result?.data?.id ?? '');
            const appliedChange: PreviewChange = {
              ...change,
              itemId: createdId || change.itemId,
              createdResourceId: createdId,
              createdResourceType: 'PlanPerson',
            };
            applied.push(appliedChange);
            const recipient = (change.metadata as any)?.recipient;
            if (recipient) recipientsNotified.push(String(recipient));
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Services') });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `schedule_position_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'schedule_position',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped,
          errors,
          irreversible: true,
          irreversibleReason: recipientsNotified.length > 0
            ? `Notification email was sent to ${recipientsNotified.join(', ')}.`
            : 'Notification email was sent to the scheduled volunteer(s).',
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          applied,
          skipped,
          errors,
          irreversible: true,
          irreversibleReason: 'Notification email was sent. Rollback will refuse.',
        }, {
          count: applied.length,
          pcoEndpoint: '/services/v2/service_types/*/plans/*/team_members',
          executionMs: Date.now() - start,
        }));
      }

      // -----------------------------------------------------------------
      // 5. confirm_or_decline_position — PATCH PlanPerson status to C / D
      // -----------------------------------------------------------------
      case 'pco_preview_confirm_or_decline_position': {
        const schema = z.object({
          serviceTypeId: z.string(),
          planId: z.string(),
          planPersonId: z.string(),
          status: z.enum(['C', 'D']),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableTargets([parsed.serviceTypeId]);
        if (writableError) return JSON.stringify(toolError(writableError));

        const endpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}/team_members/${parsed.planPersonId}`;
        const current = await client.get<any>(endpoint);
        if (!current?.data) {
          return JSON.stringify(toolError(`PlanPerson ${parsed.planPersonId} not found on plan ${parsed.planId}.`));
        }
        const currentFlat = client.flatten(current.data);
        const beforeStatus = String((currentFlat as any).status ?? '');

        if (beforeStatus === parsed.status) {
          return JSON.stringify(toolSuccess({
            previewToken: null,
            totalChanges: 0,
            summary: { totalChanges: 0, serviceTypeBreakdown: {}, itemTypeBreakdown: {}, topPlans: [] },
            changes: [],
            note: `Status is already ${parsed.status}; no change required.`,
          }, {
            count: 0,
            pcoEndpoint: endpoint,
            executionMs: Date.now() - start,
          }));
        }

        const change: PreviewChange = {
          serviceTypeId: parsed.serviceTypeId,
          planId: parsed.planId,
          itemId: parsed.planPersonId,
          beforeAttributes: { status: beforeStatus },
          afterAttributes: { status: parsed.status },
          reason: `Set PlanPerson status from ${beforeStatus || '(empty)'} to ${parsed.status}`,
          applyMethod: 'PATCH',
          applyEndpoint: endpoint,
          applyBody: { data: { type: 'PlanPerson', attributes: { status: parsed.status } } },
          rollbackMethod: 'PATCH',
          rollbackEndpoint: endpoint,
          rollbackBody: { data: { type: 'PlanPerson', attributes: { status: beforeStatus } } },
          metadata: {
            personName: (currentFlat as any).name ?? null,
            positionName: (currentFlat as any).team_position_name ?? null,
          },
        };

        const op = createPreviewOperation('confirm_position', [change], {
          serviceTypeId: parsed.serviceTypeId,
          planId: parsed.planId,
          planPersonId: parsed.planPersonId,
          beforeStatus,
          afterStatus: parsed.status,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: summarizePreviewChanges([change]),
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: endpoint,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_confirm_or_decline_position': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
        });
        const parsed = schema.parse(args);
        const op = getPreviewOperation(parsed.previewToken, 'confirm_position');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for confirm_position operation. Run preview again.'));

        const writableError = validateWritableTargets(op.changes.map((change) => change.serviceTypeId));
        if (writableError) return JSON.stringify(toolError(writableError));

        const applied: PreviewChange[] = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            await client.patch(change.applyEndpoint as string, change.applyBody);
            applied.push(change);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Services') });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `confirm_position_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'confirm_position',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped,
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          applied,
          skipped,
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/services/v2/service_types/*/plans/*/team_members/*',
          executionMs: Date.now() - start,
        }));
      }

      // -----------------------------------------------------------------
      // 6. create_plan — POST a new plan
      // -----------------------------------------------------------------
      case 'pco_preview_create_plan': {
        const schema = z.object({
          serviceTypeId: z.string(),
          sortDate: z.string(),
          title: z.string().optional(),
          seriesTitle: z.string().optional(),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableTargets([parsed.serviceTypeId]);
        if (writableError) return JSON.stringify(toolError(writableError));

        const plansEndpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans`;
        const attributes: Record<string, unknown> = { sort_date: parsed.sortDate };
        if (parsed.title !== undefined) attributes.title = parsed.title;
        if (parsed.seriesTitle !== undefined) attributes.series_title = parsed.seriesTitle;

        const applyBody = { data: { type: 'Plan', attributes } };

        const change: PreviewChange = {
          serviceTypeId: parsed.serviceTypeId,
          planId: '',
          planDate: parsed.sortDate,
          itemId: '',
          beforeAttributes: {},
          afterAttributes: attributes,
          reason: `Create plan in service type ${parsed.serviceTypeId} for ${parsed.sortDate}`,
          applyMethod: 'POST',
          applyEndpoint: plansEndpoint,
          applyBody,
          rollbackMethod: 'DELETE',
          // rollbackEndpoint set on apply once planId is known
        };

        const op = createPreviewOperation('create_plan', [change], {
          serviceTypeId: parsed.serviceTypeId,
          sortDate: parsed.sortDate,
          title: parsed.title ?? null,
          seriesTitle: parsed.seriesTitle ?? null,
          note: 'Rollback DELETEs the plan; PCO may refuse if the plan has items or people scheduled.',
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: summarizePreviewChanges([change]),
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: plansEndpoint,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_create_plan': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
        });
        const parsed = schema.parse(args);
        const op = getPreviewOperation(parsed.previewToken, 'create_plan');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for create_plan operation. Run preview again.'));

        const writableError = validateWritableTargets(op.changes.map((change) => change.serviceTypeId));
        if (writableError) return JSON.stringify(toolError(writableError));

        const applied: PreviewChange[] = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            const result = await client.post<any>(change.applyEndpoint as string, change.applyBody);
            const createdId = String(result?.data?.id ?? '');
            const appliedChange: PreviewChange = {
              ...change,
              planId: createdId || change.planId,
              createdResourceId: createdId,
              createdResourceType: 'Plan',
              rollbackEndpoint: createdId
                ? `${change.applyEndpoint}/${createdId}`
                : undefined,
              rollbackMethod: createdId ? 'DELETE' : 'NONE',
            };
            applied.push(appliedChange);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Services') });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `create_plan_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'create_plan',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped,
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          applied,
          skipped,
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/services/v2/service_types/*/plans',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_plan_times_detailed': {
        const schema = z.object({
          serviceTypeId: z.string(),
          planId: z.string(),
          timeZone: z.string().optional().default('UTC'),
        });
        const parsed = schema.parse(args);

        const endpoint = `/services/v2/service_types/${parsed.serviceTypeId}/plans/${parsed.planId}/plan_times`;
        const response = await client.get<any>(endpoint, { per_page: 100 });
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: parsed.timeZone,
          weekday: 'short',
          month: 'short',
          day: '2-digit',
          hour: 'numeric',
          minute: '2-digit',
        });

        const times = Array.isArray(response.data)
          ? response.data.map((r: any) => {
              const flat = client.flatten(r);
              const startsAtRaw = (flat.starts_at ?? flat.begins_at ?? null) as string | null;
              const endsAtRaw = (flat.ends_at ?? null) as string | null;
              const label = String(flat.name ?? flat.time_type ?? flat.kind ?? flat.service_time_name ?? 'Plan Time');
              const inferredCategory = /rehearsal|run ?through|sound ?check/i.test(label) ? 'rehearsal' : 'service';
              return {
                id: flat.id,
                label,
                category: inferredCategory,
                startsAt: startsAtRaw,
                endsAt: endsAtRaw,
                startsAtLocal: startsAtRaw ? formatter.format(new Date(startsAtRaw)) : null,
                endsAtLocal: endsAtRaw ? formatter.format(new Date(endsAtRaw)) : null,
              };
            })
          : [];

        return JSON.stringify(toolSuccess({
          planTimes: times,
          timeZone: parsed.timeZone,
        }, {
          count: times.length,
          pcoEndpoint: endpoint,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_services_preview_summary': {
        const schema = z.object({
          previewToken: z.string(),
        });
        const parsed = schema.parse(args);
        const op = previewOperations.get(parsed.previewToken);
        if (!op) {
          return JSON.stringify(toolError('Unknown or expired previewToken.'));
        }

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          kind: op.kind,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          summary: summarizePreviewChanges(op.changes),
          sampleChanges: op.changes.slice(0, 20),
        }, {
          count: op.changes.length,
          pcoEndpoint: 'services-preview-summary',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_services_write_audit_log': {
        const schema = z.object({
          limit: z.number().int().positive().max(100).optional().default(20),
        });
        const parsed = schema.parse(args);
        pruneAuditOperations();

        const operations = Array.from(auditOperations.values())
          .sort((a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime())
          .slice(0, parsed.limit)
          .map((op) => ({
            operationId: op.operationId,
            kind: op.kind,
            appliedAt: op.appliedAt,
            sourcePreviewToken: op.sourcePreviewToken,
            appliedCount: op.applied.length,
            skippedCount: op.skipped.length,
            errorCount: op.errors.length,
            summary: summarizePreviewChanges(op.applied),
          }));

        return JSON.stringify(toolSuccess({ operations }, {
          count: operations.length,
          pcoEndpoint: 'services-write-audit',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_rollback_services_write_operation': {
        const schema = z.object({
          operationId: z.string(),
          confirmPhrase: z.literal('ROLLBACK_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(100),
          requireCurrentValueMatch: z.boolean().optional().default(true),
        });
        const parsed = schema.parse(args);
        const operation = getAuditOperation(parsed.operationId);
        if (!operation) {
          return JSON.stringify(toolError('Unknown operationId (or it has expired from audit history).'));
        }

        if (operation.irreversible) {
          return JSON.stringify(toolError(
            `This operation type is irreversible. Audit only.${operation.irreversibleReason ? ` Reason: ${operation.irreversibleReason}` : ''}`
          ));
        }

        if (operation.applied.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Operation has ${operation.applied.length} applied changes, exceeding maxChanges=${parsed.maxChanges}.`));
        }

        const writableError = validateWritableTargets(operation.applied.map((change) => change.serviceTypeId));
        if (writableError) {
          return JSON.stringify(toolError(writableError));
        }

        const rolledBack: PreviewChange[] = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of operation.applied) {
          // New kinds carry explicit rollback metadata; legacy kinds fall back to PATCH item with beforeAttributes.
          const useGenericRollback = Boolean(change.rollbackMethod && change.rollbackEndpoint);
          const itemEndpoint = `/services/v2/service_types/${change.serviceTypeId}/plans/${change.planId}/items/${change.itemId}`;
          try {
            if (!useGenericRollback && parsed.requireCurrentValueMatch) {
              const current = await client.get<any>(itemEndpoint);
              const currentFlat = current?.data ? client.flatten(current.data) : null;
              let mismatch = false;
              for (const [key, expected] of Object.entries(change.afterAttributes)) {
                if ((currentFlat as any)?.[key] !== expected) {
                  mismatch = true;
                  break;
                }
              }
              if (mismatch) {
                skipped.push({ ...change, reason: 'Current value no longer matches post-apply state.' });
                continue;
              }
            }

            if (useGenericRollback) {
              const method = change.rollbackMethod;
              const endpoint = change.rollbackEndpoint as string;
              if (method === 'NONE') {
                skipped.push({ ...change, reason: 'No rollback action recorded for this change.' });
                continue;
              }
              if (method === 'DELETE') {
                await client.delete(endpoint);
              } else if (method === 'POST') {
                await client.post(endpoint, change.rollbackBody ?? {});
              } else {
                // default PATCH
                await client.patch(endpoint, change.rollbackBody ?? { data: { type: 'Item', attributes: change.beforeAttributes } });
              }
            } else {
              await client.patch(itemEndpoint, {
                data: {
                  type: 'Item',
                  attributes: change.beforeAttributes,
                },
              });
            }
            rolledBack.push(change);
          } catch (err) {
            errors.push({
              ...change,
              error: PlanningCenterClient.formatError(err, 'Services'),
            });
          }
        }

        const rollbackOperationId = `rollback_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId: rollbackOperationId,
          kind: operation.kind,
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.operationId,
          applied: rolledBack.map((change) => ({
            ...change,
            beforeAttributes: change.afterAttributes,
            afterAttributes: change.beforeAttributes,
            reason: `Rollback of ${parsed.operationId}`,
          })),
          skipped,
          errors,
        });

        return JSON.stringify(toolSuccess({
          rollbackOperationId,
          sourceOperationId: parsed.operationId,
          attempted: operation.applied.length,
          rolledBackCount: rolledBack.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          rolledBack,
          skipped,
          errors,
        }, {
          count: rolledBack.length,
          pcoEndpoint: '/services/v2/service_types/*/plans/*/items/*',
          executionMs: Date.now() - start,
        }));
      }

      default:
        return JSON.stringify(toolError(`Unknown services tool: ${name}`));
    }
  } catch (err) {
    return JSON.stringify(
      toolError(PlanningCenterClient.formatError(err, 'Services'), {
        pcoEndpoint: name,
        executionMs: Date.now() - start,
      })
    );
  }
}

/** Return tool definitions for registration in index.ts */
export function getServicesToolDefinitions() {
  return [
    {
      name: 'pco_get_service_types',
      description:
        'Get all service types configured in Planning Center Services (e.g., "Sunday Morning," "Wednesday Night," "Online Campus"). Call this first when working with services to get the serviceTypeId values needed by other tools.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      },
    },
    {
      name: 'pco_get_upcoming_services',
      description:
        'Get upcoming service plans within a date range for a specific service type. Returns plan dates, titles, series titles, and key counts. Use get_service_types first to find the serviceTypeId.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID (from get_service_types)' },
          daysAhead: { type: 'number', description: 'Number of days ahead to look (default 14)' },
        },
        required: ['serviceTypeId'],
      },
    },
    {
      name: 'pco_get_plan_teams',
      description:
        "Get all volunteer teams and their scheduling status for a specific service plan. Shows each team's name and member statuses. Useful for identifying volunteer gaps. Use get_service_types and get_upcoming_services first to find serviceTypeId and planId.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID (from get_service_types)' },
          planId: { type: 'string', description: 'The plan ID (from get_upcoming_services)' },
        },
        required: ['serviceTypeId', 'planId'],
      },
    },
    {
      name: 'pco_get_unfilled_positions',
      description:
        'Find volunteer positions in upcoming services that have no one scheduled (status U or D). Returns service dates, team names, and position names so staff can identify gaps.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID' },
          daysAhead: { type: 'number', description: 'Number of days ahead to look (default 14)' },
        },
        required: ['serviceTypeId'],
      },
    },
    {
      name: 'pco_get_plan_items',
      description:
        'Get the full service order/rundown for a specific plan — every item in sequence including songs (with title, author, key, arrangement), headers, media, and item notes. Use get_service_types and get_upcoming_services first to find serviceTypeId and planId.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID (from get_service_types)' },
          planId: { type: 'string', description: 'The plan ID (from get_upcoming_services)' },
        },
        required: ['serviceTypeId', 'planId'],
      },
    },
    {
      name: 'pco_get_service_attendance',
      description:
        'Get headcount attendance for a past service plan. Returns plan time data with any available headcount information. Use get_service_types and get_upcoming_services first to find serviceTypeId and planId.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID (from get_service_types)' },
          planId: { type: 'string', description: 'The plan ID' },
        },
        required: ['serviceTypeId', 'planId'],
      },
    },
    {
      name: 'pco_analyze_volunteer_scheduling',
      description:
        'Analyze volunteer scheduling patterns over the last N weeks for a service type. Returns: top volunteers by frequency, reliability rates (confirmed vs declined), team fill rates, and chronic decliners. Use for "who are our most reliable volunteers", "which teams are understaffed", or "predict staffing needs" questions.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID' },
          weeks: { type: 'number', description: 'Weeks of history to analyze (default 12)' },
        },
        required: ['serviceTypeId'],
      },
    },
    {
      name: 'pco_search_songs',
      description:
        'Search the Planning Center song library by title. Returns matching songs with CCLI number, copyright info, and when each was last scheduled.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query (song title)' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'pco_preview_item_title_replace',
      description:
        'Preview bulk item title find/replace across service types and weekend date ranges. This is a dry-run that returns a previewToken and exact item diffs; it does not write changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          targetServiceTypeIds: { type: 'array', items: { type: 'string' }, description: 'Service type IDs to scan' },
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          findText: { type: 'string', description: 'Text or regex to find' },
          replaceText: { type: 'string', description: 'Replacement text' },
          matchMode: { type: 'string', enum: ['exact', 'contains', 'regex'], description: 'Match mode (default exact)' },
          itemType: { type: 'string', enum: ['song', 'media', 'header', 'regular'], description: 'Optional item type filter' },
          caseSensitive: { type: 'boolean', description: 'Case sensitive matching (default false)' },
          maxPlansScanned: { type: 'number', description: 'Safety limit on plans scanned (default 200)' },
        },
        required: ['targetServiceTypeIds', 'startDate', 'endDate', 'findText', 'replaceText'],
      },
    },
    {
      name: 'pco_apply_item_title_replace',
      description:
        'Apply a previously previewed title replace operation using previewToken and explicit confirmation phrase. Services-only write operation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned by pco_preview_item_title_replace' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to allow from preview (default 100)' },
          requireCurrentValueMatch: { type: 'boolean', description: 'Skip if item changed since preview (default true)' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_sync_item_from_reference_plan',
      description:
        'Preview syncing selected item fields from one reference plan item to matching items in target plans. Dry-run only; returns previewToken and diffs.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          reference: { type: 'object', description: 'Reference item locator: serviceTypeId, planId, itemSelector' },
          targets: { type: 'array', items: { type: 'object' }, description: 'Target item locators: serviceTypeId, planId, itemSelector[]' },
          fields: { type: 'array', items: { type: 'string', enum: ['title', 'description', 'notes'] }, description: 'Fields to sync (default title)' },
        },
        required: ['reference', 'targets'],
      },
    },
    {
      name: 'pco_apply_sync_item_from_reference_plan',
      description:
        'Apply a previewed reference sync operation via previewToken and confirmation phrase. Services-only write operation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned by pco_preview_sync_item_from_reference_plan' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to allow from preview (default 100)' },
          requireCurrentValueMatch: { type: 'boolean', description: 'Skip if item changed since preview (default true)' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_get_plan_times_detailed',
      description:
        'Return detailed plan times including rehearsal/service labels and local formatted clock times for a plan.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID' },
          planId: { type: 'string', description: 'The plan ID' },
          timeZone: { type: 'string', description: 'IANA timezone for local formatting (default UTC)' },
        },
        required: ['serviceTypeId', 'planId'],
      },
    },
    {
      name: 'pco_get_services_preview_summary',
      description:
        'Summarize a preview token into grouped dry-run stats by service type, plan, and item type before applying changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned from a preview write tool' },
        },
        required: ['previewToken'],
      },
    },
    {
      name: 'pco_get_services_write_audit_log',
      description:
        'List recent Services write operations (apply/rollback) with summary counts for auditing.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max operations to return (default 20, max 100)' },
        },
        required: [] as string[],
      },
    },
    {
      name: 'pco_rollback_services_write_operation',
      description:
        'Rollback a prior Services write operation by restoring each changed item to its previous values. Refuses for irreversible operations (e.g. schedule_position, which has already sent a notification email).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          operationId: { type: 'string', description: 'Operation ID returned by apply tool' },
          confirmPhrase: { type: 'string', enum: ['ROLLBACK_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to rollback (default 100)' },
          requireCurrentValueMatch: { type: 'boolean', description: 'Skip if current item no longer matches applied state (default true)' },
        },
        required: ['operationId', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_add_song_to_plan',
      description:
        'Preview inserting a song item at the given position (1-based sequence) on a service plan. Dry-run only — returns previewToken and the planned insertion. Apply via pco_apply_add_song_to_plan.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID' },
          planId: { type: 'string', description: 'The plan ID' },
          songId: { type: 'string', description: 'The PCO Song ID to add' },
          position: { type: 'number', description: 'Target sequence position (1-based)' },
          arrangementId: { type: 'string', description: 'Optional arrangement ID' },
          key: { type: 'string', description: 'Optional key name (e.g. "G", "Am")' },
        },
        required: ['serviceTypeId', 'planId', 'songId', 'position'],
      },
    },
    {
      name: 'pco_apply_add_song_to_plan',
      description:
        'Apply a previewed add_song operation, inserting the song into the plan items. Reversible via pco_rollback_services_write_operation (DELETEs the created item).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token from pco_preview_add_song_to_plan' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_reorder_plan_items',
      description:
        'Preview reordering plan items by passing the full list of item IDs in the desired order. Dry-run — returns previewToken and per-item sequence diffs.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID' },
          planId: { type: 'string', description: 'The plan ID' },
          itemIdsInOrder: { type: 'array', items: { type: 'string' }, description: 'Item IDs in the desired final order' },
        },
        required: ['serviceTypeId', 'planId', 'itemIdsInOrder'],
      },
    },
    {
      name: 'pco_apply_reorder_plan_items',
      description:
        'Apply a previewed reorder operation, PATCHing each item to its new sequence. Reversible via pco_rollback_services_write_operation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token from pco_preview_reorder_plan_items' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_set_item_key_or_tempo',
      description:
        'Preview updating a song item\'s key, length, or arrangement. Dry-run — returns previewToken and diff.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID' },
          planId: { type: 'string', description: 'The plan ID' },
          itemId: { type: 'string', description: 'The item ID' },
          key: { type: 'string', description: 'Optional new key name' },
          length: { type: 'number', description: 'Optional new length in seconds' },
          arrangementId: { type: 'string', description: 'Optional new arrangement ID' },
        },
        required: ['serviceTypeId', 'planId', 'itemId'],
      },
    },
    {
      name: 'pco_apply_set_item_key_or_tempo',
      description:
        'Apply a previewed song-item key/length/arrangement change. Reversible via pco_rollback_services_write_operation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token from pco_preview_set_item_key_or_tempo' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_schedule_position',
      description:
        'Preview scheduling a person to a team position for a plan. IRREVERSIBLE — applying will send a notification email to the volunteer. Preview shows recipient, position, and plan date.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID' },
          planId: { type: 'string', description: 'The plan ID' },
          teamId: { type: 'string', description: 'The team ID' },
          personId: { type: 'string', description: 'The person ID' },
          positionName: { type: 'string', description: 'The position name on the team' },
        },
        required: ['serviceTypeId', 'planId', 'teamId', 'personId', 'positionName'],
      },
    },
    {
      name: 'pco_apply_schedule_position',
      description:
        'Apply a previewed schedule_position operation. IRREVERSIBLE — PCO sends a notification email to the volunteer. Rollback will refuse with an irreversibility error.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token from pco_preview_schedule_position' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_confirm_or_decline_position',
      description:
        'Preview setting a PlanPerson status to C (confirmed) or D (declined). Reversible. Dry-run — returns previewToken and before/after status.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID' },
          planId: { type: 'string', description: 'The plan ID' },
          planPersonId: { type: 'string', description: 'The PlanPerson (team_members) ID' },
          status: { type: 'string', enum: ['C', 'D'], description: 'C=confirmed, D=declined' },
        },
        required: ['serviceTypeId', 'planId', 'planPersonId', 'status'],
      },
    },
    {
      name: 'pco_apply_confirm_or_decline_position',
      description:
        'Apply a previewed confirm/decline operation, PATCHing the PlanPerson status. Reversible via pco_rollback_services_write_operation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token from pco_preview_confirm_or_decline_position' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_create_plan',
      description:
        'Preview creating a new service plan. Dry-run — returns previewToken and the planned attributes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          serviceTypeId: { type: 'string', description: 'The service type ID' },
          sortDate: { type: 'string', description: 'ISO date for sort_date (e.g. "2026-06-07T16:00:00Z")' },
          title: { type: 'string', description: 'Optional plan title' },
          seriesTitle: { type: 'string', description: 'Optional series title' },
        },
        required: ['serviceTypeId', 'sortDate'],
      },
    },
    {
      name: 'pco_apply_create_plan',
      description:
        'Apply a previewed create_plan operation. Reversible via pco_rollback_services_write_operation (DELETE the created plan). PCO may refuse the DELETE if the plan has items or people scheduled.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token from pco_preview_create_plan' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
  ];
}
