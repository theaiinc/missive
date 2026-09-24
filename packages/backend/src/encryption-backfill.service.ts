import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { userScope } from "@theaiinc/missive-core";
import { PostgresService } from "./storage/postgres.service";
import { UsersService } from "./users.service";
import { runAsUser } from "./request-context";
import { dataCipher } from "./data-cipher";
import { safeError } from "./log-safe";
import { addressIndex, normalizeAddress, sealIdentity } from "./identity-crypto";
import { ConnectorStore } from "./connector.store";
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
    // Identity first: sign-in matches users by blind index, so every user must
    // have one before the first request.
    await this.identities();
    await this.connectors();
    await this.connectorIds();
    await this.hostedMessageIds();
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
    const isJson = (c: string) => c === "recipients" || c === "items" || c === "conditions";
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

  /** users.email/name and mailboxes.address/display_name: encrypted, with blind indexes. */
  private async identities() {
    const users = await this.pg.systemQuery(`SELECT id, email, name FROM users WHERE email_bidx IS NULL`);
    for (const u of users.rows) {
      const email = normalizeAddress(u.email);
      await this.pg.systemQuery(
        `UPDATE users SET email = $2, email_bidx = $3, name = $4 WHERE id = $1 AND email_bidx IS NULL`,
        [u.id, await sealIdentity("users.email", email), await addressIndex("users.email", email),
         u.name == null || String(u.name).startsWith("mv1.") ? u.name : await sealIdentity("users.name", u.name)],
      );
    }
    const boxes = await this.pg.systemQuery(`SELECT address, display_name FROM mailboxes WHERE address_bidx IS NULL`);
    for (const m of boxes.rows) {
      const address = normalizeAddress(m.address);
      await this.pg.systemQuery(
        `UPDATE mailboxes SET address = $2, address_bidx = $3, display_name = $4 WHERE address = $1 AND address_bidx IS NULL`,
        [m.address, await sealIdentity("mailboxes.address", address), await addressIndex("mailboxes.address", address),
         m.display_name == null ? null : await sealIdentity("mailboxes.display_name", m.display_name)],
      );
    }
    if (users.rows.length || boxes.rows.length) this.log.log(`identities: encrypted ${users.rows.length} user(s), ${boxes.rows.length} mailbox(es)`);
  }

  /**
   * Connector ids used to be "<provider>:<email>". They become
   * "<provider>:<blind index>", with email and label encrypted. The primary
   * key can't be updated in place while sync_logs may reference it, so the
   * row is copied under the new id, references moved, then the old row removed.
   */
  private async connectorIds() {
    let moved = 0;
    for (const user of await this.users.all()) {
      moved += await runAsUser(user, async () => {
        const { rows } = await this.pg.query(`SELECT id, provider, email, label FROM connectors WHERE email NOT LIKE 'mv1.%'`);
        for (const r of rows) {
          const newId = await ConnectorStore.idFor(r.provider, r.email);
          const email = await dataCipher().encrypt(userScope(user.id), "connectors.email", r.email);
          const label = await dataCipher().encrypt(userScope(user.id), "connectors.label", r.label ?? r.email);
          await this.pg.query(
            `INSERT INTO connectors (id, provider, label, email, enabled, credentials, settings, last_sync_at, status, created_at, updated_at, owner_id)
             SELECT $2, provider, $3, $4, enabled, credentials, settings, last_sync_at, status, created_at, NOW(), owner_id
               FROM connectors WHERE id = $1
             ON CONFLICT (id) DO NOTHING`,
            [r.id, newId, label, email],
          );
          await this.pg.query(`UPDATE sync_logs SET connector_id = $2 WHERE connector_id = $1`, [r.id, newId]);
          if (newId !== r.id) await this.pg.query(`DELETE FROM connectors WHERE id = $1`, [r.id]);
        }
        return rows.length;
      });
    }
    if (moved) this.log.log(`connectors: re-keyed ${moved} connector id(s)`);
  }

  /** Hosted mail's provider_message_id was "<mailbox address>:<Message-ID>"; the prefix becomes the mailbox's blind index. */
  private async hostedMessageIds() {
    let done = 0;
    for (const user of await this.users.all()) {
      done += await runAsUser(user, async () => {
        const { rows } = await this.pg.query(
          `SELECT id, provider_message_id FROM missives WHERE provider = 'missive' AND split_part(provider_message_id, ':', 1) LIKE '%@%'`,
        );
        for (const r of rows) {
          const cut = r.provider_message_id.indexOf(":");
          const next = `${await addressIndex("mailboxes.address", r.provider_message_id.slice(0, cut))}${r.provider_message_id.slice(cut)}`;
          await this.pg.query(`UPDATE missives SET provider_message_id = $2 WHERE id = $1`, [r.id, next]);
        }
        return rows.length;
      });
    }
    if (done) this.log.log(`missives: re-keyed ${done} hosted message id(s)`);
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
