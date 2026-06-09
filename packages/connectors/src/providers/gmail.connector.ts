import { BaseConnector } from "../base-connector";
import type { SyncResult, SendPayload } from "@theaiinc/missive-core";

interface GmailConfig extends Record<string, unknown> {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
}

export class GmailConnector extends BaseConnector {
  readonly provider = "gmail";

  private get gmailConfig(): GmailConfig {
    return this.config as GmailConfig;
  }

  override async connect(config: Record<string, unknown>): Promise<void> {
    this.config = config;
  }

  override async disconnect(): Promise<void> {
    // Revoke tokens, clean up
  }

  override async sync(): Promise<SyncResult> {
    // 1. Use Gmail API to list messages
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
    // 1. Build RFC 2822 message
    // 2. Send via Gmail API
    // 3. Return provider message ID
    return "provider-message-id";
  }

  async getAuthUrl(): Promise<string> {
    return "https://accounts.google.com/o/oauth2/v2/auth?...";
  }

  async handleCallback(code: string): Promise<void> {
    // Exchange code for tokens
  }
}