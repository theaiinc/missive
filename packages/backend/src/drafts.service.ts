import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PostgresService } from "./storage/postgres.service";
import { requireUser } from "./request-context";

export type StoredDraft = {
  id: string;
  mailbox: string;
  payload: Record<string, unknown>;
  updatedAt: string;
  createdAt: string;
};

@Injectable()
export class DraftsService {
  constructor(private readonly db: PostgresService) {}

  async list(): Promise<StoredDraft[]> {
    const user = requireUser();
    const result = await this.db.query(
      `SELECT id, mailbox, payload, updated_at, created_at
         FROM drafts WHERE owner_id = $1 ORDER BY updated_at DESC`,
      [user.id],
    );
    return result.rows.map((row) => this.map(row));
  }

  async get(id: string): Promise<StoredDraft | null> {
    const user = requireUser();
    const result = await this.db.query(
      `SELECT id, mailbox, payload, updated_at, created_at
         FROM drafts WHERE id = $1 AND owner_id = $2`,
      [id, user.id],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async upsert(input: {
    id?: string;
    mailbox: string;
    payload: Record<string, unknown>;
    updatedAt?: string;
  }): Promise<StoredDraft> {
    const user = requireUser();
    const id = input.id ?? randomUUID();
    const result = await this.db.query(
      `INSERT INTO drafts (id, owner_id, mailbox, payload, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, NOW()))
       ON CONFLICT (id) DO UPDATE SET
         mailbox = EXCLUDED.mailbox,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at
       WHERE drafts.owner_id = $2
       RETURNING id, mailbox, payload, updated_at, created_at`,
      [id, user.id, input.mailbox, JSON.stringify(input.payload), input.updatedAt ?? null],
    );
    if (!result.rows[0]) throw new Error("Draft does not exist or belongs to another user");
    return this.map(result.rows[0]);
  }

  async remove(id: string): Promise<void> {
    const user = requireUser();
    await this.db.query("DELETE FROM drafts WHERE id = $1 AND owner_id = $2", [id, user.id]);
  }

  private map(row: any): StoredDraft {
    return {
      id: row.id,
      mailbox: row.mailbox,
      payload: row.payload,
      updatedAt: new Date(row.updated_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }
}