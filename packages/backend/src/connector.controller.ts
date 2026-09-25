import { safeError } from "./log-safe";
import { Controller, Get, Post, Delete, Body, Query, Req, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { siteFor } from "./auth/sites";
import { google } from "googleapis";
import { ConnectorStore } from "./connector.store";
import { SyncService } from "./sync.service";
import { ImapSyncService, type ImapConfig } from "./imap-sync.service";

@Controller("api/v1/connector")
export class ConnectorController {
  constructor(
    private readonly store: ConnectorStore,
    private readonly sync: SyncService,
    private readonly imapSync: ImapSyncService
  ) {}

  // ── Gmail Auth ──

  @Get("gmail/auth")
  getGmailAuthUrl(@Req() req: Request): { url: string } {
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
      throw new ServiceUnavailableException("Connecting Gmail isn't set up on this server yet.");
    }
    return { url: this.store.getGmailAuthUrl(siteFor(req).appUrl) };
  }

  // ── Gmail Token Exchange ──

  @Post("gmail/token")
  async exchangeGmailToken(@Req() req: Request, @Body() body: { code: string }) {
    if (!body.code) {
      return { error: "missing_code" };
    }

    try {
      const oauth2 = this.store.createOAuth2Client(siteFor(req).appUrl);
      const { tokens } = await oauth2.getToken(body.code);
      oauth2.setCredentials(tokens);

      const oauth2api = google.oauth2({ version: "v2", auth: oauth2 as any });
      const { data: profile } = await oauth2api.userinfo.get();

      const connector = await this.store.save("gmail", {
        provider: "gmail",
        label: profile.email ?? "Gmail",
        email: profile.email ?? "unknown",
        tokens: {
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token ?? undefined,
          expiry_date: tokens.expiry_date ?? undefined,
        },
        connectedAt: new Date().toISOString(),
      });

      return { connected: true, id: connector.id, email: profile.email };
    } catch (err) {
      console.error("Gmail token exchange error:", safeError(err));
      return { error: "token_exchange_failed" };
    }
  }

  // ── Gmail Status (all accounts) ──

  @Get("gmail/status")
  async getGmailStatus(): Promise<{
    connected: boolean;
    accounts: { id: string; email: string; label: string; connectedAt: string; lastSyncAt?: string | null }[];
  }> {
    const accounts = await this.store.list("gmail");
    return {
      connected: accounts.length > 0,
      accounts: accounts.map((a) => ({
        id: a.id,
        email: a.email,
        label: a.label,
        connectedAt: a.connectedAt,
        lastSyncAt: a.lastSyncAt,
      })),
    };
  }

  // ── Google Calendar (a separate connection; see GCAL_SCOPES) ──

  @Get("gcal/auth")
  getGcalAuthUrl(@Req() req: Request): { url: string } {
    if (!process.env.GCAL_CLIENT_ID || !process.env.GCAL_CLIENT_SECRET) {
      throw new ServiceUnavailableException("Connecting Google Calendar isn't set up on this server yet.");
    }
    return { url: this.store.getGcalAuthUrl(siteFor(req).appUrl) };
  }

  @Post("gcal/token")
  async exchangeGcalToken(@Req() req: Request, @Body() body: { code: string }) {
    if (!body.code) return { error: "missing_code" };
    try {
      const oauth2 = this.store.createCalendarOAuthClient(siteFor(req).appUrl);
      const { tokens } = await oauth2.getToken(body.code);
      if (!String(tokens.scope ?? "").includes("calendar.readonly")) return { error: "calendar_access_not_granted" };
      oauth2.setCredentials(tokens);
      const { data: profile } = await google.oauth2({ version: "v2", auth: oauth2 as any }).userinfo.get();
      const connector = await this.store.save("gcal", {
        provider: "gcal",
        label: profile.email ?? "Google Calendar",
        email: profile.email ?? "unknown",
        tokens: { access_token: tokens.access_token!, refresh_token: tokens.refresh_token ?? undefined, expiry_date: tokens.expiry_date ?? undefined },
        connectedAt: new Date().toISOString(),
      });
      return { connected: true, id: connector.id, email: profile.email };
    } catch (err) {
      console.error("Google Calendar token exchange error:", safeError(err));
      return { error: "token_exchange_failed" };
    }
  }

  @Get("gcal/status")
  async getGcalStatus() {
    const accounts = await this.store.list("gcal");
    return { connected: accounts.length > 0, accounts: accounts.map((a) => ({ id: a.id, email: a.email, connectedAt: a.connectedAt })) };
  }

  @Delete("gcal/disconnect")
  async disconnectGcal(@Body() body: { id: string }) {
    if (!body.id) return { error: "missing_id" };
    await this.store.remove(body.id);
    return { disconnected: true };
  }

  // ── Gmail Disconnect ──

  @Delete("gmail/disconnect")
  async disconnectGmail(@Body() body: { id: string }) {
    if (!body.id) {
      return { error: "missing_id" };
    }
    await this.store.remove(body.id);
    return { disconnected: true };
  }

  // ── Gmail Sync ──

  @Get("gmail/sync")
  async syncGmail(@Query("email") email?: string) {
    return this.sync.syncGmail(email);
  }

  // ── Outlook / Microsoft ──

  @Get("outlook/auth")
  getOutlookAuthUrl(@Req() req: Request): { url: string } {
    if (!process.env.OUTLOOK_CLIENT_ID || !process.env.OUTLOOK_CLIENT_SECRET) {
      throw new ServiceUnavailableException("Connecting Outlook isn't set up on this server yet.");
    }
    return { url: this.store.getOutlookAuthUrl(siteFor(req).appUrl) };
  }

  @Post("outlook/token")
  async exchangeOutlookToken(@Req() req: Request, @Body() body: { code: string }) {
    if (!body.code) {
      return { error: "missing_code" };
    }

    try {
      const { tokens, email } = await this.store.exchangeOutlookCode(body.code, siteFor(req).appUrl);
      const connector = await this.store.save("outlook", {
        provider: "outlook",
        label: email,
        email,
        tokens,
        connectedAt: new Date().toISOString(),
      });

      return { connected: true, id: connector.id, email };
    } catch (err) {
      console.error("Outlook token exchange error:", safeError(err));
      return { error: "token_exchange_failed" };
    }
  }

  @Get("outlook/status")
  async getOutlookStatus(): Promise<{
    connected: boolean;
    accounts: { id: string; email: string; label: string; connectedAt: string; lastSyncAt?: string | null }[];
  }> {
    const accounts = await this.store.list("outlook");
    return {
      connected: accounts.length > 0,
      accounts: accounts.map((a) => ({
        id: a.id,
        email: a.email,
        label: a.label,
        connectedAt: a.connectedAt,
        lastSyncAt: a.lastSyncAt,
      })),
    };
  }

  @Delete("outlook/disconnect")
  async disconnectOutlook(@Body() body: { id: string }) {
    if (!body.id) {
      return { error: "missing_id" };
    }
    await this.store.remove(body.id);
    return { disconnected: true };
  }

  @Get("outlook/sync")
  async syncOutlook(@Query("email") email?: string) {
    return this.sync.syncOutlook(email);
  }

  // ── IMAP / POP ──

  @Post("imap/test")
  async testImap(@Body() body: ImapConfig) {
    if (!body.host || !body.user || !body.password) {
      return { error: "host, user, and password are required" };
    }
    try {
      const email = await this.imapSync.testConnection({
        host: body.host,
        port: body.port ?? 993,
        useTls: body.useTls !== false,
        user: body.user,
        password: body.password,
      });
      return { connected: true, email };
    } catch (err: any) {
      return { connected: false, error: err.message ?? "Connection failed" };
    }
  }

  @Post("imap/connect")
  async connectImap(@Body() body: ImapConfig & { label?: string }) {
    if (!body.host || !body.user || !body.password) {
      return { error: "host, user, and password are required" };
    }

    try {
      // Test connection first
      const email = await this.imapSync.testConnection({
        host: body.host,
        port: body.port ?? 993,
        useTls: body.useTls !== false,
        user: body.user,
        password: body.password,
      });

      // Save credentials
      const connector = await this.store.save("imap", {
        provider: "imap",
        label: body.label ?? `${body.host} (${email})`,
        email,
        tokens: {
          host: body.host,
          port: body.port ?? 993,
          useTls: body.useTls !== false,
          password: body.password,
          user: body.user,
        },
        connectedAt: new Date().toISOString(),
      });

      // Trigger initial sync
      this.imapSync.syncImap(email).catch(() => {});

      return { connected: true, id: connector.id, email };
    } catch (err: any) {
      return { error: err.message ?? "Connection failed" };
    }
  }

  @Get("imap/status")
  async getImapStatus(): Promise<{
    connected: boolean;
    accounts: { id: string; email: string; label: string; connectedAt: string; lastSyncAt?: string | null }[];
  }> {
    const accounts = await this.store.list("imap");
    return {
      connected: accounts.length > 0,
      accounts: accounts.map((a) => ({
        id: a.id,
        email: a.email,
        label: a.label,
        connectedAt: a.connectedAt,
        lastSyncAt: a.lastSyncAt,
      })),
    };
  }

  @Delete("imap/disconnect")
  async disconnectImap(@Body() body: { id: string }) {
    if (!body.id) {
      return { error: "missing_id" };
    }
    await this.store.remove(body.id);
    return { disconnected: true };
  }

  @Get("imap/sync")
  async syncImap(@Query("email") email?: string) {
    return this.imapSync.syncImap(email);
  }

  /**
   * List OAuth accounts (Gmail/Outlook) that can be used as an IMAP XOAUTH2 bridge.
   */
  @Get("imap/oauth-accounts")
  async getImapOAuthAccounts() {
    const gmailAccounts = await this.store.list("gmail");
    const outlookAccounts = await this.store.list("outlook");
    return {
      accounts: [
        ...gmailAccounts.map((a) => ({
          id: a.id,
          provider: "gmail" as const,
          email: a.email,
          label: a.label,
        })),
        ...outlookAccounts.map((a) => ({
          id: a.id,
          provider: "outlook" as const,
          email: a.email,
          label: a.label,
        })),
      ],
    };
  }

  /**
   * Connect an IMAP account using XOAUTH2 from an existing OAuth account.
   * The OAuth account (Gmail/Outlook) must already be connected.
   */
  @Post("imap/connect-with-oauth")
  async connectImapWithOAuth(
    @Body() body: { oauthAccountId: string; label?: string }
  ) {
    if (!body.oauthAccountId) {
      return { error: "oauthAccountId is required" };
    }

    try {
      // Find the OAuth account
      const oauthConnector = await this.store.get(body.oauthAccountId);
      if (!oauthConnector) {
        return { error: "OAuth account not found" };
      }

      if (oauthConnector.provider !== "outlook" && oauthConnector.provider !== "gmail") {
        return { error: "Only Gmail and Outlook accounts support IMAP XOAUTH2" };
      }

      // Get the IMAP host based on provider
      const isOutlook = oauthConnector.provider === "outlook";
      const host = isOutlook ? "outlook.office365.com" : "imap.gmail.com";
      const email = oauthConnector.email;

      // Get a fresh access token
      const accessToken = isOutlook
        ? await this.store.getValidOutlookToken(body.oauthAccountId)
        : await this.store.getValidGmailToken(body.oauthAccountId);

      // Test connection with XOAUTH2
      await this.imapSync.testConnection({
        host,
        port: 993,
        useTls: true,
        user: email,
        accessToken,
      });

      // Save IMAP connector linked to the OAuth account
      const connector = await this.store.save("imap", {
        provider: "imap",
        label: body.label ?? `${oauthConnector.provider}:${email}`,
        email,
        tokens: {
          host,
          port: 993,
          useTls: true,
          oauthProviderId: body.oauthAccountId,
        },
        connectedAt: new Date().toISOString(),
      });

      // Trigger initial sync
      this.imapSync.syncImap(email).catch(() => {});

      return { connected: true, id: connector.id, email };
    } catch (err: any) {
      return { error: err.message ?? "Connection failed" };
    }
  }
}
