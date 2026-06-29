import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFigmaHandoffPrompt, buildFigmaSpec } from "../src/shared/figma";
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

  it("normalizes a partial slide into a Figma-safe slide spec", () => {
    const slide = normalizeSlide({ title: "A", layout: "metric", bullets: ["one", "two"] }, 2);
    expect(slide.id).toBe("s3");
    expect(slide.layout).toBe("metric");
    expect(slide.visual).toContain("visual");
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

  it("surfaces non-missing feedback store read errors", async () => {
    await mkdir(feedbackPath(), { recursive: true });
    await expect(readFeedbackEntries()).rejects.toThrow();
  });
});
