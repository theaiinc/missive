import { useQuery } from "@tanstack/react-query";

/** Your own mailbox, or a group you're in (only owners and moderators may send as a group). */
export type Mailbox = { address: string; domain: string; displayName?: string; kind?: "mailbox" | "group"; role?: "owner" | "moderator" | "member" };

/** The addresses someone may send from. */
export const canSendAs = (m: Mailbox) => m.kind !== "group" || m.role !== "member";
/** mailboxOffer: this account may claim a hosted mailbox at `domain` (and has none yet). accountUrl: their Aegis account page. */
export type Me = { id: string; email: string; name?: string; mailboxes: Mailbox[]; mailboxOffer?: { domain: string } | null; accountUrl?: string; isAdmin?: boolean };

/** The signed-in Aegis user and the hosted mailboxes they can send from. */
export function useMe() {
  return useQuery<Me>({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/v1/me");
      if (!res.ok) throw new Error(`Couldn't load your account (${res.status})`);
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
}

/** An address you can send from: a hosted mailbox or group, or a connected Gmail account (sent through Gmail). */
export type Sender = { address: string; label: string; kind: "mailbox" | "group" | "gmail"; displayName?: string };

/** Everything the From menu offers, hosted mailboxes first. */
export function useSenders(): Sender[] {
  const { data: me } = useMe();
  const { data: gmail } = useQuery<{ accounts: { email: string; needsReauth?: boolean }[] }>({
    queryKey: ["gmail-status"],
    queryFn: async () => {
      const res = await fetch("/api/v1/connector/gmail/status");
      return res.ok ? res.json() : { accounts: [] };
    },
    staleTime: 5 * 60_000,
  });
  const hosted: Sender[] = (me?.mailboxes ?? []).filter(canSendAs).map((m) => ({
    address: m.address,
    displayName: m.displayName,
    kind: m.kind === "group" ? "group" : "mailbox",
    label: (m.displayName ? `${m.displayName} <${m.address}>` : m.address) + (m.kind === "group" ? " · group" : ""),
  }));
  const taken = new Set(hosted.map((s) => s.address));
  const viaGmail: Sender[] = (gmail?.accounts ?? [])
    .filter((a) => !a.needsReauth && !taken.has(a.email))
    .map((a) => ({ address: a.email, kind: "gmail", label: `${a.email} · Gmail` }));
  return [...hosted, ...viaGmail];
}

export type Signature = { address: string; text: string; source: "missive" | "gmail" | "none" };

/** The signature for an address you send from (yours from Settings, else your Gmail one). */
export function useSignature(address: string | undefined) {
  return useQuery<Signature>({
    queryKey: ["signature", address],
    queryFn: async () => {
      const res = await fetch(`/api/v1/signatures?address=${encodeURIComponent(address!)}`);
      return res.ok ? res.json() : { address: address!, text: "", source: "none" };
    },
    enabled: !!address,
    staleTime: 10 * 60_000,
  });
}
