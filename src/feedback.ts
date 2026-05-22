import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { serviceFeedback, type ServiceFeedbackRow } from './db/schema.js';

export type ServiceFeedbackInput = {
  connectionId?: string;
  serviceTypeId: string;
  planId: string;
  planTitle?: string | null;
  planDate?: string | null;
  wins: string[];
  issues: string[];
  doAgain: string[];
  avoidNextTime: string[];
  notes?: string | null;
  tags?: string[];
};

export type ServiceFeedbackRecord = ServiceFeedbackInput & {
  id: string;
  createdAt: string;
};

export interface FeedbackStore {
  saveServiceFeedback(input: ServiceFeedbackInput): Promise<ServiceFeedbackRecord>;
  listServiceFeedback(input: {
    connectionId?: string;
    serviceTypeId?: string;
    planId?: string;
    tags?: string[];
    limit?: number;
  }): Promise<ServiceFeedbackRecord[]>;
}

export class DisabledFeedbackStore implements FeedbackStore {
  async saveServiceFeedback(): Promise<ServiceFeedbackRecord> {
    throw new Error('Service feedback memory is not configured for this MCP server. Use the hosted connector with the database enabled.');
  }

  async listServiceFeedback(): Promise<ServiceFeedbackRecord[]> {
    return [];
  }
}

export class NeonFeedbackStore implements FeedbackStore {
  constructor(private readonly db: Db) {}

  async saveServiceFeedback(input: ServiceFeedbackInput): Promise<ServiceFeedbackRecord> {
    if (!input.connectionId) {
      throw new Error('Missing connectionId for service feedback memory.');
    }

    const [row] = await this.db
      .insert(serviceFeedback)
      .values({
        pcoConnectionId: input.connectionId,
        serviceTypeId: input.serviceTypeId,
        planId: input.planId,
        planTitle: input.planTitle ?? null,
        planDate: input.planDate ?? null,
        wins: input.wins,
        issues: input.issues,
        doAgain: input.doAgain,
        avoidNextTime: input.avoidNextTime,
        notes: input.notes ?? null,
        tags: input.tags ?? [],
      })
      .returning();

    return rowToFeedback(row);
  }

  async listServiceFeedback(input: {
    connectionId?: string;
    serviceTypeId?: string;
    planId?: string;
    tags?: string[];
    limit?: number;
  }): Promise<ServiceFeedbackRecord[]> {
    if (!input.connectionId) return [];

    const conditions = [eq(serviceFeedback.pcoConnectionId, input.connectionId)];
    if (input.serviceTypeId) conditions.push(eq(serviceFeedback.serviceTypeId, input.serviceTypeId));
    if (input.planId) conditions.push(eq(serviceFeedback.planId, input.planId));
    if (input.tags?.length) {
      conditions.push(sql`${serviceFeedback.tags} && ${input.tags}::text[]`);
    }

    const rows = await this.db
      .select()
      .from(serviceFeedback)
      .where(and(...conditions))
      .orderBy(desc(serviceFeedback.createdAt))
      .limit(input.limit ?? 20);

    return rows.map(rowToFeedback);
  }
}

function rowToFeedback(row: ServiceFeedbackRow): ServiceFeedbackRecord {
  return {
    id: row.id,
    connectionId: row.pcoConnectionId,
    serviceTypeId: row.serviceTypeId,
    planId: row.planId,
    planTitle: row.planTitle,
    planDate: row.planDate,
    wins: (row.wins as string[]) ?? [],
    issues: (row.issues as string[]) ?? [],
    doAgain: (row.doAgain as string[]) ?? [],
    avoidNextTime: (row.avoidNextTime as string[]) ?? [],
    notes: row.notes,
    tags: row.tags ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}
