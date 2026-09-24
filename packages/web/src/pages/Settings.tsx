import { useQuery, useMutation } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useEffect, useState } from "react";
import { RefreshCw, Trash2, Plus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAccountColors, colorOptions } from "@/hooks/useAccountColors";
import { useEntityConfig, ConfigItem } from "@/hooks/useEntityConfig";

interface AccountInfo {
  id: string;
  email: string;
  label: string;
  connectedAt: string;
  lastSyncAt: string | null;
}

interface ProviderStatus {
  connected: boolean;
  accounts: AccountInfo[];
}

async function getAuthUrl(provider: string): Promise<string> {
  const res = await fetch(`/api/v1/connector/${provider}/auth`);
  const data = await res.json();
  return data.url;
}

async function getStatus(provider: string): Promise<ProviderStatus> {
  const res = await fetch(`/api/v1/connector/${provider}/status`);
  return res.json();
}

async function syncProvider(provider: string, email?: string): Promise<any> {
  const params = email ? `?email=${encodeURIComponent(email)}` : "";
  const res = await fetch(`/api/v1/connector/${provider}/sync${params}`);
  return res.json();
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

async function disconnectProvider(provider: string, id: string): Promise<void> {
  await fetch(`/api/v1/connector/${provider}/disconnect`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

function AccountCard({
  account,
  onSync,
  onDisconnect,
  syncing,
}: {
  account: AccountInfo;
  onSync: () => void;
  onDisconnect: () => void;
  syncing: boolean;
}) {
  const { getColor, setColor } = useAccountColors();
  const [showColors, setShowColors] = useState(false);
  const color = getColor(account.email);

  return (
    <Card className="flex items-center justify-between p-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-base font-bold bg-red-100 text-red-600 flex-shrink-0">
          G
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {account.label}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {account.email}
          </p>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            {account.lastSyncAt
              ? `Last sync: ${formatRelativeTime(account.lastSyncAt)}`
              : "Never synced"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
        {/* Color picker */}
        <div className="relative">
          <button
            onClick={() => setShowColors(!showColors)}
            className={`w-8 h-8 rounded-lg ${color.swatch} border-2 border-border hover:ring-2 hover:ring-primary/40 transition-all`}
            title="Change badge color"
          />
          {showColors && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowColors(false)} />
              <div className="absolute right-0 top-full mt-2 z-50 bg-popover border border-border rounded-xl shadow-xl p-3 w-[216px]">
                <p className="text-[11px] font-medium text-muted-foreground mb-2.5">Badge color</p>
                <div className="flex flex-wrap gap-2.5">
                  {colorOptions.map((opt, i) => (
                    <button
                      key={i}
                      onClick={() => { setColor(account.email, i); setShowColors(false); }}
                      className={`w-10 h-10 rounded-lg ${opt.swatch} border-2 hover:ring-2 hover:ring-primary/40 transition-all ${
                        getColor(account.email).label === opt.label ? "ring-2 ring-primary border-white dark:border-zinc-900" : "border-border"
                      }`}
                      title={opt.label}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={onSync}
          disabled={syncing}
        >
          <RefreshCw
            className={`w-3.5 h-3.5 mr-1.5 ${syncing ? "animate-spin" : ""}`}
          />
          {syncing ? "Syncing..." : "Sync"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDisconnect}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
        <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border-0">
          Connected
        </Badge>
      </div>
    </Card>
  );
}

function ImapAccountCard({
  account,
  onSync,
  onDisconnect,
  syncing,
}: {
  account: AccountInfo;
  onSync: () => void;
  onDisconnect: () => void;
  syncing: boolean;
}) {
  const { getColor, setColor } = useAccountColors();
  const [showColors, setShowColors] = useState(false);
  const color = getColor(account.email);

  return (
    <Card className="flex items-center justify-between p-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center text-base font-bold text-purple-600 flex-shrink-0">
          @
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {account.label}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {account.email}
          </p>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            {account.lastSyncAt
              ? `Last sync: ${formatRelativeTime(account.lastSyncAt)}`
              : "Never synced"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
        {/* Color picker */}
        <div className="relative">
          <button
            onClick={() => setShowColors(!showColors)}
            className={`w-8 h-8 rounded-lg ${color.swatch} border-2 border-border hover:ring-2 hover:ring-primary/40 transition-all`}
            title="Change badge color"
          />
          {showColors && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowColors(false)} />
              <div className="absolute right-0 top-full mt-2 z-50 bg-popover border border-border rounded-xl shadow-xl p-3 w-[216px]">
                <p className="text-[11px] font-medium text-muted-foreground mb-2.5">Badge color</p>
                <div className="flex flex-wrap gap-2.5">
                  {colorOptions.map((opt, i) => (
                    <button
                      key={i}
                      onClick={() => { setColor(account.email, i); setShowColors(false); }}
                      className={`w-10 h-10 rounded-lg ${opt.swatch} border-2 hover:ring-2 hover:ring-primary/40 transition-all ${
                        getColor(account.email).label === opt.label ? "ring-2 ring-primary border-white dark:border-zinc-900" : "border-border"
                      }`}
                      title={opt.label}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={onSync}
          disabled={syncing}
        >
          <RefreshCw
            className={`w-3.5 h-3.5 mr-1.5 ${syncing ? "animate-spin" : ""}`}
          />
          {syncing ? "Syncing..." : "Sync"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDisconnect}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
        <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border-0">
          Connected
        </Badge>
      </div>
    </Card>
  );
}

function ProviderSection({
  label,
  letter,
  bgClass,
  accounts,
  onConnect,
  onSync,
  onDisconnect,
  syncingEmail,
}: {
  label: string;
  letter: string;
  bgClass: string;
  accounts?: AccountInfo[];
  onConnect: () => void;
  onSync: (email: string) => void;
  onDisconnect: (id: string) => void;
  syncingEmail: string | null;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${bgClass}`}
          >
            {letter}
          </div>
          <h3 className="text-sm font-medium text-foreground">{label}</h3>
        </div>
        <Button variant="outline" size="sm" onClick={onConnect}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          Add account
        </Button>
      </div>
      {accounts && accounts.length > 0 ? (
        <div className="space-y-2">
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onSync={() => onSync(account.email)}
              onDisconnect={() => onDisconnect(account.id)}
              syncing={syncingEmail === account.email}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground px-1">
          Not connected. Click "Add account" above to connect one.
        </p>
      )}
    </div>
  );
}

function ImapSection({
  accounts,
  onConnect,
  onSync,
  onDisconnect,
  syncingEmail,
  connecting,
}: {
  accounts?: AccountInfo[];
  onConnect: (config: {
    host: string;
    port: number;
    useTls: boolean;
    user: string;
    password: string;
    label?: string;
  }) => void;
  onSync: (email: string) => void;
  onDisconnect: (id: string) => void;
  syncingEmail: string | null;
  connecting: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [testResult, setTestResult] = useState<{
    connected: boolean;
    email?: string;
    error?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [oauthConnecting, setOauthConnecting] = useState(false);

  // Fetch available OAuth accounts that can be used for IMAP XOAUTH2
  const { data: oauthAccounts } = useQuery({
    queryKey: ["imap-oauth-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/v1/connector/imap/oauth-accounts");
      const data = await res.json();
      return (data.accounts ?? []) as {
        id: string;
        provider: "gmail" | "outlook";
        email: string;
        label: string;
      }[];
    },
  });

  const connectViaOAuth = async (oauthAccountId: string) => {
    setOauthConnecting(true);
    try {
      const res = await fetch("/api/v1/connector/imap/connect-with-oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oauthAccountId }),
      });
      let data: any;
      try {
        data = await res.json();
      } catch {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Server returned an invalid response");
      }
      if (data.error) throw new Error(data.error);
      setShowForm(false);
    } catch (err: any) {
      alert(`OAuth IMAP connection failed: ${err.message}`);
    } finally {
      setOauthConnecting(false);
    }
  };

  const handleTest = async () => {
    if (!host || !user || !password) return;
    setTesting(true);
    setTestResult(null);
    try {
      const portNum = parseInt(port, 10);
      const res = await fetch("/api/v1/connector/imap/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host,
          port: portNum || 993,
          useTls: portNum === 993 || portNum === 0,
          user,
          password,
        }),
      });
      let data: any;
      try {
        data = await res.json();
      } catch {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Server returned an invalid response");
      }
      if (data.error) throw new Error(data.error);
      setTestResult({ connected: true, email: data.email });
    } catch (err: any) {
      setTestResult({ connected: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = () => {
    if (!host || !user || !password) return;
    setTestResult(null);
    const portNum = parseInt(port, 10);
    onConnect({
      host,
      port: portNum || 993,
      useTls: portNum === 993 || portNum === 0,
      user,
      password,
      label: label || undefined,
    });
    setShowForm(false);
    setHost("");
    setPort("993");
    setUser("");
    setPassword("");
    setLabel("");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center text-sm font-bold text-purple-600">
            @
          </div>
          <div>
            <h3 className="text-sm font-medium text-foreground">
              IMAP / POP3
            </h3>
            <p className="text-[10px] text-muted-foreground">
              Any email provider with IMAP/POP access
            </p>
          </div>
        </div>
        {!showForm && (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add account
          </Button>
        )}
      </div>

      {/* OAuth XOAUTH2 quick-connect — reuse an already-connected Gmail/Outlook account via IMAP */}
      {oauthAccounts && oauthAccounts.length > 0 && !showForm && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
            Quick connect via OAuth
          </p>
          <div className="flex flex-wrap gap-2">
            {oauthAccounts
              .filter(
                (oa) =>
                  !accounts?.some(
                    (a) => a.email === oa.email && a.label.includes(oa.provider)
                  )
              )
              .map((oa) => (
                <button
                  key={oa.id}
                  disabled={oauthConnecting}
                  onClick={() => connectViaOAuth(oa.id)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/30 hover:bg-muted transition-colors text-left disabled:opacity-50"
                >
                  <div
                    className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold ${
                      oa.provider === "gmail"
                        ? "bg-red-100 text-red-600"
                        : "bg-blue-100 text-blue-600"
                    }`}
                  >
                    {oa.provider === "gmail" ? "G" : "O"}
                  </div>
                  <div className="text-xs">
                    <p className="font-medium">{oa.label}</p>
                    <p className="text-muted-foreground">{oa.email}</p>
                  </div>
                  {oauthConnecting && (
                    <Loader2 className="w-3 h-3 animate-spin ml-1" />
                  )}
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Connection form */}
      {showForm && (
        <Card className="p-4 space-y-3">
          {/* Provider presets */}
          <div className="flex flex-wrap items-center gap-1.5 pb-1">
            <span className="text-xs text-muted-foreground mr-1">Presets:</span>
            {[
              { label: "Gmail", host: "imap.gmail.com", port: "993", useTls: true },
              { label: "Outlook.com", host: "outlook.office365.com", port: "993", useTls: true },
              { label: "Yahoo", host: "imap.mail.yahoo.com", port: "993", useTls: true },
              { label: "iCloud", host: "imap.mail.me.com", port: "993", useTls: true },
            ].map((preset) => (
              <button
                key={preset.host}
                type="button"
                onClick={() => {
                  setHost(preset.host);
                  setPort(preset.port);
                  setTestResult(null);
                }}
                className="text-xs px-2.5 py-1 rounded-full border border-border bg-muted/30 hover:bg-muted transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2">
              <label className="text-xs font-medium text-foreground">Label</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Work Email"
                className="w-full bg-background border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <label className="text-xs font-medium text-foreground">IMAP Server</label>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="imap.example.com"
                className="w-full bg-background border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Port</label>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="993"
                className="w-full bg-background border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">TLS/SSL</label>
              <select
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="993">993 (SSL/TLS)</option>
                <option value="143">143 (STARTTLS)</option>
              </select>
            </div>
            <div className="space-y-1.5 col-span-2">
              <label className="text-xs font-medium text-foreground">Email / Username</label>
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="user@example.com"
                className="w-full bg-background border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <label className="text-xs font-medium text-foreground">Password / App Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-background border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* Provider setup hints */}
          {host === "imap.gmail.com" && (
            <div className="text-xs text-muted-foreground bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 px-3 py-2 rounded-md space-y-1">
              <p className="font-medium">Gmail setup:</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Enable <a className="underline" href="https://myaccount.google.com/security" target="_blank" rel="noopener">2-Step Verification</a> on your Google account</li>
                <li>Generate an <a className="underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">App Password</a></li>
                <li>Use the app password above (not your regular Gmail password)</li>
              </ol>
            </div>
          )}
          {host === "outlook.office365.com" && (
            <div className="text-xs text-muted-foreground bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 px-3 py-2 rounded-md space-y-1">
              <p className="font-medium">Outlook.com setup:</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Enable IMAP in Outlook settings</li>
                <li>Use an <a className="underline" href="https://account.live.com/password/change" target="_blank" rel="noopener">App Password</a> if you have 2FA enabled</li>
                <li>Otherwise use your regular Microsoft account password</li>
              </ol>
            </div>
          )}
          {host === "imap.mail.yahoo.com" && (
            <div className="text-xs text-muted-foreground bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 px-3 py-2 rounded-md space-y-1">
              <p className="font-medium">Yahoo setup:</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Generate an <a className="underline" href="https://login.yahoo.com/account/security" target="_blank" rel="noopener">App Password</a> from your Yahoo account settings</li>
                <li>Use the app password above (not your regular Yahoo password)</li>
              </ol>
            </div>
          )}
          {host === "imap.mail.me.com" && (
            <div className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-950/40 text-gray-700 dark:text-gray-300 px-3 py-2 rounded-md space-y-1">
              <p className="font-medium">iCloud setup:</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Generate an <a className="underline" href="https://appleid.apple.com/account/manage" target="_blank" rel="noopener">App-Specific Password</a> in your Apple ID settings</li>
                <li>Use the app-specific password above (not your regular Apple ID password)</li>
              </ol>
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!host || !user || !password || connecting}
            >
              {connecting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : (
                <Plus className="w-3.5 h-3.5 mr-1" />
              )}
              {connecting ? "Connecting..." : "Connect"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTest}
              disabled={!host || !user || !password || testing}
            >
              {testing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : null}
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowForm(false);
                setTestResult(null);
              }}
            >
              Cancel
            </Button>
          </div>

          {/* Test result feedback */}
          {testResult && (
            <div
              className={`text-xs px-3 py-2 rounded-md space-y-1 ${
                testResult.connected
                  ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400"
                  : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400"
              }`}
            >
              <p>
                {testResult.connected
                  ? `✅ Connected as ${testResult.email}`
                  : `❌ ${testResult.error}`}
              </p>
              {!testResult.connected && testResult.error?.toLowerCase().includes("authenticate") && (
                <p className="opacity-80">
                  Most providers require an <strong>App Password</strong> — use the setup guide above for help.
                </p>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Connected accounts */}
      {accounts && accounts.length > 0 ? (
        <div className="space-y-2">
          {accounts.map((account) => (
            <ImapAccountCard
              key={account.id}
              account={account}
              onSync={() => onSync(account.email)}
              onDisconnect={() => onDisconnect(account.id)}
              syncing={syncingEmail === account.email}
            />
          ))}
        </div>
      ) : !showForm ? (
        <p className="text-xs text-muted-foreground px-1">
          No IMAP accounts connected. Use this for any email provider that gives you IMAP or POP access.
        </p>
      ) : null}
    </div>
  );
}

function ConfigSection({
  title,
  badge,
  items,
  onAdd,
  onRemove,
  onRename,
  onSetColor,
  icon,
}: {
  title: string;
  badge: string;
  items: ConfigItem[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onSetColor: (name: string, colorIndex: number) => void;
  icon: string;
}) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [colorPicker, setColorPicker] = useState<string | null>(null);

  const handleAdd = () => {
    if (!newName.trim()) return;
    onAdd(newName.trim());
    setNewName("");
  };

  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <Badge variant="secondary" className="text-[10px]">{badge}</Badge>
      </div>

      <Card className="p-4">
        {/* Add new */}
        <div className="flex items-center gap-2 mb-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
            placeholder={`New ${title.toLowerCase().slice(0, -1)} name...`}
            className="flex-1 bg-background border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
          />
          <Button variant="outline" size="sm" onClick={handleAdd} disabled={!newName.trim()}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add
          </Button>
        </div>

        {items.length === 0 && (
          <p className="text-xs text-muted-foreground px-1">
            No {title.toLowerCase()} configured yet.
          </p>
        )}

        {/* Item list */}
        <div className="space-y-1.5">
          {items.map((item) => (
            <div
              key={item.name}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/20"
            >
              {/* Color picker */}
              <div className="relative">
                <button
                  onClick={() => setColorPicker(colorPicker === item.name ? null : item.name)}
                  className={`w-6 h-6 rounded-md ${colorOptions[item.colorIndex].swatch} border border-border hover:ring-2 hover:ring-primary/40 transition-all shrink-0`}
                  title="Change color"
                />
                {colorPicker === item.name && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setColorPicker(null)} />
                    <div className="absolute left-0 top-full mt-1.5 z-50 bg-popover border border-border rounded-xl shadow-xl p-2.5 w-[180px]">
                      <div className="flex flex-wrap gap-1.5">
                        {colorOptions.map((opt, i) => (
                          <button
                            key={i}
                            onClick={() => { onSetColor(item.name, i); setColorPicker(null); }}
                            className={`w-7 h-7 rounded-md ${opt.swatch} border hover:ring-2 hover:ring-primary/40 transition-all ${
                              item.colorIndex === i ? "ring-2 ring-primary" : "border-border"
                            }`}
                            title={opt.label}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Name (editable inline) */}
              {editing === item.name ? (
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && editValue.trim()) {
                      onRename(item.name, editValue.trim());
                      setEditing(null);
                    }
                    if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={() => setEditing(null)}
                  className="flex-1 bg-background border border-border rounded px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                />
              ) : (
                <span
                  className="flex-1 text-sm text-foreground cursor-pointer hover:text-primary"
                  onClick={() => { setEditing(item.name); setEditValue(item.name); }}
                  title="Click to rename"
                >
                  {item.name}
                </span>
              )}

              <button
                onClick={() => onRemove(item.name)}
                className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                title="Remove"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}

export function Settings() {
  const [searchParams] = useSearchParams();

  const { data: gmailStatus, refetch: refetchGmail } = useQuery({
    queryKey: ["connector", "gmail", "status"],
    queryFn: () => getStatus("gmail"),
  });

  const { data: outlookStatus, refetch: refetchOutlook } = useQuery({
    queryKey: ["connector", "outlook", "status"],
    queryFn: () => getStatus("outlook"),
  });

  const { data: imapStatus, refetch: refetchImap } = useQuery({
    queryKey: ["connector", "imap", "status"],
    queryFn: () => getStatus("imap"),
  });

  const [imapConnecting, setImapConnecting] = useState(false);

  const syncMutation = useMutation({
    mutationFn: ({ provider, email }: { provider: string; email?: string }) =>
      syncProvider(provider, email),
    onSuccess: () => {
      setTimeout(() => {
        refetchGmail();
        refetchOutlook();
        refetchImap();
      }, 1000);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: ({ provider, id }: { provider: string; id: string }) =>
      disconnectProvider(provider, id),
    onSuccess: () => {
      refetchGmail();
      refetchOutlook();
      refetchImap();
    },
  });

  const imapConnectMutation = useMutation({
    mutationFn: async (config: {
      host: string;
      port: number;
      useTls: boolean;
      user: string;
      password: string;
      label?: string;
    }) => {
      const res = await fetch("/api/v1/connector/imap/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      let data: any;
      try {
        data = await res.json();
      } catch {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Server returned an invalid response");
      }
      if (data.error) throw new Error(data.error);
      return data;
    },
    onMutate: () => setImapConnecting(true),
    onSuccess: () => {
      refetchImap();
    },
    onError: (err: Error) => {
      alert(`Connection failed: ${err.message}`);
    },
    onSettled: () => setImapConnecting(false),
  });

  const organizations = useEntityConfig("missive_managed_organizations");
  const projects = useEntityConfig("missive_managed_projects");

  // Handle OAuth callback result
  useEffect(() => {
    const error = searchParams.get("error");
    const connected = searchParams.get("connected");
    if (error) {
      console.error("OAuth error:", error);
    }
    if (connected === "gmail") {
      refetchGmail();
      window.history.replaceState({}, "", "/settings");
    }
    if (connected === "outlook") {
      refetchOutlook();
      window.history.replaceState({}, "", "/settings");
    }
  }, [searchParams, refetchGmail, refetchOutlook]);

  const handleConnect = async (provider: string) => {
    const authUrl = await getAuthUrl(provider);
    window.location.href = authUrl;
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-8 py-4 border-b border-border bg-card">
        <h2 className="text-lg font-semibold text-foreground">Settings</h2>
      </div>

      <div className="flex-1 px-8 py-6 space-y-8 overflow-y-auto">
        {/* Connected Accounts */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <h3 className="text-sm font-medium text-foreground">
              Connected Accounts
            </h3>
            <Badge variant="secondary" className="text-[10px]">
              Missive
            </Badge>
          </div>
          <div className="space-y-6">
            <ProviderSection
              label="Gmail"
              letter="G"
              bgClass="bg-red-100 text-red-600"
              accounts={gmailStatus?.accounts}
              onConnect={() => handleConnect("gmail")}
              onSync={(email) => syncMutation.mutate({ provider: "gmail", email })}
              onDisconnect={(id) => disconnectMutation.mutate({ provider: "gmail", id })}
              syncingEmail={
                syncMutation.isPending && syncMutation.variables?.provider === "gmail"
                  ? syncMutation.variables?.email ?? null
                  : null
              }
            />
            <ProviderSection
              label="Outlook / Microsoft 365"
              letter="O"
              bgClass="bg-blue-100 text-blue-600"
              accounts={outlookStatus?.accounts}
              onConnect={() => handleConnect("outlook")}
              onSync={(email) => syncMutation.mutate({ provider: "outlook", email })}
              onDisconnect={(id) => disconnectMutation.mutate({ provider: "outlook", id })}
              syncingEmail={
                syncMutation.isPending && syncMutation.variables?.provider === "outlook"
                  ? syncMutation.variables?.email ?? null
                  : null
              }
            />
            <ImapSection
              accounts={imapStatus?.accounts}
              onConnect={(config) => imapConnectMutation.mutate(config)}
              onSync={(email) => syncMutation.mutate({ provider: "imap", email })}
              onDisconnect={(id) => disconnectMutation.mutate({ provider: "imap", id })}
              syncingEmail={
                syncMutation.isPending && syncMutation.variables?.provider === "imap"
                  ? syncMutation.variables?.email ?? null
                  : null
              }
              connecting={imapConnecting}
            />
          </div>
        </section>

        <Separator />

        {/* Organizations */}
        <ConfigSection
          title="Organizations"
          badge="Entity"
          items={organizations.items}
          onAdd={organizations.addItem}
          onRemove={organizations.removeItem}
          onRename={organizations.renameItem}
          onSetColor={organizations.setColor}
          icon="org"
        />

        <div className="py-2" />

        {/* Projects */}
        <ConfigSection
          title="Projects"
          badge="Entity"
          items={projects.items}
          onAdd={projects.addItem}
          onRemove={projects.removeItem}
          onRename={projects.renameItem}
          onSetColor={projects.setColor}
          icon="project"
        />

        <Separator />

        {/* Ecosystem Integration */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <h3 className="text-sm font-medium text-foreground">
              Ecosystem Integration
            </h3>
            <Badge variant="secondary" className="text-[10px]">
              The AI Inc
            </Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="p-4">
              <p className="text-sm font-medium text-foreground">Pathway</p>
              <p className="text-xs text-muted-foreground mt-1">
                Memory, graph, orchestration
              </p>
              <Badge variant="outline" className="mt-2 text-[10px]">
                Not connected
              </Badge>
            </Card>
            <Card className="p-4">
              <p className="text-sm font-medium text-foreground">Cognition</p>
              <p className="text-xs text-muted-foreground mt-1">
                Agentic reasoning & actions
              </p>
              <Badge variant="outline" className="mt-2 text-[10px]">
                Not connected
              </Badge>
            </Card>
          </div>
        </section>

        <Separator />

        {/* AI Model */}
        <section>
          <h3 className="text-sm font-medium text-foreground mb-4">
            AI Model
          </h3>
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">
                  google/gemma-4-26b-a4b-qat
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Running on LM Studio at 127.0.0.1:1234
                </p>
              </div>
              <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border-0">
                Active
              </Badge>
            </div>
          </Card>
        </section>
      </div>
    </div>
  );
}
