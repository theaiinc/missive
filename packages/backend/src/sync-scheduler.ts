import { safeError } from "./log-safe";
import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { SyncService } from "./sync.service";
import { ImapSyncService } from "./imap-sync.service";
import { OrganizerService } from "./organizer.service";
import { RuleService } from "./rule.service";
import { SystemEventService } from "./system-event.service";
import { UsersService } from "./users.service";
import { runAsUser } from "./request-context";
import { CalendarService } from "./calendar/calendar.service";
import { StorageService } from "./storage/storage.service";

/**
 * Checks every connected account for new mail each minute, and every 5
 * minutes runs the slower work: files, calendars, the organizer and rules.
 *
 * Mail and the slow work used to share one 5-minute tick, run user after
 * user, so new mail could wait 5 minutes plus however long everyone's
 * organizer took. A mail check now costs a provider call and, unless
 * something changed, nothing from the database (SyncService.mailboxSeen).
 */
@Injectable()
export class SyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(SyncScheduler.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private mailHandle: ReturnType<typeof setInterval> | null = null;

  /** How often to run the slow work (ms). Default 5 minutes. */
  private readonly intervalMs: number;
  /** How often to check for new mail (ms). Default 1 minute. */
  private readonly mailIntervalMs: number;
  /** A pass still running when the next is due is not started again. */
  private mailRunning = false;
  private slowRunning = false;

  constructor(
    private readonly sync: SyncService,
    private readonly imapSync: ImapSyncService,
    private readonly organizer: OrganizerService,
    private readonly rules: RuleService,
    private readonly events: SystemEventService,
    private readonly users: UsersService,
    private readonly calendar: CalendarService,
    private readonly storage: StorageService
  ) {
    this.intervalMs = parseInt(process.env.AUTO_SYNC_INTERVAL_MS ?? "300000", 10);
    this.mailIntervalMs = parseInt(process.env.MAIL_SYNC_INTERVAL_MS ?? "60000", 10);
  }

  onModuleInit() {
    this.users.ensureAllFolders().catch((err) => this.logger.error("Folder setup error:", safeError(err)));

    // Search indexes first, so the first search after a deploy is quick.
    setTimeout(() => this.forEachUser(() => this.warmSearch()), 3_000);

    // First mail check shortly after startup, then every minute.
    setTimeout(() => void this.mailPass(), 10_000);
    this.mailHandle = setInterval(() => void this.mailPass(), this.mailIntervalMs);

    // The slow work shortly after that, then every 5 minutes.
    setTimeout(() => void this.slowPass(), 30_000);
    this.intervalHandle = setInterval(() => void this.slowPass(), this.intervalMs);

    this.logger.log(
      `Mail checked every ${this.mailIntervalMs / 1000}s; organizer, calendars and rules every ${this.intervalMs / 1000}s`
    );
  }

  private async mailPass() {
    if (this.mailRunning) return;
    this.mailRunning = true;
    try {
      await this.forEachUser(() => this.syncMail());
    } finally {
      this.mailRunning = false;
    }
  }

  private async slowPass() {
    if (this.slowRunning) return;
    this.slowRunning = true;
    try {
      await this.forEachUser(() => this.tick());
    } finally {
      this.slowRunning = false;
    }
  }

  private async warmSearch() {
    try {
      await this.storage.warmSearchIndex();
    } catch (err) {
      this.logger.error("Search index warm-up error:", safeError(err));
    }
  }

  /** Each user's accounts and mail are only visible as that user, so jobs run once per user. */
  private async forEachUser(job: () => Promise<void>) {
    try {
      for (const user of await this.users.all()) {
        await runAsUser(user, job);
      }
    } catch (err) {
      this.logger.error("Scheduled job error:", safeError(err));
    }
  }

  /** New mail from every connected account (Gmail, Outlook, IMAP). */
  private async syncMail() {
    let syncMessage = "";

    try {
      const gmailResults = await this.sync.syncGmail();
      const gmailTotal = Object.values(gmailResults).reduce(
        (acc: number, r: any) => acc + (r.synced ?? 0),
        0
      );
      this.reportReauth("Gmail", gmailResults);
      if (gmailTotal > 0) {
        this.logger.log(`Auto-sync Gmail: ${gmailTotal} new message(s)`);
        syncMessage += `Synced **${gmailTotal}** new Gmail message(s). `;
      }
    } catch (err) {
      this.logger.error("Auto-sync Gmail error:", safeError(err));
    }

    try {
      const outlookResults = await this.sync.syncOutlook();
      const outlookTotal = Object.values(outlookResults).reduce(
        (acc: number, r: any) => acc + (r.synced ?? 0),
        0
      );
      this.reportReauth("Outlook", outlookResults);
      if (outlookTotal > 0) {
        this.logger.log(`Auto-sync Outlook: ${outlookTotal} new message(s)`);
        syncMessage += `Synced **${outlookTotal}** new Outlook message(s). `;
      }
    } catch (err) {
      this.logger.error("Auto-sync Outlook error:", safeError(err));
    }

    try {
      const imapResults = await this.imapSync.syncImap();
      const imapTotal = Object.values(imapResults).reduce(
        (acc: number, r: any) => acc + (r.synced ?? 0),
        0
      );
      if (imapTotal > 0) {
        this.logger.log(`Auto-sync IMAP: ${imapTotal} new message(s)`);
        syncMessage += `Synced **${imapTotal}** new IMAP message(s). `;
      }
    } catch (err) {
      this.logger.error("Auto-sync IMAP error:", safeError(err));
    }

    if (syncMessage) {
      this.events.emit("sync", syncMessage.trim());
    }
  }

  /** The slow work: files, calendars, then organizing and rules for what came in. */
  private async tick() {
    // Files on mail synced before attachments were kept, once per account.
    try {
      await this.sync.backfillAttachments();
    } catch (err) {
      this.logger.error("Attachments backfill error:", safeError(err));
    }

    // Calendars: .ics subscriptions and connected accounts, each only when due.
    try {
      await this.calendar.refreshDue();
    } catch (err) {
      this.logger.error("Calendar refresh error:", safeError(err));
    }

    // After all syncs, organize new missives and generate digest
    await this.runOrganizer();

    // Periodically evaluate rules against pending missives
    // (catches missives that were classified after their initial sync)
    await this.runRuleEvaluation();
  }

  /**
   * Accounts the provider has locked us out of are not retried; say so where
   * the person will see it (once, when it happens). Settings keeps showing the
   * Reconnect alert from the stored status.
   */
  private reportReauth(provider: string, results: Record<string, any>) {
    const flagged = Object.values(results).filter((r: any) => r?.needsReauth);
    if (flagged.length === 0) return;
    const fresh = flagged.filter((r: any) => r.newlyFlagged).length;
    this.logger.warn(`Auto-sync ${provider}: ${flagged.length} account(s) need reconnecting, skipped`);
    if (fresh > 0) {
      this.events.emit("sync", `**${fresh}** ${provider} account(s) need to be reconnected in Settings — syncing is paused for them.`);
    }
  }

  private async runOrganizer() {
    // MISSIVE_ORGANIZER=off switches it off (e.g. with no model to reach).
    if (process.env.MISSIVE_ORGANIZER === "off") return;
    try {
      const classified = await this.organizer.processNewMissives(50);
      if (classified > 0) {
        await this.organizer.generateDigest();
      } else {
        // Still try to generate a digest — there might be newly synced missives
        // that were already processed but not yet digested
        await this.organizer.generateDigest();
      }
    } catch (err) {
      this.logger.error("Organizer error:", safeError(err));
    }
  }

  /**
   * Evaluate all enabled rules against missives that haven't been
   * evaluated yet or were updated since their last evaluation.
   * This ensures rules based on classification fields are applied
   * after the OrganizerService has classified new missives.
   */
  private async runRuleEvaluation() {
    try {
      const result = await this.rules.evaluatePending(50);
      if (result.evaluated > 0) {
        this.logger.log(
          `Auto-evaluated rules: ${result.evaluated} missive(s) checked, ${result.applied} matched`
        );
        if (result.applied > 0) {
          this.events.emit("rules", `Applied rules to **${result.applied}** message(s) (checked ${result.evaluated}).`);
        }
      }
    } catch (err) {
      this.logger.error("Auto-rule evaluation error:", safeError(err));
    }
  }

  /** Allow graceful cleanup */
  stop() {
    for (const handle of [this.intervalHandle, this.mailHandle]) if (handle) clearInterval(handle);
    this.intervalHandle = null;
    this.mailHandle = null;
  }
}
