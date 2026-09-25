import { DurableObject } from "cloudflare:workers";

/**
 * The API's language model: an OpenAI-compatible /chat/completions backed by
 * Workers AI, for the organizer and the chat assistant. Only the API may call
 * it (EDGE_SECRET), and it keeps to a daily share of the Cloudflare account's
 * free 10,000 neurons (AI_DAILY_NEURONS, 4,500 by default; Bugmole's Scents
 * uses the rest), counted in the AiBudget Durable Object.
 */
export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** Neurons per token for AI_MODEL ($0.293 / $2.253 per million tokens). */
const PER_INPUT_TOKEN = 26_668 / 1e6;
const PER_OUTPUT_TOKEN = 204_805 / 1e6;
const DEFAULT_DAILY_NEURONS = 4_500;
const MAX_OUTPUT_TOKENS = 2_048;

export interface AiEnv {
  AI: Ai;
  AI_BUDGET: DurableObjectNamespace<AiBudget>;
  AI_DAILY_NEURONS?: string;
}

type Usage = { prompt_tokens?: number; completion_tokens?: number };
type Message = { role: string; content: string };

const day = () => new Date().toISOString().slice(0, 10);

export function neurons(usage: Usage | undefined, promptChars: number, answerChars: number): number {
  // Without a usage report, estimate about four characters a token.
  return (usage?.prompt_tokens ?? promptChars / 4) * PER_INPUT_TOKEN + (usage?.completion_tokens ?? answerChars / 4) * PER_OUTPUT_TOKEN;
}

/** Today's spending, one counter per UTC day. */
export class AiBudget extends DurableObject {
  async spent(): Promise<number> {
    return (await this.ctx.storage.get<number>(day())) ?? 0;
  }
  async spend(amount: number): Promise<number> {
    const key = day();
    const total = ((await this.ctx.storage.get<number>(key)) ?? 0) + Math.max(0, amount);
    await this.ctx.storage.put(key, total);
    const old = [...(await this.ctx.storage.list<number>()).keys()].filter((k) => k < key);
    if (old.length) await this.ctx.storage.delete(old);
    return total;
  }
}

const budget = (env: AiEnv) => env.AI_BUDGET.getByName("workers-ai");
export const dailyLimit = (env: AiEnv) => {
  const n = Number(env.AI_DAILY_NEURONS);
  return env.AI_DAILY_NEURONS && Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_NEURONS;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function aiUsage(env: AiEnv): Promise<Response> {
  const limit = dailyLimit(env);
  const spent = await budget(env).spent();
  return json({ model: AI_MODEL, provider: "Cloudflare Workers AI", spent: Math.round(spent), limit, left: Math.max(0, Math.round(limit - spent)) });
}

export async function chatCompletions(request: Request, env: AiEnv): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { messages?: Message[]; stream?: boolean; temperature?: number; max_tokens?: number }
    | null;
  const messages = (body?.messages ?? []).filter((m) => m && typeof m.content === "string").map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length) return json({ error: { message: "messages is required" } }, 400);

  const limit = dailyLimit(env);
  const spent = await budget(env).spent();
  if (spent >= limit) {
    return json({ error: { message: `Today's AI allowance is used up (${Math.round(spent)} of ${limit} neurons); it resets at 00:00 UTC.`, type: "budget" } }, 429);
  }
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  const input = {
    messages,
    max_tokens: Math.min(Math.max(1, Math.round(body?.max_tokens ?? 1024)), MAX_OUTPUT_TOKENS),
    ...(typeof body?.temperature === "number" ? { temperature: body.temperature } : {}),
  };
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (!body?.stream) {
    let out: { response?: unknown; usage?: Usage };
    try {
      out = (await env.AI.run(AI_MODEL as never, input as never)) as typeof out;
    } catch (e) {
      return json({ error: { message: e instanceof Error ? e.message : String(e) } }, 502);
    }
    const content = typeof out.response === "string" ? out.response : out.response == null ? "" : JSON.stringify(out.response);
    await budget(env).spend(neurons(out.usage, promptChars, content.length));
    return json({
      id, object: "chat.completion", created, model: AI_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: out.usage ?? null,
    });
  }

  // Streaming: Workers AI sends `data: {"response": "…"}` events; re-shape
  // them as OpenAI chunks, and count what was used once the stream ends.
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = (await env.AI.run(AI_MODEL as never, { ...input, stream: true } as never)) as ReadableStream<Uint8Array>;
  } catch (e) {
    return json({ error: { message: e instanceof Error ? e.message : String(e) } }, 502);
  }
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buffer = "";
  let answerChars = 0;
  let usage: Usage | undefined;
  const chunk = (delta: Record<string, string>, finish: string | null = null) =>
    enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: AI_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const reshape = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(chunk({ role: "assistant" }));
    },
    transform(bytes, controller) {
      buffer += dec.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : "";
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data) as { response?: string; usage?: Usage };
          if (event.usage) usage = event.usage;
          if (event.response) {
            answerChars += event.response.length;
            controller.enqueue(chunk({ content: event.response }));
          }
        } catch {
          // skip a malformed event
        }
      }
    },
    async flush(controller) {
      controller.enqueue(chunk({}, "stop"));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      await budget(env).spend(neurons(usage, promptChars, answerChars));
    },
  });
  return new Response(stream.pipeThrough(reshape), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
