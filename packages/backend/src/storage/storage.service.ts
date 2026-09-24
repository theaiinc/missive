import { Injectable } from '@nestjs/common';
import { PostgresService } from './postgres.service';
import { openRow, openRows, seal, sealJson } from './content-crypto';
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
    return rowToMissive(await openRow('missives', rows[0]));
  }

  async saveMissive(missive: Missive): Promise<void> {
    await this.pg.query(
      `INSERT INTO missives (
        id, thread_id, channel, direction, provider, provider_message_id,
        subject, body, body_html, sender_name, sender_address, recipients, status,
        classification, account_email, folder, received_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
      ON CONFLICT (owner_id, provider, provider_message_id) DO UPDATE SET
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
        await seal('missives', 'subject', missive.subject),
        await seal('missives', 'body', missive.body),
        await seal('missives', 'body_html', missive.bodyHtml),
        await seal('missives', 'sender_name', missive.from.name),
        await seal('missives', 'sender_address', missive.from.address),
        await sealJson('missives', 'recipients', missive.to),
        missive.status,
        missive.classification ?? null,
        await seal('missives', 'account_email', missive.accountEmail),
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
    return (await openRows('missives', rows)).map(rowToMissive);
  }

  async getRecentMissives(since: string, limit = 10): Promise<Missive[]> {
    const { rows } = await this.pg.query(
      `SELECT * FROM missives WHERE created_at > $1 ORDER BY created_at DESC LIMIT $2`,
      [since, limit],
    );
    return (await openRows('missives', rows)).map(rowToMissive);
  }

  // ── Threads ──

  async getThread(id: string): Promise<Thread | null> {
    const { rows } = await this.pg.query(
      `SELECT * FROM threads WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToThread(await openRow('threads', rows[0]));
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
        await seal('threads', 'subject', thread.subject),
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

    // Body, subject and sender are encrypted, so the database can't match
    // them: those filters run below, on the decrypted rows.
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
    if (query.organization) {
      conditions.push(`$${idx} = ANY(organizations)`);
      params.push(query.organization);
      idx++;
    }
    if (query.project) {
      conditions.push(`$${idx} = ANY(projects)`);
      params.push(query.project);
      idx++;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    let missives: Missive[];
    let total: number;
    const text = query.query?.trim().toLowerCase();
    const from = query.from?.trim().toLowerCase();
    if (text || from) {
      // Decrypt this user's candidate rows (already narrowed by folder,
      // channel, dates, ...) and match in memory, as ILIKE '%…%' did.
      const dataRes = await this.pg.query(
        `SELECT * FROM missives ${where} ORDER BY received_at DESC`,
        params,
      );
      const matches = (await openRows('missives', dataRes.rows)).filter((r) =>
        (!text || `${r.subject ?? ''}\n${r.body ?? ''}`.toLowerCase().includes(text)) &&
        (!from || String(r.sender_address ?? '').toLowerCase().includes(from)),
      );
      total = matches.length;
      missives = matches.slice(offset, offset + limit).map(rowToMissive);
    } else {
      const countRes = await this.pg.query(
        `SELECT COUNT(*) FROM missives ${where}`,
        params,
      );
      total = parseInt(countRes.rows[0].count, 10);
      const dataRes = await this.pg.query(
        `SELECT * FROM missives ${where} ORDER BY received_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      );
      missives = (await openRows('missives', dataRes.rows)).map(rowToMissive);
    }

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
       GROUP BY f.owner_id, f.id
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

  async classifyMissive(id: string, classification: string): Promise<void> {
    const folder = classificationToFolder(classification);
    if (folder) {
      await this.pg.query(
        'UPDATE missives SET classification = $1, folder = $2, updated_at = NOW() WHERE id = $3',
        [classification, folder, id],
      );
    } else {
      await this.pg.query(
        'UPDATE missives SET classification = $1, updated_at = NOW() WHERE id = $2',
        [classification, id],
      );
    }
  }

  async classifyThread(threadId: string, classification: string): Promise<void> {
    const folder = classificationToFolder(classification);
    if (folder) {
      await this.pg.query(
        'UPDATE missives SET classification = $1, folder = $2, updated_at = NOW() WHERE thread_id = $3',
        [classification, folder, threadId],
      );
    } else {
      await this.pg.query(
        'UPDATE missives SET classification = $1, updated_at = NOW() WHERE thread_id = $2',
        [classification, threadId],
      );
    }
  }

  async moveThread(threadId: string, folder: string): Promise<void> {
    await this.pg.query(
      'UPDATE missives SET folder = $1, updated_at = NOW() WHERE thread_id = $2',
      [folder, threadId],
    );
  }

  /** Find other missives with the same sender domain currently in `folder`. */
  async findMissivesBySenderDomain(
    domain: string,
    folder: string,
    excludeId: string,
    limit = 20,
  ): Promise<{ id: string }[]> {
    // sender_address is encrypted: narrow by folder in SQL, match the domain here.
    const { rows } = await this.pg.query(
      `SELECT id, owner_id, sender_address FROM missives WHERE folder = $1 AND id <> $2 ORDER BY received_at DESC`,
      [folder, excludeId],
    );
    const suffix = `@${domain.toLowerCase()}`;
    return (await openRows('missives', rows))
      .filter((r) => String(r.sender_address ?? '').toLowerCase().endsWith(suffix))
      .slice(0, limit)
      .map((r) => ({ id: r.id }));
  }

  /** Move multiple missives to a folder in one query. */
  async batchMoveMissives(ids: string[], folder: string): Promise<void> {
    await this.pg.query(
      `UPDATE missives SET folder = $1, updated_at = NOW() WHERE id = ANY($2::text[])`,
      [folder, ids],
    );
  }

  // ── Organizations ──

  async setMissiveOrganizations(id: string, organizations: string[]): Promise<void> {
    await this.pg.query(
      'UPDATE missives SET organizations = $1, updated_at = NOW() WHERE id = $2',
      [organizations, id],
    );
  }

  async setThreadOrganizations(threadId: string, organizations: string[]): Promise<void> {
    await this.pg.query(
      'UPDATE missives SET organizations = $1, updated_at = NOW() WHERE thread_id = $2',
      [organizations, threadId],
    );
  }

  /** List all distinct organizations across all missives. */
  async listOrganizations(): Promise<string[]> {
    const { rows } = await this.pg.query(
      "SELECT DISTINCT unnest(organizations) AS org FROM missives WHERE organizations != '{}' ORDER BY org"
    );
    return rows.map((r: any) => r.org);
  }

  // ── Projects ──

  async setMissiveProjects(id: string, projects: string[]): Promise<void> {
    await this.pg.query(
      'UPDATE missives SET projects = $1, updated_at = NOW() WHERE id = $2',
      [projects, id],
    );
  }

  async setThreadProjects(threadId: string, projects: string[]): Promise<void> {
    await this.pg.query(
      'UPDATE missives SET projects = $1, updated_at = NOW() WHERE thread_id = $2',
      [projects, threadId],
    );
  }

  /** List all distinct projects across all missives. */
  async listProjects(): Promise<string[]> {
    const { rows } = await this.pg.query(
      "SELECT DISTINCT unnest(projects) AS proj FROM missives WHERE projects != '{}' ORDER BY proj"
    );
    return rows.map((r: any) => r.proj);
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
    organizations: row.organizations ?? undefined,
    projects: row.projects ?? undefined,
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

function classificationToFolder(classification: string): string | null {
  const map: Record<string, string> = {
    invoice: "invoices",
    complaint: "complaints",
    lead: "leads",
    support: "support",
    personal: "personal",
    notification: "inbox",
    newsletter: "archived",
    meeting: "archived",
    spam: "archived",
    other: "archived",
  };
  return map[classification?.toLowerCase()] ?? null;
}
