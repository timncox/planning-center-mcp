import crypto from 'node:crypto';
import { z } from 'zod';
import { PlanningCenterClient } from '../client.js';
import { toolSuccess, toolError } from '../response.js';

type CalendarKind =
  | 'calendar_create_event'
  | 'calendar_update_event_time'
  | 'calendar_approve_resource_request';

type PreviewChange = {
  // Identifying fields per resource; only relevant ones are populated.
  eventId?: string;
  eventResourceRequestId?: string;
  resourceId?: string;
  beforeAttributes: Record<string, unknown>;
  afterAttributes: Record<string, unknown>;
  reason?: string;
};

type PreviewOperation = {
  token: string;
  kind: CalendarKind;
  createdAt: string;
  expiresAt: string;
  changes: PreviewChange[];
  summary: Record<string, unknown>;
};

type AppliedWriteOperation = {
  operationId: string;
  kind: CalendarKind;
  appliedAt: string;
  sourcePreviewToken: string;
  applied: Array<PreviewChange & { createdId?: string }>;
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

function createPreviewOperation(
  kind: CalendarKind,
  changes: PreviewChange[],
  summary: Record<string, unknown>
) {
  prunePreviewOperations();
  const token = `preview_${crypto.randomBytes(18).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  const op: PreviewOperation = { token, kind, createdAt, expiresAt, changes, summary };
  previewOperations.set(token, op);
  return op;
}

function getPreviewOperation(token: string, kind: CalendarKind) {
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

function getCalendarWritesEnabled(): boolean {
  const raw = process.env.PCO_CALENDAR_WRITES_ENABLED?.trim();
  return Boolean(raw && raw.length > 0);
}

function getCalendarResourceAllowlist(): Set<string> | null {
  const raw = process.env.PCO_WRITABLE_CALENDAR_RESOURCE_IDS?.trim();
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return null;
  return new Set(ids);
}

function validateCalendarWritesEnabled(): string | null {
  if (!getCalendarWritesEnabled()) {
    return 'Calendar write tools are disabled. Set PCO_CALENDAR_WRITES_ENABLED=true to enable.';
  }
  return null;
}

function validateResourceAllowlist(resourceIds: string[]): string | null {
  const allow = getCalendarResourceAllowlist();
  if (!allow) return null; // If unset, any resource is fine.
  const blocked = Array.from(new Set(resourceIds.filter(Boolean))).filter((id) => !allow.has(id));
  if (blocked.length === 0) return null;
  return `Calendar resource ID(s) not in writable allowlist: ${blocked.join(', ')}. Update PCO_WRITABLE_CALENDAR_RESOURCE_IDS.`;
}

function summarizePreviewChanges(changes: PreviewChange[]) {
  const eventIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const change of changes) {
    if (change.eventId) eventIds.add(change.eventId);
    if (change.eventResourceRequestId) requestIds.add(change.eventResourceRequestId);
  }
  return {
    totalChanges: changes.length,
    distinctEvents: eventIds.size,
    distinctResourceRequests: requestIds.size,
  };
}

export async function handleCalendarTool(
  name: string,
  args: Record<string, unknown>,
  client: PlanningCenterClient
): Promise<string> {
  const start = Date.now();

  try {
    switch (name) {
      // ─────────────────────────────────────────────────────────────────────
      // 1. CREATE EVENT — preview + apply (rollback = DELETE created event)
      // ─────────────────────────────────────────────────────────────────────
      case 'pco_preview_create_calendar_event': {
        const schema = z.object({
          name: z.string().min(1),
          startsAt: z.string().min(1),
          endsAt: z.string().min(1),
          description: z.string().optional(),
          locationName: z.string().optional(),
          allDay: z.boolean().optional().default(false),
        });
        const parsed = schema.parse(args);

        const gateError = validateCalendarWritesEnabled();
        if (gateError) return JSON.stringify(toolError(gateError));

        if (Number.isNaN(Date.parse(parsed.startsAt))) {
          return JSON.stringify(toolError('startsAt must be a valid ISO datetime string.'));
        }
        if (Number.isNaN(Date.parse(parsed.endsAt))) {
          return JSON.stringify(toolError('endsAt must be a valid ISO datetime string.'));
        }
        if (Date.parse(parsed.endsAt) < Date.parse(parsed.startsAt)) {
          return JSON.stringify(toolError('endsAt must be on or after startsAt.'));
        }

        const afterAttributes: Record<string, unknown> = {
          name: parsed.name,
          starts_at: parsed.startsAt,
          ends_at: parsed.endsAt,
          all_day_event: parsed.allDay,
        };
        if (parsed.description !== undefined) afterAttributes.description = parsed.description;
        if (parsed.locationName !== undefined) afterAttributes.location_name = parsed.locationName;

        const change: PreviewChange = {
          beforeAttributes: {},
          afterAttributes,
          reason: 'New event will be created via POST /calendar/v2/events',
        };

        const op = createPreviewOperation('calendar_create_event', [change], {
          name: parsed.name,
          startsAt: parsed.startsAt,
          endsAt: parsed.endsAt,
          allDay: parsed.allDay,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: op.changes.length,
          summary: summarizePreviewChanges(op.changes),
          changes: op.changes,
        }, {
          count: op.changes.length,
          pcoEndpoint: '/calendar/v2/events',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_create_calendar_event': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(10),
        });
        const parsed = schema.parse(args);

        const gateError = validateCalendarWritesEnabled();
        if (gateError) return JSON.stringify(toolError(gateError));

        const op = getPreviewOperation(parsed.previewToken, 'calendar_create_event');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for calendar_create_event. Run preview again.'));
        }

        if (op.changes.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Preview contains ${op.changes.length} changes, exceeding maxChanges=${parsed.maxChanges}.`));
        }

        const applied: Array<PreviewChange & { createdId?: string }> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          try {
            const created = await client.post<any>('/calendar/v2/events', {
              data: { type: 'Event', attributes: change.afterAttributes },
            });
            const createdId = String(created?.data?.id ?? '');
            applied.push({ ...change, createdId, eventId: createdId });
          } catch (err) {
            errors.push({
              ...change,
              error: PlanningCenterClient.formatError(err, 'Calendar'),
            });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `calendar_create_event_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'calendar_create_event',
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
          pcoEndpoint: '/calendar/v2/events',
          executionMs: Date.now() - start,
        }));
      }

      // ─────────────────────────────────────────────────────────────────────
      // 2. UPDATE EVENT TIME — preview + apply + rollback
      // ─────────────────────────────────────────────────────────────────────
      case 'pco_preview_update_event_time': {
        const schema = z.object({
          eventId: z.string().min(1),
          startsAt: z.string().min(1),
          endsAt: z.string().min(1),
        });
        const parsed = schema.parse(args);

        const gateError = validateCalendarWritesEnabled();
        if (gateError) return JSON.stringify(toolError(gateError));

        if (Number.isNaN(Date.parse(parsed.startsAt))) {
          return JSON.stringify(toolError('startsAt must be a valid ISO datetime string.'));
        }
        if (Number.isNaN(Date.parse(parsed.endsAt))) {
          return JSON.stringify(toolError('endsAt must be a valid ISO datetime string.'));
        }
        if (Date.parse(parsed.endsAt) < Date.parse(parsed.startsAt)) {
          return JSON.stringify(toolError('endsAt must be on or after startsAt.'));
        }

        // Read current state for beforeAttributes
        const current = await client.get<any>(`/calendar/v2/events/${parsed.eventId}`);
        const currentFlat = current?.data ? client.flatten(current.data) : null;
        if (!currentFlat) {
          return JSON.stringify(toolError(`Event ${parsed.eventId} not found.`));
        }

        const beforeAttributes = {
          starts_at: (currentFlat as any).starts_at,
          ends_at: (currentFlat as any).ends_at,
        };
        const afterAttributes = {
          starts_at: parsed.startsAt,
          ends_at: parsed.endsAt,
        };

        const change: PreviewChange = {
          eventId: parsed.eventId,
          beforeAttributes,
          afterAttributes,
          reason: 'Event time will be updated via PATCH /calendar/v2/events/{id}. Note: PCO Calendar may also expose times on /event_instances/{id} for recurring series — this tool updates the parent event only.',
        };

        const op = createPreviewOperation('calendar_update_event_time', [change], {
          eventId: parsed.eventId,
          before: beforeAttributes,
          after: afterAttributes,
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: op.changes.length,
          summary: summarizePreviewChanges(op.changes),
          changes: op.changes,
        }, {
          count: op.changes.length,
          pcoEndpoint: `/calendar/v2/events/${parsed.eventId}`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_update_event_time': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(10),
          requireCurrentValueMatch: z.boolean().optional().default(true),
        });
        const parsed = schema.parse(args);

        const gateError = validateCalendarWritesEnabled();
        if (gateError) return JSON.stringify(toolError(gateError));

        const op = getPreviewOperation(parsed.previewToken, 'calendar_update_event_time');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for calendar_update_event_time. Run preview again.'));
        }

        if (op.changes.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Preview contains ${op.changes.length} changes, exceeding maxChanges=${parsed.maxChanges}.`));
        }

        const applied: Array<PreviewChange & { createdId?: string }> = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          const endpoint = `/calendar/v2/events/${change.eventId}`;
          try {
            if (parsed.requireCurrentValueMatch) {
              const current = await client.get<any>(endpoint);
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

            await client.patch(endpoint, {
              data: { type: 'Event', attributes: change.afterAttributes },
            });
            applied.push(change);
          } catch (err) {
            errors.push({
              ...change,
              error: PlanningCenterClient.formatError(err, 'Calendar'),
            });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `calendar_update_event_time_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'calendar_update_event_time',
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
          pcoEndpoint: '/calendar/v2/events/*',
          executionMs: Date.now() - start,
        }));
      }

      // ─────────────────────────────────────────────────────────────────────
      // 3. APPROVE RESOURCE REQUEST — preview only; apply marked TODO if
      //    the action-endpoint shape can't be confirmed at runtime.
      // ─────────────────────────────────────────────────────────────────────
      case 'pco_preview_approve_resource_request': {
        const schema = z.object({
          eventResourceRequestId: z.string().min(1),
          approverNote: z.string().optional(),
        });
        const parsed = schema.parse(args);

        const gateError = validateCalendarWritesEnabled();
        if (gateError) return JSON.stringify(toolError(gateError));

        // Read the request to capture beforeAttributes + resource details.
        const reqResp = await client.get<any>(
          `/calendar/v2/event_resource_requests/${parsed.eventResourceRequestId}`,
          { include: 'resource,event' as any }
        );
        const requestRecord = reqResp?.data;
        if (!requestRecord) {
          return JSON.stringify(toolError(`Event resource request ${parsed.eventResourceRequestId} not found.`));
        }
        const requestFlat = client.flatten(requestRecord);

        // Pull resource ID from relationships if available.
        const resourceRelData = requestRecord?.relationships?.resource?.data;
        const resourceId = resourceRelData?.id ? String(resourceRelData.id) : undefined;

        if (resourceId) {
          const resourceError = validateResourceAllowlist([resourceId]);
          if (resourceError) return JSON.stringify(toolError(resourceError));
        }

        const beforeAttributes: Record<string, unknown> = {
          status: (requestFlat as any).status ?? 'pending',
        };
        if ((requestFlat as any).approver_notes !== undefined) {
          beforeAttributes.approver_notes = (requestFlat as any).approver_notes;
        }

        const afterAttributes: Record<string, unknown> = {
          status: 'approved',
        };
        if (parsed.approverNote !== undefined) {
          afterAttributes.approver_notes = parsed.approverNote;
        }

        const change: PreviewChange = {
          eventResourceRequestId: parsed.eventResourceRequestId,
          resourceId,
          beforeAttributes,
          afterAttributes,
          reason: 'Approval will be applied via POST /calendar/v2/event_resource_requests/{id}/approve (action endpoint). PCO Calendar uses a non-JSON:API action route — verify against your PCO docs before enabling apply.',
        };

        const op = createPreviewOperation('calendar_approve_resource_request', [change], {
          eventResourceRequestId: parsed.eventResourceRequestId,
          resourceId,
          before: beforeAttributes,
          after: afterAttributes,
          applyImplementationStatus: 'TODO_VERIFY_ENDPOINT',
        });

        return JSON.stringify(toolSuccess({
          previewToken: op.token,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
          totalChanges: op.changes.length,
          summary: summarizePreviewChanges(op.changes),
          changes: op.changes,
          notes: [
            'Preview only — verify the PCO Calendar approve-action endpoint shape before invoking apply.',
            'PCO docs hint at POST /calendar/v2/event_resource_requests/{id}/approve as an action route.',
          ],
        }, {
          count: op.changes.length,
          pcoEndpoint: `/calendar/v2/event_resource_requests/${parsed.eventResourceRequestId}`,
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_apply_approve_resource_request': {
        const schema = z.object({
          previewToken: z.string(),
          confirmPhrase: z.literal('APPLY_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(10),
        });
        const parsed = schema.parse(args);

        const gateError = validateCalendarWritesEnabled();
        if (gateError) return JSON.stringify(toolError(gateError));

        const op = getPreviewOperation(parsed.previewToken, 'calendar_approve_resource_request');
        if (!op) {
          return JSON.stringify(toolError('Invalid or expired previewToken for calendar_approve_resource_request. Run preview again.'));
        }

        // Defense-in-depth allowlist re-check.
        const resourceIds = op.changes.map((c) => c.resourceId).filter((id): id is string => Boolean(id));
        const resourceError = validateResourceAllowlist(resourceIds);
        if (resourceError) return JSON.stringify(toolError(resourceError));

        if (op.changes.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Preview contains ${op.changes.length} changes, exceeding maxChanges=${parsed.maxChanges}.`));
        }

        const applied: Array<PreviewChange & { createdId?: string }> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of op.changes) {
          const endpoint = `/calendar/v2/event_resource_requests/${change.eventResourceRequestId}/approve`;
          try {
            // PCO Calendar approve is an action endpoint; body is typically empty
            // but we pass approver_notes via attributes when present.
            const body: Record<string, unknown> = {};
            if ((change.afterAttributes as any).approver_notes !== undefined) {
              body.data = {
                type: 'EventResourceRequest',
                attributes: { approver_notes: (change.afterAttributes as any).approver_notes },
              };
            }
            await client.post(endpoint, body);
            applied.push(change);
          } catch (err) {
            errors.push({
              ...change,
              error: PlanningCenterClient.formatError(err, 'Calendar'),
            });
          }
        }

        previewOperations.delete(parsed.previewToken);
        const operationId = `calendar_approve_resource_request_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        saveAuditOperation({
          operationId,
          kind: 'calendar_approve_resource_request',
          appliedAt: new Date().toISOString(),
          sourcePreviewToken: parsed.previewToken,
          applied,
          skipped: [],
          errors,
          irreversible: true,
          irreversibleReason:
            'PCO Calendar resource-request approval is an action-route call. The reverse "unapprove" path is not reliably available — operation is recorded as audit-only.',
        });

        return JSON.stringify(toolSuccess({
          operationId,
          sourcePreviewToken: parsed.previewToken,
          attempted: op.changes.length,
          appliedCount: applied.length,
          skippedCount: 0,
          errorCount: errors.length,
          irreversible: true,
          irreversibleReason:
            'PCO Calendar resource-request approval is an action-route call. The reverse "unapprove" path is not reliably available — operation is recorded as audit-only.',
          applied,
          skipped: [],
          errors,
        }, {
          count: applied.length,
          pcoEndpoint: '/calendar/v2/event_resource_requests/*/approve',
          executionMs: Date.now() - start,
        }));
      }

      // ─────────────────────────────────────────────────────────────────────
      // Audit + rollback for calendar writes
      // ─────────────────────────────────────────────────────────────────────
      case 'pco_get_calendar_preview_summary': {
        const schema = z.object({ previewToken: z.string() });
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
          pcoEndpoint: 'calendar-preview-summary',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_get_calendar_write_audit_log': {
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
            irreversible: op.irreversible ?? false,
            irreversibleReason: op.irreversibleReason,
            summary: summarizePreviewChanges(op.applied),
          }));

        return JSON.stringify(toolSuccess({ operations }, {
          count: operations.length,
          pcoEndpoint: 'calendar-write-audit',
          executionMs: Date.now() - start,
        }));
      }

      case 'pco_rollback_calendar_write_operation': {
        const schema = z.object({
          operationId: z.string(),
          confirmPhrase: z.literal('ROLLBACK_CHANGES'),
          maxChanges: z.number().int().positive().optional().default(10),
        });
        const parsed = schema.parse(args);

        const gateError = validateCalendarWritesEnabled();
        if (gateError) return JSON.stringify(toolError(gateError));

        const operation = getAuditOperation(parsed.operationId);
        if (!operation) {
          return JSON.stringify(toolError('Unknown operationId (or it has expired from audit history).'));
        }

        if (operation.irreversible) {
          return JSON.stringify(toolError(
            `This operation type is irreversible. Audit only. ${operation.irreversibleReason ?? ''}`.trim()
          ));
        }

        if (operation.applied.length > parsed.maxChanges) {
          return JSON.stringify(toolError(`Operation has ${operation.applied.length} applied changes, exceeding maxChanges=${parsed.maxChanges}.`));
        }

        const rolledBack: Array<PreviewChange & { createdId?: string }> = [];
        const skipped: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];

        for (const change of operation.applied) {
          try {
            if (operation.kind === 'calendar_create_event') {
              const createdId = change.createdId ?? change.eventId;
              if (!createdId) {
                skipped.push({ ...change, reason: 'No createdId recorded; cannot delete.' });
                continue;
              }
              await client.delete(`/calendar/v2/events/${createdId}`);
              rolledBack.push(change);
            } else if (operation.kind === 'calendar_update_event_time') {
              if (!change.eventId) {
                skipped.push({ ...change, reason: 'No eventId recorded; cannot revert.' });
                continue;
              }
              await client.patch(`/calendar/v2/events/${change.eventId}`, {
                data: { type: 'Event', attributes: change.beforeAttributes },
              });
              rolledBack.push(change);
            } else {
              skipped.push({ ...change, reason: `Rollback not implemented for kind ${operation.kind}.` });
            }
          } catch (err) {
            errors.push({
              ...change,
              error: PlanningCenterClient.formatError(err, 'Calendar'),
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
          pcoEndpoint: 'calendar-rollback',
          executionMs: Date.now() - start,
        }));
      }

      default:
        return JSON.stringify(toolError(`Unknown calendar tool: ${name}`));
    }
  } catch (err) {
    return JSON.stringify(
      toolError(PlanningCenterClient.formatError(err, 'Calendar'), {
        pcoEndpoint: name,
        executionMs: Date.now() - start,
      })
    );
  }
}

export function getCalendarToolDefinitions() {
  return [
    {
      name: 'pco_preview_create_calendar_event',
      description:
        'Preview creating a new Planning Center Calendar event. Dry-run only; returns previewToken plus the full attribute payload that will be POSTed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Event name (required)' },
          startsAt: { type: 'string', description: 'ISO-8601 start datetime' },
          endsAt: { type: 'string', description: 'ISO-8601 end datetime' },
          description: { type: 'string', description: 'Optional event description' },
          locationName: { type: 'string', description: 'Optional human-readable location' },
          allDay: { type: 'boolean', description: 'All-day event flag (default false)' },
        },
        required: ['name', 'startsAt', 'endsAt'],
      },
    },
    {
      name: 'pco_apply_create_calendar_event',
      description:
        'Apply a previewed calendar event creation. Posts to /calendar/v2/events. Reversible via rollback (DELETE the created event).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned by pco_preview_create_calendar_event' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to allow from preview (default 10)' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_update_event_time',
      description:
        'Preview updating an existing calendar event\'s start/end times. Reads current PCO state for the before-baseline. Updates the parent /calendar/v2/events/{id}; for recurring series, instance-level times may also exist on /event_instances/{id} — this tool does NOT update those.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          eventId: { type: 'string', description: 'Planning Center event ID' },
          startsAt: { type: 'string', description: 'New ISO-8601 start datetime' },
          endsAt: { type: 'string', description: 'New ISO-8601 end datetime' },
        },
        required: ['eventId', 'startsAt', 'endsAt'],
      },
    },
    {
      name: 'pco_apply_update_event_time',
      description:
        'Apply a previewed event-time update via PATCH /calendar/v2/events/{id}. Reversible via rollback.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned by pco_preview_update_event_time' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to allow from preview (default 10)' },
          requireCurrentValueMatch: { type: 'boolean', description: 'Skip if event changed since preview (default true)' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_preview_approve_resource_request',
      description:
        'Preview approving a pending Planning Center Calendar event resource request. Reads the current request + resource and returns the proposed approval as a previewToken. Apply uses an action-route POST and is audit-only (irreversible).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          eventResourceRequestId: { type: 'string', description: 'PCO event resource request ID' },
          approverNote: { type: 'string', description: 'Optional note attached to the approval' },
        },
        required: ['eventResourceRequestId'],
      },
    },
    {
      name: 'pco_apply_approve_resource_request',
      description:
        'Apply a previewed resource-request approval via POST /calendar/v2/event_resource_requests/{id}/approve. IRREVERSIBLE — recorded in audit log only. Verify PCO action-endpoint shape before relying on this in production.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned by pco_preview_approve_resource_request' },
          confirmPhrase: { type: 'string', enum: ['APPLY_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to allow from preview (default 10)' },
        },
        required: ['previewToken', 'confirmPhrase'],
      },
    },
    {
      name: 'pco_get_calendar_preview_summary',
      description:
        'Summarize a calendar preview token before applying — shows kind, change count, and sample changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          previewToken: { type: 'string', description: 'Token returned from a calendar preview tool' },
        },
        required: ['previewToken'],
      },
    },
    {
      name: 'pco_get_calendar_write_audit_log',
      description:
        'List recent Calendar write operations (apply/rollback) with summary counts and irreversibility flags.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max operations to return (default 20, max 100)' },
        },
        required: [] as string[],
      },
    },
    {
      name: 'pco_rollback_calendar_write_operation',
      description:
        'Rollback a prior Calendar write operation. Reversible kinds: calendar_create_event (DELETE) + calendar_update_event_time (PATCH back). Irreversible kinds (resource-request approval) return an error.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          operationId: { type: 'string', description: 'Operation ID returned by an apply tool' },
          confirmPhrase: { type: 'string', enum: ['ROLLBACK_CHANGES'], description: 'Safety confirmation phrase' },
          maxChanges: { type: 'number', description: 'Max changes to rollback (default 10)' },
        },
        required: ['operationId', 'confirmPhrase'],
      },
    },
  ];
}
