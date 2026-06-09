import { Module } from "@nestjs/common";
import { PostgresService } from "./postgres.service";
import { StorageService } from "./storage.service";

@Module({
  providers: [PostgresService, StorageService],
  exports: [PostgresService, StorageService],
})
export class StorageModule {}
