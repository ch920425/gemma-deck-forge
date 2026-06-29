import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callCerebrasText,
  fallbackAgentFinding,
  fallbackBrainstorm,
  hasCerebrasKey,
  parseJsonFromText,
  tokensPerSecond
} from "../src/server/cerebras";
import { generateDeck, polishDeck, runOutlineDesignSwarm, summariseOutlinePayload, synthesizeDeck } from "../src/server/deck";
import { runGbrainQuery } from "../src/server/gbrain";
import { runBrainstormSwarm, runContextWritingSwarm } from "../src/server/textSwarms";
import { buildAgentUserPrompt, buildBrainstormPrompt, buildSynthesisPrompt } from "../src/shared/prompts";
import type { AgentFinding, GenerateRequest } from "../src/shared/schema";

let previousPrimary: string | undefined;
let previousBackup: string | undefined;
let previousKeyList: string | undefined;
let previousDataDir: string | undefined;
let previousEvalMs: string | undefined;
let dataDir = "";

const input: GenerateRequest = {
  idea: "Idea to Figma Slides with Gemma on Cerebras",
  audience: "hackathon judges",
  brainstormNotes: "Show parallelism.",
  gbrainContext: "Recovered Figma MCP workflow plus Supabase gbrain evidence.",
  slideCount: 5
};

beforeEach(async () => {
  previousPrimary = process.env.CEREBRAS_API_KEY;
  previousBackup = process.env.CEREBRAS_BACKUP_API_KEY;
  previousKeyList = process.env.CEREBRAS_API_KEYS;
  previousDataDir = process.env.GEMMA_DECK_DATA_DIR;
  previousEvalMs = process.env.GEMMA_OUTLINE_EVAL_MS;
  delete process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_BACKUP_API_KEY;
  delete process.env.CEREBRAS_API_KEYS;
  dataDir = await mkdtemp(path.join(tmpdir(), "gemma-deck-flow-"));
  process.env.GEMMA_DECK_DATA_DIR = dataDir;
});

afterEach(async () => {
  restoreEnv("CEREBRAS_API_KEY", previousPrimary);
  restoreEnv("CEREBRAS_BACKUP_API_KEY", previousBackup);
  restoreEnv("CEREBRAS_API_KEYS", previousKeyList);
  restoreEnv("GEMMA_DECK_DATA_DIR", previousDataDir);
  restoreEnv("GEMMA_OUTLINE_EVAL_MS", previousEvalMs);
  await rm(dataDir, { recursive: true, force: true });
});

describe("Cerebras helpers without configured keys", () => {
  it("reports missing keys without trying a network request", async () => {
    expect(hasCerebrasKey()).toBe(false);
    await expect(callCerebrasText([{ role: "user", content: "hello" }])).rejects.toThrow("CEREBRAS_API_KEY");
  });

  it("parses fenced, prefixed, array, and empty JSON responses deterministically", () => {
    expect(parseJsonFromText<{ ok: boolean }>('```json\n{"ok":true}\n```').ok).toBe(true);
    expect(parseJsonFromText<{ ok: boolean }>('Here is JSON: {"ok":true}').ok).toBe(true);
    expect(parseJsonFromText<Array<{ ok: boolean }>>('[{"ok":true}]')[0].ok).toBe(true);
    expect(() => parseJsonFromText("")).toThrow("Empty JSON response");
  });

  it("computes output speed only when timing and completion tokens exist", () => {
    expect(tokensPerSecond({ completion_tokens: 120 }, 2000)).toBe(60);
    expect(tokensPerSecond(undefined, 2000)).toBeUndefined();
    expect(tokensPerSecond({ completion_tokens: 120 }, 0)).toBeUndefined();
  });

  it("provides deterministic brainstorm and agent fallbacks", () => {
    expect(fallbackBrainstorm().questions).toHaveLength(3);
    const finding = fallbackAgentFinding("critic", "Judge");
    expect(finding.agentId).toBe("critic");
    expect(finding.slideIdeas[0].headline).toContain("Parallel Gemma agents");
  });

  it("returns a redacted provider error for an invalid live credential", async () => {
    process.env.CEREBRAS_API_KEY = "csk-invalidcredentialforredaction";
    await expect(callCerebrasText([{ role: "user", content: "Return ok" }], 5)).rejects.toThrow(/Cerebras API/);
  }, 30_000);
});

