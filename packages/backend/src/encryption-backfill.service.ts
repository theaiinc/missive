import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { userScope } from "@theaiinc/missive-core";
import { PostgresService } from "./storage/postgres.service";
import { UsersService } from "./users.service";
import { runAsUser } from "./request-context";
import { dataCipher } from "./data-cipher";

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
