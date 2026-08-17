import type { AiProviderName, AiResponse, AiToolCall, ChatMessage } from "./types.js";

export type AiProvider = {
  name: AiProviderName;
  chat(messages: ChatMessage[], systemPrompt: string): Promise<AiResponse>;
};

type ProviderConfig = {
  geminiApiKey?: string;
  geminiModel?: string;
  claudeApiKey?: string;
  claudeModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  primaryProvider?: AiProviderName;
};

export class AiExhaustedError extends Error {
  constructor(public readonly failures: Array<{ provider: AiProviderName; error: string }>) {
    super(`All configured AI providers failed: ${failures.map((failure) => failure.provider).join(", ")}`);
  }
}

export class AiOrchestrator {
  readonly providers: AiProvider[];

  constructor(providers: AiProvider[], primaryProvider?: AiProviderName) {
    this.providers = [...providers].sort((left, right) => Number(right.name === primaryProvider) - Number(left.name === primaryProvider));
  }

  get enabled() { return this.providers.length > 0; }
  get configuredProviders() { return this.providers.map((provider) => provider.name); }
  get primaryProvider() { return this.providers[0]?.name; }

  async chat(messages: ChatMessage[], systemPrompt: string) {
    const failures: AiExhaustedError["failures"] = [];
    for (const provider of this.providers) {
      try { return { ...(await provider.chat(messages, systemPrompt)), provider: provider.name }; }
      catch (error) { failures.push({ provider: provider.name, error: error instanceof Error ? error.message : String(error) }); }
    }
    throw new AiExhaustedError(failures);
  }
}

export function createAiOrchestrator(config: ProviderConfig) {
  const providers: AiProvider[] = [];
  if (config.geminiApiKey) providers.push(new GeminiProvider(config.geminiApiKey, config.geminiModel || "gemini-2.5-flash"));
  if (config.claudeApiKey) providers.push(new ClaudeProvider(config.claudeApiKey, config.claudeModel || "claude-sonnet-4-20250514"));
  if (config.openaiApiKey) providers.push(new OpenAiProvider(config.openaiApiKey, config.openaiModel || "gpt-4.1-mini"));
  return new AiOrchestrator(providers, config.primaryProvider);
}

class GeminiProvider implements AiProvider {
  readonly name = "gemini" as const;
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async chat(messages: ChatMessage[], systemPrompt: string) {
    const body = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
        generationConfig: { maxOutputTokens: 500, responseMimeType: "application/json" },
      },
      { "x-goog-api-key": this.apiKey },
    );
    return parseAiResponse(readString(body, ["candidates", 0, "content", "parts", 0, "text"]));
  }
}

class ClaudeProvider implements AiProvider {
  readonly name = "claude" as const;
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async chat(messages: ChatMessage[], systemPrompt: string) {
    const body = await postJson("https://api.anthropic.com/v1/messages", {
      model: this.model,
      max_tokens: 500,
      system: systemPrompt,
      messages,
    }, { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" });
    return parseAiResponse(readString(body, ["content", 0, "text"]));
  }
}

class OpenAiProvider implements AiProvider {
  readonly name = "openai" as const;
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async chat(messages: ChatMessage[], systemPrompt: string) {
    const body = await postJson("https://api.openai.com/v1/chat/completions", {
      model: this.model,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: systemPrompt }, ...messages],
    }, { Authorization: `Bearer ${this.apiKey}` });
    return parseAiResponse(readString(body, ["choices", 0, "message", "content"]));
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({})) as { error?: { message?: string; status?: string } };
  if (!response.ok) throw new Error(`HTTP ${response.status}${result.error?.status ? ` ${result.error.status}` : ""}${result.error?.message ? `: ${result.error.message}` : ""}`);
  return result;
}

function readString(value: unknown, path: Array<string | number>) {
  let cursor = value;
  for (const key of path) cursor = cursor && typeof cursor === "object" ? (cursor as Record<string | number, unknown>)[key] : undefined;
  if (typeof cursor !== "string" || !cursor.trim()) throw new Error("AI provider returned an empty response");
  return cursor;
}

export function parseAiResponse(raw: string): AiResponse {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try { value = JSON.parse(cleaned); }
  catch { return { text: cleaned.slice(0, 2_000), resolved: false }; }
  if (!value || typeof value !== "object") return { text: cleaned.slice(0, 2_000), resolved: false };
  const record = value as Record<string, unknown>;
  const toolCalls = Array.isArray(record.toolCalls)
    ? record.toolCalls.flatMap((tool): AiToolCall[] => tool && typeof tool === "object" && typeof (tool as Record<string, unknown>).name === "string"
      ? [{ name: String((tool as Record<string, unknown>).name), arguments: asArguments((tool as Record<string, unknown>).arguments) }]
      : [])
    : [];
  return {
    text: typeof record.text === "string" ? record.text.trim().slice(0, 2_000) : "",
    ...(toolCalls.length ? { toolCalls } : {}),
    resolved: record.resolved === true,
    escalate: record.escalate === true,
  };
}

function asArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
    catch { return {}; }
  }
  return {};
}
