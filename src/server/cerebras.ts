import type { AgentFinding, BrainstormResponse } from "../shared/schema";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  time_info?: Record<string, unknown>;
}

export interface CerebrasResult<T> {
  value: T;
  rawText: string;
  latencyMs: number;
  usage?: CompletionUsage;
  model: string;
}

const endpoint = "https://api.cerebras.ai/v1/chat/completions";

export function getCerebrasModel(): string {
  return process.env.CEREBRAS_MODEL || "gemma-4-31b";
}

export function hasCerebrasKey(): boolean {
  return getCerebrasKeys().length > 0;
}

export async function callCerebrasText(messages: ChatMessage[], maxTokens = 900): Promise<CerebrasResult<string>> {
  const apiKeys = getCerebrasKeys();
  if (!apiKeys.length) {
    throw new Error("CEREBRAS_API_KEY is not set");
  }

  const errors: string[] = [];
  for (const apiKey of apiKeys) {
    const started = performance.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: getCerebrasModel(),
        messages,
        max_tokens: maxTokens,
        temperature: 0.35,
        reasoning_effort: "none"
      })
    });
    const text = await response.text();
    const latencyMs = Math.round(performance.now() - started);

    if (!response.ok) {
      const errorText = `Cerebras API ${response.status}: ${redactSecrets(text).slice(0, 500)}`;
      errors.push(errorText);
      if (response.status === 429 || /rate limit/i.test(text)) {
        continue;
      }
      throw new Error(errorText);
    }

    const json = JSON.parse(text) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: CompletionUsage;
    };
    const rawText = json.choices?.[0]?.message?.content || "";
    return {
      value: rawText,
      rawText,
      latencyMs,
      usage: json.usage,
      model: json.model || getCerebrasModel()
    };
  }

  throw new Error(errors.join(" | ") || "All configured Cerebras API keys failed");
}

export async function callCerebrasJson<T>(messages: ChatMessage[], maxTokens = 1200): Promise<CerebrasResult<T>> {
  const textResult = await callCerebrasText(
    [
      ...messages,
      {
        role: "system",
        content: "Return only valid JSON. Do not wrap it in Markdown fences."
      }
    ],
    maxTokens
  );
  return {
    ...textResult,
    value: parseJsonFromText<T>(textResult.value)
  };
}

export function parseJsonFromText<T>(text: string): T {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty JSON response");
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  const firstBrace = candidate.indexOf("{");
  const firstBracket = candidate.indexOf("[");
  const start =
    firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);
  const jsonText = start > 0 ? candidate.slice(start) : candidate;
  return JSON.parse(jsonText) as T;
}

export function tokensPerSecond(usage: CompletionUsage | undefined, latencyMs: number): number | undefined {
  const outputTokens = usage?.completion_tokens;
  if (!outputTokens || latencyMs <= 0) {
    return undefined;
  }
  return Math.round((outputTokens / (latencyMs / 1000)) * 10) / 10;
}

export function fallbackBrainstorm(): BrainstormResponse {
  return {
    questions: [
      "Which exact workflow should the 60-second demo start from: raw idea, gbrain search, or an existing outline?",
      "What proof artifact best shows Cerebras speed: latency race, parallel agent board, or live slide polish?",
      "Who is the buyer persona: founder, PM lead, enterprise knowledge team, or design/product ops?"
    ],
    sharperAngle:
      "A live deck copilot where multiple Gemma 4 agents race in parallel, turn gbrain context into slide decisions, and push a Figma-ready deck spec in seconds.",
    assumptions: [
      "The demo optimizes for Track 1 and Track 3.",
      "The first version should generate a Figma handoff artifact even when the bridge is disconnected."
    ]
  };
}

export function fallbackAgentFinding(agentId: AgentFinding["agentId"], label: string): AgentFinding {
  return {
    agentId,
    label,
    summary: `${label} fallback: prioritize speed-visible parallel generation, concrete evidence, and a Figma-ready deck artifact.`,
    slideIdeas: [
      {
        title: "Speed as the product surface",
        headline: "Parallel Gemma agents turn context into deck decisions before a human loses flow.",
        visual: "Agent lane race with latency chips and slide cards materializing underneath.",
        evidence: "Cerebras Gemma 4 31B low-latency calls plus per-agent timing in the UI."
      }
    ],
    risks: ["Live Figma mutation needs Desktop Bridge connection."]
  };
}

function getCerebrasKeys(): string[] {
  const keys = [
    process.env.CEREBRAS_API_KEY,
    process.env.CEREBRAS_BACKUP_API_KEY,
    ...(process.env.CEREBRAS_API_KEYS || "").split(",")
  ]
    .map((key) => key?.trim())
    .filter(Boolean) as string[];
  return [...new Set(keys)];
}

function redactSecrets(value: string): string {
  return value.replace(/csk-[A-Za-z0-9]+/g, "csk-REDACTED");
}