describe("fallback generation flow", () => {
  it("runs the context writer swarm with two agentic loops and hidden recipient constraints", async () => {
    const events: string[] = [];
    const audience = "Cerebras x Gemma hackathon judges and enterprise AI buyers";
    const result = await runContextWritingSwarm(
      {
        idea: input.idea,
        context: "## Evidence\n- Cerebras low latency makes agent loops visible.\n- Figma bridge can render ordered slide actions.",
        audience
      },
      (event) => events.push(event)
    );
    expect(result.drafts).toHaveLength(10);
    expect(events.filter((event) => event === "context_writer_workflow_started")).toHaveLength(2);
    expect(events.filter((event) => event === "context_writer_workflow_complete")).toHaveLength(2);
    expect(events.filter((event) => event === "context_writer_agent_started")).toHaveLength(10);
    expect(events.filter((event) => event === "context_writer_agent_complete")).toHaveLength(10);
    expect(events).toContain("context_writer_complete");
    expect(result.finalText).toContain("Finalized Context Brief");
    expect(result.finalText).toContain("Cerebras low latency");
    expect(result.finalText).not.toContain(`Audience: ${audience}`);
  });

  it("runs the brainstorm swarm with three agentic loops and keeps recipient values out of visible brief text", async () => {
    const events: string[] = [];
    const audience = "Cerebras x Gemma hackathon judges and enterprise AI buyers";
    const result = await runBrainstormSwarm(
      {
        idea: input.idea,
        context: input.gbrainContext,
        audience
      },
      (event) => events.push(event)
    );
    expect(result.agentDrafts).toHaveLength(15);
    expect(result.keyMessages).toHaveLength(3);
    expect(result.audience).toBe(audience);
    expect(events.filter((event) => event === "brainstorm_workflow_started")).toHaveLength(3);
    expect(events.filter((event) => event === "brainstorm_workflow_complete")).toHaveLength(3);
    expect(events.filter((event) => event === "brainstorm_agent_started")).toHaveLength(15);
    expect(events.filter((event) => event === "brainstorm_agent_complete")).toHaveLength(15);
    expect(events).toContain("brainstorm_complete");
    expect(result.finalBrief).toContain("Brainstorm Final Brief");
    expect(result.finalBrief).not.toContain(`Audience: ${audience}`);
    expect(result.assumptions.join(" ")).not.toContain(audience);
  });

  it("generates a complete deck through real fallback paths and stream events", async () => {
    const events: string[] = [];
    const deck = await generateDeck(input, (event) => events.push(event));
    expect(deck.slides).toHaveLength(10);
    expect(deck.figmaSpec.slides).toHaveLength(10);
    expect(new Set(deck.slides.map((slide) => slide.formatId)).size).toBe(10);
    expect(events.filter((event) => event === "agent_error")).toHaveLength(5);
    expect(events.filter((event) => event === "agent_started").length).toBeGreaterThanOrEqual(18);
    expect(events.filter((event) => event === "agent_complete").length).toBeGreaterThanOrEqual(13);
    expect(events).toContain("deck_complete");
  });

  it("synthesizes fallback deck from supplied findings when live synthesis is unavailable", async () => {
    const finding: AgentFinding = {
      agentId: "story",
      label: "Story",
      summary: "Summary",
      slideIdeas: [
        {
          title: "Proof",
          headline: "Fast parallel proof",
          visual: "Race",
          evidence: "Timing"
        }
      ],
      risks: []
    };
    const deck = await synthesizeDeck({ ...input, slideCount: 6 }, [finding], "keep speed visible");
    expect(deck.slides).toHaveLength(10);
    expect(JSON.stringify(deck.slides)).toContain("Fast parallel proof");
    expect(deck.thesis).toContain("Cerebras speed");
  });

  it("polishes via fallback while rebuilding the Figma spec", async () => {
    const deck = await generateDeck(input);
    const events: string[] = [];
    const polished = await polishDeck({ deck, instruction: "" }, (event) => events.push(event));
    expect(polished.slides).toHaveLength(deck.slides.length);
    expect(polished.figmaSpec.slides[0].headline).toBe(polished.slides[0].headline);
    expect(events).toContain("polish_error");
    expect(events).toContain("deck_complete");
  });

  it("runs the ten-format outline eval/fix swarm with a configured eval window", async () => {
    process.env.GEMMA_OUTLINE_EVAL_MS = "120";
    const events: Array<{ event: string; payload: unknown }> = [];
    const outlineContext = await runOutlineDesignSwarm(input, [fallbackAgentFinding("story", "Story")], "", (event, payload) =>
      events.push({ event, payload })
    );
    const parsed = JSON.parse(outlineContext) as { fixes: Array<{ formatId: string }> };
    expect(parsed.fixes).toHaveLength(10);
    expect(new Set(parsed.fixes.map((fix) => fix.formatId)).size).toBe(10);
    expect(events.filter((item) => item.event === "agent_complete").length).toBeGreaterThanOrEqual(13);
    expect(outlineContext).toContain("operator-close");
  });

  it("recovers from provider errors during outline categorization without stopping eval/fix", async () => {
    process.env.CEREBRAS_API_KEY = "csk-invalidcredentialforoutlinefallback";
    process.env.GEMMA_OUTLINE_EVAL_MS = "40";
    const outlineContext = await runOutlineDesignSwarm(input, [fallbackAgentFinding("visual", "Visual")], "", () => undefined);
    expect(outlineContext).toContain("Cerebras API");
    expect(outlineContext).toContain("operator-close");
    expect(JSON.parse(outlineContext).fixes).toHaveLength(10);
  }, 30_000);
});

