import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Missive, Thread, EntityReference } from "@theaiinc/missive-core";
import { StorageService } from "./storage/storage.service";

export interface MoveResult {
  moved: number;
  autoMoved: number;
  autoMovedIds: string[];
}

@Injectable()
export class MissiveService {
  private readonly logger = new Logger(MissiveService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2
  ) {}

  async getMissive(id: string): Promise<Missive | null> {
    return this.storage.getMissive(id);
  }

  async getThread(id: string): Promise<Thread | null> {
    return this.storage.getThread(id);
  }

  async getThreadMissives(threadId: string): Promise<Missive[]> {
    return this.storage.getThreadMissives(threadId);
  }

  async getRecentMissives(since: string, limit?: number) {
    return this.storage.getRecentMissives(since, limit);
  }

  async summarize(threadId: string): Promise<string> {
    return "[summary placeholder]";
  }

  async classify(missiveId: string): Promise<string> {
    const classification = "unclassified";
    const folder = classificationToFolder(classification);
    if (folder) {
      await this.storage.moveMissive(missiveId, folder);
    }
    return classification;
  }

  async extractEntities(missiveId: string): Promise<EntityReference[]> {
    return [];
  }

  async moveMissive(id: string, folder: string): Promise<MoveResult> {
    const missive = await this.storage.getMissive(id);
    if (!missive) return { moved: 0, autoMoved: 0, autoMovedIds: [] };

    const sourceFolder = missive.folder ?? "inbox";
    await this.storage.moveMissive(id, folder);

    // Learn from this manual move — find similar missives still in the source folder
    const autoMovedIds = await this.autoMoveSimilar(missive, sourceFolder, folder);

    if (autoMovedIds.length > 0) {
      this.logger.log(
        `Manual move of ${id} → ${folder} triggered auto-move of ${autoMovedIds.length} similar message(s)`
      );
    }

    return {
      moved: 1,
      autoMoved: autoMovedIds.length,
      autoMovedIds,
    };
  }

  async moveThread(threadId: string, folder: string): Promise<MoveResult> {
    const missives = await this.storage.getThreadMissives(threadId);
    if (missives.length === 0) return { moved: 0, autoMoved: 0, autoMovedIds: [] };

    const sourceFolder = missives[0]!.folder ?? "inbox";
    await this.storage.moveThread(threadId, folder);

    // Learn from the first message in the thread
    const autoMovedIds = await this.autoMoveSimilar(missives[0]!, sourceFolder, folder);

    if (autoMovedIds.length > 0) {
      this.logger.log(
        `Manual thread move ${threadId} → ${folder} triggered auto-move of ${autoMovedIds.length} similar message(s)`
      );
    }

    return {
      moved: missives.length,
      autoMoved: autoMovedIds.length,
      autoMovedIds,
    };
  }

  /**
   * Find missives with the same sender domain in the source folder and move them.
   * Returns the IDs of auto-moved missives.
   */
  /**
   * Marks a message as spam (or not spam), with the other messages from the
   * same sender address in its folder. By address, not domain: a domain
   * like gmail.com is shared by people you want to hear from.
   */
  async markSpam(id: string, spam: boolean): Promise<MoveResult> {
    const missive = await this.storage.getMissive(id);
    if (!missive) return { moved: 0, autoMoved: 0, autoMovedIds: [] };
    const sourceFolder = missive.folder ?? "inbox";
    const address = missive.from.address;
    const others = address && sourceFolder !== (spam ? "spam" : "inbox")
      ? (await this.storage.findMissivesBySender(address, sourceFolder, id)).map((r) => r.id)
      : [];
    await this.storage.setSpam([id, ...others], spam);
    return { moved: 1, autoMoved: others.length, autoMovedIds: others };
  }

  private async autoMoveSimilar(
    reference: Missive,
    sourceFolder: string,
    targetFolder: string
  ): Promise<string[]> {
    if (sourceFolder === targetFolder) return [];

    const senderDomain = reference.from.address?.split("@")[1];
    if (!senderDomain) return [];

    const rows = await this.storage.findMissivesBySenderDomain(
      senderDomain,
      sourceFolder,
      reference.id
    );

    if (rows.length === 0) return [];

    const ids = rows.map((r: any) => r.id);
    await this.storage.batchMoveMissives(ids, targetFolder);

    return ids;
  }
}

/** Map a classification string to a folder slug */
function classificationToFolder(classification: string): string | null {
  const map: Record<string, string> = {
    invoice: "invoices",
    complaint: "complaints",
    lead: "leads",
    support: "support",
    personal: "personal",
  };
  return map[classification.toLowerCase()] ?? null;
}