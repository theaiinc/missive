import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PostgresService } from "./storage/postgres.service";
import { requireUser } from "./request-context";
import { DraftUnreadableError, openDraft, sealDraft } from "./draft-crypto";

export type StoredDraft = {
  id: string;
  mailbox: string;
  payload: Record<string, unknown>;
  updatedAt: string;
  createdAt: string;
};

const COLUMNS = "id, owner_id, mailbox, payload, updated_at, created_at";

/**
 * Compose drafts, stored encrypted for their owner (draft-crypto.ts) and
 * opened here, so the API only ever returns plain drafts to their owner.
 */
@Injectable()
export class DraftsService {
  private readonly log = new Logger("Drafts");

  constructor(private readonly db: PostgresService) {}

  /** Yours, newest first. A draft that can't be decrypted is left out (and logged by id), not shown. */
  async list(): Promise<StoredDraft[]> {
    const user = requireUser();
    const result = await this.db.query(
      `SELECT ${COLUMNS} FROM drafts WHERE owner_id = $1 ORDER BY updated_at DESC`,
      [user.id],
    );
    const drafts: StoredDraft[] = [];
    for (const row of result.rows) {
      try {
        drafts.push(await this.open(row));
      } catch (error) {
        if (!(error instanceof DraftUnreadableError)) throw error;
        this.log.warn(error.message);
      }
    }
    return drafts;
  }

  /** Null when there's no such draft of yours; DraftUnreadableError when it doesn't decrypt. */
  async get(id: string): Promise<StoredDraft | null> {
    const user = requireUser();
    const result = await this.db.query(
      `SELECT ${COLUMNS} FROM drafts WHERE id = $1 AND owner_id = $2`,
      [id, user.id],
    );
    return result.rows[0] ? this.open(result.rows[0]) : null;
  }

  async upsert(input: {
    id?: string;
    mailbox: string;
    payload: Record<string, unknown>;
    updatedAt?: string;
  }): Promise<StoredDraft | null> {
    const user = requireUser();
    const id = input.id ?? randomUUID();
    const sealed = await sealDraft(user.id, id, input);
    const result = await this.db.query(
      `INSERT INTO drafts (id, owner_id, mailbox, payload, is_empty, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE($6::timestamptz, NOW()))
       ON CONFLICT (id) DO UPDATE SET
         mailbox = EXCLUDED.mailbox,
         payload = EXCLUDED.payload,
         is_empty = EXCLUDED.is_empty,
         updated_at = EXCLUDED.updated_at
       WHERE drafts.owner_id = $2
       RETURNING id, updated_at, created_at`,
      [id, user.id, sealed.mailbox, sealed.payload, sealed.isEmpty, input.updatedAt ?? null],
    );
    // No row: the id is someone else's draft (the conflict's WHERE refused it).
    const row = result.rows[0];
    if (!row) return null;
    // What was just saved, without decrypting it again.
    return this.map(row, { mailbox: input.mailbox, payload: input.payload });
  }

  /** False when there's no such draft of yours. */
  async remove(id: string): Promise<boolean> {
    const user = requireUser();
    const result = await this.db.query("DELETE FROM drafts WHERE id = $1 AND owner_id = $2", [id, user.id]);
    return (result.rowCount ?? 0) > 0;
  }

  private async open(row: any): Promise<StoredDraft> {
    return this.map(row, await openDraft(row));
  }

  private map(row: any, content: { mailbox: string; payload: Record<string, unknown> }): StoredDraft {
    return {
      id: row.id,
      mailbox: content.mailbox,
      payload: content.payload,
      updatedAt: new Date(row.updated_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }
}
