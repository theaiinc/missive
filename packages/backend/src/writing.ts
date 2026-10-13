import { llmBaseUrl, llmHeaders, llmModel } from "./llm";

/**
 * The writing model, for translating a message (translate.ts) and drafting
 * one (draft.ts). Hosted, it's Workers AI's Gemma 4 through the edge Worker
 * (packages/edge/src/ai.ts, WRITING_MODEL), counted against the same daily
 * allowance as the organizer; locally, LM Studio's model.
 */
export const writingModel = () => process.env.LM_STUDIO_WRITING_MODEL || llmModel();

export class WritingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Message = { role: "system" | "user" | "assistant"; content: string };

/** The model's answer to `messages`; a WritingError with the status to answer with when there's none. */
export async function write(messages: Message[], maxTokens: number, temperature = 0.2): Promise<string> {
  const res = await fetch(`${llmBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: llmHeaders(),
    body: JSON.stringify({ model: writingModel(), messages, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(90_000),
  }).catch((e: unknown) => {
    throw new WritingError(`The writing model didn't answer (${e instanceof Error ? e.message : String(e)})`, 502);
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    // 429: today's Workers AI allowance is used up; the edge says when it resets.
    throw new WritingError(detail?.error?.message ?? `The writing model returned ${res.status}`, res.status === 429 ? 429 : 502);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const answer = data.choices?.[0]?.message?.content ?? "";
  if (!answer.trim()) throw new WritingError("The model's answer came back empty", 502);
  return answer;
}
