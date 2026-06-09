import { Injectable } from '@nestjs/common';
import { PostgresService } from './postgres.service';
import type {
  Missive,
  Thread,
  SearchQuery,
  SearchResult,
  Folder,
} from '@theaiinc/missive-core';

@Injectable()
export class StorageService {
  constructor(private readonly pg: PostgresService) {}

  // ── Missives ──

  async getMissive(id: string): Promise<Missive | null> {
    const { rows } = await this.pg.query(
      `SELECT * FROM missives WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToMissive(rows[0]);
  }

  async saveMissive(missive: Missive): Promise<void> {
    await this.pg.query(
      `INSERT INTO missives (
        id, thread_id, channel, direction, provider, provider_message_id,
        subject, body, body_html, sender_name, sender_address, recipients, status,
        classification, account_email, folder, received_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
      ON CONFLICT (provider, provider_message_id) DO UPDATE SET
        body = EXCLUDED.body,
        body_html = EXCLUDED.body_html,
        status = EXCLUDED.status,
        updated_at = NOW()`,
      [
        missive.id,
        missive.threadId,
        missive.channel,
        missive.direction,
        missive.provider,
        missive.providerMessageId,
        missive.subject ?? null,
        missive.body,
        missive.bodyHtml ?? null,
        missive.from.name ?? null,
        missive.from.address,
        JSON.stringify(missive.to),
        missive.status,
        missive.classification ?? null,
        missive.accountEmail ?? null,
        missive.folder ?? 'inbox',
        missive.receivedAt,
      ],
    );
  }

  async getThreadMissives(threadId: string): Promise<Missive[]> {
    const { rows } = await this.pg.query(
      `SELECT * FROM missives WHERE thread_id = $1 ORDER BY received_at DESC`,
      [threadId],
    );
    return rows.map(rowToMissive);
  }

  async getRecentMissives(since: string, limit = 10): Promise<Missive[]> {
    const { rows } = await this.pg.query(
      `SELECT * FROM missives WHERE created_at > $1 ORDER BY created_at DESC LIMIT $2`,
      [since, limit],
    );
    return rows.map(rowToMissive);
  }

  // ── Threads ──

  async getThread(id: string): Promise<Thread | null> {
    const { rows } = await this.pg.query(
      `SELECT * FROM threads WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToThread(rows[0]);
  }

  async saveThread(thread: Thread): Promise<void> {
    await this.pg.query(
      `INSERT INTO threads (
        id, provider, provider_thread_id, subject, participants,
        message_count, missive_ids, last_activity_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET
        message_count = EXCLUDED.message_count,
        missive_ids = EXCLUDED.missive_ids,
        last_activity_at = EXCLUDED.last_activity_at,
        updated_at = NOW()`,
      [
        thread.id,
        thread.provider,
        thread.providerThreadId,
        thread.subject ?? null,
        JSON.stringify(thread.participants),
        thread.messageCount,
        `{${thread.missiveIds.join(',')}}`,
        thread.lastActivityAt,
      ],
    );
  }

  // ── Search ──

  async search(query: SearchQuery): Promise<SearchResult> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (query.folder) {
      conditions.push(`folder = $${idx}`);
      params.push(query.folder);
      idx++;
    }

    if (query.query) {
      conditions.push(`(body ILIKE $${idx} OR subject ILIKE $${idx})`);
      params.push(`%${query.query}%`);
      idx++;
    }
    if (query.channel) {
      conditions.push(`channel = $${idx}`);
      params.push(query.channel);
      idx++;
    }
    if (query.provider) {
      conditions.push(`provider = $${idx}`);
      params.push(query.provider);
      idx++;
    }
    if (query.from) {
      conditions.push(`sender_address ILIKE $${idx}`);
      params.push(`%${query.from}%`);
      idx++;
    }
    if (query.after) {
      conditions.push(`received_at >= $${idx}`);
      params.push(query.after);
      idx++;
    }
    if (query.before) {
      conditions.push(`received_at <= $${idx}`);
      params.push(query.before);
      idx++;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const countRes = await this.pg.query(
      `SELECT COUNT(*) FROM missives ${where}`,
      params,
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const dataRes = await this.pg.query(
      `SELECT * FROM missives ${where} ORDER BY received_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );
    const missives = dataRes.rows.map(rowToMissive);

    // Resolve threads
    const threadIds = [...new Set(missives.map(m => m.threadId))] as string[];
    const threads: Thread[] = [];
    for (const tid of threadIds) {
      const t = await this.getThread(tid);
      if (t) threads.push(t);
    }

    return { missives, threads, total };
  }

  // ── Folders ──

  async listFolders(): Promise<(Folder & { missiveCount: number })[]> {
    const { rows } = await this.pg.query(
      `SELECT f.*, COUNT(m.id)::int AS missive_count
       FROM folders f
       LEFT JOIN missives m ON m.folder = f.slug
       GROUP BY f.id, f.name, f.slug, f.icon, f.system, f.ord, f.created_at, f.updated_at
       ORDER BY f.ord ASC`,
    );
    return rows.map(rowToFolder);
  }

  async createFolder(data: {
    name: string;
    slug: string;
    icon?: string;
    color?: string;
  }): Promise<Folder> {
    const { rows } = await this.pg.query(
      `INSERT INTO folders (id, name, slug, icon, color, system, ord, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,false,(SELECT COALESCE(MAX(ord), 6) + 1 FROM folders),NOW(),NOW())
       RETURNING *`,
      [data.slug, data.name, data.slug, data.icon ?? null, data.color ?? null],
    );
    return rowToFolder(rows[0]);
  }

  async moveMissive(id: string, folder: string): Promise<void> {
    await this.pg.query(
      'UPDATE missives SET folder = $1, updated_at = NOW() WHERE id = $2',
      [folder, id],
    );
  }

  async moveThread(threadId: string, folder: string): Promise<void> {
    await this.pg.query(
      'UPDATE missives SET folder = $1, updated_at = NOW() WHERE thread_id = $2',
      [folder, threadId],
    );
  }
}

function rowToMissive(row: any): Missive {
  return {
    id: row.id,
    threadId: row.thread_id,
    channel: row.channel,
    direction: row.direction,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    subject: row.subject ?? undefined,
    body: row.body,
    bodyHtml: row.body_html ?? undefined,
    from: { name: row.sender_name ?? undefined, address: row.sender_address },
    to:
      typeof row.recipients === 'string'
        ? JSON.parse(row.recipients)
        : row.recipients,
    status: row.status,
    classification: row.classification ?? undefined,
    folder: row.folder ?? 'inbox',
    accountEmail: row.account_email ?? undefined,
    receivedAt: row.received_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToThread(row: any): Thread {
  return {
    id: row.id,
    provider: row.provider,
    providerThreadId: row.provider_thread_id,
    subject: row.subject ?? undefined,
    participants:
      typeof row.participants === 'string'
        ? JSON.parse(row.participants)
        : row.participants,
    messageCount: row.message_count,
    missiveIds: row.missive_ids ?? [],
    lastActivityAt: row.last_activity_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToFolder(row: any): Folder & { missiveCount: number } {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon ?? undefined,
    color: row.color ?? undefined,
    system: row.system,
    order: row.ord,
    missiveCount: row.missive_count ?? 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
