import { Injectable, OnModuleInit } from "@nestjs/common";
import { Pool } from "pg";
import * as fs from "node:fs";
import * as path from "node:path";

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

    // Seed system folders
    const systemFolders = [
      { slug: "inbox", name: "Inbox", icon: "inbox", ord: 0 },
      { slug: "archived", name: "Archived", icon: "archive", ord: 1 },
      { slug: "invoices", name: "Invoices", icon: "file-text", ord: 2 },
      { slug: "complaints", name: "Complaints", icon: "alert-triangle", ord: 3 },
      { slug: "leads", name: "Leads", icon: "user-plus", ord: 4 },
      { slug: "support", name: "Support", icon: "life-buoy", ord: 5 },
      { slug: "personal", name: "Personal", icon: "user", ord: 6 },
    ];
    for (const f of systemFolders) {
      await this.pool.query(
        `INSERT INTO folders (id, name, slug, icon, system, ord, created_at, updated_at)
         VALUES ($1,$2,$3,$4,true,$5,NOW(),NOW())
         ON CONFLICT (slug) DO NOTHING`,
        [f.slug, f.name, f.slug, f.icon, f.ord]
      );
    }
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

  async query(text: string, params?: any[]) {
    return this.pool.query(text, params);
  }
}
