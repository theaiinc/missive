import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { SyncService } from "./sync.service";
import { ImapSyncService } from "./imap-sync.service";
import { OrganizerService } from "./organizer.service";
import { RuleService } from "./rule.service";
import { SystemEventService } from "./system-event.service";

/**
 * Periodically syncs all connected accounts on a 5-minute interval,
 * then organizes new missives and generates digests.
 */
@Injectable()
export class SyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(SyncScheduler.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** How often to run the full sync (ms). Default 5 minutes. */
  private readonly intervalMs: number;

  constructor(
    private readonly sync: SyncService,
    private readonly imapSync: ImapSyncService,
    private readonly organizer: OrganizerService,
    private readonly rules: RuleService,
    private readonly events: SystemEventService
  ) {
    this.intervalMs = parseInt(process.env.AUTO_SYNC_INTERVAL_MS ?? "300000", 10);
  }

  onModuleInit() {
    // Run initial organizer pass shortly after startup (5s)
    setTimeout(() => this.runOrganizer(), 5_000);

    // First sync shortly after startup
    setTimeout(() => this.tick(), 15_000);

    this.logger.log(
      `Auto-sync scheduled every ${this.intervalMs / 1000}s`
    );
    this.intervalHandle = setInterval(() => this.tick(), this.intervalMs);
  }

  private async tick() {
    let syncMessage = "";

    try {
      const gmailResults = await this.sync.syncGmail();
      const gmailTotal = Object.values(gmailResults).reduce(
        (acc: number, r: any) => acc + (r.synced ?? 0),
        0
      );
      if (gmailTotal > 0) {
        this.logger.log(`Auto-sync Gmail: ${gmailTotal} new message(s)`);
        syncMessage += `Synced **${gmailTotal}** new Gmail message(s). `;
      }
    } catch (err) {
      this.logger.error("Auto-sync Gmail error:", err);
    }

    try {
      const outlookResults = await this.sync.syncOutlook();
      const outlookTotal = Object.values(outlookResults).reduce(
        (acc: number, r: any) => acc + (r.synced ?? 0),
        0
      );
      if (outlookTotal > 0) {
        this.logger.log(`Auto-sync Outlook: ${outlookTotal} new message(s)`);
        syncMessage += `Synced **${outlookTotal}** new Outlook message(s). `;
      }
    } catch (err) {
      this.logger.error("Auto-sync Outlook error:", err);
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
      this.logger.error("Auto-sync IMAP error:", err);
    }

    if (syncMessage) {
      this.events.emit("sync", syncMessage.trim());
    }

    // After all syncs, organize new missives and generate digest
    await this.runOrganizer();

    // Periodically evaluate rules against pending missives
    // (catches missives that were classified after their initial sync)
    await this.runRuleEvaluation();
  }

  private async runOrganizer() {
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
      this.logger.error("Organizer error:", err);
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
      this.logger.error("Auto-rule evaluation error:", err);
    }
  }

  /** Allow graceful cleanup */
  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}
