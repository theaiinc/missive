import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { userScope } from "@theaiinc/missive-core";
import { PostgresService } from "./storage/postgres.service";
import { dataCipher } from "./data-cipher";

/**
 * Encrypts email data written before encryption existed. Runs once all
 * modules (and so the migrations) are up; idempotent, and only touches rows
 * that are still plaintext. Rows with no owner can't be given a user key and
 * are counted in the log instead.
 */
@Injectable()
export class EncryptionBackfillService implements OnApplicationBootstrap {
  private readonly log = new Logger("EncryptionBackfill");

  constructor(private readonly pg: PostgresService) {}

  async onApplicationBootstrap() {
    // Fails startup if MISSIVE_DATA_KEY is missing, before any request is served.
    dataCipher();
    await this.connectors();
  }

  /** OAuth tokens and IMAP passwords: JSONB object -> encrypted JSON string. */
  private async connectors() {
    const { rows } = await this.pg.systemQuery(
      `SELECT id, owner_id, credentials FROM connectors WHERE jsonb_typeof(credentials) = 'object'`,
    );
    let done = 0;
    let orphaned = 0;
    for (const row of rows) {
      if (!row.owner_id) { orphaned++; continue; }
      const sealed = await dataCipher().encrypt(userScope(row.owner_id), "connectors.credentials", JSON.stringify(row.credentials));
      await this.pg.systemQuery(
        `UPDATE connectors SET credentials = $2::jsonb WHERE id = $1 AND jsonb_typeof(credentials) = 'object'`,
        [row.id, JSON.stringify(sealed)],
      );
      done++;
    }
    if (done || orphaned) this.log.log(`connectors.credentials: encrypted ${done}, without an owner ${orphaned}`);
  }
}
