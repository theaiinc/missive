import { BadRequestException, Body, Controller, Get, Injectable, Logger, Post } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { createHash } from "node:crypto";
import webpush, { type PushSubscription } from "web-push";
import type { Missive } from "@theaiinc/missive-core";
import { PostgresService } from "./storage/postgres.service";
import { openRows, seal } from "./storage/content-crypto";
import { currentUser, runAsUser } from "./request-context";
import { safeError } from "./log-safe";

/** Older mail (a first sync, a backlog) is filed quietly. */
const FRESH_MS = 15 * 60_000;

const endpointHash = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex");

/**
 * Push notifications for new mail (Web Push), so they arrive with Missive
 * closed, on a phone too once Missive is added to the home screen. web-push
 * encrypts each payload for the subscribing browser, so the push service
 * (Google, Apple, Mozilla) only relays ciphertext.
 * Needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY; without them it stays off.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger("Push");
  readonly publicKey = process.env.VAPID_PUBLIC_KEY ?? "";
  private readonly enabled: boolean;

  constructor(private readonly pg: PostgresService) {
    this.enabled = !!(this.publicKey && process.env.VAPID_PRIVATE_KEY);
    if (this.enabled) {
      // The subject is how push services reach the sender: the app, not a person's address.
      webpush.setVapidDetails(process.env.APP_URL || "https://missive.theaiinc.com", this.publicKey, process.env.VAPID_PRIVATE_KEY!);
    }
  }

  async subscribe(sub: PushSubscription): Promise<void> {
    await this.pg.query(
      `INSERT INTO push_subscriptions (endpoint_hash, subscription) VALUES ($1, $2)
       ON CONFLICT (owner_id, endpoint_hash) DO UPDATE SET subscription = EXCLUDED.subscription`,
      [endpointHash(sub.endpoint), await seal("push_subscriptions", "subscription", JSON.stringify(sub))],
    );
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.pg.query(`DELETE FROM push_subscriptions WHERE endpoint_hash = $1`, [endpointHash(endpoint)]);
  }

  /** Every new message (hosted mailboxes, Gmail, Outlook, IMAP) is announced here, as its owner. */
  @OnEvent("missive.received")
  onReceived(event: { payload: Missive }) {
    const user = currentUser();
    if (!this.enabled || !user) return;
    void runAsUser(user, () => this.announce(event.payload)).catch((e) => this.log.warn(`Push failed: ${safeError(e)}`));
  }

  private async announce(m: Missive): Promise<void> {
    if (m.direction !== "inbound" || Date.now() - Date.parse(m.receivedAt) > FRESH_MS) return;
    // Where it is now: a rule (or a rule learned from your filing) may have moved it already.
    const { rows: now } = await this.pg.query(`SELECT folder, status FROM missives WHERE id = $1`, [m.id]);
    if (now[0]?.folder !== "inbox" || now[0]?.status !== "unread") return;
    const { rows } = await this.pg.query(`SELECT id, subscription FROM push_subscriptions`);
    if (!rows.length) return;
    const payload = JSON.stringify({
      title: m.from.name || m.from.address,
      body: m.subject || "(no subject)",
      url: `/thread/${m.threadId}`,
      tag: m.threadId,
    });
    for (const row of await openRows("push_subscriptions", rows)) {
      try {
        await webpush.sendNotification(JSON.parse(row.subscription), payload, { TTL: 3600 });
      } catch (e) {
        // Gone: the browser unsubscribed or the permission was taken back.
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await this.pg.query(`DELETE FROM push_subscriptions WHERE id = $1`, [row.id]);
        else this.log.warn(`Push to one browser failed (${status ?? "?"})`);
      }
    }
  }
}

@Controller("api/v1/push")
export class PushController {
  constructor(private readonly push: PushService) {}

  /** The server's public key (VAPID) a browser subscribes with; empty when push isn't configured. */
  @Get("key")
  key() {
    return { publicKey: this.push.publicKey };
  }

  @Post("subscribe")
  async subscribe(@Body() body: { subscription?: PushSubscription }) {
    const s = body.subscription;
    if (!s?.endpoint?.startsWith("https://") || !s.keys?.p256dh || !s.keys?.auth) throw new BadRequestException("Not a push subscription");
    await this.push.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
    return { subscribed: true };
  }

  @Post("unsubscribe")
  async unsubscribe(@Body() body: { endpoint?: string }) {
    if (body.endpoint) await this.push.unsubscribe(body.endpoint);
    return { subscribed: false };
  }
}
