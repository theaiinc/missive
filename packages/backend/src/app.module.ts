import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { MissiveController } from "./missive.controller";
import { ConnectorController } from "./connector.controller";
import { FolderController } from "./folder.controller";
import { ChatController } from "./chat.controller";
import { RuleController } from "./rule.controller";
import { MissiveService } from "./missive.service";
import { SearchService } from "./search.service";
import { ChatService } from "./chat.service";
import { RuleService } from "./rule.service";
import { SyncService } from "./sync.service";
import { ImapSyncService } from "./imap-sync.service";
import { SyncScheduler } from "./sync-scheduler";
import { ConnectorStore } from "./connector.store";
import { OrganizerService } from "./organizer.service";
import { DigestController } from "./digest.controller";
import { StorageModule } from "./storage/storage.module";

@Module({
  imports: [EventEmitterModule.forRoot(), StorageModule],
  controllers: [MissiveController, ConnectorController, FolderController, ChatController, RuleController, DigestController],
  providers: [MissiveService, SearchService, ChatService, RuleService, SyncService, ImapSyncService, SyncScheduler, ConnectorStore, OrganizerService],
  exports: [MissiveService, SearchService, ChatService, RuleService, SyncService, ImapSyncService, ConnectorStore, OrganizerService],
})
export class AppModule {}