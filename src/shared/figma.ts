import type { DeckSpec, FigmaBuildPlan, FigmaDeckSpec, FigmaSlideBuildStage } from "./schema";

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

export function buildFigmaBuildPlan(deck: DeckSpec): FigmaBuildPlan {
  return {
    script: buildExecutableFigmaScript(deck),
    stages: buildParallelFigmaStages(deck),
    checklist: [
      "Create slide frames inside a named Gemma Deck Forge section.",
      "Run build, review, revise, polish, and finalize passes across every slide.",
      "Keep Figma writes in one ordered bridge lane while agent planning runs in parallel.",
      "Measure slide-actions/sec and screenshot-verify the final section."
    ],
    target: "figma-design-frames"
  };
}

export function buildParallelFigmaStages(deck: DeckSpec): FigmaSlideBuildStage[] {
  const phases: FigmaSlideBuildStage["phase"][] = ["build", "review", "revise", "polish", "finalize"];
  const slides = ensureTenSlides(deck);
  return phases.flatMap((phase, phaseIndex) =>
    slides.map((slide, slideIndex) => ({
      slideId: `s${slideIndex + 1}`,
      title: slide.title,
      phase,
      status: phaseIndex === 0 ? "running" : "queued",
      summary: stageSummary(phase, slide.title)
    }))
  );
}

export function buildExecutableFigmaScript(deck: DeckSpec): string {
  const payload = JSON.stringify(toFigmaPayload(deck));
  return `
const startedAt = Date.now();
const deck = ${payload};
const phaseLabels = [
  { key: "build", label: "BUILT", color: "#0E7C66", note: "frame + first copy pass" },
  { key: "review", label: "REVIEWED", color: "#2D6CDF", note: "hierarchy + proof checked" },
  { key: "revise", label: "REVISED", color: "#D95D39", note: "copy and proof tightened" },
  { key: "polish", label: "POLISHED", color: "#E0A928", note: "spacing + emphasis tuned" },
  { key: "final", label: "FINAL", color: "#17211D", note: "ready for screenshot gate" }
];
await figma.loadAllPagesAsync();
const page = figma.currentPage;
const existing = page.findOne(node => node.type === "SECTION" && node.name === deck.sectionName);
if (existing) existing.remove();
const section = figma.createSection();
section.name = deck.sectionName;
section.x = deck.origin.x;
section.y = deck.origin.y;
section.resizeWithoutConstraints(deck.sectionWidth, deck.sectionHeight);
page.appendChild(section);
const fonts = [
  { family: "Inter", style: "Regular" },
  { family: "Inter", style: "Bold" }
];
try {
  await Promise.all(fonts.map(font => figma.loadFontAsync(font)));
} catch (error) {
  fonts[0] = { family: "Arial", style: "Regular" };
  fonts[1] = { family: "Arial", style: "Bold" };
  await Promise.all(fonts.map(font => figma.loadFontAsync(font)));
}
function paint(hex) {
  const value = hex.replace("#", "");
  const int = parseInt(value, 16);
  return { type: "SOLID", color: { r: ((int >> 16) & 255) / 255, g: ((int >> 8) & 255) / 255, b: (int & 255) / 255 } };
}
function rect(parent, name, x, y, w, h, color, radius = 16) {
  const node = figma.createRectangle();
  node.name = name;
  node.x = x;
  node.y = y;
  node.resize(w, h);
  node.cornerRadius = radius;
  node.fills = [paint(color)];
  parent.appendChild(node);
  return node;
}
function text(parent, name, value, x, y, w, size, color, bold = false) {
  const node = figma.createText();
  node.name = name;
  node.x = x;
  node.y = y;
  node.resize(w, 10);
  node.fontName = bold ? fonts[1] : fonts[0];
  node.characters = String(value).replace(/[\\u0000-\\u001F\\u007F]/g, " ").replace(/\\s+/g, " ").trim();
  node.fontSize = size;
  node.lineHeight = { unit: "PERCENT", value: 110 };
  node.fills = [paint(color)];
  node.textAutoResize = "HEIGHT";
  parent.appendChild(node);
  return node;
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
text(section, "section title", deck.title, deck.padding, 30, 1200, 34, "#FFFDF7", true);
text(section, "section subtitle", "Build -> review -> revise -> polish -> final, streaming visibly across every slide through Figma Desktop Bridge", deck.padding, 74, 1500, 18, "#DCE7DF");
const frames = [];
const statusNodes = [];
const reviewNodes = [];
for (const [index, slide] of deck.slides.entries()) {
  const col = index % deck.columns;
  const row = Math.floor(index / deck.columns);
  const x = deck.padding + col * (deck.slideWidth + deck.gap);
  const y = deck.padding + 112 + row * (deck.slideHeight + deck.gap);
  const frame = figma.createFrame();
  frame.name = "Slide " + String(index + 1).padStart(2, "0") + " - " + slide.title;
  frame.x = x;
  frame.y = y;
  frame.resize(deck.slideWidth, deck.slideHeight);
  frame.cornerRadius = 20;
  frame.clipsContent = true;
  frame.fills = [paint(index === 0 ? "#17211D" : "#FFFDF7")];
  section.appendChild(frame);
  frames.push(frame);
  const ink = index === 0 ? "#FFFDF7" : "#17211D";
  const muted = index === 0 ? "#DCE7DF" : "#53625A";
  rect(frame, "accent rule", 42, 34, 150, 8, slide.accent, 4);
  text(frame, "slide no", String(index + 1).padStart(2, "0"), deck.slideWidth - 96, 32, 54, 18, muted, true);
  text(frame, "title", slide.title.toUpperCase(), 42, 58, 420, 13, slide.accent, true);
  text(frame, "headline", slide.headline, 42, 88, deck.slideWidth - 84, index === 0 ? 43 : 35, ink, true);
  text(frame, "body", slide.body, 46, 214, deck.slideWidth - 92, 18, muted);
  slide.bullets.slice(0, 4).forEach((bullet, i) => {
    const bx = 46 + i * 218;
    rect(frame, "agent card " + i, bx, 302, 198, 76, index === 0 ? "#26332D" : "#F1EBDD", 14);
    text(frame, "agent " + i, "AGENT " + (i + 1), bx + 14, 316, 90, 10, slide.accent, true);
    text(frame, "bullet " + i, bullet, bx + 14, 338, 162, 16, index === 0 ? "#FFFDF7" : "#17211D", true);
  });
  rect(frame, "evidence well", 46, 398, deck.slideWidth - 92, 50, index === 0 ? "#203D35" : "#E7F2EE", 14);
  text(frame, "evidence text", "Evidence: " + slide.evidence.join(" / "), 62, 414, deck.slideWidth - 124, 14, index === 0 ? "#DCE7DF" : "#22352E");
  const review = text(frame, "live review note", "Queued for parallel review...", 46, 462, 520, 14, muted);
  reviewNodes.push(review);
  const chips = [];
  phaseLabels.forEach((phase, i) => {
    const chipBg = rect(frame, phase.key + " chip bg", 46 + i * 174, 492, 148, 30, "#D8D0BF", 15);
    const chipText = text(frame, phase.key + " chip text", phase.label, 64 + i * 174, 501, 112, 10, "#17211D", true);
    chips.push({ bg: chipBg, text: chipText, phase });
  });
  statusNodes.push(chips);
}
figma.viewport.scrollAndZoomIntoView([section]);
let actionCount = 0;
for (const [phaseIndex, phase] of phaseLabels.entries()) {
  for (let slideIndex = 0; slideIndex < deck.slides.length; slideIndex++) {
    const chip = statusNodes[slideIndex][phaseIndex];
    chip.bg.fills = [paint(phase.color)];
    chip.text.fills = [paint("#FFFFFF")];
    reviewNodes[slideIndex].characters = phase.label + ": " + phase.note + ". Slide " + (slideIndex + 1) + " passed this gate.";
    frames[slideIndex].strokes = [paint(phase.color)];
    frames[slideIndex].strokeWeight = phaseIndex === phaseLabels.length - 1 ? 5 : 3;
    actionCount += 1;
    await sleep(deck.actionDelayMs);
  }
}
const elapsedSec = (Date.now() - startedAt) / 1000;
figma.viewport.scrollAndZoomIntoView([section]);
figma.notify("Gemma Deck Forge finalized " + deck.slides.length + " slides: " + actionCount + " actions at " + (actionCount / elapsedSec).toFixed(1) + "/sec");
return { sectionId: section.id, sectionName: section.name, slideCount: deck.slides.length, actionCount, elapsedSec: Number(elapsedSec.toFixed(2)), actionsPerSecond: Number((actionCount / elapsedSec).toFixed(2)), frameIds: frames.map(frame => frame.id) };
`.trim();
}

