import crypto from 'node:crypto';
import { z } from 'zod';
import { PlanningCenterClient } from '../client.js';
import { toolSuccess, toolError } from '../response.js';

// ===== People-writes preview / apply / audit / rollback infrastructure =====

type PeopleWriteKind =
  | 'people_add_note'
  | 'people_update_person_field'
  | 'people_add_to_list'
  | 'people_remove_from_list'
  | 'people_create_workflow_card'
  | 'people_update_household_membership';

type PeoplePreviewChange = {
  beforeAttributes: Record<string, unknown>;
  afterAttributes: Record<string, unknown>;
  // Resource pointers (varies per verb)
  personId?: string;
  noteCategoryId?: string;
  listId?: string;
  workflowId?: string;
  householdId?: string;
  assigneeId?: string;
  // Apply-time results (set during apply, used during rollback)
  createdId?: string;
  membershipId?: string;
  reason?: string;
};

type PeoplePreviewOperation = {
  token: string;
  kind: PeopleWriteKind;
  createdAt: string;
  expiresAt: string;
  changes: PeoplePreviewChange[];
  summary: Record<string, unknown>;
};

type PeopleAppliedOperation = {
  operationId: string;
  kind: PeopleWriteKind;
  appliedAt: string;
  sourcePreviewToken: string;
  applied: PeoplePreviewChange[];
  skipped: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  irreversible?: boolean;
  irreversibleReason?: string;
};

const PEOPLE_PREVIEW_TTL_MS = 15 * 60_000;
const PEOPLE_AUDIT_TTL_MS = 7 * 24 * 60 * 60_000;
const peoplePreviewOperations = new Map<string, PeoplePreviewOperation>();
const peopleAuditOperations = new Map<string, PeopleAppliedOperation>();

function prunePeoplePreviewOperations() {
  const now = Date.now();
  for (const [token, op] of peoplePreviewOperations.entries()) {
    if (new Date(op.expiresAt).getTime() <= now) {
      peoplePreviewOperations.delete(token);
    }
  }
}

