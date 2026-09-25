/**
 * Where the organizer and chat assistant reach their language model: any
 * OpenAI-compatible /chat/completions. Locally that's LM Studio; hosted, the
 * edge Worker serves Workers AI at APP_URL/internal/ai/v1 and sets
 * LLM_API_KEY so only the API can use it (packages/edge/src/ai.ts).
 */
export const llmBaseUrl = () => process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
export const llmModel = () => process.env.LM_STUDIO_MODEL ?? "google/gemma-4-26b-a4b-qat";

export function llmHeaders(): Record<string, string> {
  const key = process.env.LLM_API_KEY;
  return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

/** How Settings describes the model, and today's use when it's metered (Workers AI). */
export async function llmInfo(): Promise<{
  model: string; provider: string; where: string; organizer: boolean;
  usage: { spent: number; limit: number; left: number } | null;
}> {
  const base = llmBaseUrl();
  const organizer = process.env.MISSIVE_ORGANIZER !== "off";
  const edge = base.replace(/\/v1\/?$/, "");
  if (base.includes("/internal/ai")) {
    try {
      const res = await fetch(`${edge}/usage`, { headers: llmHeaders(), signal: AbortSignal.timeout(5_000) });
      const u = res.ok ? ((await res.json()) as { model: string; provider: string; spent: number; limit: number; left: number }) : null;
      return {
        model: u?.model ?? llmModel(), provider: "Cloudflare Workers AI", where: "Hosted by Cloudflare; your mail isn't used to train it", organizer,
        usage: u ? { spent: u.spent, limit: u.limit, left: u.left } : null,
      };
    } catch {
      return { model: llmModel(), provider: "Cloudflare Workers AI", where: "Hosted by Cloudflare; your mail isn't used to train it", organizer, usage: null };
    }
  }
  const host = (() => { try { return new URL(base).host; } catch { return base; } })();
  return { model: llmModel(), provider: "LM Studio", where: `Running on LM Studio at ${host}`, organizer, usage: null };
}
