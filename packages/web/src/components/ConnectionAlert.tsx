import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";

type Account = { email: string; lastSyncAt?: string | null; needsReauth?: boolean; lastError?: string | null };
type Provider = "gmail" | "outlook";
const NAMES: Record<Provider, string> = { gmail: "Gmail", outlook: "Outlook" };

/** Syncs run every 5 minutes; an hour without one means it has stopped. */
const STALE_MS = 60 * 60_000;

async function accounts(provider: Provider): Promise<Account[]> {
  const res = await fetch(`/api/v1/connector/${provider}/status`);
  return res.ok ? ((await res.json()).accounts ?? []) : [];
}

function ago(iso: string): string {
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/**
 * A connected mail account that stopped working, said where the person looks
 * (above every page), not only in Settings: one the provider stopped accepting
 * the sign-in for (needs reconnecting), or one that hasn't synced for an hour.
 * The backend also sends a push notification the first time (push.service.ts).
 */
export function ConnectionAlert() {
  const query = (provider: Provider) => ({
    queryKey: ["connection-health", provider],
    queryFn: () => accounts(provider),
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: true,
  });
  const { data: gmail = [] } = useQuery(query("gmail"));
  const { data: outlook = [] } = useQuery(query("outlook"));

  const all = [
    ...gmail.map((a) => ({ ...a, provider: "gmail" as const })),
    ...outlook.map((a) => ({ ...a, provider: "outlook" as const })),
  ];
  const broken = all.find((a) => a.needsReauth);
  const stale = all.find((a) => !a.needsReauth && a.lastSyncAt && Date.now() - Date.parse(a.lastSyncAt) > STALE_MS);
  if (!broken && !stale) return null;

  const reconnect = async (provider: Provider) => {
    try {
      const res = await fetch(`/api/v1/connector/${provider}/auth`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.message ?? data.error ?? `Couldn't start reconnecting ${NAMES[provider]}.`);
      window.location.href = data.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div role="alert" className="shrink-0 flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
      <AlertCircle className="w-4 h-4 shrink-0" />
      {broken ? (
        <>
          <span className="flex-1 min-w-0">
            <strong>{broken.email}</strong> needs reconnecting: {NAMES[broken.provider]} stopped accepting Missive's sign-in, so its mail isn't arriving.
          </span>
          <button className="underline font-medium shrink-0" onClick={() => reconnect(broken.provider)}>Reconnect</button>
        </>
      ) : (
        <>
          <span className="flex-1 min-w-0">
            <strong>{stale!.email}</strong> hasn't synced for {ago(stale!.lastSyncAt!)}, so new mail from it may be missing.
          </span>
          <Link to="/settings" className="underline font-medium shrink-0">Check in Settings</Link>
        </>
      )}
    </div>
  );
}