function createPeoplePreviewOperation(
  kind: PeopleWriteKind,
  changes: PeoplePreviewChange[],
  summary: Record<string, unknown>
): PeoplePreviewOperation {
  prunePeoplePreviewOperations();
  const token = `preview_${crypto.randomBytes(18).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PEOPLE_PREVIEW_TTL_MS).toISOString();
  const op: PeoplePreviewOperation = { token, kind, createdAt, expiresAt, changes, summary };
  peoplePreviewOperations.set(token, op);
  return op;
}

function getPeoplePreviewOperation(token: string, kind: PeopleWriteKind) {
  prunePeoplePreviewOperations();
  const op = peoplePreviewOperations.get(token);
  if (!op || op.kind !== kind) return null;
  if (new Date(op.expiresAt).getTime() <= Date.now()) {
    peoplePreviewOperations.delete(token);
    return null;
  }
  return op;
}

function prunePeopleAuditOperations() {
  const now = Date.now();
  for (const [operationId, op] of peopleAuditOperations.entries()) {
    if (new Date(op.appliedAt).getTime() + PEOPLE_AUDIT_TTL_MS <= now) {
      peopleAuditOperations.delete(operationId);
    }
  }
}

function savePeopleAuditOperation(operation: PeopleAppliedOperation) {
  prunePeopleAuditOperations();
  peopleAuditOperations.set(operation.operationId, operation);
}

function getPeopleAuditOperation(operationId: string) {
  prunePeopleAuditOperations();
  return peopleAuditOperations.get(operationId) ?? null;
}

function getPeopleWritesEnabled(): boolean {
  const raw = process.env.PCO_PEOPLE_WRITES_ENABLED?.trim();
  if (!raw) return false;
  return raw.toLowerCase() !== 'false' && raw !== '0' && raw !== '';
}

function peopleWritesDisabledError(): string {
  return 'People writes are disabled. Set PCO_PEOPLE_WRITES_ENABLED=true to enable.';
}

function getWritableListIdAllowlist(): Set<string> | null {
  const raw = process.env.PCO_WRITABLE_LIST_IDS?.trim();
  if (!raw) return null;
  const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  return new Set(ids);
}

function validateWritableListId(listId: string): string | null {
  const allow = getWritableListIdAllowlist();
  if (!allow) return null; // unset = allow all
  if (!allow.has(listId)) {
    return `List ID ${listId} is not in PCO_WRITABLE_LIST_IDS allowlist.`;
  }
  return null;
}

const PERSON_WRITABLE_FIELDS = [
  'nickname',
  'first_name',
  'last_name',
  'middle_name',
  'birthdate',
  'anniversary',
  'gender',
  'grade',
  'school_id',
] as const;
type PersonWritableField = (typeof PERSON_WRITABLE_FIELDS)[number];

function newOperationId(kind: PeopleWriteKind): string {
  return `${kind}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

/** Handle a People module tool call */
export async function handlePeopleTool(
  name: string,
  args: Record<string, unknown>,
  client: PlanningCenterClient
): Promise<string> {
  const start = Date.now();

  try {
    switch (name) {
      case 'pco_search_people': {
        const schema = z.object({
          query: z.string(),
          limit: z.number().optional().default(20),
        });
        const parsed = schema.parse(args);

        const response = await client.get<any>('/people/v2/people', {
          'where[search_name]': parsed.query,
          per_page: parsed.limit,
          include: 'emails,phone_numbers',
        });

        const people = Array.isArray(response.data)
          ? response.data.map((r: any) => {
              const flat = client.flatten(r);
              // Resolve included emails and phone numbers
              const personEmails = (r.relationships?.emails?.data ?? []).map((ref: any) =>
                client.resolveIncludes(ref.id, 'Email', response.included ?? [])
              ).filter(Boolean);
              const personPhones = (r.relationships?.phone_numbers?.data ?? []).map((ref: any) =>
                client.resolveIncludes(ref.id, 'PhoneNumber', response.included ?? [])
              ).filter(Boolean);
              return { ...flat, email_addresses: personEmails, phone_numbers: personPhones };
            })
          : [];

        return JSON.stringify(toolSuccess(people, {
          count: people.length,
          totalCount: response.meta?.total_count,
          pcoEndpoint: '/people/v2/people',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_person': {
        const schema = z.object({ personId: z.string() });
        const parsed = schema.parse(args);

        const response = await client.get<any>(
          `/people/v2/people/${parsed.personId}`,
          { include: 'emails,phone_numbers,addresses,households' }
        );

        const person = client.flatten(response.data);
        const included = response.included ?? [];

        const emails = (response.data.relationships?.emails?.data ?? [])
          .map((ref: any) => client.resolveIncludes(ref.id, 'Email', included))
          .filter(Boolean);
        const phones = (response.data.relationships?.phone_numbers?.data ?? [])
          .map((ref: any) => client.resolveIncludes(ref.id, 'PhoneNumber', included))
          .filter(Boolean);
        const addresses = (response.data.relationships?.addresses?.data ?? [])
          .map((ref: any) => client.resolveIncludes(ref.id, 'Address', included))
          .filter(Boolean);
        const households = (response.data.relationships?.households?.data ?? [])
          .map((ref: any) => client.resolveIncludes(ref.id, 'Household', included))
          .filter(Boolean);

        return JSON.stringify(toolSuccess(
          { ...person, email_addresses: emails, phone_numbers: phones, addresses, households },
          {
            pcoEndpoint: `/people/v2/people/${parsed.personId}`,
            executionMs: Date.now() - start,
          }
        ));
      }

      case 'pco_list_saved_lists': {
        const { items, totalCount } = await client.paginate(
          '/people/v2/lists',
          { order: 'name' }
        );

        return JSON.stringify(toolSuccess(items, {
          count: items.length,
          totalCount,
          pcoEndpoint: '/people/v2/lists',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_people_by_list': {
        const schema = z.object({ listId: z.string() });
        const parsed = schema.parse(args);

        const { items, totalCount } = await client.paginate(
          `/people/v2/lists/${parsed.listId}/people`,
          { per_page: 100 }
        );

        return JSON.stringify(toolSuccess(items, {
          count: items.length,
          totalCount,
          hasMore: items.length < totalCount,
          pcoEndpoint: `/people/v2/lists/${parsed.listId}/people`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_people_stats': {
        // Use per_page=1 requests to get total_count from meta without fetching all records
        const totalResponse = await client.get<any>('/people/v2/people', { per_page: 1 });
        const totalCount = totalResponse.meta?.total_count ?? 0;

        // Get counts by status
        const statuses = ['active', 'inactive'];
        const statusCounts: Record<string, number> = {};
        for (const status of statuses) {
          try {
            const resp = await client.get<any>('/people/v2/people', {
              per_page: 1,
              'where[status]': status,
            });
            statusCounts[status] = resp.meta?.total_count ?? 0;
          } catch {
            statusCounts[status] = -1; // couldn't query
          }
        }

        // Get counts by membership
        const memberships = ['Member', 'Regular Attender', 'Visitor', 'No Membership'];
        const membershipCounts: Record<string, number> = {};
        for (const membership of memberships) {
          try {
            const resp = await client.get<any>('/people/v2/people', {
              per_page: 1,
              'where[membership]': membership,
            });
            membershipCounts[membership] = resp.meta?.total_count ?? 0;
          } catch {
            // Some orgs may not use this field
          }
        }

        // Recently added (last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
        const recentResponse = await client.get<any>('/people/v2/people', {
          per_page: 1,
          'where[created_at][gte]': thirtyDaysAgo.toISOString(),
        });
        const recentlyAdded = recentResponse.meta?.total_count ?? 0;

        return JSON.stringify(toolSuccess(
          {
            totalPeople: totalCount,
            byStatus: statusCounts,
            byMembership: membershipCounts,
            addedLast30Days: recentlyAdded,
          },
          {
            pcoEndpoint: '/people/v2/people',
            executionMs: Date.now() - start,
          }
        ));
      }

      case 'pco_get_people_by_status': {
        const schema = z.object({
          status: z.enum(['active', 'inactive']),
          limit: z.number().optional().default(50),
        });
        const parsed = schema.parse(args);

        const response = await client.get<any>('/people/v2/people', {
          'where[status]': parsed.status,
          per_page: parsed.limit,
          order: '-updated_at',
          include: 'emails',
        });

        const people = Array.isArray(response.data)
          ? response.data.map((r: any) => {
              const flat = client.flatten(r);
              const personEmails = (r.relationships?.emails?.data ?? []).map((ref: any) =>
                client.resolveIncludes(ref.id, 'Email', response.included ?? [])
              ).filter(Boolean);
              return { ...flat, email_addresses: personEmails };
            })
          : [];

        return JSON.stringify(toolSuccess(people, {
          count: people.length,
          totalCount: response.meta?.total_count,
          hasMore: people.length < (response.meta?.total_count ?? 0),
          pcoEndpoint: '/people/v2/people',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_people_by_membership': {
        const schema = z.object({
          membership: z.string(),
          limit: z.number().optional().default(50),
        });
        const parsed = schema.parse(args);

        const response = await client.get<any>('/people/v2/people', {
          'where[membership]': parsed.membership,
          per_page: parsed.limit,
          order: 'last_name',
          include: 'emails',
        });

        const people = Array.isArray(response.data)
          ? response.data.map((r: any) => {
              const flat = client.flatten(r);
              const personEmails = (r.relationships?.emails?.data ?? []).map((ref: any) =>
                client.resolveIncludes(ref.id, 'Email', response.included ?? [])
              ).filter(Boolean);
              return { ...flat, email_addresses: personEmails };
            })
          : [];

        return JSON.stringify(toolSuccess(people, {
          count: people.length,
          totalCount: response.meta?.total_count,
          hasMore: people.length < (response.meta?.total_count ?? 0),
          pcoEndpoint: '/people/v2/people',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_new_people': {
        const schema = z.object({
          days: z.number().optional().default(30),
          limit: z.number().optional().default(100),
        });
        const parsed = schema.parse(args);

        const since = new Date();
        since.setUTCDate(since.getUTCDate() - parsed.days);
        const sinceISO = since.toISOString();

        const response = await client.get<any>('/people/v2/people', {
          order: '-created_at',
          'where[created_at][gte]': sinceISO,
          per_page: parsed.limit,
          include: 'emails',
        });

        const people = Array.isArray(response.data)
          ? response.data.map((r: any) => {
              const flat = client.flatten(r);
              const personEmails = (r.relationships?.emails?.data ?? []).map((ref: any) =>
                client.resolveIncludes(ref.id, 'Email', response.included ?? [])
              ).filter(Boolean);
              return { ...flat, email_addresses: personEmails };
            })
          : [];

        return JSON.stringify(toolSuccess(people, {
          count: people.length,
          totalCount: response.meta?.total_count,
          pcoEndpoint: '/people/v2/people',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_identify_at_risk_members': {
        const schema = z.object({
          inactiveWeeks: z.number().optional().default(6),
          limit: z.number().optional().default(100),
        });
        const parsed = schema.parse(args);

        // Find people who haven't checked in recently
        // Strategy: get check-ins from the last N weeks, build a set of active person IDs,
        // then compare against people with status=active who are NOT in that set
        const cutoffDate = new Date();
        cutoffDate.setUTCDate(cutoffDate.getUTCDate() - parsed.inactiveWeeks * 7);

        // Get recent check-ins to find who IS active
        const { items: recentCheckins } = await client.paginateWithIncludes(
          '/check-ins/v2/check_ins',
          {
            'where[checked_in_at][gte]': cutoffDate.toISOString(),
            per_page: 100,
          },
          20
        );

        const recentlyActiveIds = new Set<string>();
        for (const checkin of recentCheckins) {
          const personId = (checkin as any).person_id as string;
          if (personId) recentlyActiveIds.add(personId);
        }

        // Get active people who were created before the cutoff (not brand new)
        const createdBefore = new Date();
        createdBefore.setUTCDate(createdBefore.getUTCDate() - parsed.inactiveWeeks * 7 * 2);

        const { items: activePeople, totalCount } = await client.paginate(
          '/people/v2/people',
          {
            'where[status]': 'active',
            'where[created_at][lte]': createdBefore.toISOString(),
            per_page: 100,
            order: 'last_name',
          },
          Math.ceil(parsed.limit / 100) + 1
        );

        // Filter to those NOT in recent check-ins
        const atRisk = activePeople
          .filter((p: any) => !recentlyActiveIds.has(p.id as string))
          .slice(0, parsed.limit)
          .map((p: any) => ({
            id: p.id,
            name: p.name,
            first_name: p.first_name,
            last_name: p.last_name,
            status: p.status,
            membership: p.membership,
            created_at: p.created_at,
            updated_at: p.updated_at,
          }));

        return JSON.stringify(toolSuccess(
          {
            criteria: `Active people with no check-in in the last ${parsed.inactiveWeeks} weeks`,
            atRiskCount: atRisk.length,
            recentlyActivePeopleCount: recentlyActiveIds.size,
            totalActivePeople: totalCount,
            atRiskMembers: atRisk,
          },
          {
            count: atRisk.length,
            pcoEndpoint: '/check-ins/v2/check_ins + /people/v2/people',
            executionMs: Date.now() - start,
          }
        ));
      }

      case 'pco_get_engagement_summary': {
        // Cross-module summary: people counts, group participation, recent check-in activity
        const results: Record<string, any> = {};

        // Total people by status
        const totalResp = await client.get<any>('/people/v2/people', { per_page: 1 });
        results.totalPeople = totalResp.meta?.total_count ?? 0;

        try {
          const activeResp = await client.get<any>('/people/v2/people', {
            per_page: 1,
            'where[status]': 'active',
          });
          results.activePeople = activeResp.meta?.total_count ?? 0;
          results.inactivePeople = results.totalPeople - results.activePeople;
        } catch {
          results.activePeople = 'unknown';
        }

        // Groups
        try {
          const groupsResp = await client.get<any>('/groups/v2/groups', { per_page: 1 });
          results.totalGroups = groupsResp.meta?.total_count ?? 0;
        } catch {
          results.totalGroups = 'module not accessible';
        }

        // Recent check-ins (last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
        try {
          const checkinResp = await client.get<any>('/check-ins/v2/check_ins', {
            per_page: 1,
            'where[checked_in_at][gte]': sevenDaysAgo.toISOString(),
          });
          results.checkInsLast7Days = checkinResp.meta?.total_count ?? 0;
        } catch {
          results.checkInsLast7Days = 'module not accessible';
        }

        // First-time visitors last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
        try {
          const firstTimeResp = await client.get<any>('/check-ins/v2/check_ins', {
            per_page: 1,
            'where[kind]': 'first_time',
            'where[checked_in_at][gte]': thirtyDaysAgo.toISOString(),
          });
          results.firstTimeVisitorsLast30Days = firstTimeResp.meta?.total_count ?? 0;
        } catch {
          results.firstTimeVisitorsLast30Days = 'module not accessible';
        }

        // New people added last 30 days
        try {
          const newPeopleResp = await client.get<any>('/people/v2/people', {
            per_page: 1,
            'where[created_at][gte]': thirtyDaysAgo.toISOString(),
          });
          results.newPeopleLast30Days = newPeopleResp.meta?.total_count ?? 0;
        } catch {
          results.newPeopleLast30Days = 'unknown';
        }

        // Upcoming registration events
        try {
          const regResp = await client.get<any>('/registrations/v2/events', {
            per_page: 1,
            filter: 'upcoming',
          });
          results.upcomingRegistrationEvents = regResp.meta?.total_count ?? 0;
        } catch {
          results.upcomingRegistrationEvents = 'module not accessible';
        }

        return JSON.stringify(toolSuccess(results, {
          pcoEndpoint: 'multiple endpoints',
          executionMs: Date.now() - start,
        }));
      }

      // ============================================================
      // People WRITE tools (preview / apply / rollback per verb)
      // ============================================================

      case 'pco_preview_add_note': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          personId: z.string(),
          noteCategoryId: z.string(),
          text: z.string().min(1),
        });
        const parsed = schema.parse(args);

        // Confirm the person exists; record name for summary
        let personName = parsed.personId;
        try {
          const personResp = await client.get<any>(`/people/v2/people/${parsed.personId}`);
          personName = String(personResp?.data?.attributes?.name ?? parsed.personId);
        } catch (err) {
          return JSON.stringify(toolError(PlanningCenterClient.formatError(err, 'People')));
        }

        const change: PeoplePreviewChange = {
          personId: parsed.personId,
          noteCategoryId: parsed.noteCategoryId,
          beforeAttributes: {},
          afterAttributes: { note: parsed.text },
          reason: 'Append note to person',
        };

        const op = createPeoplePreviewOperation('people_add_note', [change], {
          personId: parsed.personId,
          personName,
          noteCategoryId: parsed.noteCategoryId,
          previewText: parsed.text,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: op.summary,
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: `/people/v2/people/${parsed.personId}/notes`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_add_note': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(10),
        });
        const parsed = schema.parse(args);
        const op = getPeoplePreviewOperation(parsed.previewToken, 'people_add_note');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for add_note. Run preview again.'));
        }
        if (op.changes.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Preview contains ${op.changes.length} changes, exceeds maxChanges=${parsed.maxChanges}.`));
        }

        const applied: PeoplePreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            const resp = await client.post<any>(`/people/v2/people/${change.personId}/notes`, {
              data: {
                type: 'Note',
                attributes: { note: change.afterAttributes.note },
                relationships: {
                  note_category: {
                    data: { type: 'NoteCategory', id: change.noteCategoryId },
                  },
                },
              },
            });
            const createdId = String(resp?.data?.id ?? '');
            applied.push({ ...change, createdId });
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'People') });
          }
        }

        peoplePreviewOperations.delete(parsed.previewToken);
        const operationId = newOperationId('people_add_note');
        savePeopleAuditOperation({
          operationId,
          kind: 'people_add_note',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped: [],
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: 0,
          errorCount: errors.length,
          applied,
          skipped: [],
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/people/v2/people/*/notes',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_preview_update_person_field': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          personId: z.string(),
          field: z.enum(PERSON_WRITABLE_FIELDS as unknown as [PersonWritableField, ...PersonWritableField[]]),
          value: z.union([z.string(), z.number(), z.null()]),
        });
        const parsed = schema.parse(args);

        let beforeValue: unknown = null;
        let personName = parsed.personId;
        try {
          const personResp = await client.get<any>(`/people/v2/people/${parsed.personId}`);
          const attrs = personResp?.data?.attributes ?? {};
          beforeValue = attrs[parsed.field] ?? null;
          personName = String(attrs.name ?? parsed.personId);
        } catch (err) {
          return JSON.stringify(toolError(PlanningCenterClient.formatError(err, 'People')));
        }

        const change: PeoplePreviewChange = {
          personId: parsed.personId,
          beforeAttributes: { [parsed.field]: beforeValue },
          afterAttributes: { [parsed.field]: parsed.value },
          reason: `Update field ${parsed.field}`,
        };

        const op = createPeoplePreviewOperation('people_update_person_field', [change], {
          personId: parsed.personId,
          personName,
          field: parsed.field,
          before: beforeValue,
          after: parsed.value,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: op.summary,
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: `/people/v2/people/${parsed.personId}`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_update_person_field': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(10),
        });
        const parsed = schema.parse(args);
        const op = getPeoplePreviewOperation(parsed.previewToken, 'people_update_person_field');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for update_person_field. Run preview again.'));
        }

        const applied: PeoplePreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            await client.patch<any>(`/people/v2/people/${change.personId}`, {
              data: {
                type: 'Person',
                attributes: change.afterAttributes,
              },
            });
            applied.push(change);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'People') });
          }
        }

        peoplePreviewOperations.delete(parsed.previewToken);
        const operationId = newOperationId('people_update_person_field');
        savePeopleAuditOperation({
          operationId,
          kind: 'people_update_person_field',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped: [],
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: 0,
          errorCount: errors.length,
          applied,
          skipped: [],
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/people/v2/people/*',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_preview_add_to_list': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          listId: z.string(),
          personId: z.string(),
        });
        const parsed = schema.parse(args);

        const listErr = validateWritableListId(parsed.listId);
        if (listErr) return JSON.stringify(toolError(listErr));

        let personName = parsed.personId;
        try {
          const personResp = await client.get<any>(`/people/v2/people/${parsed.personId}`);
          personName = String(personResp?.data?.attributes?.name ?? parsed.personId);
        } catch (err) {
          return JSON.stringify(toolError(PlanningCenterClient.formatError(err, 'People')));
        }

        const change: PeoplePreviewChange = {
          listId: parsed.listId,
          personId: parsed.personId,
          beforeAttributes: {},
          afterAttributes: { membership: 'present' },
          reason: 'Add person to list',
        };

        const op = createPeoplePreviewOperation('people_add_to_list', [change], {
          listId: parsed.listId,
          personId: parsed.personId,
          personName,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: op.summary,
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: `/people/v2/lists/${parsed.listId}/list_results`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_add_to_list': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(10),
        });
        const parsed = schema.parse(args);
        const op = getPeoplePreviewOperation(parsed.previewToken, 'people_add_to_list');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for add_to_list. Run preview again.'));
        }

        // Defense-in-depth: re-check allowlist at apply time
        for (const change of op.changes) {
          const listErr = validateWritableListId(change.listId!);
          if (listErr) return JSON.stringify(toolError(listErr));
        }

        const applied: PeoplePreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            const resp = await client.post<any>(`/people/v2/lists/${change.listId}/list_results`, {
              data: {
                type: 'ListResult',
                relationships: {
                  person: { data: { type: 'Person', id: change.personId } },
                },
              },
            });
            const createdId = String(resp?.data?.id ?? '');
            applied.push({ ...change, createdId });
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'People') });
          }
        }

        peoplePreviewOperations.delete(parsed.previewToken);
        const operationId = newOperationId('people_add_to_list');
        savePeopleAuditOperation({
          operationId,
          kind: 'people_add_to_list',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped: [],
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: 0,
          errorCount: errors.length,
          applied,
          skipped: [],
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/people/v2/lists/*/list_results',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_preview_remove_from_list': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          listId: z.string(),
          personId: z.string(),
        });
        const parsed = schema.parse(args);

        const listErr = validateWritableListId(parsed.listId);
        if (listErr) return JSON.stringify(toolError(listErr));

        // Look up the existing list_results membership for this person on this list
        let membershipId: string | null = null;
        try {
          const resp = await client.get<any>(`/people/v2/lists/${parsed.listId}/list_results`, {
            'where[person_id]': parsed.personId,
            per_page: 1,
          });
          const row = Array.isArray(resp?.data) ? resp.data[0] : null;
          membershipId = row?.id ? String(row.id) : null;
        } catch (err) {
          return JSON.stringify(toolError(PlanningCenterClient.formatError(err, 'People')));
        }
        if (!membershipId) {
          return JSON.stringify(toolError(`Person ${parsed.personId} is not currently a member of list ${parsed.listId}.`));
        }

        const change: PeoplePreviewChange = {
          listId: parsed.listId,
          personId: parsed.personId,
          membershipId,
          beforeAttributes: { membership: 'present' },
          afterAttributes: { membership: 'absent' },
          reason: 'Remove person from list',
        };

        const op = createPeoplePreviewOperation('people_remove_from_list', [change], {
          listId: parsed.listId,
          personId: parsed.personId,
          membershipId,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: op.summary,
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: `/people/v2/lists/${parsed.listId}/list_results/${membershipId}`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_remove_from_list': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(10),
        });
        const parsed = schema.parse(args);
        const op = getPeoplePreviewOperation(parsed.previewToken, 'people_remove_from_list');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for remove_from_list. Run preview again.'));
        }

        for (const change of op.changes) {
          const listErr = validateWritableListId(change.listId!);
          if (listErr) return JSON.stringify(toolError(listErr));
        }

        const applied: PeoplePreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            await client.delete(`/people/v2/lists/${change.listId}/list_results/${change.membershipId}`);
            applied.push(change);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'People') });
          }
        }

        peoplePreviewOperations.delete(parsed.previewToken);
        const operationId = newOperationId('people_remove_from_list');
        savePeopleAuditOperation({
          operationId,
          kind: 'people_remove_from_list',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped: [],
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: 0,
          errorCount: errors.length,
          applied,
          skipped: [],
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/people/v2/lists/*/list_results/*',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_preview_create_workflow_card': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          workflowId: z.string(),
          personId: z.string(),
          assigneeId: z.string().optional(),
          note: z.string().optional(),
        });
        const parsed = schema.parse(args);

        // Look up person + assignee for recipient summary
        let personName = parsed.personId;
        let assigneeName: string | null = null;
        let assigneeEmail: string | null = null;
        let workflowName = parsed.workflowId;
        try {
          const personResp = await client.get<any>(`/people/v2/people/${parsed.personId}`);
          personName = String(personResp?.data?.attributes?.name ?? parsed.personId);
        } catch (err) {
          return JSON.stringify(toolError(PlanningCenterClient.formatError(err, 'People')));
        }
        try {
          const workflowResp = await client.get<any>(`/people/v2/workflows/${parsed.workflowId}`);
          workflowName = String(workflowResp?.data?.attributes?.name ?? parsed.workflowId);
        } catch {
          // Non-fatal — workflow name is for summary only
        }
        if (parsed.assigneeId) {
          try {
            const assigneeResp = await client.get<any>(`/people/v2/people/${parsed.assigneeId}`, {
              include: 'emails',
            });
            assigneeName = String(assigneeResp?.data?.attributes?.name ?? parsed.assigneeId);
            const includes = assigneeResp?.included ?? [];
            const emailRecord = includes.find((rec: any) => rec.type === 'Email' && rec.attributes?.primary)
              ?? includes.find((rec: any) => rec.type === 'Email');
            if (emailRecord) {
              assigneeEmail = String(emailRecord.attributes?.address ?? '');
            }
          } catch {
            // Non-fatal — assignee lookup is best-effort for summary
          }
        }

        const change: PeoplePreviewChange = {
          workflowId: parsed.workflowId,
          personId: parsed.personId,
          assigneeId: parsed.assigneeId,
          beforeAttributes: {},
          afterAttributes: {
            note: parsed.note ?? null,
            assigneeId: parsed.assigneeId ?? null,
          },
          reason: 'Create workflow card (will trigger notification email)',
        };

        const op = createPeoplePreviewOperation('people_create_workflow_card', [change], {
          workflowId: parsed.workflowId,
          workflowName,
          personId: parsed.personId,
          personName,
          assigneeId: parsed.assigneeId ?? null,
          assigneeName,
          assigneeEmail,
          irreversibleNote: 'Apply will send a notification email to the assignee. The card can be deleted but the email cannot be recalled.',
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: op.summary,
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: `/people/v2/workflows/${parsed.workflowId}/cards`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_create_workflow_card': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(10),
        });
        const parsed = schema.parse(args);
        const op = getPeoplePreviewOperation(parsed.previewToken, 'people_create_workflow_card');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for create_workflow_card. Run preview again.'));
        }

        const applied: PeoplePreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            const relationships: Record<string, unknown> = {
              person: { data: { type: 'Person', id: change.personId } },
            };
            if (change.assigneeId) {
              relationships.assignee = { data: { type: 'Person', id: change.assigneeId } };
            }
            const attributes: Record<string, unknown> = {};
            if (change.afterAttributes.note) {
              attributes.note = change.afterAttributes.note;
            }
            const resp = await client.post<any>(`/people/v2/workflows/${change.workflowId}/cards`, {
              data: {
                type: 'WorkflowCard',
                attributes,
                relationships,
              },
            });
            const createdId = String(resp?.data?.id ?? '');
            applied.push({ ...change, createdId });
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'People') });
          }
        }

        peoplePreviewOperations.delete(parsed.previewToken);
        const operationId = newOperationId('people_create_workflow_card');
        savePeopleAuditOperation({
          operationId,
          kind: 'people_create_workflow_card',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped: [],
          errors,
          irreversible: true,
          irreversibleReason: 'Notification email sent to assignee — irreversible even if the card is later deleted.',
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: 0,
          errorCount: errors.length,
          applied,
          skipped: [],
          errors,
          irreversible: true,
          irreversibleReason: 'Notification email sent to assignee — irreversible even if the card is later deleted.',
        }, {
          count: applied.length,
          pcoEndpoint: '/people/v2/workflows/*/cards',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_preview_update_household_membership': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          householdId: z.string(),
          personId: z.string(),
          pending: z.enum(['set_primary', 'remove']),
        });
        const parsed = schema.parse(args);

        // Read household to capture current primary_contact_id
        let beforePrimaryId: string | null = null;
        let householdName = parsed.householdId;
        try {
          const householdResp = await client.get<any>(`/people/v2/households/${parsed.householdId}`);
          beforePrimaryId = String(householdResp?.data?.relationships?.primary_contact?.data?.id ?? '') || null;
          householdName = String(householdResp?.data?.attributes?.name ?? parsed.householdId);
        } catch (err) {
          return JSON.stringify(toolError(PlanningCenterClient.formatError(err, 'People')));
        }

        // For 'remove', look up the membership id for this person on this household
        let membershipId: string | null = null;
        if (parsed.pending === 'remove') {
          try {
            const resp = await client.get<any>(
              `/people/v2/households/${parsed.householdId}/household_memberships`,
              { 'where[person_id]': parsed.personId, per_page: 1 }
            );
            const row = Array.isArray(resp?.data) ? resp.data[0] : null;
            membershipId = row?.id ? String(row.id) : null;
            if (!membershipId) {
              return JSON.stringify(toolError(
                `Person ${parsed.personId} is not a member of household ${parsed.householdId}.`
              ));
            }
          } catch (err) {
            return JSON.stringify(toolError(PlanningCenterClient.formatError(err, 'People')));
          }
        }

        const beforeAttributes: Record<string, unknown> = {
          primary_contact_id: beforePrimaryId,
        };
        const afterAttributes: Record<string, unknown> =
          parsed.pending === 'set_primary'
            ? { primary_contact_id: parsed.personId }
            : { membership: 'absent' };

        const change: PeoplePreviewChange = {
          householdId: parsed.householdId,
          personId: parsed.personId,
          membershipId: membershipId ?? undefined,
          beforeAttributes,
          afterAttributes,
          reason: parsed.pending === 'set_primary' ? 'Set new primary contact' : 'Remove household membership',
        };

        const op = createPeoplePreviewOperation('people_update_household_membership', [change], {
          householdId: parsed.householdId,
          householdName,
          personId: parsed.personId,
          pending: parsed.pending,
          beforePrimaryId,
          membershipId,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: op.summary,
          changes: [change],
        }, {
          count: 1,
          pcoEndpoint: `/people/v2/households/${parsed.householdId}`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_update_household_membership': {
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(10),
        });
        const parsed = schema.parse(args);
        const op = getPeoplePreviewOperation(parsed.previewToken, 'people_update_household_membership');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for update_household_membership. Run preview again.'));
        }

        const applied: PeoplePreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            if (change.afterAttributes.primary_contact_id !== undefined) {
              await client.patch<any>(`/people/v2/households/${change.householdId}`, {
                data: {
                  type: 'Household',
                  relationships: {
                    primary_contact: {
                      data: { type: 'Person', id: change.afterAttributes.primary_contact_id },
                    },
                  },
                },
              });
            } else if (change.membershipId) {
              await client.delete(
                `/people/v2/households/${change.householdId}/household_memberships/${change.membershipId}`
              );
            } else {
              throw new Error('Unable to apply: missing primary_contact_id or membershipId');
            }
            applied.push(change);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'People') });
          }
        }

        peoplePreviewOperations.delete(parsed.previewToken);
        const operationId = newOperationId('people_update_household_membership');
        savePeopleAuditOperation({
          operationId,
          kind: 'people_update_household_membership',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped: [],
          errors,
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: 0,
          errorCount: errors.length,
          applied,
          skipped: [],
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/people/v2/households/*',
          executionMs: Date.now() - start,
        }));
      }

      // ============================================================
      // People write rollback + audit log + preview summary
      // ============================================================

      case 'pco_get_people_preview_summary': {
        const schema = z.object({ previewToken: z.string() });
        const parsed = schema.parse(args);
        const op = peoplePreviewOperations.get(parsed.previewToken);
        if (!op) return JSON.stringify(toolError('Unknown or expired previewToken.'));
        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          kind: op.kind,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          summary: op.summary,
          sampleChanges: op.changes.slice(0, 20),
        }, {
          count: op.changes.length,
          pcoEndpoint: 'people-preview-summary',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_people_write_audit_log': {
        const schema = z.object({
          limit: z.number().int().positive().max(100).optional().default(20),
        });
        const parsed = schema.parse(args);
        prunePeopleAuditOperations();
        const operations = Array.from(peopleAuditOperations.values())
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
            irreversible: op.irreversible ?? false,
            irreversibleReason: op.irreversibleReason ?? null,
          }));
        return JSON.stringify(toolSuccess({ operations }, {
          count: operations.length,
          pcoEndpoint: 'people-write-audit',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_rollback_people_write_operation': {
        const schema = z.object({
          operationId: z.string(),
          confirmPhrase: z.literal('ROLLBACK_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(50),
        });
        const parsed = schema.parse(args);

        const operation = getPeopleAuditOperation(parsed.operationId);
        if (!operation) {
          return JSON.stringify(toolError('Unknown operationId (or it has expired from audit history).'));
        }
        if (operation.irreversible) {
          return JSON.stringify(toolError(
            `This operation type is irreversible. ${operation.irreversibleReason ?? 'Audit only.'}`
          ));
        }
        if (!getPeopleWritesEnabled()) {
          return JSON.stringify(toolError(peopleWritesDisabledError()));
        }
        if (operation.applied.length > parsed.maxChanges) {
          return JSON.stringify(toolError(
            `Operation has ${operation.applied.length} applied changes, exceeds maxChanges=${parsed.maxChanges}.`
          ));
        }

        const rolledBack: PeoplePreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of operation.applied) {
          try {
            switch (operation.kind) {
              case 'people_add_note': {
                if (!change.createdId) {
                  throw new Error('Cannot rollback note: createdId missing');
                }
                await client.delete(`/people/v2/people/${change.personId}/notes/${change.createdId}`);
                break;
              }
              case 'people_update_person_field': {
                await client.patch<any>(`/people/v2/people/${change.personId}`, {
                  data: {
                    type: 'Person',
                    attributes: change.beforeAttributes,
                  },
                });
                break;
              }
              case 'people_add_to_list': {
                if (!change.createdId) {
                  throw new Error('Cannot rollback add_to_list: createdId missing');
                }
                await client.delete(`/people/v2/lists/${change.listId}/list_results/${change.createdId}`);
                break;
              }
              case 'people_remove_from_list': {
                // Re-add via POST list_results
                await client.post<any>(`/people/v2/lists/${change.listId}/list_results`, {
                  data: {
                    type: 'ListResult',
                    relationships: {
                      person: { data: { type: 'Person', id: change.personId } },
                    },
                  },
                });
                break;
              }
              case 'people_update_household_membership': {
                // Restore previous primary_contact_id if that was the change
                if (change.afterAttributes.primary_contact_id !== undefined) {
                  const prior = change.beforeAttributes.primary_contact_id;
                  if (prior) {
                    await client.patch<any>(`/people/v2/households/${change.householdId}`, {
                      data: {
                        type: 'Household',
                        relationships: {
                          primary_contact: {
                            data: { type: 'Person', id: prior as string },
                          },
                        },
                      },
                    });
                  } else {
                    throw new Error('Cannot rollback household primary: prior primary_contact_id unknown.');
                  }
                } else {
                  // For 'remove' membership rollback: re-create membership row
                  await client.post<any>(
                    `/people/v2/households/${change.householdId}/household_memberships`,
                    {
                      data: {
                        type: 'HouseholdMembership',
                        relationships: {
                          person: { data: { type: 'Person', id: change.personId } },
                        },
                      },
                    }
                  );
                }
                break;
              }
              default:
                throw new Error(`Rollback not implemented for kind ${operation.kind}`);
            }
            rolledBack.push(change);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'People') });
          }
        }

        const rollbackOperationId = `rollback_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        savePeopleAuditOperation({
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
          skipped: [],
          errors,
        });

        return JSON.stringify(toolSuccess({
          rollbackOperationId,
          sourceOperationId: parsed.operationId,
          attempted: operation.applied.length,
          rolledBackCount: rolledBack.length,
          skippedCount: 0,
          errorCount: errors.length,
          rolledBack,
          skipped: [],
          errors,
        }, {
          count: rolledBack.length,
          pcoEndpoint: 'people-write-rollback',
          executionMs: Date.now() - start,
        }));
      }

      default:
        return JSON.stringify(toolError(`Unknown people tool: ${name}`));
    }
  } catch (err) {
    return JSON.stringify(
      toolError(PlanningCenterClient.formatError(err, 'People'), {
        pcoEndpoint: name,
        executionMs: Date.now() - start,
      })
    );
  }
}

/** Return tool definitions for registration */
export function getPeopleToolDefinitions() {
  return [
    {
      name: 'pco_search_people',
      description:
        'Search for people in Planning Center People by name or email. Returns active people matching the query with contact info. Searches against search_name which matches partial first/last name or email.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Name or email to search for' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'pco_get_person',
      description:
        'Get the full profile for a specific person by their Planning Center person ID. Includes all emails, phones, addresses, and household data. Use after search_people for complete info.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          personId: { type: 'string', description: 'The person ID' },
        },
        required: ['personId'],
      },
    },
    {
      name: 'pco_list_saved_lists',
      description:
        'Get all saved people lists in Planning Center. Lists are pre-built segments (e.g., "First Time Guests," "Volunteers"). Returns names and IDs for use with get_people_by_list.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      },
    },
    {
      name: 'pco_get_people_by_list',
      description:
        'Get all people in a saved Planning Center People list. Use list_saved_lists first to find the listId.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          listId: { type: 'string', description: 'The list ID (from list_saved_lists)' },
        },
        required: ['listId'],
      },
    },
    {
      name: 'pco_get_people_stats',
      description:
        'Get a CRM dashboard overview of your Planning Center people database: total count, breakdown by status (active vs inactive), breakdown by membership type (Member, Regular Attender, Visitor, etc.), and how many were added in the last 30 days. This is the go-to tool for "how many people do we have" and similar questions.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      },
    },
    {
      name: 'pco_get_people_by_status',
      description:
        'Get people filtered by their PCO status (active or inactive). Returns people sorted by most recently updated. Useful for finding inactive records, cleanup audits, or re-engagement campaigns.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', enum: ['active', 'inactive'], description: 'Filter by status: "active" or "inactive"' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
        required: ['status'],
      },
    },
    {
      name: 'pco_get_people_by_membership',
      description:
        'Get people filtered by their membership type (e.g., "Member", "Regular Attender", "Visitor"). Returns people sorted by last name. Useful for membership reports and engagement analysis.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          membership: { type: 'string', description: 'Membership type (e.g., "Member", "Regular Attender", "Visitor")' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
        required: ['membership'],
      },
    },
    {
      name: 'pco_get_new_people',
      description:
        'Find people added to Planning Center in the last N days, ordered by most recent first. Useful for tracking new guest/visitor volume.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          days: { type: 'number', description: 'Number of days to look back (default 30)' },
          limit: { type: 'number', description: 'Max results (default 100)' },
        },
        required: [] as string[],
      },
    },
    {
      name: 'pco_identify_at_risk_members',
      description:
        'Find active people who have NOT checked in within the last N weeks. These are "at-risk" members who may be disengaging. Cross-references check-in data with the people database. Use for pastoral care follow-up, re-engagement campaigns, or data health checks.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          inactiveWeeks: { type: 'number', description: 'Weeks of inactivity to flag (default 6)' },
          limit: { type: 'number', description: 'Max results (default 100)' },
        },
        required: [] as string[],
      },
    },
    {
      name: 'pco_get_engagement_summary',
      description:
        'Cross-module church health dashboard: total people (active vs inactive), group count, check-ins last 7 days, first-time visitors last 30 days, new people added last 30 days, and upcoming registration events. One tool call that gives a full pulse on your church. Use this for "give me an overview" or "how are we doing" questions.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      },
    },

    // ===== People WRITE tools =====
    {
      name: 'pco_preview_add_note',
      description:
        'Preview appending a note to a person in Planning Center People. Dry-run: returns a previewToken with the change shape; does not write. Requires PCO_PEOPLE_WRITES_ENABLED=true.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          personId: { type: 'string', description: 'Person ID to attach the note to' },
          noteCategoryId: { type: 'string', description: 'Note category ID (required by PCO)' },
          text: { type: 'string', description: 'Note body text' },
        },
        required: ['personId', 'noteCategoryId', 'text'],
      },
    },
    {
      name: 'pco_apply_add_note',
      description:
        'Apply a previewed add_note operation using previewToken. Creates the note via POST /people/v2/people/{personId}/notes. Reversible via rollback (note will be deleted).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'] },
          maxChanges: { type: 'number', description: 'Max changes to allow (default 10)' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_update_person_field',
      description:
        'Preview updating one whitelisted attribute on a person. Allowed fields: nickname, first_name, last_name, middle_name, birthdate, anniversary, gender, grade, school_id. Dry-run; does not write. Requires PCO_PEOPLE_WRITES_ENABLED=true.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          personId: { type: 'string' },
          field: { type: 'string', enum: [...PERSON_WRITABLE_FIELDS] },
          value: {
            description: 'New value for the field (string | number | null)',
          },
        },
        required: ['personId', 'field', 'value'],
      },
    },
    {
      name: 'pco_apply_update_person_field',
      description:
        'Apply a previewed person field update via PATCH /people/v2/people/{personId}. Reversible via rollback (PATCH back to beforeAttributes).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'] },
          maxChanges: { type: 'number' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_add_to_list',
      description:
        'Preview adding a person to a saved People list. Dry-run; does not write. Requires PCO_PEOPLE_WRITES_ENABLED=true; optionally gated by PCO_WRITABLE_LIST_IDS.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          listId: { type: 'string' },
          personId: { type: 'string' },
        },
        required: ['listId', 'personId'],
      },
    },
    {
      name: 'pco_apply_add_to_list',
      description:
        'Apply a previewed add_to_list operation via POST /people/v2/lists/{listId}/list_results. Reversible via rollback (DELETE the created membership).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'] },
          maxChanges: { type: 'number' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_remove_from_list',
      description:
        'Preview removing a person from a saved People list. Dry-run; does not write. Requires PCO_PEOPLE_WRITES_ENABLED=true; optionally gated by PCO_WRITABLE_LIST_IDS.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          listId: { type: 'string' },
          personId: { type: 'string' },
        },
        required: ['listId', 'personId'],
      },
    },
    {
      name: 'pco_apply_remove_from_list',
      description:
        'Apply a previewed remove_from_list operation via DELETE /people/v2/lists/{listId}/list_results/{membershipId}. Reversible via rollback (re-create the membership).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'] },
          maxChanges: { type: 'number' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_create_workflow_card',
      description:
        'Preview assigning a workflow card to a person. WARNING: applying this operation triggers a notification email to the assignee — this side-effect is irreversible. Preview summary includes assignee name + email. Requires PCO_PEOPLE_WRITES_ENABLED=true.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflowId: { type: 'string' },
          personId: { type: 'string' },
          assigneeId: { type: 'string', description: 'Person ID of the staff member to assign (optional)' },
          note: { type: 'string', description: 'Initial card note (optional)' },
        },
        required: ['workflowId', 'personId'],
      },
    },
    {
      name: 'pco_apply_create_workflow_card',
      description:
        'Apply a previewed create_workflow_card operation via POST /people/v2/workflows/{workflowId}/cards. IRREVERSIBLE — assignee will be emailed. Rollback will reject with an irreversibility error; use the PCO UI to delete the card if needed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'] },
          maxChanges: { type: 'number' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_update_household_membership',
      description:
        'Preview changing a household membership: either set a new primary contact (`set_primary`) or remove a person from a household (`remove`). Dry-run; does not write. Requires PCO_PEOPLE_WRITES_ENABLED=true.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          householdId: { type: 'string' },
          personId: { type: 'string' },
          pending: { type: 'string', enum: ['set_primary', 'remove'] },
        },
        required: ['householdId', 'personId', 'pending'],
      },
    },
    {
      name: 'pco_apply_update_household_membership',
      description:
        'Apply a previewed household membership change. For set_primary: PATCH /people/v2/households/{householdId} to update primary_contact. For remove: DELETE /people/v2/households/{householdId}/household_memberships/{membershipId}. Reversible via rollback.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'] },
          maxChanges: { type: 'number' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_get_people_preview_summary',
      description: 'Inspect a People-write preview by token without applying it.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string' },
        },
        required: ['previewToken'],
      },
    },
    {
      name: 'pco_get_people_write_audit_log',
      description: 'List recent People write operations (most recent first).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number' },
        },
        required: [] as string[],
      },
    },
    {
      name: 'pco_rollback_people_write_operation',
      description:
        'Rollback a previously applied People write operation by operationId. Workflow card operations are irreversible (rollback returns an error). All others restore previous state.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          operationId: { type: 'string' },
          confirmPhrase: { type: 'string', enum: ['ROLLBACK_CHANGES'] },
          maxChanges: { type: 'number' },
        },
        required: ['operationId', 'confirmPhrase'],
      },
    },
  ];
}
