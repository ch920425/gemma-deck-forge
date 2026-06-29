import type { DeckSpec, FigmaDeckSpec } from "./schema";

export function buildFigmaSpec(deck: Omit<DeckSpec, "figmaSpec">): FigmaDeckSpec {
  return {
    deckTitle: deck.title,
    theme: {
      background: "#F7F4EC",
      ink: "#17211D",
      accent: "#0E7C66",
      secondaryAccent: "#D95D39"
    },
    slides: deck.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      headline: slide.headline,
      layout: slide.layout,
      blocks: [
        { kind: "headline", text: slide.headline },
        { kind: "body", text: slide.body },
        { kind: "bullets", text: slide.bullets.join("\n") },
        { kind: "evidence", text: slide.evidence.join("\n") },
        { kind: "visual", text: slide.visual }
      ],
      notes: slide.speakerNotes
    }))
  };
}

export function buildFigmaHandoffPrompt(deck: DeckSpec): string {
  return [
    "Use the figma-slides-executive-deck workflow.",
    "Open Figma Desktop -> target Slides file -> Plugins -> Development -> Figma Desktop Bridge -> Run, then call figma_get_status with probe:true.",
    "Create the following slides directly in the open Figma Slides file. Match the deck's local visual grammar if existing slides are present. Screenshot and iterate after creation.",
    "",
    "Deck spec JSON:",
    JSON.stringify(deck.figmaSpec, null, 2)
  ].join("\n");
}
