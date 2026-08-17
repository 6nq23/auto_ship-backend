import { describe, expect, it, vi } from "vitest";
import { AiOrchestrator, createAiOrchestrator, parseAiResponse, type AiProvider } from "./ai-providers.js";

describe("AI provider orchestration", () => {
  it("uses the configured primary first and fails over without changing the request", async () => {
    const messages = [{ role: "user" as const, content: "track RBD5001" }];
    const gemini: AiProvider = { name: "gemini", chat: vi.fn(async () => { throw new Error("rate limited"); }) };
    const openai: AiProvider = { name: "openai", chat: vi.fn(async () => ({ text: "fallback answer", resolved: true })) };
    const orchestrator = new AiOrchestrator([gemini, openai], "gemini");

    await expect(orchestrator.chat(messages, "rules")).resolves.toEqual({ text: "fallback answer", resolved: true, provider: "openai" });
    expect(gemini.chat).toHaveBeenCalledWith(messages, "rules");
    expect(openai.chat).toHaveBeenCalledWith(messages, "rules");
  });

  it("parses fenced structured tool calls and rejects non-object arguments safely", () => {
    expect(parseAiResponse("```json\n{\"text\":\"\",\"toolCalls\":[{\"name\":\"track_order\",\"arguments\":{\"identifier\":\"RBD5001\"}}]}\n```"))
      .toEqual({ text: "", toolCalls: [{ name: "track_order", arguments: { identifier: "RBD5001" } }], resolved: false, escalate: false });
    expect(parseAiResponse("plain reply")).toEqual({ text: "plain reply", resolved: false });
  });

  it("uses the available Gemini 2.5 Flash default and the API-key header", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/models/gemini-2.5-flash:generateContent");
      expect(String(url)).not.toContain("key=");
      expect(init?.headers).toEqual(expect.objectContaining({ "x-goog-api-key": "test-key" }));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"text\":\"Hello\",\"resolved\":true}" }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ai = createAiOrchestrator({ geminiApiKey: "test-key", primaryProvider: "gemini" });
      await expect(ai.chat([{ role: "user", content: "Hello" }], "rules")).resolves.toEqual(expect.objectContaining({ provider: "gemini", text: "Hello", resolved: true }));
    } finally { vi.unstubAllGlobals(); }
  });
});
