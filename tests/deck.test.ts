import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FIGMA_GENERATION_BATCH_COUNT,
  FIGMA_GENERATION_BATCH_INTERVAL_MS,
  FIGMA_QA_BATCH_COUNT,
  FIGMA_QA_DIAGNOSE_FIX_LOOP_COUNT,
  FIGMA_QA_VLM_SYSTEM_PROMPT,
  buildFigmaBuildPlan,
  buildFigmaGenerationBatchScripts,
  buildFigmaHandoffPrompt,
  buildFigmaQaBatchScripts,
  buildFigmaSpec
} from "../src/shared/figma";
import { normalizeDeck, normalizeGenerateRequest, normalizeSlide } from "../src/server/deck";
import { feedbackPath, readFeedbackEntries, readFeedbackMemory, saveFeedback } from "../src/server/feedbackStore";
import type { GenerateRequest, SlideSpec } from "../src/shared/schema";

let dataDir = "";
let previousDataDir: string | undefined;

beforeEach(async () => {
  previousDataDir = process.env.GEMMA_DECK_DATA_DIR;
  dataDir = await mkdtemp(path.join(tmpdir(), "gemma-deck-forge-"));
  process.env.GEMMA_DECK_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (previousDataDir === undefined) {
    delete process.env.GEMMA_DECK_DATA_DIR;
  } else {
    process.env.GEMMA_DECK_DATA_DIR = previousDataDir;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe("deck normalization", () => {
  it("keeps slide count bounded and fills missing slide fields", () => {
    const input: GenerateRequest = {
      idea: "",
      audience: "",
      brainstormNotes: "",
      sourceContext: "",
      slideCount: 12
    };
    const normalized = normalizeGenerateRequest(input);
    expect(normalized.slideCount).toBe(10);
    expect(normalized.idea).toContain("Gemma 4");

    const deck = normalizeDeck({ title: "X", audience: "Y", thesis: "Z", slides: [] }, normalized);
    expect(deck.slides).toHaveLength(10);
    expect(deck.figmaSpec.slides).toHaveLength(10);
    expect(deck.slides[0].accent).toMatch(/^#/);
  });

  it("bounds short requests and preserves supplied brainstorming fields", () => {
    const normalized = normalizeGenerateRequest({
      idea: "  Build slides live  ",
      audience: "  impatient judges  ",
      brainstormNotes: "  stronger opener  ",
      sourceContext: "  source proof  ",
      slideCount: 1
    });
    expect(normalized).toMatchObject({
      idea: "Build slides live",
      audience: "impatient judges",
      brainstormNotes: "stronger opener",
      sourceContext: "source proof",
      slideCount: 10
    });
  });

  it("normalizes a partial slide into a Figma-safe slide spec", () => {
    const slide = normalizeSlide({ title: "A", layout: "metric", bullets: ["one", "two"] }, 2);
    expect(slide.id).toBe("s3");
    expect(slide.layout).toBe("evidence");
    expect(slide.formatId).toBe("context-map");
    expect(slide.visual).toContain("reference");
  });

  it("sanitizes unsafe slide fields into reliable defaults", () => {
    const slide = normalizeSlide(
      {
        id: "",
        title: "",
        headline: "",
        body: "",
        bullets: "not an array" as unknown as string[],
        evidence: "not an array" as unknown as string[],
        visual: "",
        layout: "unknown" as SlideSpec["layout"],
        accent: "red",
        speakerNotes: ""
      },
      1
    );
    expect(slide.id).toBe("s2");
    expect(slide.title).toBe("Stakes Thesis");
    expect(slide.headline).toContain("Cerebras");
    expect(slide.bullets).toEqual([]);
    expect(slide.evidence).toEqual([]);
    expect(slide.layout).toBe("thesis");
    expect(slide.formatRequirement).toContain("slow batch generation");
    expect(slide.accent).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("falls back from invalid deck candidates and trims optional arrays", () => {
    const input = normalizeGenerateRequest({
      idea: "Figma burst",
      audience: "judges",
      brainstormNotes: "",
      sourceContext: "",
      slideCount: 3
    });
    const fallback = normalizeDeck(null, input);
    expect(fallback.title).toBe("Gemma Deck Forge");
    expect(fallback.slides).toHaveLength(10);
    expect(fallback.figmaSpec.slides).toHaveLength(10);
    expect(new Set(fallback.slides.map((slide) => slide.formatId)).size).toBe(10);

    const explicit = normalizeDeck(
      {
        title: "Custom",
        audience: "Ops",
        thesis: "Fast matters.",
        narrativeArc: ["one", "", "two", "three", "four", "five", "six", "seven"],
        slides: [fallback.slides[0]],
        demoScript: ["a", "", "b", "c", "d", "e", "f", "g", "h"]
      },
      input
    );
    expect(explicit.narrativeArc).toEqual(["one", "two", "three", "four", "five", "six"]);
    expect(explicit.demoScript).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(explicit.slides).toHaveLength(10);
  });
});

describe("figma handoff", () => {
  it("builds a structured Figma spec and reconnect prompt", () => {
    const slide: SlideSpec = {
      id: "s1",
      title: "Title",
      headline: "Headline",
      body: "Body",
      bullets: ["A", "B"],
      evidence: ["Proof"],
      visual: "Visual",
      layout: "opener",
      accent: "#0E7C66",
      speakerNotes: "Talk track"
    };
    const figmaSpec = buildFigmaSpec({
      title: "Deck",
      audience: "Judges",
      thesis: "Thesis",
      narrativeArc: [],
      slides: [slide],
      demoScript: []
    });
    expect(figmaSpec.slides[0].blocks.map((block) => block.kind)).toContain("visual");
    const prompt = buildFigmaHandoffPrompt({
      title: "Deck",
      audience: "Judges",
      thesis: "Thesis",
      narrativeArc: [],
      slides: [slide],
      demoScript: [],
      figmaSpec
    });
    expect(prompt).toContain("Figma Desktop Bridge");
    expect(prompt).toContain("Deck spec JSON");
  });

  it("builds an executable parallel Figma finalizer plan", () => {
    const deck = normalizeDeck(
      {
        title: "Parallel Demo",
        audience: "Judges",
        thesis: "Speed is visible.",
        slides: [
          {
            title: "One",
            headline: "One headline",
            body: "One body",
            bullets: ["Build", "Review", "Polish"],
            evidence: ["Proof"],
            visual: "Visual",
            layout: "demo",
            accent: "#0E7C66",
            speakerNotes: "Notes"
          }
        ]
      },
      {
        idea: "x",
        audience: "y",
        brainstormNotes: "",
        sourceContext: "",
        slideCount: 1
      }
    );
    const plan = buildFigmaBuildPlan(deck);
    expect(plan.target).toBe("figma-design-frames");
    expect(plan.stages).toHaveLength(50);
    expect(plan.stages.slice(0, 5).every((stage) => stage.phase === "build")).toBe(true);
    expect(FIGMA_GENERATION_BATCH_INTERVAL_MS).toBe(1000);
    expect(plan.checklist.join(" ")).toContain("every 1s");
    expect(plan.checklist.join(" ")).toContain("98% outline");
    expect(plan.script).toContain("figma.createSection");
    expect(plan.script).toContain("maxBottom");
    expect(plan.script).toContain("wireframe scaffold");
    expect(plan.script).toContain("referenceCue");
    expect(plan.script).toContain("layoutWarnings");
    expect(plan.script).not.toContain("sleep(");
    expect(() => new Function("(async function() {\n" + plan.script + "\n})()")).not.toThrow();
  });

  it("builds distinct generation and VLM QA batch scripts for repeated bridge calls", () => {
    const deck = normalizeDeck(
      {
        title: "Parallel Demo",
        audience: "Judges",
        thesis: "Speed is visible.",
        slides: [
          {
            title: "One",
            headline: "One headline",
            body: "One body",
            bullets: ["Build", "Review", "Polish"],
            evidence: ["Proof"],
            visual: "Visual",
            layout: "demo",
            accent: "#0E7C66",
            speakerNotes: "Notes"
          }
        ]
      },
      {
        idea: "x",
        audience: "y",
        brainstormNotes: "",
        sourceContext: "",
        slideCount: 1
      }
    );
    const generationScripts = buildFigmaGenerationBatchScripts(deck);
    const qaScripts = buildFigmaQaBatchScripts(deck, { sectionId: "section-1", feedback: "Make the metric slide stronger." });

    expect(generationScripts).toHaveLength(FIGMA_GENERATION_BATCH_COUNT);
    expect(qaScripts).toHaveLength(FIGMA_QA_BATCH_COUNT);
    expect(FIGMA_QA_DIAGNOSE_FIX_LOOP_COUNT).toBe(10);
    expect(FIGMA_QA_VLM_SYSTEM_PROMPT).toContain("screenshotObservations");
    expect(FIGMA_QA_VLM_SYSTEM_PROMPT).toContain("figmaFixes");
    expect(new Set(generationScripts).size).toBe(FIGMA_GENERATION_BATCH_COUNT);
    expect(new Set(qaScripts).size).toBe(FIGMA_QA_BATCH_COUNT);
    expect(generationScripts[0]).toContain("blank frames");
    expect(generationScripts.at(-1)).toContain("ready deck");
    expect(qaScripts[0]).toContain("Gemma VLM");
    expect(qaScripts[0]).toContain("getNodeByIdAsync");
    expect(qaScripts[0]).toContain("screenshotObservations");
    expect(qaScripts[0]).toContain("maxDiagnoseFixLoops");
    expect(qaScripts[0]).toContain("exportAsync");
    expect(qaScripts[0]).toContain("cleanFinalLayout");
    expect(qaScripts[0]).toContain("bytesToBase64");
    expect(qaScripts.join("\n")).toContain("Feedback applied");
    expect(qaScripts.join("\n")).toContain('"sectionId":"section-1"');
    expect(qaScripts.join("\n")).not.toContain("figma.createSection");
    expect(qaScripts.join("\n")).not.toContain('startsWith("Gemma Deck Forge -")');
    expect(generationScripts.every((script) => !script.includes("sleep("))).toBe(true);
    expect(qaScripts.every((script) => !script.includes("sleep("))).toBe(true);
  });
});

describe("feedback memory", () => {
  it("persists feedback and summarizes recent signals for future prompts", async () => {
    await saveFeedback({
      deckTitle: "Demo",
      rating: 5,
      keep: "agent latency board",
      change: "shorter opener",
      notes: "Make proof more concrete"
    });
    const entries = await readFeedbackEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toMatch(/[a-f0-9-]+/);
    const memory = await readFeedbackMemory();
    expect(memory).toContain("agent latency board");
    expect(memory).toContain("shorter opener");
  });

  it("keeps a bounded rolling feedback memory with clamped ratings", async () => {
    for (let index = 0; index < 55; index += 1) {
      await saveFeedback({
        deckTitle: `Demo ${index}`,
        rating: index === 54 ? 99 : 0,
        keep: index >= 50 ? `keep ${index}` : "",
        change: "",
        notes: ""
      });
    }
    const entries = await readFeedbackEntries();
    expect(entries).toHaveLength(50);
    expect(entries[0].deckTitle).toBe("Demo 5");
    expect(entries.at(-1)?.rating).toBe(5);

    const memory = await readFeedbackMemory();
    expect(memory).toContain("Demo 54");
    expect(memory).toContain("keep 54");
    expect(memory).not.toContain("Demo 45");
  });

  it("surfaces non-missing feedback store read errors", async () => {
    await mkdir(feedbackPath(), { recursive: true });
    await expect(readFeedbackEntries()).rejects.toThrow();
  });
});
