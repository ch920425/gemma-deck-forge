import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFigmaBuildPlan, buildFigmaHandoffPrompt, buildFigmaSpec } from "../src/shared/figma";
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
      gbrainContext: "",
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
      gbrainContext: "  source proof  ",
      slideCount: 1
    });
    expect(normalized).toMatchObject({
      idea: "Build slides live",
      audience: "impatient judges",
      brainstormNotes: "stronger opener",
      gbrainContext: "source proof",
      slideCount: 3
    });
  });

  it("normalizes a partial slide into a Figma-safe slide spec", () => {
    const slide = normalizeSlide({ title: "A", layout: "metric", bullets: ["one", "two"] }, 2);
    expect(slide.id).toBe("s3");
    expect(slide.layout).toBe("metric");
    expect(slide.visual).toContain("visual");
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
    expect(slide.title).toBe("Slide 2");
    expect(slide.headline).toBe("Make the product value obvious.");
    expect(slide.bullets).toEqual([]);
    expect(slide.evidence).toEqual([]);
    expect(slide.layout).toBe("evidence");
    expect(slide.accent).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("falls back from invalid deck candidates and trims optional arrays", () => {
    const input = normalizeGenerateRequest({
      idea: "Figma burst",
      audience: "judges",
      brainstormNotes: "",
      gbrainContext: "",
      slideCount: 3
    });
    const fallback = normalizeDeck(null, input);
    expect(fallback.title).toBe("Gemma Deck Forge");
    expect(fallback.slides).toHaveLength(3);
    expect(fallback.figmaSpec.slides).toHaveLength(3);

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
    expect(explicit.slides).toHaveLength(3);
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
        gbrainContext: "",
        slideCount: 1
      }
    );
    const plan = buildFigmaBuildPlan(deck);
    expect(plan.target).toBe("figma-design-frames");
    expect(plan.stages).toHaveLength(50);
    expect(plan.stages.slice(0, 5).every((stage) => stage.phase === "build")).toBe(true);
    expect(plan.script).toContain("actionsPerSecond");
    expect(plan.script).toContain("figma.createSection");
    expect(plan.script).toContain("actionDelayMs");
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
