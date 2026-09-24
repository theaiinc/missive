import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Availability = { address: string; available: boolean; reason?: "invalid" | "reserved" | "taken" };

const REASONS: Record<NonNullable<Availability["reason"]>, string> = {
  invalid: "Use lower-case letters, numbers and . _ - (starting and ending with a letter or number).",
  reserved: "That address is reserved.",
  taken: "That address is already taken.",
};

/**
 * First sign-in for an account Aegis created blank: the person picks their
 * hosted Missive address at the offered domain before using the app.
 */
export function ClaimMailbox({ domain }: { domain: string }) {
  const queryClient = useQueryClient();
  const [localPart, setLocalPart] = useState("");
  const [check, setCheck] = useState<Availability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCheck(null);
    const value = localPart.trim().toLowerCase();
    if (!value) return;
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/v1/mailboxes/available?localPart=${encodeURIComponent(value)}`);
      if (res.ok) setCheck(await res.json());
    }, 300);
    return () => clearTimeout(timer);
  }, [localPart]);

  async function claim(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch("/api/v1/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ localPart: localPart.trim().toLowerCase() }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? body.message ?? "Couldn't create that mailbox. Try another address.");
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={claim} className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Choose your Missive address</h1>
          <p className="text-sm text-muted-foreground">
            This is your own mailbox at {domain}, alongside your Aegis account. You can&apos;t change it later.
          </p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Address</span>
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value)}
              placeholder="jane"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="mailbox-status"
            />
            <span className="whitespace-nowrap text-sm text-muted-foreground">@{domain}</span>
          </div>
        </label>
        <p id="mailbox-status" aria-live="polite" className="min-h-5 text-sm">
          {check?.available && <span className="text-green-600 dark:text-green-400">{check.address} is available</span>}
          {check && !check.available && check.reason && <span className="text-destructive">{REASONS[check.reason]}</span>}
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={!check?.available || saving}>
          {saving ? "Creating…" : "Create my mailbox"}
        </Button>
      </form>
    </div>
  );
}
