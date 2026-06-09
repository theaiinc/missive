import OpenAI from "openai";
import type { Missive, EntityReference } from "@theaiinc/missive-core";

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class AIService {
  private client: OpenAI;
  private model: string;

  constructor(
    baseURL = "http://127.0.0.1:1234/v1",
    model = "google/gemma-4-26b-a4b-qat"
  ) {
    this.client = new OpenAI({
      baseURL,
      apiKey: "lm-studio", // LM Studio accepts any key
      dangerouslyAllowBrowser: true,
    });
    this.model = model;
  }

  async summarize(missives: Missive[]): Promise<string> {
    const text = missives
      .map((m) => `[${m.from.name ?? m.from.address}]: ${m.body}`)
      .join("\n\n");

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "You are a communication analyst. Summarize the following conversation concisely, highlighting key points, decisions, and action items.",
        },
        { role: "user", content: text },
      ],
    });

    return response.choices[0]?.message?.content ?? "No summary available.";
  }

  async classify(missive: Missive): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "Classify the following message into one of: invoice, lead, complaint, support, personal, other. Respond with only the classification label.",
        },
        {
          role: "user",
          content: `Subject: ${missive.subject ?? "(no subject)"}\n\nBody: ${missive.body}`,
        },
      ],
    });

    return response.choices[0]?.message?.content?.toLowerCase().trim() ?? "other";
  }

  async extractEntities(missive: Missive): Promise<EntityReference[]> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: `Extract entities from the following message. Return a JSON object with an "entities" array, each with: type (person|company|project|product) and name. Example: {"entities":[{"type":"person","name":"John Doe"}]}`,
        },
        {
          role: "user",
          content: `Subject: ${missive.subject ?? "(no subject)"}\n\nBody: ${missive.body}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];

    try {
      const parsed = JSON.parse(content);
      return (parsed.entities ?? []).map(
        (e: { type: string; name: string }) => ({
          id: generateId(),
          type: e.type as EntityReference["type"],
          name: e.name,
        })
      );
    } catch {
      return [];
    }
  }

  async generateThreadMemory(missives: Missive[]): Promise<{
    decisions: string[];
    actionItems: string[];
    deadlines: string[];
    risks: string[];
  }> {
    const text = missives
      .map((m) => `[${m.from.name ?? m.from.address}]: ${m.body}`)
      .join("\n\n");

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: `Analyze the conversation and extract structured memory. Return JSON with: decisions (array of strings), actionItems (array of strings), deadlines (array of strings), risks (array of strings).`,
        },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return { decisions: [], actionItems: [], deadlines: [], risks: [] };

    try {
      return JSON.parse(content);
    } catch {
      return { decisions: [], actionItems: [], deadlines: [], risks: [] };
    }
  }
}