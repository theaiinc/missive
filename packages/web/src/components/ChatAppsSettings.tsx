import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiJson } from "@/lib/api";
import { CHAT_APP_NAMES } from "@/pages/Chat";

type ChatProvider = keyof typeof CHAT_APP_NAMES;
type ChatAccount = {
  id: string;
  provider: ChatProvider;
  label: string;
  handle: string;
  connectedAt: string;
  running: boolean;
  needsReauth: boolean;
  lastError: string | null;
};

const HELP: Record<ChatProvider, string> = {
  telegram: "Create a bot with @BotFather, and turn its privacy mode off (/setprivacy → Disable) so it sees group messages. Then add it to your groups.",
  discord:
    "Create an application in the Discord Developer Portal, turn on Message Content Intent for its bot, and invite the bot to your server. Paste the bot's token here.",
};

/** Settings → Chat apps: the Telegram and Discord bots whose conversations show under Chat. */
export function ChatAppsSettings() {
  const queryClient = useQueryClient();
  const { data: accounts } = useQuery<ChatAccount[]>({
    queryKey: ["chat-accounts"],
    queryFn: () => apiJson<ChatAccount[]>("/api/v1/chat-apps/accounts"),
  });
  const [adding, setAdding] = useState<ChatProvider | null>(null);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["chat-accounts"] }),
      queryClient.invalidateQueries({ queryKey: ["chat-conversations"] }),
    ]);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adding || busy) return;
    setBusy(true);
    try {
      const account = await apiJson<ChatAccount>("/api/v1/chat-apps/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: adding, token, label }),
      });
      toast.success(`Connected ${account.handle}`);
      setAdding(null);
      setLabel("");
      setToken("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't connect the bot");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (account: ChatAccount) => {
    if (!window.confirm(`Disconnect ${account.handle}? Its conversations stay, but no new messages arrive.`)) return;
    try {
      await apiJson(`/api/v1/chat-apps/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect it");
    }
  };

  return (
    <section id="chat-apps" className="scroll-mt-4">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-sm font-medium text-foreground">Chat apps</h3>
        <Badge variant="secondary" className="text-[10px]">
          Chat
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Bots that bring Telegram and Discord conversations into Chat, where you can read and answer them. Name each one after what it's for, such as a
        project, and its conversations are marked with that name.
      </p>

      <div className="space-y-6">
        {(Object.keys(CHAT_APP_NAMES) as ChatProvider[]).map((provider) => {
          const mine = accounts?.filter((a) => a.provider === provider) ?? [];
          return (
            <div key={provider} className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-foreground">{CHAT_APP_NAMES[provider]}</h4>
                {adding !== provider && (
                  <Button variant="outline" size="sm" onClick={() => setAdding(provider)}>
                    <Plus className="w-3.5 h-3.5 mr-1" />
                    Connect a bot
                  </Button>
                )}
              </div>

              {mine.map((a) => (
                <div key={a.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{a.label}</span>
                      <span className="truncate text-xs text-muted-foreground">{a.handle}</span>
                    </div>
                    {a.needsReauth ? (
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
                        <AlertTriangle className="w-3 h-3" />
                        {a.lastError ?? "The token stopped working. Connect the bot again with a new one."}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-xs text-muted-foreground">{a.running ? "Listening for messages" : "Starting…"}</p>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void disconnect(a)} aria-label={`Disconnect ${a.handle}`}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              {!mine.length && adding !== provider && <p className="text-xs text-muted-foreground px-1">No bot connected.</p>}

              {adding === provider && (
                <form onSubmit={connect} className="rounded-lg border border-border p-3 space-y-3">
                  <p className="text-xs text-muted-foreground">{HELP[provider]}</p>
                  <div className="space-y-1">
                    <label htmlFor={`${provider}-label`} className="text-xs font-medium text-foreground">
                      Name
                    </label>
                    <Input id={`${provider}-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. the project it's for" />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`${provider}-token`} className="text-xs font-medium text-foreground">
                      Bot token
                    </label>
                    <Input
                      id={`${provider}-token`}
                      type="password"
                      autoComplete="off"
                      required
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={busy || !token.trim()}>
                      {busy && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                      Connect
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAdding(null);
                        setToken("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
