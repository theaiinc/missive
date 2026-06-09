import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Missive, Thread, EntityReference } from "@theaiinc/missive-core";
import { StorageService } from "./storage/storage.service";

@Injectable()
export class MissiveService {
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
    // Will delegate to AI service
    return "[summary placeholder]";
  }

  async classify(missiveId: string): Promise<string> {
    // Will delegate to AI service
    const classification = "unclassified";

    // Auto-move to folder based on classification
    const folder = classificationToFolder(classification);
    if (folder) {
      await this.storage.moveMissive(missiveId, folder);
    }

    return classification;
  }

  async extractEntities(missiveId: string): Promise<EntityReference[]> {
    // Will delegate to AI service
    return [];
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