import { Injectable } from "@nestjs/common";
import { google, type Auth } from "googleapis";
import { PostgresService } from "./storage/postgres.service";

export interface StoredConnector {
  id: string;
  provider: string;
  label: string;
  email: string;
  tokens: Record<string, any>;
  connectedAt: string;
  lastSyncAt?: string | null;
}

@Injectable()
export class ConnectorStore {
  constructor(private readonly pg: PostgresService) {}

  // ── Gmail OAuth ──

  createOAuth2Client(): Auth.OAuth2Client {
    return new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI ?? "http://localhost:5173/oauth"
    );
  }

  getGmailAuthUrl(): string {
    const oauth2 = this.createOAuth2Client();
    return oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      state: "gmail",
      scope: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    });
  }

  getOAuthClientForConnector(connector: StoredConnector): Auth.OAuth2Client {
    const oauth2 = this.createOAuth2Client();
    oauth2.setCredentials(connector.tokens);
    return oauth2;
  }

  /**
   * Get a valid Gmail access token, refreshing if expired.
   * Updates stored tokens when refreshed.
   */
  async getValidGmailToken(connectorId: string): Promise<string> {
    const connector = await this.get(connectorId);
    if (!connector || connector.provider !== "gmail") {
      throw new Error(`Invalid or missing Gmail connector: ${connectorId}`);
    }

    const tokens = connector.tokens;
    const expiry = tokens.expiry_date ? Number(tokens.expiry_date) : 0;

    // If still valid, return current access token
    if (tokens.access_token && expiry > Date.now() + 60000) {
      return tokens.access_token;
    }

    // Need to refresh
    if (!tokens.refresh_token) {
      throw new Error("No refresh token available — re-authenticate with Gmail");
    }

    const oauth2 = this.createOAuth2Client();
    oauth2.setCredentials({ refresh_token: tokens.refresh_token });
    const { credentials } = await oauth2.refreshAccessToken();

    // Save updated tokens
    const freshTokens = {
      access_token: credentials.access_token!,
      refresh_token: credentials.refresh_token ?? tokens.refresh_token,
      expiry_date: credentials.expiry_date ?? undefined,
    };
    await this.save("gmail", {
      provider: "gmail",
      label: connector.label,
      email: connector.email,
      tokens: freshTokens,
      connectedAt: connector.connectedAt,
    });

    return freshTokens.access_token;
  }

  // ── Outlook / Microsoft OAuth ──

  private get outlookTenant(): string {
    return process.env.OUTLOOK_TENANT ?? "common";
  }

  getOutlookAuthUrl(): string {
    const clientId = process.env.OUTLOOK_CLIENT_ID;
    const redirectUri =
      process.env.OUTLOOK_REDIRECT_URI ?? "http://localhost:5173/oauth";
    const scope =
      "openid profile email User.Read Mail.Read Mail.ReadBasic Mail.Send offline_access IMAP.AccessAsUser.All";
    return (
      `https://login.microsoftonline.com/${this.outlookTenant}/oauth2/v2.0/authorize?` +
      new URLSearchParams({
        client_id: clientId ?? "",
        response_type: "code",
        redirect_uri: redirectUri,
        scope,
        state: "outlook",
      }).toString()
    );
  }

  async exchangeOutlookCode(
    code: string
  ): Promise<{
    tokens: { access_token: string; refresh_token?: string; expiry_date?: number };
    email: string;
  }> {
    const redirectUri =
      process.env.OUTLOOK_REDIRECT_URI ?? "http://localhost:5173/oauth";
    const res = await fetch(
      `https://login.microsoftonline.com/${this.outlookTenant}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.OUTLOOK_CLIENT_ID ?? "",
          client_secret: process.env.OUTLOOK_CLIENT_SECRET ?? "",
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Outlook token exchange failed: ${res.status} ${text}`);
    }
    const data = await res.json() as Record<string, any>;

    // Get user email from /me
    const meRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const me = await meRes.json() as Record<string, any>;

    return {
      tokens: {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? undefined,
        expiry_date: data.expires_in
          ? Date.now() + data.expires_in * 1000
          : undefined,
      },
      email: me.mail ?? me.userPrincipalName ?? "unknown",
    };
  }

  async refreshOutlookTokens(
    refreshToken: string
  ): Promise<{ access_token: string; refresh_token?: string; expiry_date?: number }> {
    const res = await fetch(
      `https://login.microsoftonline.com/${this.outlookTenant}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.OUTLOOK_CLIENT_ID ?? "",
          client_secret: process.env.OUTLOOK_CLIENT_SECRET ?? "",
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }).toString(),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Outlook token refresh failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Record<string, any>;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? undefined,
      expiry_date: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : undefined,
    };
  }

  /**
   * Get a valid Outlook access token, refreshing if expired.
   * Updates stored tokens when refreshed.
   */
  async getValidOutlookToken(connectorId: string): Promise<string> {
    const connector = await this.get(connectorId);
    if (!connector || connector.provider !== "outlook") {
      throw new Error(`Invalid or missing Outlook connector: ${connectorId}`);
    }

    const tokens = connector.tokens;
    const expiry = tokens.expiry_date ? Number(tokens.expiry_date) : 0;

    // If still valid, return current access token
    if (tokens.access_token && expiry > Date.now() + 60000) {
      return tokens.access_token;
    }

    // Need to refresh
    if (!tokens.refresh_token) {
      throw new Error("No refresh token available — re-authenticate with Outlook");
    }

    const fresh = await this.refreshOutlookTokens(tokens.refresh_token);

    // Save updated tokens
    await this.save("outlook", {
      provider: "outlook",
      label: connector.label,
      email: connector.email,
      tokens: fresh,
      connectedAt: connector.connectedAt,
    });

    return fresh.access_token;
  }

  // ── Generic connector CRUD ──

  async save(
    provider: string,
    data: Omit<StoredConnector, "id">
  ): Promise<StoredConnector> {
    const id = `${provider}:${data.email}`;
    const { rows } = await this.pg.query(
      `INSERT INTO connectors (id, provider, label, email, credentials, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label,
         credentials = EXCLUDED.credentials,
         updated_at = NOW()
       RETURNING *`,
      [id, provider, data.label, data.email, JSON.stringify(data.tokens)]
    );
    return rowToConnector(rows[0]);
  }

  async get(id: string): Promise<StoredConnector | undefined> {
    const { rows } = await this.pg.query(
      "SELECT * FROM connectors WHERE id = $1",
      [id]
    );
    if (rows.length === 0) return undefined;
    return rowToConnector(rows[0]);
  }

  async list(provider: string): Promise<StoredConnector[]> {
    const { rows } = await this.pg.query(
      "SELECT * FROM connectors WHERE provider = $1 ORDER BY created_at ASC",
      [provider]
    );
    return rows.map(rowToConnector);
  }

  async listAll(): Promise<StoredConnector[]> {
    const { rows } = await this.pg.query(
      "SELECT * FROM connectors ORDER BY provider, created_at ASC"
    );
    return rows.map(rowToConnector);
  }

  async remove(id: string): Promise<void> {
    await this.pg.query("DELETE FROM connectors WHERE id = $1", [id]);
  }

  async updateLastSyncAt(id: string): Promise<void> {
    await this.pg.query(
      "UPDATE connectors SET last_sync_at = NOW() WHERE id = $1",
      [id]
    );
  }

  getAppUrl(): string {
    return process.env.CORS_ORIGIN ?? "http://localhost:5173";
  }
}

function rowToConnector(row: any): StoredConnector {
  const creds =
    typeof row.credentials === "string"
      ? JSON.parse(row.credentials)
      : row.credentials;
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    email: row.email ?? "",
    tokens: creds,
    connectedAt: row.created_at?.toISOString?.() ?? row.created_at,
    lastSyncAt: row.last_sync_at
      ? (row.last_sync_at.toISOString?.() ?? row.last_sync_at)
      : null,
  };
}
