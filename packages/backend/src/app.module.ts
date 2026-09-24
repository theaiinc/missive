import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
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
import { SystemEventService } from "./system-event.service";
import { SystemEventController } from "./system-event.controller";
import { StorageModule } from "./storage/storage.module";
import { AuthController } from "./auth/auth.controller";
import { AuthMiddleware } from "./auth/auth.middleware";
import { UsersService } from "./users.service";
import { MailboxService } from "./mailbox.service";
import { EncryptionBackfillService } from "./encryption-backfill.service";
import { MailboxController } from "./mailbox.controller";
import { InviteController } from "./invite.controller";
import { AdminAccess, AdminController } from "./admin.controller";
import { GroupsService } from "./groups.service";

@Module({
  imports: [EventEmitterModule.forRoot(), StorageModule],
  controllers: [AuthController, MailboxController, InviteController, AdminController, MissiveController, ConnectorController, FolderController, ChatController, RuleController, DigestController, SystemEventController],
  providers: [UsersService, GroupsService, AdminAccess, MailboxService, MissiveService, SearchService, ChatService, RuleService, SyncService, ImapSyncService, SyncScheduler, ConnectorStore, OrganizerService, SystemEventService, EncryptionBackfillService],
  exports: [MissiveService, SearchService, ChatService, RuleService, SyncService, ImapSyncService, ConnectorStore, OrganizerService, SystemEventService],
})
export class AppModule implements NestModule {
  /** Every route needs an Aegis session except sign-in, health and inbound mail (see AuthMiddleware). */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes("*");
  }
}