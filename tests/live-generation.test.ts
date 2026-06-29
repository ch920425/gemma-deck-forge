import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasCerebrasKey } from "../src/server/cerebras";
import { generateDeck, polishDeck } from "../src/server/deck";

let dataDir = "";
let previousDataDir: string | undefined;

beforeEach(async () => {
  previousDataDir = process.env.GEMMA_DECK_DATA_DIR;
  dataDir = await mkdtemp(path.join(tmpdir(), "gemma-deck-live-"));
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

describe("live Cerebras deck generation", () => {
  it.runIf(hasCerebrasKey())("runs parallel Gemma agents and polishes the generated deck", async () => {
    const events: string[] = [];
    const deck = await generateDeck(
      {
        idea: "Realtime Cerebras Gemma agents turn gbrain context into Figma Slides.",
        audience: "hackathon judges",
        brainstormNotes: "Show speed as the product interaction.",
        gbrainContext: "Recovered Figma Desktop Bridge workflow and Supabase gbrain schema.",
        slideCount: 3
      },
      (event) => events.push(event)
    );

    expect(deck.slides).toHaveLength(3);
    expect(deck.figmaSpec.slides).toHaveLength(3);
    expect(events).toContain("deck_complete");

    const polished = await polishDeck({
      deck: { ...deck, slides: deck.slides.slice(0, 1), figmaSpec: { ...deck.figmaSpec, slides: deck.figmaSpec.slides.slice(0, 1) } },
      instruction: "Make the opener more concrete for a 60-second demo."
    });
    expect(polished.slides).toHaveLength(1);
    expect(polished.figmaSpec.slides[0].headline).toBe(polished.slides[0].headline);
  }, 120_000);
});
