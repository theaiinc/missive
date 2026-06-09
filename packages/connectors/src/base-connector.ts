import type {
  Connector,
  SyncResult,
  SendPayload,
} from "@theaiinc/missive-core";

export abstract class BaseConnector implements Connector {
  abstract readonly provider: string;
  protected config: Record<string, unknown> = {};

  async connect(config: Record<string, unknown>): Promise<void> {
    this.config = config;
  }

  abstract disconnect(): Promise<void>;
  abstract sync(): Promise<SyncResult>;
  abstract send(message: SendPayload): Promise<string>;
}