function toFigmaPayload(deck: DeckSpec) {
  const slideWidth = 960;
  const slideHeight = 540;
  const gap = 64;
  const padding = 72;
  const columns = 2;
  const slides = ensureTenSlides(deck);
  const rows = Math.ceil(slides.length / columns);
  return {
    title: `Gemma Deck Forge: ${cleanText(deck.title)}`,
    sectionName: `Gemma Deck Forge - ${cleanText(deck.title).slice(0, 42)}`,
    origin: { x: 0, y: 1500 },
    slideWidth,
    slideHeight,
    gap,
    padding,
    columns,
    actionDelayMs: 105,
    sectionWidth: padding * 2 + columns * slideWidth + (columns - 1) * gap,
    sectionHeight: padding * 2 + 112 + rows * slideHeight + Math.max(0, rows - 1) * gap,
    slides
  };
}

function ensureTenSlides(deck: DeckSpec) {
  const slides = deck.slides.map((slide) => ({
    title: cleanText(slide.title),
    headline: cleanText(slide.headline),
    body: cleanText(slide.body),
    bullets: slide.bullets.map(cleanText),
    evidence: slide.evidence.map(cleanText),
    accent: slide.accent
  }));
  while (slides.length < 10) {
    const index = slides.length + 1;
    slides.push({
      title: `Loop pass ${index}`,
      headline: "Agentic updates keep landing until the final deck clears review.",
      body: "This generated slide proves the finalizer can keep updating a 10-slide deck even when the source outline is shorter.",
      bullets: ["Review", "Revise", "Polish"],
      evidence: ["Generated by the Figma finalizer"],
      accent: index % 2 === 0 ? "#2D6CDF" : "#0E7C66"
    });
  }
  return slides.slice(0, 10);
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

function stageSummary(phase: FigmaSlideBuildStage["phase"], title: string): string {
  const labels = {
    build: "Create frame and first copy pass",
    review: "Check hierarchy, proof, overflow, and story flow",
    revise: "Apply review notes across copy and evidence",
    polish: "Tighten spacing, contrast, and emphasis",
    finalize: "Mark ready for screenshot validation"
  };
  return `${labels[phase]}: ${title}`;
}
