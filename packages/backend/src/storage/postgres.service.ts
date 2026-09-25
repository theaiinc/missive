import { Injectable, OnModuleInit } from "@nestjs/common";
import { Pool } from "pg";
import * as fs from "node:fs";
import * as path from "node:path";
import { currentUser, runAsUser } from "../request-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM_FOLDERS = [
  { slug: "inbox", name: "Inbox", icon: "inbox", ord: 0 },
  { slug: "sent", name: "Sent", icon: "send", ord: 1 },
  { slug: "archived", name: "Archived", icon: "archive", ord: 2 },
  { slug: "invoices", name: "Invoices", icon: "file-text", ord: 3 },
  { slug: "complaints", name: "Complaints", icon: "alert-triangle", ord: 4 },
  { slug: "leads", name: "Leads", icon: "user-plus", ord: 5 },
  { slug: "support", name: "Support", icon: "life-buoy", ord: 6 },
  { slug: "personal", name: "Personal", icon: "user", ord: 7 },
  { slug: "spam", name: "Spam", icon: "shield-alert", ord: 8 },
];

@Injectable()
export class PostgresService implements OnModuleInit {
  public pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ?? "postgresql://missive:missive@localhost:5432/missive",
    });
  }

  async onModuleInit() {
    await this.runMigrations();
  }

  /** Creates the system folders for a user; safe to call on every sign-in. */
  async ensureUserFolders(userId: string) {
    if (!UUID.test(userId)) throw new Error("Bad user id");
    // As that user: folders has FORCE ROW LEVEL SECURITY, so without
    // app.user_id the insert is refused unless the connection bypasses RLS.
    await runAsUser({ id: userId, email: "" }, async () => {
      for (const f of SYSTEM_FOLDERS) {
        await this.query(
        `INSERT INTO folders (id, name, slug, icon, system, ord, owner_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,true,$5,$6,NOW(),NOW())
         ON CONFLICT (owner_id, slug) DO NOTHING`,
          [f.slug, f.name, f.slug, f.icon, f.ord, userId]
        );
      }
    });
  }

  /** Resolve migration files — from dist/ back to src/ */
  private migrationDir(): string {
    // When running compiled (dist/storage/): ../../src/storage/migrations
    const fromDist = path.resolve(__dirname, "../../src/storage/migrations");
    if (fs.existsSync(fromDist)) return fromDist;
    // Fallback (tsx or direct): adjacent migrations folder
    return path.resolve(__dirname, "migrations");
  }

  private async runMigrations() {
    const dir = this.migrationDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const file of files) {
      const { rows } = await this.pool.query(
        "SELECT 1 FROM _migrations WHERE name = $1",
        [file]
      );
      if (rows.length > 0) continue;

      const sql = fs.readFileSync(path.join(dir, file), "utf-8");
      await this.pool.query(sql);
      await this.pool.query("INSERT INTO _migrations (name) VALUES ($1)", [
        file,
      ]);
      console.log(`[migration] applied ${file}`);
    }
  }

  /**
   * Runs a query for the current user (see runAsUser). It runs as the
   * restricted missive_app role with app.user_id set, so row-level security
   * only shows and accepts that user's rows. With no user it sees nothing.
   */
  async query(text: string, params?: any[]) {
    const user = currentUser();
    const userId = user && UUID.test(user.id) ? user.id : "";
    const client = await this.pool.connect();
    try {
      // userId is a validated UUID (or empty), so it's safe inline; this keeps
      // the setup to one round trip.
      await client.query(`BEGIN; SET LOCAL ROLE missive_app; SELECT set_config('app.user_id', '${userId}', true);`);
      const result = await client.query(text, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs a query as the server itself, without row-level security. Only for
   * the users, domains and mailboxes tables and account setup — never with
   * input that picks another user's mail.
   */
  async systemQuery(text: string, params?: any[]) {
    return this.pool.query(text, params);
  }
}
