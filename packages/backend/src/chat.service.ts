import { Injectable, HttpException, HttpStatus } from "@nestjs/common";
import { llmBaseUrl, llmHeaders, llmModel } from "./llm";
import { StorageService } from "./storage/storage.service";
import { RuleService } from "./rule.service";
import { ConnectorStore } from "./connector.store";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ToolResult {
  name: string;
  success: boolean;
  message: string;
  data?: any;
}

@Injectable()
export class ChatService {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly storage: StorageService,
    private readonly rules: RuleService,
    private readonly connectors: ConnectorStore
  ) {
    this.baseUrl = llmBaseUrl();
    this.model = llmModel();
    this.timeoutMs = parseInt(process.env.LM_STUDIO_TIMEOUT_MS ?? "120000", 10);
  }

  /** Available tool definitions for the AI. */
  private getToolDefinitions(): string {
    return `
You have the ability to perform actions by invoking tools. To call a tool, include a line in your response with the following format:

TOOL_CALL:createFolder({"name": "Folder Name", "slug": "folder-slug"})

The slug should be a URL-friendly version of the name (lowercase, hyphens instead of spaces, no special chars).

TOOL_CALL:classify({"missiveId": "missive-id", "classification": "invoice"})

The classification must be one of: invoice, complaint, lead, support, personal, notification, newsletter, meeting, spam, other.

TOOL_CALL:move({"missiveId": "missive-id", "folder": "folder-slug"})

You can also move entire threads with TOOL_CALL:moveThread({"threadId": "thread-id", "folder": "folder-slug"})

Available tools:

1. createFolder — Create a new folder to organize messages
   Parameters: { "name": string, "slug": string }

2. classify — Set a classification label on a missive. This also automatically moves it to the correct folder based on the classification
   Parameters: { "missiveId": string, "classification": string }

3. move — Move a missive to a different folder
   Parameters: { "missiveId": string, "folder": string }

4. moveThread — Move an entire thread (all messages in it) to a different folder
   Parameters: { "threadId": string, "folder": string }

5. setOrganizations — Set the organization(s) a missive belongs to. Use an array even for a single org.
   Parameters: { "missiveId": string, "organizations": string[] }

6. setThreadOrganizations — Set the organization(s) for all messages in a thread.
   Parameters: { "threadId": string, "organizations": string[] }

7. setProjects — Set the project(s) a missive belongs to. Use an array even for a single project.
   Parameters: { "missiveId": string, "projects": string[] }

8. setThreadProjects — Set the project(s) for all messages in a thread.
   Parameters: { "threadId": string, "projects": string[] }

Only call tools when explicitly requested by the user. When you call a tool, include both your explanation AND the TOOL_CALL line in your response.`;
  }

  /** Execute a tool call and return the result. */
  private async executeTool(toolName: string, args: any): Promise<ToolResult> {
    switch (toolName) {
      case "createFolder": {
        if (!args.name || !args.slug) {
          return { name: toolName, success: false, message: "name and slug are required" };
        }
        try {
          const folder = await this.storage.createFolder({
            name: args.name,
            slug: args.slug,
          });
          return {
            name: toolName,
            success: true,
            message: `Created folder "${args.name}" (${args.slug}).`,
            data: folder,
          };
        } catch (err: any) {
          return {
            name: toolName,
            success: false,
            message: err.message ?? "Failed to create folder.",
          };
        }
      }
      case "classify": {
        if (!args.missiveId || !args.classification) {
          return { name: toolName, success: false, message: "missiveId and classification are required." };
        }
        try {
          await this.storage.classifyMissive(args.missiveId, args.classification);
          return {
            name: toolName,
            success: true,
            message: `Classified message **${args.missiveId.slice(0, 8)}...** as "${args.classification}" and moved it to the correct folder.`,
            data: { classification: args.classification },
          };
        } catch (err: any) {
          return { name: toolName, success: false, message: err.message ?? "Failed to classify." };
        }
      }
      case "move": {
        if (!args.missiveId || !args.folder) {
          return { name: toolName, success: false, message: "missiveId and folder are required." };
        }
        try {
          await this.storage.moveMissive(args.missiveId, args.folder);
          return {
            name: toolName,
            success: true,
            message: `Moved message **${args.missiveId.slice(0, 8)}...** to **${args.folder}**.`,
          };
        } catch (err: any) {
          return { name: toolName, success: false, message: err.message ?? "Failed to move message." };
        }
      }
      case "moveThread": {
        if (!args.threadId || !args.folder) {
          return { name: toolName, success: false, message: "threadId and folder are required." };
        }
        try {
          await this.storage.moveThread(args.threadId, args.folder);
          return {
            name: toolName,
            success: true,
            message: `Moved thread **${args.threadId.slice(0, 8)}...** to **${args.folder}**.`,
          };
        } catch (err: any) {
          return { name: toolName, success: false, message: err.message ?? "Failed to move thread." };
        }
      }
      case "setOrganizations": {
        if (!args.missiveId || !Array.isArray(args.organizations)) {
          return { name: toolName, success: false, message: "missiveId and organizations array are required." };
        }
        try {
          await this.storage.setMissiveOrganizations(args.missiveId, args.organizations);
          return {
            name: toolName,
            success: true,
            message: `Set organizations for message **${args.missiveId.slice(0, 8)}...** to: ${args.organizations.join(", ") || "(none)"}.`,
            data: { organizations: args.organizations },
          };
        } catch (err: any) {
          return { name: toolName, success: false, message: err.message ?? "Failed to set organizations." };
        }
      }
      case "setThreadOrganizations": {
        if (!args.threadId || !Array.isArray(args.organizations)) {
          return { name: toolName, success: false, message: "threadId and organizations array are required." };
        }
        try {
          await this.storage.setThreadOrganizations(args.threadId, args.organizations);
          return {
            name: toolName,
            success: true,
            message: `Set organizations for thread **${args.threadId.slice(0, 8)}...** to: ${args.organizations.join(", ") || "(none)"}.`,
            data: { organizations: args.organizations },
          };
        } catch (err: any) {
          return { name: toolName, success: false, message: err.message ?? "Failed to set organizations." };
        }
      }
      case "setProjects": {
        if (!args.missiveId || !Array.isArray(args.projects)) {
          return { name: toolName, success: false, message: "missiveId and projects array are required." };
        }
        try {
          await this.storage.setMissiveProjects(args.missiveId, args.projects);
          return {
            name: toolName,
            success: true,
            message: `Set projects for message **${args.missiveId.slice(0, 8)}...** to: ${args.projects.join(", ") || "(none)"}.`,
            data: { projects: args.projects },
          };
        } catch (err: any) {
          return { name: toolName, success: false, message: err.message ?? "Failed to set projects." };
        }
      }
      case "setThreadProjects": {
        if (!args.threadId || !Array.isArray(args.projects)) {
          return { name: toolName, success: false, message: "threadId and projects array are required." };
        }
        try {
          await this.storage.setThreadProjects(args.threadId, args.projects);
          return {
            name: toolName,
            success: true,
            message: `Set projects for thread **${args.threadId.slice(0, 8)}...** to: ${args.projects.join(", ") || "(none)"}.`,
            data: { projects: args.projects },
          };
        } catch (err: any) {
          return { name: toolName, success: false, message: err.message ?? "Failed to set projects." };
        }
      }
      default:
        return { name: toolName, success: false, message: `Unknown tool: ${toolName}` };
    }
  }

  /** Scan content for tool calls and execute them. Returns modified content (with TOOL_CALL lines removed) and results. */
  private async processToolCalls(content: string): Promise<{ cleanedContent: string; results: ToolResult[] }> {
    const toolCallRegex = /TOOL_CALL:(\w+)\((\{.*?\})\)/gs;
    const results: ToolResult[] = [];
    let cleanedContent = content;

    let match: RegExpExecArray | null;
    while ((match = toolCallRegex.exec(content)) !== null) {
      const toolName = match[1]!;
      const argsStr = match[2]!;
      try {
        const args = JSON.parse(argsStr);
        const result = await this.executeTool(toolName, args);
        results.push(result);
      } catch {
        results.push({ name: toolName, success: false, message: "Failed to parse tool arguments." });
      }
      // Remove the TOOL_CALL line from the visible content
      cleanedContent = cleanedContent.replace(match[0]!, "").trim();
    }

    return { cleanedContent, results };
  }

  /** Build a dynamic system message with the current app context. */
  private async buildSystemPrompt(): Promise<string> {
    const parts: string[] = [
      "You are Missive AI, an intelligent communication assistant integrated into the Missive platform. You help users manage their communications — emails, chat messages, tickets, and more. Be concise, helpful, and professional.",
      "",
      "=== APP CONTEXT ===",
    ];

    // Connected accounts
    try {
      const accounts = await this.connectors.listAll();
      if (accounts.length > 0) {
        parts.push(`Connected accounts (${accounts.length}):`);
        for (const acct of accounts) {
          parts.push(`- ${acct.provider}: ${acct.email} (${acct.label})`);
        }
      } else {
        parts.push("No email accounts connected yet.");
      }
    } catch {
      parts.push("Accounts: unavailable");
    }

    // Folders
    try {
      const folders = await this.storage.listFolders();
      if (folders.length > 0) {
        parts.push(`Folders: ${folders.map((f) => `${f.name} (${f.slug})`).join(", ")}`);
      }
    } catch {
      parts.push("Folders: unavailable");
    }

    // Active rules
    try {
      const allRules = await this.rules.list();
      const enabled = allRules.filter((r) => r.enabled);
      if (enabled.length > 0) {
        parts.push(`Active rules (${enabled.length}):`);
        for (const rule of enabled) {
          const conds = rule.conditions.map((c) => `${c.field} ${c.operator} "${c.value}"`).join(" AND ");
          const acts = rule.actions.map((a) => `${a.type}${a.params?.folder ? ` → ${a.params.folder}` : ""}`).join(", ");
          parts.push(`- "${rule.name}": if ${conds} then ${acts}`);
        }
      } else {
        parts.push("No active rules.");
      }
    } catch {
      parts.push("Rules: unavailable");
    }

    // Recent missives summary
    try {
      const recent = await this.storage.getRecentMissives(
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        15
      );
      if (recent.length > 0) {
        parts.push(`\nRecent messages (last 24h, ${recent.length} total):`);
        for (const m of recent.slice(0, 10)) {
          const sender = m.from.name ?? m.from.address;
          const subj = m.subject ?? "(no subject)";
          const folder = m.folder ?? "inbox";
          const cls = m.classification ? ` [${m.classification}]` : "";
          parts.push(`- From: ${sender} | Subject: ${subj} | Folder: ${folder}${cls}`);
        }
        if (recent.length > 10) {
          parts.push(`... and ${recent.length - 10} more`);
        }
      } else {
        parts.push("No messages in the last 24 hours.");
      }
    } catch {
      parts.push("Recent messages: unavailable");
    }

    // Per-folder counts via folders API
    try {
      const folders = await this.storage.listFolders();
      if (folders.length > 0) {
        parts.push("\nFolder overview:");
        for (const f of folders) {
          parts.push(`- ${f.name} (${f.slug}): ${f.missiveCount} messages`);
        }
      }
    } catch {
      // Silently skip
    }

    // Organizations in use
    try {
      const orgs = await this.storage.listOrganizations();
      if (orgs.length > 0) {
        parts.push(`\nOrganizations in use: ${orgs.join(", ")}`);
      }
    } catch {
      // Silently skip
    }

    // Projects in use
    try {
      const projs = await this.storage.listProjects();
      if (projs.length > 0) {
        parts.push(`\nProjects in use: ${projs.join(", ")}`);
      }
    } catch {
      // Silently skip
    }

    parts.push("\nRespond helpfully. Use the context above to answer questions about the user's inbox. When asked to summarize or find something, use the information provided. Suggest rules or actions based on what you see in the user's messages.");

    parts.push("\n" + this.getToolDefinitions());
    return parts.join("\n");
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
          "The AI model timed out. It may be busy; try again in a moment.",
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
    const systemContent = await this.buildSystemPrompt();
    const systemMessage: ChatMessage = {
      role: "system",
      content: systemContent,
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
        headers: llmHeaders(),
        body,
        timeout: this.timeoutMs,
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HttpException(
        `AI model error (${response.status}): ${text}`,
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
    let fullContent = "";

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
              fullContent += content;
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
    }

    // After stream completes, process any tool calls in the accumulated content
    const { cleanedContent, results } = await this.processToolCalls(fullContent);

    // If content was cleaned (tool lines removed), send the cleaned content
    if (cleanedContent !== fullContent) {
      res.write(`data: ${JSON.stringify({ toolCleaned: cleanedContent })}\n\n`);
    }

    // Send tool results if any
    if (results.length > 0) {
      for (const result of results) {
        res.write(
          `data: ${JSON.stringify({ toolResult: result })}\n\n`
        );
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
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
        headers: llmHeaders(),
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
        `AI model error (${response.status}): ${text}`,
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
