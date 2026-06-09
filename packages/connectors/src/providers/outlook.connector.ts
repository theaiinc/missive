import { BaseConnector } from "../base-connector";
import type { SyncResult, SendPayload } from "@theaiinc/missive-core";

interface OutlookConfig extends Record<string, unknown> {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

export class OutlookConnector extends BaseConnector {
  readonly provider = "outlook";

  private get outlookConfig(): OutlookConfig {
    return this.config as OutlookConfig;
  }

  override async connect(config: Record<string, unknown>): Promise<void> {
    this.config = config;
  }

  override async disconnect(): Promise<void> {
    // Revoke tokens, clean up
  }

  override async sync(): Promise<SyncResult> {
    // 1. Use Microsoft Graph API to list messages
    // 2. Fetch full message details
    // 3. Convert to Missive format
    // 4. Emit events
    return {
      newMessages: 0,
      updatedMessages: 0,
      errors: [],
      syncedAt: new Date().toISOString(),
    };
  }

  override async send(payload: SendPayload): Promise<string> {
    // 1. Build message
    // 2. Send via Microsoft Graph API
    // 3. Return provider message ID
    return "provider-message-id";
  }
}