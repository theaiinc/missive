import { BadRequestException, Body, Controller, Get, Injectable, Logger, Put, Query } from "@nestjs/common";
import { createHash } from "node:crypto";
import { google } from "googleapis";
import { PostgresService } from "./storage/postgres.service";
import { openRows, seal } from "./storage/content-crypto";
import { ConnectorStore } from "./connector.store";
import { sourceText } from "./translate";
import { safeError } from "./log-safe";

const addressHash = (address: string) => createHash("sha256").update(address.trim().toLowerCase()).digest("hex");
const MAX_SIGNATURE = 2_000;

export interface Signature {
  address: string;
  text: string;
  /** Where it came from: what you saved in Missive, your Gmail settings, or nothing yet. */
  source: "missive" | "gmail" | "none";
}

/**
 * Signatures, one per address you send from. What you save in Settings wins;
 * otherwise a connected Gmail account's own signature is used (read with the
 * Gmail access it already has), as plain text.
 */
@Injectable()
export class SignatureService {
  private readonly log = new Logger("Signatures");

  constructor(
    private readonly pg: PostgresService,
    private readonly store: ConnectorStore,
  ) {}

  async get(address: string): Promise<Signature> {
    const { rows } = await this.pg.query(`SELECT text FROM signatures WHERE address_hash = $1`, [addressHash(address)]);
    if (rows.length) return { address, text: (await openRows("signatures", rows))[0]!.text, source: "missive" };
    const gmail = await this.fromGmail(address);
    return gmail ? { address, text: gmail, source: "gmail" } : { address, text: "", source: "none" };
  }

  async save(address: string, text: string): Promise<Signature> {
    const clean = text.replace(/\r\n/g, "\n").trim().slice(0, MAX_SIGNATURE);
    await this.pg.query(
      `INSERT INTO signatures (address_hash, text) VALUES ($1, $2)
       ON CONFLICT (owner_id, address_hash) DO UPDATE SET text = EXCLUDED.text, updated_at = NOW()`,
      [addressHash(address), await seal("signatures", "text", clean)],
    );
    return { address, text: clean, source: "missive" };
  }

  /** The Gmail account's signature for this address, as text; null without one. */
  private async fromGmail(address: string): Promise<string | null> {
    const account = await this.store.getByEmail("gmail", address.toLowerCase());
    if (!account || account.status === "needs_reauth") return null;
    try {
      const oauth2 = this.store.createOAuth2Client();
      oauth2.setCredentials({ access_token: await this.store.getValidGmailToken(account.id) });
      const gmail = google.gmail({ version: "v1", auth: oauth2 as never });
      const res = await gmail.users.settings.sendAs.get({ userId: "me", sendAsEmail: account.email });
      const html = res.data.signature ?? "";
      return html.trim() ? sourceText({ body: "", bodyHtml: html }) || null : null;
    } catch (e) {
      this.log.warn(`Couldn't read a Gmail signature: ${safeError(e)}`);
      return null;
    }
  }
}

@Controller("api/v1/signatures")
export class SignatureController {
  constructor(private readonly signatures: SignatureService) {}

  @Get()
  get(@Query("address") address?: string) {
    if (!address?.includes("@")) throw new BadRequestException("Which address?");
    return this.signatures.get(address);
  }

  @Put()
  save(@Body() body: { address?: string; text?: string }) {
    if (!body?.address?.includes("@") || typeof body.text !== "string") throw new BadRequestException("Send an address and the signature text");
    return this.signatures.save(body.address, body.text);
  }
}
