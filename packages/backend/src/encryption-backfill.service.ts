import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { userScope } from "@theaiinc/missive-core";
import { PostgresService } from "./storage/postgres.service";
import { UsersService } from "./users.service";
import { runAsUser } from "./request-context";
import { dataCipher } from "./data-cipher";
import { safeError } from "./log-safe";
import { ENCRYPTED_COLUMNS, type EncryptedTable } from "./storage/content-crypto";

/**
 * Encrypts email data written before encryption existed. Runs once all
 * modules (and so the migrations) are up; idempotent, and only touches rows
 * that are still plaintext.
 *
 * It works one user at a time, as that user: the mail tables have FORCE ROW
 * LEVEL SECURITY, so a query with no user set sees no rows at all -- even for
 * the table owner, which is what the app connects as in production.
 */
@Injectable()
export class EncryptionBackfillService implements OnApplicationBootstrap {
  private readonly log = new Logger("EncryptionBackfill");

  constructor(
    private readonly pg: PostgresService,
    private readonly users: UsersService,
  ) {}

  async onApplicationBootstrap() {
    // Fails startup if MISSIVE_DATA_KEY is missing, before any request is served.
    dataCipher();
    await this.connectors();
    // Mail content can be large: encrypt it in the background so startup (and
    // the container's health check) isn't held up. Reads handle both
    // encrypted and not-yet-encrypted rows meanwhile.
    void (async () => {
      for (const table of Object.keys(ENCRYPTED_COLUMNS) as EncryptedTable[]) await this.content(table);
    })().catch((err) => this.log.error(`content backfill stopped: ${safeError(err)}`));
  }

  /**
   * Mail content (missives, threads, digests): every listed column that isn't
   * already "mv1.…" is encrypted for the row's owner, in batches, as that
   * owner. JSON columns become the encrypted JSON text stored as a JSON string.
   */
  private async content(table: EncryptedTable) {
    const columns = ENCRYPTED_COLUMNS[table];
    const isJson = (c: string) => c === "recipients" || c === "items";
    // A column still needs work if it's a JSON object/array, or text without the prefix.
    const pending = columns
      .map((c) => (isJson(c)
        ? `(${c} IS NOT NULL AND jsonb_typeof(${c}) <> 'string')`
        : `(${c} IS NOT NULL AND ${c} NOT LIKE 'mv1.%')`))
      .join(" OR ");
    let done = 0;
    for (const user of await this.users.all()) {
      done += await runAsUser(user, async () => {
        let count = 0;
        for (;;) {
          const { rows } = await this.pg.query(`SELECT id, ${columns.join(", ")} FROM ${table} WHERE ${pending} LIMIT 200`);
          if (rows.length === 0) return count;
          for (const row of rows) {
            const values: (string | null)[] = [];
            for (const c of columns) {
              const v = row[c];
              if (v == null) { values.push(null); continue; }
              if (isJson(c)) {
                values.push(typeof v === "string" ? JSON.stringify(v) : JSON.stringify(await this.sealFor(user.id, table, c, JSON.stringify(v))));
              } else {
                values.push(String(v).startsWith("mv1.") ? v : await this.sealFor(user.id, table, c, v));
              }
            }
            const sets = columns.map((c, i) => `${c} = $${i + 2}${isJson(c) ? "::jsonb" : ""}`).join(", ");
            // Only while still pending: never overwrite a row a sync has since
            // rewritten (already encrypted) with values read before that.
            await this.pg.query(`UPDATE ${table} SET ${sets} WHERE id = $1 AND (${pending})`, [row.id, ...values]);
            count++;
          }
        }
      });
    }
    if (done) this.log.log(`${table}: encrypted ${done} row(s)`);
  }

  private sealFor(userId: string, table: string, column: string, value: string): Promise<string> {
    return dataCipher().encrypt(userScope(userId), `${table}.${column}`, value);
  }

  /** OAuth tokens and IMAP passwords: JSONB object -> encrypted JSON string. */
  private async connectors() {
    let done = 0;
    for (const user of await this.users.all()) {
      done += await runAsUser(user, async () => {
        const { rows } = await this.pg.query(
          `SELECT id, credentials FROM connectors WHERE jsonb_typeof(credentials) = 'object'`,
        );
        for (const row of rows) {
          const sealed = await dataCipher().encrypt(userScope(user.id), "connectors.credentials", JSON.stringify(row.credentials));
          await this.pg.query(
            `UPDATE connectors SET credentials = $2::jsonb WHERE id = $1 AND jsonb_typeof(credentials) = 'object'`,
            [row.id, JSON.stringify(sealed)],
          );
        }
        return rows.length;
      });
    }
    if (done) this.log.log(`connectors.credentials: encrypted ${done}`);
  }
}
