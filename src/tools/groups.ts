import crypto from 'node:crypto';
import { z } from 'zod';
import { PlanningCenterClient } from '../client.js';
import { toolSuccess, toolError } from '../response.js';

// ---------------------------------------------------------------------------
// Write-tool preview/audit infrastructure (groups phase)
// ---------------------------------------------------------------------------

type GroupsWriteKind =
  | 'groups_add_to_group'
  | 'groups_remove_from_group'
  | 'groups_log_group_attendance'
  | 'groups_send_group_email'
  | 'groups_create_group_meeting';

type GroupsPreviewChange = {
  groupId?: string;
  eventId?: string;
  membershipId?: string;
  personId?: string;
  attendanceId?: string;
  /** PCO endpoint relative to base for apply */
  endpoint?: string;
  /** PCO endpoint relative to base for rollback */
  rollbackEndpoint?: string;
  beforeAttributes: Record<string, unknown>;
  afterAttributes: Record<string, unknown>;
  reason?: string;
  /** Optional metadata for human-readable previews (e.g. recipient name/email) */
  meta?: Record<string, unknown>;
};

type GroupsPreviewOperation = {
  token: string;
  kind: GroupsWriteKind;
  createdAt: string;
  expiresAt: string;
  changes: GroupsPreviewChange[];
  summary: Record<string, unknown>;
};

type GroupsAppliedWriteOperation = {
  operationId: string;
  kind: GroupsWriteKind;
  appliedAt: string;
  sourcePreviewToken: string;
  applied: GroupsPreviewChange[];
  skipped: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  irreversible?: boolean;
  irreversibleReason?: string;
};

const GROUPS_PREVIEW_TTL_MS = 15 * 60_000;
const GROUPS_AUDIT_TTL_MS = 7 * 24 * 60 * 60_000;
const groupsPreviewOperations = new Map<string, GroupsPreviewOperation>();
const groupsAuditOperations = new Map<string, GroupsAppliedWriteOperation>();

function pruneGroupsPreviewOperations() {
  const now = Date.now();
  for (const [token, op] of groupsPreviewOperations.entries()) {
    if (new Date(op.expiresAt).getTime() <= now) {
      groupsPreviewOperations.delete(token);
    }
  }
}

