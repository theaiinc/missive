import { useQuery } from "@tanstack/react-query";

export type Mailbox = { address: string; domain: string; displayName?: string };
export type Me = { id: string; email: string; name?: string; mailboxes: Mailbox[] };

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
