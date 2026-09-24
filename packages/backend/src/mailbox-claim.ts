/**
 * Rules for the address a person picks for their hosted mailbox.
 * Lower-case letters, digits and . _ - ; starts and ends with a letter or
 * digit; no "..". Role and system names are reserved.
 */
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const RESERVED = new Set([
  "abuse", "admin", "administrator", "billing", "contact", "help", "hostmaster", "info", "mail", "mailer-daemon",
  "marketing", "no-reply", "noc", "noreply", "postmaster", "root", "sales", "security", "support", "sysadmin",
  "team", "webmaster", "www",
]);

export type LocalPartProblem = "invalid" | "reserved";

export function normalizeLocalPart(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function localPartProblem(localPart: string): LocalPartProblem | null {
  if (!LOCAL_PART.test(localPart) || localPart.includes("..")) return "invalid";
  if (RESERVED.has(localPart)) return "reserved";
  return null;
}