describe("prompt and CLI integration surfaces", () => {
  it("builds prompts that include idea, context, feedback, and schema constraints", () => {
    const agentPrompt = buildAgentUserPrompt(input, "keep latency chips");
    expect(agentPrompt).toContain(input.idea);
    expect(agentPrompt).toContain("keep latency chips");

    const synthesisPrompt = buildSynthesisPrompt(input, JSON.stringify([{ summary: "x" }]), "change opener");
    expect(synthesisPrompt).toContain("Return only valid JSON");
    expect(synthesisPrompt).toContain("change opener");

    const brainstormPrompt = buildBrainstormPrompt(input.idea, input.gbrainContext);
    expect(brainstormPrompt).toContain("high-leverage questions");
    expect(brainstormPrompt).toContain(input.gbrainContext);
  });

  it("runs the Supabase CLI path and returns a structured failure when not linked", async () => {
    const previousWorkdir = process.env.SUPABASE_WORKDIR;
    process.env.SUPABASE_WORKDIR = dataDir;
    const result = await runGbrainQuery("Gemma deck", 1);
    restoreEnv("SUPABASE_WORKDIR", previousWorkdir);
    expect(result.ok).toBe(false);
    expect(result.sql).toContain("public.pages");
    expect(result.error || result.raw).toBeTruthy();
  });

  it("returns a structured failure for an invalid explicit Supabase DB URL", async () => {
    const previousUrl = process.env.SUPABASE_DB_URL;
    process.env.SUPABASE_DB_URL = "postgresql://invalid:invalid@127.0.0.1:1/postgres";
    const result = await runGbrainQuery("Gemma deck", 1);
    restoreEnv("SUPABASE_DB_URL", previousUrl);
    expect(result.ok).toBe(false);
    expect(result.error || result.raw).toBeTruthy();
  }, 30_000);

  it("summarizes outline payloads with a fallback for empty values", () => {
    expect(summariseOutlinePayload(null, "fallback summary")).toBe("fallback summary");
    expect(summariseOutlinePayload({ ok: true, items: ["a", "b"] }, "fallback summary")).toContain('"ok":true');
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
