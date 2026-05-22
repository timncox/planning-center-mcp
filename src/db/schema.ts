import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  uuid,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const pcoConnections = pgTable('pco_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  churchName: text('church_name'),
  pcoOrganizationId: text('pco_organization_id'),
  pcoPersonId: text('pco_person_id'),
  pcoPersonName: text('pco_person_name'),
  encryptedAccessToken: text('encrypted_access_token').notNull(),
  encryptedRefreshToken: text('encrypted_refresh_token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const connectorTokens = pgTable(
  'connector_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pcoConnectionId: uuid('pco_connection_id')
      .notNull()
      .references(() => pcoConnections.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    name: text('name'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUniq: uniqueIndex('connector_tokens_token_hash_uniq').on(t.tokenHash),
    connectionIdx: index('connector_tokens_connection_idx').on(t.pcoConnectionId),
  }),
);

export const mcpAuditLogs = pgTable(
  'mcp_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pcoConnectionId: uuid('pco_connection_id').references(() => pcoConnections.id, {
      onDelete: 'set null',
    }),
    toolName: text('tool_name'),
    success: boolean('success'),
    executionMs: integer('execution_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    connectionIdx: index('mcp_audit_logs_connection_idx').on(t.pcoConnectionId),
  }),
);

export const serviceFeedback = pgTable(
  'service_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pcoConnectionId: uuid('pco_connection_id')
      .notNull()
      .references(() => pcoConnections.id, { onDelete: 'cascade' }),
    serviceTypeId: text('service_type_id').notNull(),
    planId: text('plan_id').notNull(),
    planTitle: text('plan_title'),
    planDate: text('plan_date'),
    wins: jsonb('wins').notNull().default(sql`'[]'::jsonb`),
    issues: jsonb('issues').notNull().default(sql`'[]'::jsonb`),
    doAgain: jsonb('do_again').notNull().default(sql`'[]'::jsonb`),
    avoidNextTime: jsonb('avoid_next_time').notNull().default(sql`'[]'::jsonb`),
    notes: text('notes'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    connectionIdx: index('service_feedback_connection_idx').on(t.pcoConnectionId),
    planIdx: index('service_feedback_plan_idx').on(t.serviceTypeId, t.planId),
    tagsIdx: index('service_feedback_tags_idx').using('gin', t.tags),
  }),
);

export type PcoConnection = typeof pcoConnections.$inferSelect;
export type ConnectorToken = typeof connectorTokens.$inferSelect;
export type ServiceFeedbackRow = typeof serviceFeedback.$inferSelect;
