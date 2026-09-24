import { useState, useCallback } from "react";

export const colorOptions = [
  { label: "Red", bg: "bg-red-100 dark:bg-red-950/40", text: "text-red-700 dark:text-red-300", swatch: "bg-red-500" },
  { label: "Blue", bg: "bg-blue-100 dark:bg-blue-950/40", text: "text-blue-700 dark:text-blue-300", swatch: "bg-blue-500" },
  { label: "Green", bg: "bg-green-100 dark:bg-green-950/40", text: "text-green-700 dark:text-green-300", swatch: "bg-green-500" },
  { label: "Purple", bg: "bg-purple-100 dark:bg-purple-950/40", text: "text-purple-700 dark:text-purple-300", swatch: "bg-purple-500" },
  { label: "Amber", bg: "bg-amber-100 dark:bg-amber-950/40", text: "text-amber-700 dark:text-amber-300", swatch: "bg-amber-500" },
  { label: "Cyan", bg: "bg-cyan-100 dark:bg-cyan-950/40", text: "text-cyan-700 dark:text-cyan-300", swatch: "bg-cyan-500" },
  { label: "Pink", bg: "bg-pink-100 dark:bg-pink-950/40", text: "text-pink-700 dark:text-pink-300", swatch: "bg-pink-500" },
  { label: "Teal", bg: "bg-teal-100 dark:bg-teal-950/40", text: "text-teal-700 dark:text-teal-300", swatch: "bg-teal-500" },
];

const STORAGE_KEY = "missive_account_colors";

/**
 * Colors are saved under a hash of the account address, never the address
 * itself: browser storage must not hold email addresses in the clear.
 * (cyrb53: a fast 53-bit string hash; salted so the keys are Missive-specific.)
 */
function storageKeyFor(email: string): string {
  const str = `missive-account-color:${email.trim().toLowerCase()}`;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `a_${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

function loadColors(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved: Record<string, number> = raw ? JSON.parse(raw) : {};
    // Colors saved before hashing were keyed by the address: re-key them once.
    if (Object.keys(saved).some((k) => k.includes("@"))) {
      const migrated: Record<string, number> = {};
      for (const [k, v] of Object.entries(saved)) migrated[k.includes("@") ? storageKeyFor(k) : k] = v;
      saveColors(migrated);
      return migrated;
    }
    return saved;
  } catch {
    return {};
  }
}

function saveColors(colors: Record<string, number>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
}

/** Deterministic hash to pick a default color index for an email */
function hashEmail(email: string): number {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % colorOptions.length;
}

export function useAccountColors() {
  const [colors, setColors] = useState<Record<string, number>>(loadColors);

  const getColor = useCallback(
    (email: string) => {
      const idx = colors[storageKeyFor(email)] ?? hashEmail(email);
      return colorOptions[idx] ?? colorOptions[0];
    },
    [colors]
  );

  const setColor = useCallback((email: string, colorIndex: number) => {
    setColors((prev) => {
      const next = { ...prev, [storageKeyFor(email)]: colorIndex };
      saveColors(next);
      return next;
    });
  }, []);

  return { getColor, setColor };
}
