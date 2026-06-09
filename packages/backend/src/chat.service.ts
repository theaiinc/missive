import { Injectable, HttpException, HttpStatus } from "@nestjs/common";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

@Injectable()
export class ChatService {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl =
      process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
    this.model =
      process.env.LM_STUDIO_MODEL ?? "google/gemma-4-26b-a4b-qat";
    this.timeoutMs = parseInt(process.env.LM_STUDIO_TIMEOUT_MS ?? "120000", 10);
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit & { timeout?: number },
  ): Promise<Response> {
    const timeout = options.timeout ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return res;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new HttpException(
          "LM Studio request timed out. The model may be loading or busy.",
          HttpStatus.GATEWAY_TIMEOUT,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stream a chat completion from LM Studio, writing SSE chunks to `res`. */
  async streamChat(
    messages: ChatMessage[],
    res: any
  ): Promise<void> {
    const systemMessage: ChatMessage = {
      role: "system",
      content: `You are Missive AI, an intelligent communication assistant integrated into the Missive platform. You help users manage their communications — emails, chat messages, tickets, and more. You can summarize threads, classify messages, extract entities, and answer questions about the user's inbox. Be concise, helpful, and professional.`,
    };

    const body = JSON.stringify({
      model: this.model,
      messages: [systemMessage, ...messages],
      stream: true,
      temperature: 0.7,
      max_tokens: 2048,
    });

    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        timeout: this.timeoutMs,
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HttpException(
        `LM Studio error (${response.status}): ${text}`,
        HttpStatus.BAD_GATEWAY
      );
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = response.body?.getReader();
    if (!reader) {
      res.write(`data: ${JSON.stringify({ error: "No response body" })}\n\n`);
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const json = trimmed.slice(6);
          if (json === "[DONE]") continue; // handled by finally block
          try {
            const parsed = JSON.parse(json);
            const content = parsed.choices?.[0]?.delta?.content ?? "";
            if (content) {
              res.write(
                `data: ${JSON.stringify({ content })}\n\n`
              );
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  }

  /** Non-streaming chat completion for simple requests. */
  async chat(messages: ChatMessage[]): Promise<string> {
    const systemMessage: ChatMessage = {
      role: "system",
      content: `You are Missive AI, an intelligent communication assistant integrated into the Missive platform.`,
    };

    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [systemMessage, ...messages],
          stream: false,
          temperature: 0.7,
          max_tokens: 1024,
        }),
        timeout: this.timeoutMs,
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HttpException(
        `LM Studio error (${response.status}): ${text}`,
        HttpStatus.BAD_GATEWAY
      );
    }

    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }

  /**
   * Ask the AI to parse a natural-language rule request into a structured
   * RuleProposal. The AI responds with JSON only.
   */
  async proposeRule(userMessage: string): Promise<{
    proposal: {
      name: string;
      description: string;
      conditions: { field: string; operator: string; value: string }[];
      actions: { type: string; params?: Record<string, string> }[];
      needsClarification: boolean;
      clarification?: string;
    } | null;
    message: string;
  }> {
    const systemPrompt = `You are Missive AI's rule-builder. Your job is to detect whether the user wants to create a rule for organizing their inbox.

If the user's message is NOT about creating a rule (e.g. "hello", "how are you", "summarize this", or any general chat), respond with:
{"proposal": null, "message": ""}

If the user IS asking to create a rule, respond with ONLY valid JSON:
{
  "proposal": {
    "name": "short rule name",
    "description": "explanation of what this rule does",
    "conditions": [
      { "field": "from_address|from_domain|subject_contains|body_contains|has_attachments|channel|classification|account_email|direction", "operator": "equals|not_equals|contains|not_contains|matches", "value": "..." }
    ],
    "actions": [
      { "type": "move_to_folder|mark_read|mark_unread|archive|label|delete|notify", "params": { "folder": "..." } }
    ],
    "needsClarification": false,
    "clarification": null
  },
  "message": "A friendly explanation for the user about what the rule does."
}

RULES:
- If the request is ambiguous or needs more info, set needsClarification to true and put the question in clarification.
- Use the correct field names from the available list above.
- For move_to_folder, the params must include a "folder" key with the folder slug.
- For label, params must include a "label" key.
- Keep rules simple — at most 2-3 conditions and 1-2 actions.
- Only output the JSON object, nothing else.`;

    const raw = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ]);

    try {
      // Try to extract JSON from the response (it may have markdown fences)
      const jsonStr = raw.replace(/```(?:json)?\s*/gi, "").trim();
      const parsed = JSON.parse(jsonStr);
      return {
        proposal: parsed.proposal ?? null,
        message: parsed.message ?? "I couldn't understand that request. Please be more specific.",
      };
    } catch {
      return {
        proposal: null,
        message: raw || "I couldn't understand that request. Please be more specific.",
      };
    }
  }
}