function createGroupsPreviewOperation(
  kind: GroupsWriteKind,
  changes: GroupsPreviewChange[],
  summary: Record<string, unknown>
) {
  pruneGroupsPreviewOperations();
  const token = `preview_${crypto.randomBytes(18).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + GROUPS_PREVIEW_TTL_MS).toISOString();
  const op: GroupsPreviewOperation = { token, kind, createdAt, expiresAt, changes, summary };
  groupsPreviewOperations.set(token, op);
  return op;
}

function getGroupsPreviewOperation(token: string, kind: GroupsWriteKind) {
  pruneGroupsPreviewOperations();
  const op = groupsPreviewOperations.get(token);
  if (!op || op.kind !== kind) return null;
  if (new Date(op.expiresAt).getTime() <= Date.now()) {
    groupsPreviewOperations.delete(token);
    return null;
  }
  return op;
}

function pruneGroupsAuditOperations() {
  const now = Date.now();
  for (const [operationId, op] of groupsAuditOperations.entries()) {
    if (new Date(op.appliedAt).getTime() + GROUPS_AUDIT_TTL_MS <= now) {
      groupsAuditOperations.delete(operationId);
    }
  }
}

function saveGroupsAuditOperation(operation: GroupsAppliedWriteOperation) {
  pruneGroupsAuditOperations();
  groupsAuditOperations.set(operation.operationId, operation);
}

function getGroupsAuditOperation(operationId: string) {
  pruneGroupsAuditOperations();
  return groupsAuditOperations.get(operationId) ?? null;
}

function getWritableGroupIds(): Set<string> | null {
  const raw = process.env.PCO_WRITABLE_GROUP_IDS?.trim();
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return null;
  return new Set(ids);
}

function validateWritableGroups(groupIds: string[]): string | null {
  const allowlist = getWritableGroupIds();
  if (!allowlist) {
    return 'Groups write tools are disabled. Set PCO_WRITABLE_GROUP_IDS to a comma-separated allowlist of writable group IDs.';
  }
  const disallowed = Array.from(new Set(groupIds.filter(Boolean))).filter((id) => !allowlist.has(id));
  if (disallowed.length === 0) return null;
  return `Write access denied for groupId(s): ${disallowed.join(', ')}. Allowed IDs are set by PCO_WRITABLE_GROUP_IDS.`;
}

function isGroupEmailEnabled(): boolean {
  return (process.env.PCO_GROUP_EMAIL_ENABLED ?? '').trim().toLowerCase() === 'true';
}

function summarizeGroupsChanges(changes: GroupsPreviewChange[]) {
  const byGroup: Record<string, number> = {};
  const byEvent: Record<string, number> = {};
  for (const change of changes) {
    if (change.groupId) byGroup[change.groupId] = (byGroup[change.groupId] ?? 0) + 1;
    if (change.eventId) byEvent[change.eventId] = (byEvent[change.eventId] ?? 0) + 1;
  }
  return {
    totalChanges: changes.length,
    byGroup,
    byEvent,
  };
}


/** Handle a Groups module tool call */
export async function handleGroupsTool(
  name: string,
  args: Record<string, unknown>,
  client: PlanningCenterClient
): Promise<string> {
  const start = Date.now();

  try {
    switch (name) {
      case 'pco_get_group_types': {
        const { items, totalCount } = await client.paginate(
          '/groups/v2/group_types',
          { order: 'name' }
        );

        return JSON.stringify(toolSuccess(items, {
          count: items.length,
          totalCount,
          pcoEndpoint: '/groups/v2/group_types',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_list_groups': {
        const schema = z.object({
          groupTypeId: z.string().optional(),
          campus: z.string().optional(),
          limit: z.number().optional().default(50),
        });
        const parsed = schema.parse(args);

        const params: Record<string, string | number> = {
          order: 'name',
          per_page: parsed.limit,
        };
        if (parsed.groupTypeId) {
          params['where[group_type_id]'] = parsed.groupTypeId;
        }

        const response = await client.get<any>('/groups/v2/groups', params);
        let groups = Array.isArray(response.data)
          ? response.data.map((r: any) => client.flatten(r))
          : [];

        if (parsed.campus) {
          const campusLower = parsed.campus.toLowerCase();
          groups = groups.filter((g: any) => {
            const loc = ((g.location as string) ?? '').toLowerCase();
            return loc.includes(campusLower);
          });
        }

        return JSON.stringify(toolSuccess(groups, {
          count: groups.length,
          totalCount: response.meta?.total_count,
          pcoEndpoint: '/groups/v2/groups',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_group_members': {
        const schema = z.object({ groupId: z.string() });
        const parsed = schema.parse(args);

        const { items, included, totalCount } = await client.paginateWithIncludes(
          `/groups/v2/groups/${parsed.groupId}/memberships`,
          { include: 'person', per_page: 100 }
        );

        const members = items.map((m: any) => {
          const personData = m.person_id
            ? client.resolveIncludes<any>(m.person_id, 'Person', included)
            : null;
          return {
            ...m,
            person_name: personData?.name ?? null,
            person_email: personData?.email ?? null,
          };
        });

        return JSON.stringify(toolSuccess(members, {
          count: members.length,
          totalCount,
          pcoEndpoint: `/groups/v2/groups/${parsed.groupId}/memberships`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_groups_without_leader': {
        const { items: groups } = await client.paginate('/groups/v2/groups', {
          order: 'name',
          per_page: 100,
        });

        const leaderless: any[] = [];

        for (const group of groups) {
          const groupId = (group as any).id as string;
          try {
            const response = await client.get<any>(
              `/groups/v2/groups/${groupId}/memberships`,
              { 'where[role]': 'leader', per_page: 1 }
            );
            const leaders = Array.isArray(response.data) ? response.data : [];
            if (leaders.length === 0) {
              leaderless.push(group);
            }
          } catch {
            // Skip groups we can't access
          }
        }

        return JSON.stringify(toolSuccess(leaderless, {
          count: leaderless.length,
          pcoEndpoint: '/groups/v2/groups/*/memberships',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_upcoming_group_events': {
        const schema = z.object({
          groupId: z.string().optional(),
          daysAhead: z.number().optional().default(30),
        });
        const parsed = schema.parse(args);

        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() + parsed.daysAhead);

        const endpoint = parsed.groupId
          ? `/groups/v2/groups/${parsed.groupId}/events`
          : '/groups/v2/events';

        const { items, totalCount } = await client.paginate(endpoint, {
          order: 'starts_at',
          filter: 'upcoming',
        });

        const filtered = items.filter((e: any) => {
          const startsAt = new Date(e.starts_at as string);
          return startsAt <= cutoff;
        });

        return JSON.stringify(toolSuccess(filtered, {
          count: filtered.length,
          totalCount,
          pcoEndpoint: endpoint,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_group_enrollment_stats': {
        // Aggregate stats across all groups: total members, avg group size, enrollment strategies
        const { items: groups, totalCount } = await client.paginate(
          '/groups/v2/groups',
          { order: 'name', per_page: 100 }
        );

        let totalMembers = 0;
        let groupsWithZeroMembers = 0;
        const enrollmentStrategies: Record<string, number> = {};
        const sizeDistribution = { small: 0, medium: 0, large: 0 }; // <5, 5-15, >15

        for (const group of groups) {
          const g = group as any;
          const memberCount = (g.memberships_count as number) ?? 0;
          totalMembers += memberCount;

          if (memberCount === 0) groupsWithZeroMembers++;
          if (memberCount < 5) sizeDistribution.small++;
          else if (memberCount <= 15) sizeDistribution.medium++;
          else sizeDistribution.large++;

          const strategy = (g.enrollment_strategy as string) ?? 'unknown';
          enrollmentStrategies[strategy] = (enrollmentStrategies[strategy] ?? 0) + 1;
        }

        const avgGroupSize = groups.length > 0
          ? Math.round((totalMembers / groups.length) * 10) / 10
          : 0;

        // Largest and smallest groups
        const sortedBySize = [...groups].sort(
          (a: any, b: any) => (b.memberships_count ?? 0) - (a.memberships_count ?? 0)
        );
        const largest = sortedBySize.slice(0, 5).map((g: any) => ({
          id: g.id,
          name: g.name,
          memberships_count: g.memberships_count,
        }));
        const smallest = sortedBySize
          .filter((g: any) => (g.memberships_count ?? 0) > 0)
          .slice(-5)
          .map((g: any) => ({
            id: g.id,
            name: g.name,
            memberships_count: g.memberships_count,
          }));

        return JSON.stringify(toolSuccess(
          {
            totalGroups: totalCount,
            totalMembers,
            averageGroupSize: avgGroupSize,
            groupsWithZeroMembers,
            sizeDistribution,
            enrollmentStrategies,
            largestGroups: largest,
            smallestActiveGroups: smallest,
          },
          {
            count: groups.length,
            totalCount,
            pcoEndpoint: '/groups/v2/groups',
            executionMs: Date.now() - start,
          }
        ));
      }

      // -------------------------------------------------------------------
      // WRITE TOOLS — preview / apply / rollback / audit / summary
      // -------------------------------------------------------------------

      case 'pco_preview_add_to_group': {
        const schema = z.object({
          groupId: z.string(),
          personId: z.string(),
          role: z.enum(['member', 'leader']).optional().default('member'),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableGroups([parsed.groupId]);
        if (writableError) return JSON.stringify(toolError(writableError));

        const change: GroupsPreviewChange = {
          groupId: parsed.groupId,
          personId: parsed.personId,
          endpoint: `/groups/v2/groups/${parsed.groupId}/memberships`,
          beforeAttributes: {},
          afterAttributes: { role: parsed.role, personId: parsed.personId },
          reason: `Add person ${parsed.personId} as ${parsed.role}`,
        };
        const op = createGroupsPreviewOperation('groups_add_to_group', [change], {
          groupId: parsed.groupId,
          personId: parsed.personId,
          role: parsed.role,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: summarizeGroupsChanges(op.changes),
          changes: op.changes,
        }, {
          count: 1,
          pcoEndpoint: '/groups/v2/groups/*/memberships',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_add_to_group': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(100),
        });
        const parsed = schema.parse(args);
        const op = getGroupsPreviewOperation(parsed.previewToken, 'groups_add_to_group');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for add_to_group. Run preview again.'));

        const writableError = validateWritableGroups(op.changes.map((c) => c.groupId ?? ''));
        if (writableError) return JSON.stringify(toolError(writableError));

        if (op.changes.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Preview contains ${op.changes.length} changes, which exceeds maxChanges=${parsed.maxChanges}.`));
        }

        const applied: GroupsPreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            const resp = await client.post<any>(change.endpoint as string, {
              data: {
                type: 'GroupMembership',
                attributes: { role: (change.afterAttributes as any).role },
                relationships: {
                  person: { data: { type: 'Person', id: change.personId } },
                },
              },
            });
            const membershipId = resp?.data?.id as string | undefined;
            applied.push({
              ...change,
              membershipId,
              rollbackEndpoint: membershipId
                ? `/groups/v2/groups/${change.groupId}/memberships/${membershipId}`
                : undefined,
            });
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Groups') });
          }
        }

        groupsPreviewOperations.delete(parsed.previewToken);
        const operationId = `groups_add_to_group_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveGroupsAuditOperation({
          operationId,
          kind: 'groups_add_to_group',
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
          pcoEndpoint: '/groups/v2/groups/*/memberships',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_preview_remove_from_group': {
        const schema = z.object({
          groupId: z.string(),
          membershipId: z.string(),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableGroups([parsed.groupId]);
        if (writableError) return JSON.stringify(toolError(writableError));

        // Read current membership for beforeAttributes
        let beforeAttributes: Record<string, unknown> = {};
        let personId: string | undefined;
        try {
          const current = await client.get<any>(
            `/groups/v2/groups/${parsed.groupId}/memberships/${parsed.membershipId}`
          );
          const flat = current?.data ? client.flatten(current.data) : {};
          beforeAttributes = {
            role: (flat as any).role,
          };
          const rel = current?.data?.relationships?.person?.data;
          if (rel && rel.id) {
            personId = String(rel.id);
            beforeAttributes.personId = personId;
          }
        } catch (err) {
          return JSON.stringify(toolError(
            `Failed to read membership ${parsed.membershipId} on group ${parsed.groupId}: ${PlanningCenterClient.formatError(err, 'Groups')}`
          ));
        }

        const change: GroupsPreviewChange = {
          groupId: parsed.groupId,
          membershipId: parsed.membershipId,
          personId,
          endpoint: `/groups/v2/groups/${parsed.groupId}/memberships/${parsed.membershipId}`,
          rollbackEndpoint: `/groups/v2/groups/${parsed.groupId}/memberships`,
          beforeAttributes,
          afterAttributes: { deleted: true },
          reason: `Remove membership ${parsed.membershipId} from group ${parsed.groupId}`,
        };
        const op = createGroupsPreviewOperation('groups_remove_from_group', [change], {
          groupId: parsed.groupId,
          membershipId: parsed.membershipId,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: summarizeGroupsChanges(op.changes),
          changes: op.changes,
        }, {
          count: 1,
          pcoEndpoint: '/groups/v2/groups/*/memberships/*',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_remove_from_group': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(100),
        });
        const parsed = schema.parse(args);
        const op = getGroupsPreviewOperation(parsed.previewToken, 'groups_remove_from_group');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for remove_from_group. Run preview again.'));

        const writableError = validateWritableGroups(op.changes.map((c) => c.groupId ?? ''));
        if (writableError) return JSON.stringify(toolError(writableError));

        if (op.changes.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Preview contains ${op.changes.length} changes, which exceeds maxChanges=${parsed.maxChanges}.`));
        }

        const applied: GroupsPreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            await client.delete(change.endpoint as string);
            applied.push(change);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Groups') });
          }
        }

        groupsPreviewOperations.delete(parsed.previewToken);
        const operationId = `groups_remove_from_group_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveGroupsAuditOperation({
          operationId,
          kind: 'groups_remove_from_group',
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
          pcoEndpoint: '/groups/v2/groups/*/memberships/*',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_preview_log_group_attendance': {
        const schema = z.object({
          eventId: z.string(),
          personIds: z.array(z.string()).min(1),
          attendance: z.boolean().optional().default(true),
          groupId: z.string().optional(),
        });
        const parsed = schema.parse(args);

        // If groupId is provided, validate it. Otherwise we need to look it up from the event.
        // PCO group events live under a group, but the event endpoint exposes group relationship.
        let groupId = parsed.groupId;
        if (!groupId) {
          try {
            const ev = await client.get<any>(`/groups/v2/events/${parsed.eventId}`);
            const rel = ev?.data?.relationships?.group?.data;
            if (rel && rel.id) groupId = String(rel.id);
          } catch {
            // ignore — validateWritableGroups below will fail with a clear message
          }
        }

        const writableError = validateWritableGroups([groupId ?? '']);
        if (writableError) return JSON.stringify(toolError(writableError));

        const changes: GroupsPreviewChange[] = parsed.personIds.map((personId) => ({
          groupId,
          eventId: parsed.eventId,
          personId,
          endpoint: `/groups/v2/events/${parsed.eventId}/attendances`,
          beforeAttributes: {},
          afterAttributes: { attended: parsed.attendance, personId },
          reason: `Record attendance=${parsed.attendance} for person ${personId} at event ${parsed.eventId}`,
        }));

        const op = createGroupsPreviewOperation('groups_log_group_attendance', changes, {
          eventId: parsed.eventId,
          groupId,
          attendance: parsed.attendance,
          recipientCount: parsed.personIds.length,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: changes.length,
          summary: summarizeGroupsChanges(op.changes),
          changes: op.changes,
        }, {
          count: changes.length,
          pcoEndpoint: '/groups/v2/events/*/attendances',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_log_group_attendance': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(500),
        });
        const parsed = schema.parse(args);
        const op = getGroupsPreviewOperation(parsed.previewToken, 'groups_log_group_attendance');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for log_group_attendance. Run preview again.'));

        const writableError = validateWritableGroups(op.changes.map((c) => c.groupId ?? ''));
        if (writableError) return JSON.stringify(toolError(writableError));

        if (op.changes.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Preview contains ${op.changes.length} changes, which exceeds maxChanges=${parsed.maxChanges}.`));
        }

        const applied: GroupsPreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            const resp = await client.post<any>(change.endpoint as string, {
              data: {
                type: 'Attendance',
                attributes: { attended: (change.afterAttributes as any).attended },
                relationships: {
                  person: { data: { type: 'Person', id: change.personId } },
                },
              },
            });
            const attendanceId = resp?.data?.id as string | undefined;
            applied.push({
              ...change,
              attendanceId,
              rollbackEndpoint: attendanceId
                ? `/groups/v2/events/${change.eventId}/attendances/${attendanceId}`
                : undefined,
            });
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Groups') });
          }
        }

        groupsPreviewOperations.delete(parsed.previewToken);
        const operationId = `groups_log_group_attendance_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveGroupsAuditOperation({
          operationId,
          kind: 'groups_log_group_attendance',
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
          pcoEndpoint: '/groups/v2/events/*/attendances',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_preview_send_group_email': {
        const schema = z.object({
          groupId: z.string(),
          subject: z.string().min(1),
          body: z.string().min(1),
          replyToId: z.string().optional(),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableGroups([parsed.groupId]);
        if (writableError) return JSON.stringify(toolError(writableError));

        if (!isGroupEmailEnabled()) {
          return JSON.stringify(toolError(
            'Group email is disabled. Set PCO_GROUP_EMAIL_ENABLED=true to permit previewing group emails.'
          ));
        }

        // Pull recipients via memberships?include=person (need raw response to read relationships)
        const membershipsResp = await client.get<any>(
          `/groups/v2/groups/${parsed.groupId}/memberships`,
          { include: 'person', per_page: 100 }
        );
        const membershipRecords: any[] = Array.isArray(membershipsResp?.data) ? membershipsResp.data : [];
        const included: any[] = Array.isArray(membershipsResp?.included) ? membershipsResp.included : [];

        const recipients = membershipRecords.map((m: any) => {
          const personRelId = m?.relationships?.person?.data?.id as string | undefined;
          const personData = personRelId
            ? client.resolveIncludes<any>(personRelId, 'Person', included)
            : null;
          return {
            personId: personRelId ?? null,
            membershipId: m.id ?? null,
            name: (personData as any)?.name ?? null,
            email: (personData as any)?.email ?? null,
            role: m?.attributes?.role ?? null,
          };
        });

        const change: GroupsPreviewChange = {
          groupId: parsed.groupId,
          beforeAttributes: {},
          afterAttributes: {
            subject: parsed.subject,
            body: parsed.body,
            replyToId: parsed.replyToId,
            recipientCount: recipients.length,
          },
          reason: `Send email to ${recipients.length} group members`,
          meta: { recipients },
        };
        const op = createGroupsPreviewOperation('groups_send_group_email', [change], {
          groupId: parsed.groupId,
          subject: parsed.subject,
          body: parsed.body,
          replyToId: parsed.replyToId,
          recipientCount: recipients.length,
          recipients,
          irreversible: true,
          warning:
            "PCO's public API does not expose a group mass-email endpoint. This preview confirms recipients before manual send; apply will fail with a clear message.",
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: op.summary,
          changes: op.changes,
        }, {
          count: 1,
          pcoEndpoint: '/groups/v2/groups/*/memberships?include=person',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_send_group_email': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
        });
        const parsed = schema.parse(args);
        const op = getGroupsPreviewOperation(parsed.previewToken, 'groups_send_group_email');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for send_group_email. Run preview again.'));

        const writableError = validateWritableGroups(op.changes.map((c) => c.groupId ?? ''));
        if (writableError) return JSON.stringify(toolError(writableError));

        if (!isGroupEmailEnabled()) {
          return JSON.stringify(toolError(
            'Group email is disabled. Set PCO_GROUP_EMAIL_ENABLED=true to apply.'
          ));
        }

        // TODO(pco-api): Planning Center Groups public API does not expose a
        // mass-email-to-group endpoint. The Groups web UI uses an internal
        // unauthenticated-by-public-API mechanism. Until/unless PCO exposes a
        // `/groups/v2/groups/{id}/messages` (or similar) endpoint, this apply
        // cannot perform the send. The preview alone is still useful: it
        // returns the canonical recipient list (with names + emails) so a
        // human can paste the body into the Groups UI manually.
        //
        // When a verified endpoint is found, replace this stub with the POST
        // and mark the audit operation `irreversible: true,
        // irreversibleReason: 'Email sent to N recipients'`.

        groupsPreviewOperations.delete(parsed.previewToken);
        const operationId = `groups_send_group_email_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const recipientCount = (op.changes[0]?.afterAttributes as any)?.recipientCount ?? 0;
        const irreversibleReason = `Email send is irreversible. PCO public API does not expose a group mass-email endpoint; ${recipientCount} recipient(s) would have been notified.`;
        saveGroupsAuditOperation({
          operationId,
          kind: 'groups_send_group_email',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied: [],
          skipped: op.changes.map((change) => ({
            ...change,
            reason: 'PCO public API does not expose a group mass-email endpoint. Use the preview recipient list and send manually via the PCO Groups UI.',
          })),
          errors: [],
          irreversible: true,
          irreversibleReason,
        });

        return JSON.stringify(toolError(
          "PCO's public API does not expose a group mass-email endpoint. Use the preview recipient list to send manually via the PCO Groups UI. (Audit row recorded for traceability.)",
          {
            pcoEndpoint: 'groups-send-group-email-not-supported',
            executionMs: Date.now() - start,
          }
        ));
      }

      case 'pco_preview_create_group_meeting': {
        const schema = z.object({
          groupId: z.string(),
          startsAt: z.string(),
          endsAt: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          locationName: z.string().optional(),
        });
        const parsed = schema.parse(args);

        const writableError = validateWritableGroups([parsed.groupId]);
        if (writableError) return JSON.stringify(toolError(writableError));

        const startTs = Date.parse(parsed.startsAt);
        const endTs = Date.parse(parsed.endsAt);
        if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
          return JSON.stringify(toolError('startsAt and endsAt must be valid ISO timestamps.'));
        }
        if (endTs < startTs) {
          return JSON.stringify(toolError('endsAt must be on or after startsAt.'));
        }

        const change: GroupsPreviewChange = {
          groupId: parsed.groupId,
          endpoint: `/groups/v2/groups/${parsed.groupId}/events`,
          beforeAttributes: {},
          afterAttributes: {
            starts_at: parsed.startsAt,
            ends_at: parsed.endsAt,
            name: parsed.name,
            description: parsed.description,
            location_type_preference: parsed.locationName ? 'physical' : undefined,
            virtual_location_url: undefined,
            location_name: parsed.locationName,
          },
          reason: `Create new meeting for group ${parsed.groupId}`,
        };

        const op = createGroupsPreviewOperation('groups_create_group_meeting', [change], {
          groupId: parsed.groupId,
          startsAt: parsed.startsAt,
          endsAt: parsed.endsAt,
          name: parsed.name,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: 1,
          summary: summarizeGroupsChanges(op.changes),
          changes: op.changes,
        }, {
          count: 1,
          pcoEndpoint: '/groups/v2/groups/*/events',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_create_group_meeting': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
        });
        const parsed = schema.parse(args);
        const op = getGroupsPreviewOperation(parsed.previewToken, 'groups_create_group_meeting');
        if (!op) return JSON.stringify(toolError('Invalid or expired previewToken for create_group_meeting. Run preview again.'));

        const writableError = validateWritableGroups(op.changes.map((c) => c.groupId ?? ''));
        if (writableError) return JSON.stringify(toolError(writableError));

        const applied: GroupsPreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          const after = change.afterAttributes as any;
          // Strip undefined attributes
          const attributes: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(after)) {
            if (v !== undefined) attributes[k] = v;
          }
          try {
            const resp = await client.post<any>(change.endpoint as string, {
              data: {
                type: 'Event',
                attributes,
              },
            });
            const eventId = resp?.data?.id as string | undefined;
            applied.push({
              ...change,
              eventId,
              rollbackEndpoint: eventId
                ? `/groups/v2/groups/${change.groupId}/events/${eventId}`
                : undefined,
            });
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Groups') });
          }
        }

        groupsPreviewOperations.delete(parsed.previewToken);
        const operationId = `groups_create_group_meeting_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveGroupsAuditOperation({
          operationId,
          kind: 'groups_create_group_meeting',
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
          pcoEndpoint: '/groups/v2/groups/*/events',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_groups_preview_summary': {
        const schema = z.object({ previewToken: z.string() });
        const parsed = schema.parse(args);
        const op = groupsPreviewOperations.get(parsed.previewToken);
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
          pcoEndpoint: 'groups-preview-summary',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_groups_write_audit_log': {
        const schema = z.object({
          limit: z.number().int().positive().max(100).optional().default(20),
        });
        const parsed = schema.parse(args);
        pruneGroupsAuditOperations();

        const operations = Array.from(groupsAuditOperations.values())
          .sort((a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime())
          .slice(0, parsed.limit)
          .map((opEntry) => ({
            operationId: opEntry.operationId,
            kind: opEntry.kind,
            appliedAt: opEntry.appliedAt,
            sourcePreviewToken: opEntry.sourcePreviewToken,
            appliedCount: opEntry.applied.length,
            skippedCount: opEntry.skipped.length,
            errorCount: opEntry.errors.length,
            irreversible: opEntry.irreversible ?? false,
            irreversibleReason: opEntry.irreversibleReason,
          }));

        return JSON.stringify(toolSuccess({ operations }, {
          count: operations.length,
          pcoEndpoint: 'groups-write-audit',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_rollback_groups_write_operation': {
        const schema = z.object({
          operationId: z.string(),
          confirmPhrase: z.literal('ROLLBACK_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(500),
        });
        const parsed = schema.parse(args);
        const operation = getGroupsAuditOperation(parsed.operationId);
        if (!operation) return JSON.stringify(toolError('Unknown operationId (or it has expired from audit history).'));

        if (operation.irreversible) {
          return JSON.stringify(toolError(
            operation.irreversibleReason ?? 'This operation type is irreversible. Audit only.'
          ));
        }

        if (operation.applied.length > parsed.maxChanges) {
          return JSON.stringify(toolError(
            `Operation has ${operation.applied.length} applied changes, exceeding maxChanges=${parsed.maxChanges}.`
          ));
        }

        const writableError = validateWritableGroups(operation.applied.map((c) => c.groupId ?? ''));
        if (writableError) return JSON.stringify(toolError(writableError));

        const rolledBack: GroupsPreviewChange[] = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of operation.applied) {
          try {
            switch (operation.kind) {
              case 'groups_add_to_group': {
                // Originally POST a membership → rollback DELETE the membership
                if (!change.rollbackEndpoint) {
                  errors.push({ ...change, error: 'No rollback endpoint recorded (apply may have failed mid-flight).' });
                  continue;
                }
                await client.delete(change.rollbackEndpoint);
                break;
              }
              case 'groups_remove_from_group': {
                // Originally DELETE membership → rollback POST a new membership
                // Note: PCO will assign a NEW membership id; we cannot restore the original id.
                if (!change.rollbackEndpoint) {
                  errors.push({ ...change, error: 'No rollback endpoint recorded.' });
                  continue;
                }
                const before = change.beforeAttributes as any;
                await client.post(change.rollbackEndpoint, {
                  data: {
                    type: 'GroupMembership',
                    attributes: { role: before.role ?? 'member' },
                    relationships: {
                      person: { data: { type: 'Person', id: change.personId } },
                    },
                  },
                });
                break;
              }
              case 'groups_log_group_attendance': {
                // Originally POST attendance → rollback DELETE the attendance record
                if (!change.rollbackEndpoint) {
                  errors.push({ ...change, error: 'No rollback endpoint recorded.' });
                  continue;
                }
                await client.delete(change.rollbackEndpoint);
                break;
              }
              case 'groups_create_group_meeting': {
                // Originally POST event → rollback DELETE the event
                if (!change.rollbackEndpoint) {
                  errors.push({ ...change, error: 'No rollback endpoint recorded.' });
                  continue;
                }
                await client.delete(change.rollbackEndpoint);
                break;
              }
              default: {
                errors.push({ ...change, error: `Rollback not implemented for kind ${operation.kind}` });
                continue;
              }
            }
            rolledBack.push(change);
          } catch (err) {
            errors.push({ ...change, error: PlanningCenterClient.formatError(err, 'Groups') });
          }
        }

        const rollbackOperationId = `rollback_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveGroupsAuditOperation({
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
          errors,
        }, {
          count: rolledBack.length,
          pcoEndpoint: 'groups-rollback',
          executionMs: Date.now() - start,
        }));
      }

      default:
        return JSON.stringify(toolError(`Unknown groups tool: ${name}`));
    }
  } catch (err) {
    return JSON.stringify(
      toolError(PlanningCenterClient.formatError(err, 'Groups'), {
        pcoEndpoint: name,
        executionMs: Date.now() - start,
      })
    );
  }
}

/** Return tool definitions for registration */
export function getGroupsToolDefinitions() {
  return [
    {
      name: 'pco_get_group_types',
      description:
        'Get all group types in Planning Center Groups (e.g., "Small Groups," "Bible Studies"). Call this first when working with groups to find groupTypeId values.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      },
    },
    {
      name: 'pco_list_groups',
      description:
        'List active Planning Center groups with member counts. Optionally filter by group type or campus. Use get_group_types first for valid groupTypeId values.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          groupTypeId: { type: 'string', description: 'Filter by group type ID' },
          campus: { type: 'string', description: 'Filter by campus name (partial match)' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
        required: [] as string[],
      },
    },
    {
      name: 'pco_get_group_members',
      description:
        'Get all members of a specific group. Returns names, roles (leader/member), and join dates. Use list_groups to find a groupId.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          groupId: { type: 'string', description: 'The group ID' },
        },
        required: ['groupId'],
      },
    },
    {
      name: 'pco_get_groups_without_leader',
      description:
        'Find active groups with no leader assigned. Groups without leaders may be orphaned or need attention. Returns groups with member counts.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      },
    },
    {
      name: 'pco_get_upcoming_group_events',
      description:
        'Get upcoming events for a specific group or all groups. Useful for planning, spotting conflicts, and reviewing engagement.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          groupId: { type: 'string', description: 'Group ID (omit for all groups)' },
          daysAhead: { type: 'number', description: 'Days ahead to look (default 30)' },
        },
        required: [] as string[],
      },
    },
    {
      name: 'pco_get_group_enrollment_stats',
      description:
        'Aggregate analytics across all groups: total members, average group size, size distribution (small/medium/large), enrollment strategy breakdown, groups with zero members, and the largest/smallest groups. Use for "how is group participation" or "are our small groups healthy" questions.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      },
    },
    // -----------------------------------------------------------------------
    // WRITE TOOLS (preview/apply pairs + rollback/audit/summary)
    // -----------------------------------------------------------------------
    {
      name: 'pco_preview_add_to_group',
      description:
        'Preview adding a person to a group as a member or leader. Returns a previewToken; no write is performed until pco_apply_add_to_group is called. groupId must be in PCO_WRITABLE_GROUP_IDS.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          groupId: { type: 'string', description: 'Target group ID (must be allow-listed)' },
          personId: { type: 'string', description: 'Person ID to add' },
          role: { type: 'string', enum: ['member', 'leader'], description: "Membership role (default 'member')" },
        },
        required: ['groupId', 'personId'],
      },
    },
    {
      name: 'pco_apply_add_to_group',
      description:
        'Apply a previously previewed add-to-group operation using previewToken and explicit confirmation phrase. Reversible via pco_rollback_groups_write_operation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned by pco_preview_add_to_group' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to allow from preview (default 100)' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_remove_from_group',
      description:
        'Preview removing a membership from a group. Reads the current membership so the operation can be rolled back. groupId must be in PCO_WRITABLE_GROUP_IDS.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          groupId: { type: 'string', description: 'Group ID (must be allow-listed)' },
          membershipId: { type: 'string', description: 'Membership ID to remove' },
        },
        required: ['groupId', 'membershipId'],
      },
    },
    {
      name: 'pco_apply_remove_from_group',
      description:
        'Apply a previously previewed remove-from-group operation. Rollback re-creates a membership with the original role (PCO assigns a new membership id).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned by pco_preview_remove_from_group' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to allow (default 100)' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_log_group_attendance',
      description:
        'Preview recording attendance for one or more people at a group event. Returns a previewToken; no write is performed until pco_apply_log_group_attendance is called. The eventId\'s parent group must be in PCO_WRITABLE_GROUP_IDS.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          eventId: { type: 'string', description: 'Group event ID' },
          personIds: { type: 'array', items: { type: 'string' }, description: 'Person IDs to record attendance for' },
          attendance: { type: 'boolean', description: 'Whether they attended (default true)' },
          groupId: { type: 'string', description: 'Optional group ID for allowlist check (looked up from event if omitted)' },
        },
        required: ['eventId', 'personIds'],
      },
    },
    {
      name: 'pco_apply_log_group_attendance',
      description:
        'Apply a previously previewed group attendance log. Reversible via rollback (deletes the attendance records).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned by pco_preview_log_group_attendance' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to allow (default 500)' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_send_group_email',
      description:
        'Preview sending an email to all members of a group. Lists every recipient (name + email + role) so the user can confirm before sending. Requires PCO_WRITABLE_GROUP_IDS + PCO_GROUP_EMAIL_ENABLED=true. NOTE: PCO public API does not expose a group mass-email endpoint; apply will return an error directing the user to send manually via the PCO Groups UI.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          groupId: { type: 'string', description: 'Group ID (must be allow-listed)' },
          subject: { type: 'string', description: 'Email subject' },
          body: { type: 'string', description: 'Email body (plain text)' },
          replyToId: { type: 'string', description: 'Optional PCO person ID to use as reply-to' },
        },
        required: ['groupId', 'subject', 'body'],
      },
    },
    {
      name: 'pco_apply_send_group_email',
      description:
        'Stub apply for send_group_email. Returns an error because PCO public API does not expose a group mass-email endpoint. Records an audit entry marked irreversible. Use the preview output to send manually via the PCO Groups UI.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned by pco_preview_send_group_email' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_create_group_meeting',
      description:
        'Preview scheduling a new event (meeting) for a group. Returns a previewToken; no write is performed until pco_apply_create_group_meeting is called. groupId must be in PCO_WRITABLE_GROUP_IDS.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          groupId: { type: 'string', description: 'Group ID (must be allow-listed)' },
          startsAt: { type: 'string', description: 'ISO timestamp for event start' },
          endsAt: { type: 'string', description: 'ISO timestamp for event end' },
          name: { type: 'string', description: 'Optional event name' },
          description: { type: 'string', description: 'Optional event description' },
          locationName: { type: 'string', description: 'Optional physical location name' },
        },
        required: ['groupId', 'startsAt', 'endsAt'],
      },
    },
    {
      name: 'pco_apply_create_group_meeting',
      description:
        'Apply a previously previewed group meeting creation. Reversible via rollback (deletes the event).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned by pco_preview_create_group_meeting' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_get_groups_preview_summary',
      description:
        'Inspect a Groups preview token. Returns the preview kind, summary stats, and a sample of changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned from a Groups preview tool' },
        },
        required: ['previewToken'],
      },
    },
    {
      name: 'pco_get_groups_write_audit_log',
      description:
        'List recent Groups write operations (apply/rollback) with summary counts for auditing.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max operations to return (default 20, max 100)' },
        },
        required: [] as string[],
      },
    },
    {
      name: 'pco_rollback_groups_write_operation',
      description:
        'Rollback a prior Groups write operation by inverting each applied change. Refuses operations marked irreversible (e.g. sent emails).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          operationId: { type: 'string', description: 'Operation ID returned by an apply tool' },
          confirmPhrase: { type: 'string', enum: ['ROLLBACK_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to rollback (default 500)' },
        },
        required: ['operationId', 'confirmPhrase'],
      },
    },
  ];
}
