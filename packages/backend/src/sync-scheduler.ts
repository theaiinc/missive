import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { SyncService } from "./sync.service";
import { ImapSyncService } from "./imap-sync.service";
import { OrganizerService } from "./organizer.service";

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
    private readonly organizer: OrganizerService
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
    try {
      const gmailResults = await this.sync.syncGmail();
      const gmailTotal = Object.values(gmailResults).reduce(
        (acc: number, r: any) => acc + (r.synced ?? 0),
        0
      );
      if (gmailTotal > 0) {
        this.logger.log(`Auto-sync Gmail: ${gmailTotal} new message(s)`);
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
      }
    } catch (err) {
      this.logger.error("Auto-sync IMAP error:", err);
    }

    // After all syncs, organize new missives and generate digest
    await this.runOrganizer();
  }

  private async runOrganizer() {
    try {
      const classified = await this.organizer.processNewMissives(20);
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

  /** Allow graceful cleanup */
  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}
