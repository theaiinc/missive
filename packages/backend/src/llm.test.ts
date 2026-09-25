import { afterEach, describe, expect, it, vi } from "vitest";
import { llmHeaders, llmInfo } from "./llm";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("llm", () => {
  it("sends the edge key only when one is set", () => {
    vi.stubEnv("LLM_API_KEY", "");
    expect(llmHeaders()).toEqual({ "Content-Type": "application/json" });
    vi.stubEnv("LLM_API_KEY", "k".repeat(40));
    expect(llmHeaders().Authorization).toBe(`Bearer ${"k".repeat(40)}`);
  });

  it("describes LM Studio locally", async () => {
    vi.stubEnv("LM_STUDIO_BASE_URL", "http://127.0.0.1:1234/v1");
    vi.stubEnv("LM_STUDIO_MODEL", "google/gemma-4-26b-a4b-qat");
    expect(await llmInfo()).toMatchObject({ provider: "LM Studio", where: "Running on LM Studio at 127.0.0.1:1234", usage: null });
  });

  it("describes Workers AI with today's use when hosted", async () => {
    vi.stubEnv("LM_STUDIO_BASE_URL", "https://mail.example/internal/ai/v1");
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider: "x", spent: 120, limit: 4500, left: 4380 })));
    vi.stubGlobal("fetch", fetch);
    const info = await llmInfo();
    expect(fetch.mock.calls[0]![0]).toBe("https://mail.example/internal/ai/usage");
    expect(info).toMatchObject({ provider: "Cloudflare Workers AI", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", usage: { spent: 120, limit: 4500, left: 4380 } });
  });
});
