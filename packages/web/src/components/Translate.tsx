import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Languages, Loader2 } from "lucide-react";

export interface Translation {
  to: string;
  language: string;
  from: string;
  subject: string;
  body: string;
  truncated: boolean;
}

type Language = { code: string; name: string };

const STORAGE_KEY = "missive.translateTo";

/** The language last translated into, else the browser's, else English. */
function defaultLanguage(languages: Language[]): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && languages.some((l) => l.code === saved)) return saved;
  } catch {}
  for (const tag of navigator.languages ?? [navigator.language]) {
    const exact = languages.find((l) => l.code.toLowerCase() === tag.toLowerCase());
    if (exact) return exact.code;
    const base = languages.find((l) => l.code.split("-")[0] === tag.split("-")[0]);
    if (base) return base.code;
  }
  return "en";
}

/**
 * "Translate to [language]" under a message, and "Translated from … · Show
 * original" once it is. The translation itself is shown by the card, from
 * `translation`.
 */
export function TranslateBar({
  missiveId,
  translation,
  onTranslation,
}: {
  missiveId: string;
  translation: Translation | null;
  onTranslation: (t: Translation | null) => void;
}) {
  const { data: languages = [] } = useQuery<Language[]>({
    queryKey: ["translate-languages"],
    queryFn: () => fetch("/api/v1/translate/languages").then((r) => r.json()),
    staleTime: Infinity,
  });
  const [to, setTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!languages.length) return null;
  const target = to ?? defaultLanguage(languages);

  const run = async (code: string) => {
    setTo(code);
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {}
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/missive/${encodeURIComponent(missiveId)}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: code }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Translation failed (${res.status})`);
      onTranslation(data as Translation);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const picker = (
    <select
      aria-label="Translate into"
      value={target}
      disabled={busy}
      onChange={(e) => (translation ? run(e.target.value) : setTo(e.target.value))}
      className="bg-transparent text-xs text-muted-foreground hover:text-foreground border-0 p-0 pr-1 focus:outline-none cursor-pointer"
    >
      {languages.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-xs text-muted-foreground border-b border-border">
      <Languages className="w-3.5 h-3.5 shrink-0" />
      {busy ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Translating…
        </span>
      ) : translation ? (
        <>
          <span>
            Translated{translation.from ? ` from ${translation.from}` : ""} into
          </span>
          {picker}
          <span aria-hidden>·</span>
          <button type="button" className="text-primary hover:underline" onClick={() => onTranslation(null)}>
            Show original
          </button>
        </>
      ) : (
        <>
          <button type="button" className="text-primary hover:underline" onClick={() => run(target)}>
            Translate
          </button>
          <span>into</span>
          {picker}
        </>
      )}
      {error && <span className="text-destructive w-full sm:w-auto">{error}</span>}
    </div>
  );
}

export function TranslatedBody({ translation }: { translation: Translation }) {
  return (
    <div className="px-4 py-3 text-sm text-foreground leading-relaxed" lang={translation.to}>
      {translation.subject && <p className="font-medium mb-2">{translation.subject}</p>}
      <div className="whitespace-pre-wrap">{translation.body}</div>
      {translation.truncated && (
        <p className="mt-3 text-xs text-muted-foreground">This message is long; only its beginning was translated.</p>
      )}
    </div>
  );
}
