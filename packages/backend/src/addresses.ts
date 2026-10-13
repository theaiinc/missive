import type { AddressObject } from "mailparser";

export type Address = { name?: string; address: string };

/**
 * An address-list header ("Name <a@x>, b@y", with quoted names that may hold
 * commas), as addresses. Anything without an @ is dropped.
 */
export function parseAddressList(raw: string | null | undefined): Address[] {
  if (!raw) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  const out: Address[] = [];
  for (const part of parts) {
    const p = part.trim();
    const m = p.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
    if (m) {
      const name = m[1]!.trim().replace(/^"(.*)"$/, "$1").trim();
      out.push({ address: m[2]!.toLowerCase(), ...(name ? { name } : {}) });
    } else if (/^[^\s@<>]+@[^\s@<>]+$/.test(p)) {
      out.push({ address: p.toLowerCase() });
    }
  }
  return out;
}

/** mailparser's parsed address header (one or several), as addresses. */
export function fromParsed(value: AddressObject | AddressObject[] | undefined): Address[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .flatMap((o) => o.value)
    .filter((a) => a.address)
    .map((a) => ({ address: a.address!.toLowerCase(), ...(a.name ? { name: a.name } : {}) }));
}

/**
 * Where a reply goes: the Reply-To addresses when they differ from the
 * sender, else the sender. Unset Reply-To, or one equal to From, means the sender.
 */
export function replyRecipients(from: Address, replyTo: Address[] | undefined): Address[] {
  const others = (replyTo ?? []).filter((a) => a.address.toLowerCase() !== from.address.toLowerCase());
  return others.length ? others : [from];
}

/** Microsoft Graph recipients ({ emailAddress: { address, name } }), as addresses. */
export function graphAddresses(list: { emailAddress?: { address?: string; name?: string } }[] | undefined): Address[] {
  return (list ?? [])
    .map((r) => ({ address: (r.emailAddress?.address ?? "").toLowerCase(), ...(r.emailAddress?.name ? { name: r.emailAddress.name } : {}) }))
    .filter((r) => r.address.includes("@"));
}
