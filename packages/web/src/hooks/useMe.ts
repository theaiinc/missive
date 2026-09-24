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
