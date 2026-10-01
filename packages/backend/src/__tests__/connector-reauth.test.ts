import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorStore, ReauthRequiredError, isRefreshRejected } from "../connector.store";
import { SyncService } from "../sync.service";

vi.mock("../data-cipher", () => ({
  sealForCurrentUser: async (_aad: string, v: string) => v,
  openForOwner: async (_owner: string, _aad: string, v: string) => v,
}));
vi.mock("../identity-crypto", () => ({ addressIndex: async (_aad: string, v: string) => v }));

type Row = { id: string; provider: string; label: string; email: string; credentials: string; status: string; last_error: string | null; created_at: string; owner_id: string };

/** A tiny in-memory stand-in for the connectors table, enough for ConnectorStore. */
function fakePg(initial: Partial<Row>) {
  const row: Row = {
    id: "outlook:me", provider: "outlook", label: "Me", email: "me@example.com", status: "active", last_error: null,
    created_at: "2026-01-01T00:00:00.000Z", owner_id: "u1", credentials: JSON.stringify({}), ...initial,
  };
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    if (sql.startsWith("SELECT * FROM connectors WHERE id")) return { rows: params[0] === row.id ? [{ ...row }] : [] };
    if (sql.includes("INSERT INTO connectors")) {
      row.credentials = JSON.parse(params[4]); // the jsonb column hands back the sealed string
      row.status = "active";
      row.last_error = null;
      return { rows: [{ ...row }] };
    }
    if (sql.includes("status = 'needs_reauth'")) {
      row.status = "needs_reauth";
      row.last_error = params[1];
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const tokens = () => JSON.parse(row.credentials);
  return { pg: { query } as any, row, tokens };
}

const expired = { access_token: "old-access", refresh_token: "old-refresh", expiry_date: 1 };
const withTokens = (t: object) => ({ credentials: JSON.stringify(t) });

function refreshResponse(status: number, body: object) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("isRefreshRejected", () => {
  it("recognises invalid_grant and 400/401, not other failures", () => {
    expect(isRefreshRejected(new Error("invalid_grant"))).toBe(true);
    expect(isRefreshRejected({ status: 400 })).toBe(true);
    expect(isRefreshRejected({ response: { status: 401 } })).toBe(true);
    expect(isRefreshRejected({ code: "400" })).toBe(true);
    expect(isRefreshRejected({ status: 500 })).toBe(false);
    expect(isRefreshRejected(new Error("socket hang up"))).toBe(false);
  });
});

describe("ConnectorStore.getValidOutlookToken", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("saves the rotated refresh token", async () => {
    const db = fakePg(withTokens(expired));
    vi.stubGlobal("fetch", refreshResponse(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
    const token = await new ConnectorStore(db.pg).getValidOutlookToken("outlook:me");
    expect(token).toBe("new-access");
    expect(db.tokens()).toMatchObject({ access_token: "new-access", refresh_token: "new-refresh" });
  });

  it("keeps the old refresh token when none comes back", async () => {
    const db = fakePg(withTokens(expired));
    vi.stubGlobal("fetch", refreshResponse(200, { access_token: "new-access", expires_in: 3600 }));
    await new ConnectorStore(db.pg).getValidOutlookToken("outlook:me");
    expect(db.tokens().refresh_token).toBe("old-refresh");
  });

  it("shares one refresh between concurrent callers", async () => {
    const db = fakePg(withTokens(expired));
    const fetchMock = refreshResponse(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    vi.stubGlobal("fetch", fetchMock);
    const store = new ConnectorStore(db.pg);
    const tokens = await Promise.all([store.getValidOutlookToken("outlook:me"), store.getValidOutlookToken("outlook:me"), store.getValidOutlookToken("outlook:me")]);
    expect(tokens).toEqual(["new-access", "new-access", "new-access"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("flags needs_reauth on invalid_grant and stops calling the provider", async () => {
    const db = fakePg(withTokens(expired));
    const fetchMock = refreshResponse(400, { error: "invalid_grant", error_description: "AADSTS70008" });
    vi.stubGlobal("fetch", fetchMock);
    const store = new ConnectorStore(db.pg);
    await expect(store.getValidOutlookToken("outlook:me")).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(db.row.status).toBe("needs_reauth");
    expect(db.row.last_error).toBeTruthy();
    expect(db.row.last_error).not.toContain("old-refresh");

    await expect(store.getValidOutlookToken("outlook:me")).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not flag the connector for a transient failure", async () => {
    const db = fakePg(withTokens(expired));
    vi.stubGlobal("fetch", refreshResponse(503, { error: "temporarily_unavailable" }));
    await expect(new ConnectorStore(db.pg).getValidOutlookToken("outlook:me")).rejects.not.toBeInstanceOf(ReauthRequiredError);
    expect(db.row.status).toBe("active");
  });

  it("clears the flag when the account is reconnected (save)", async () => {
    const db = fakePg({ ...withTokens(expired), status: "needs_reauth", last_error: "revoked" });
    await new ConnectorStore(db.pg).save("outlook", { provider: "outlook", label: "Me", email: "me@example.com", tokens: { access_token: "a" }, connectedAt: "" });
    expect(db.row.status).toBe("active");
    expect(db.row.last_error).toBeNull();
  });
});

describe("SyncService with a connector that needs reauth", () => {
  function setup(getValid: () => Promise<string>, status = "active") {
    const connector = { id: "outlook:me", email: "me@example.com", tokens: {}, status, lastError: "Reconnect this account" };
    const store = { list: async () => [connector], getValidOutlookToken: vi.fn(getValid), updateLastSyncAt: async () => {} };
    return { store, sync: new SyncService(store as any, {} as any, {} as any, { emit: vi.fn() } as any) };
  }

  it("reports a newly flagged account", async () => {
    const { sync } = setup(async () => { throw new ReauthRequiredError("outlook:me"); });
    const r = await sync.syncOutlook();
    expect(r["me@example.com"]).toMatchObject({ needsReauth: true, newlyFlagged: true });
  });

  it("skips an already flagged account without asking for a token", async () => {
    const { sync, store } = setup(async () => "never", "needs_reauth");
    const r = await sync.syncOutlook();
    expect(r["me@example.com"]).toMatchObject({ needsReauth: true, newlyFlagged: false });
    expect(store.getValidOutlookToken).not.toHaveBeenCalled();
  });
});
