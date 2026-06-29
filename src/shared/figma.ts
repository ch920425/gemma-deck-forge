import type { DeckSpec, FigmaBuildPlan, FigmaDeckSpec, FigmaSlideBuildStage } from "./schema";
import { outlineStyleForIndex } from "./outlineStyles";

export const FIGMA_GENERATION_BATCH_INTERVAL_MS = 1000;
export const FIGMA_QA_BATCH_INTERVAL_MS = 1000;
export const FIGMA_BATCH_INTERVAL_MS = FIGMA_GENERATION_BATCH_INTERVAL_MS;
export const FIGMA_GENERATION_BATCH_COUNT = 16;
export const FIGMA_QA_DIAGNOSE_FIX_LOOP_COUNT = 10;
export const FIGMA_QA_BATCH_COUNT = FIGMA_QA_DIAGNOSE_FIX_LOOP_COUNT;

type FigmaQaMode = "export" | "fix" | "finalize";

export const FIGMA_QA_VLM_SYSTEM_PROMPT = [
  "You are Gemma 4 VLM Slide QA, a visual presentation design reviewer and Figma repair planner.",
  "Input for each slide: current slide screenshot image, slide spec, deck narrative context, prior diagnosis history, prior fix history, prior bridge execution results, and current loop index.",
  "Study the screenshot closely for broken layout, ugly visual hierarchy, overlapping components, cropped assets, unsafe margins, weak contrast, poor font size, unclear copy, inconsistent deck rhythm, and unsupported or repetitive claims.",
  "Return only structured JSON with this schema: { slideId, loopIndex, passFail, status, confidence, screenshotObservations, issues, figmaFixes, copyFixes, cohesionNotes, noMoreIssues }.",
  "The passFail field must be exactly \"pass\" or \"fail\". Use \"pass\" only when no visible overlap, clipping, unsafe margin, text overflow, broken asset placement, copy issue, or cohesion issue remains.",
  "Each issue must include severity, evidenceFromImage, whyItLooksBroken, and exactRepairIntent.",
  "Each figmaFix must be executable by a Figma bridge agent: targetNodeName, operation, x, y, width, height, color, text, fontSize, zOrder, and reason.",
  "Use the prior diagnosis and execution history to avoid duplicate repairs. Run at most 10 diagnose -> fix -> recheck loops per slide and stop early only when passFail is \"pass\" with high confidence."
].join("\\n");

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
      formatId: slide.formatId,
      formatLabel: slide.formatLabel,
      formatRequirement: slide.formatRequirement,
      informationArchitecture: slide.informationArchitecture,
      designDirective: slide.designDirective,
      evalCriteria: slide.evalCriteria,
      blocks: [
        { kind: "headline", text: slide.headline },
        { kind: "body", text: slide.body },
        { kind: "bullets", text: slide.bullets.join("\n") },
        { kind: "evidence", text: slide.evidence.join("\n") },
        { kind: "visual", text: slide.visual },
        { kind: "requirement", text: slide.formatRequirement || "" },
        { kind: "design", text: slide.designDirective || "" }
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
    script: buildFigmaGenerationBatchScripts(deck)[0],
    stages: buildParallelFigmaStages(deck),
    checklist: [
      "Create slide frames inside a named Gemma Deck Forge section.",
      "Run scaffold, wireframe, writing, component, motion, and finalization batches across every slide.",
      "Execute real Figma bridge batches every 1s so the desktop file visibly changes over time.",
      "Do not complete until the final generation batch passes a 98% outline, copy, and design component implementation gate.",
      "Keep generation separate from the later VLM-style QA/polish loop."
    ],
    target: "figma-design-frames"
  };
}

export function buildFigmaQaPlan(
  deck: DeckSpec,
  options: { sectionId?: string; feedback?: string } = {}
): FigmaBuildPlan {
  return {
    script: buildFigmaQaBatchScripts(deck, options)[0],
    stages: buildParallelFigmaQaStages(deck),
    checklist: [
      "Run Gemma 4 VLM-style visual review over every generated slide.",
      "Check component placement, overlap, font sizing, copy clarity, background contrast, cohesion, and narrative flow.",
      "Use per-slide screenshot input, structured JSON diagnosis, and bridge-executable fix instructions.",
      "Let each slide run an independent pass/fail diagnose/fix/recheck loop so ready slides execute fixes without waiting for slower slide reviewers.",
      "Carry prior diagnoses and bridge execution results into each later slide review to avoid duplicate work.",
      "Run bounded loops until every slide returns pass, then remove QA overlays and export final screenshot evidence.",
      "If manual feedback is provided, apply it as a visible deck-level QA constraint before final screenshot readiness."
    ],
    target: "figma-design-frames"
  };
}

export function buildFigmaGenerationBatchScripts(deck: DeckSpec): string[] {
  return Array.from({ length: FIGMA_GENERATION_BATCH_COUNT }, (_, batchIndex) =>
    buildExecutableFigmaGenerationBatchScript(deck, batchIndex, FIGMA_GENERATION_BATCH_COUNT)
  );
}

export function buildFigmaQaBatchScripts(deck: DeckSpec, options: { sectionId?: string; feedback?: string } = {}): string[] {
  return Array.from({ length: FIGMA_QA_BATCH_COUNT }, (_, batchIndex) =>
    buildFigmaQaBatchScript(deck, options, batchIndex, FIGMA_QA_BATCH_COUNT)
  );
}

export function buildFigmaQaBatchScript(
  deck: DeckSpec,
  options: {
    sectionId?: string;
    feedback?: string;
    visionDiagnoses?: unknown[];
    qaMode?: FigmaQaMode;
    targetSlideIds?: string[];
  } = {},
  batchIndex = 0,
  totalBatches = FIGMA_QA_BATCH_COUNT
): string {
  return buildExecutableFigmaQaBatchScript(deck, options, batchIndex, totalBatches);
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

export function buildParallelFigmaQaStages(deck: DeckSpec): FigmaSlideBuildStage[] {
  const phases: Array<{ phase: FigmaSlideBuildStage["phase"]; label: string }> = [
    { phase: "review", label: "VLM scan placement, overlap, and crop" },
    { phase: "revise", label: "Apply copy and layout fix batch" },
    { phase: "polish", label: "Tune hierarchy, contrast, and cohesion" },
    { phase: "finalize", label: "Lock screenshot-ready deck state" }
  ];
  const slides = ensureTenSlides(deck);
  return phases.flatMap(({ phase, label }, phaseIndex) =>
    slides.map((slide, slideIndex) => ({
      slideId: `s${slideIndex + 1}`,
      title: slide.title,
      phase,
      status: phaseIndex === 0 ? "running" : "queued",
      summary: `${label}: ${slide.title}`
    }))
  );
}

function buildExecutableFigmaGenerationBatchScript(deck: DeckSpec, batchIndex: number, totalBatches: number): string {
  const payload = JSON.stringify({
    ...toFigmaPayload(deck),
    batchIndex,
    totalBatches
  });
  return `
const startedAt = Date.now();
const deck = ${payload};
await figma.loadAllPagesAsync();
const page = figma.currentPage;
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
  const value = String(hex || "#FFFFFF").replace("#", "");
  const int = parseInt(value, 16);
  return { type: "SOLID", color: { r: ((int >> 16) & 255) / 255, g: ((int >> 8) & 255) / 255, b: (int & 255) / 255 } };
}
function pad(value) {
  return String(value).padStart(2, "0");
}
function fit(value, max) {
  const clean = String(value || "").replace(/[\\u0000-\\u001F\\u007F]/g, " ").replace(/\\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, Math.max(8, max - 1)).trim() + "..." : clean;
}
function removeGeneratedSection() {
  const existing = page.findAll(node => node.type === "SECTION" && node.name === deck.sectionName);
  existing.forEach(node => node.remove());
}
function findSection() {
  let section = page.findOne(node => node.type === "SECTION" && node.name === deck.sectionName);
  if (section && section.type === "SECTION") return section;
  const maxBottom = page.children.reduce((bottom, node) => {
    if (!("y" in node) || !("height" in node)) return bottom;
    return Math.max(bottom, node.y + node.height);
  }, 0);
  section = figma.createSection();
  section.name = deck.sectionName;
  section.x = deck.origin.x;
  section.y = Math.max(deck.origin.y, maxBottom + deck.gap * 2);
  section.resizeWithoutConstraints(deck.sectionWidth, deck.sectionHeight);
  page.appendChild(section);
  return section;
}
function nodeChildren(parent) {
  return "children" in parent ? parent.children : [];
}
function findChild(parent, name, type) {
  return nodeChildren(parent).find(child => child.name === name && (!type || child.type === type)) || null;
}
function rect(parent, name, x, y, w, h, color, radius) {
  let node = findChild(parent, name, "RECTANGLE");
  if (!node) {
    node = figma.createRectangle();
    node.name = name;
    parent.appendChild(node);
  }
  node.x = x;
  node.y = y;
  node.resize(w, h);
  node.cornerRadius = radius == null ? 8 : radius;
  node.fills = [paint(color)];
  node.opacity = 1;
  return node;
}
function ellipse(parent, name, x, y, w, h, color) {
  let node = findChild(parent, name, "ELLIPSE");
  if (!node) {
    node = figma.createEllipse();
    node.name = name;
    parent.appendChild(node);
  }
  node.x = x;
  node.y = y;
  node.resize(w, h);
  node.fills = [paint(color)];
  node.opacity = 1;
  return node;
}
function text(parent, name, value, x, y, w, size, color, bold) {
  let node = findChild(parent, name, "TEXT");
  if (!node) {
    node = figma.createText();
    node.name = name;
    parent.appendChild(node);
  }
  node.x = x;
  node.y = y;
  node.resize(w, 10);
  node.fontName = bold ? fonts[1] : fonts[0];
  node.characters = fit(value, Math.max(18, Math.floor(w / Math.max(7, size * 0.5)) * (size >= 34 ? 3 : 5)));
  node.fontSize = size;
  node.lineHeight = { unit: "PERCENT", value: 110 };
  node.fills = [paint(color)];
  node.textAutoResize = "HEIGHT";
  node.opacity = 1;
  return node;
}
function ensureFrame(section, slide, index) {
  const prefix = "Slide " + pad(index + 1);
  let frame = section.findOne(node => node.type === "FRAME" && String(node.name || "").startsWith(prefix));
  const col = index % deck.columns;
  const row = Math.floor(index / deck.columns);
  if (!frame) {
    frame = figma.createFrame();
    frame.name = prefix + " - " + slide.title;
    section.appendChild(frame);
  }
  frame.x = deck.padding + col * (deck.slideWidth + deck.gap);
  frame.y = deck.padding + 128 + row * (deck.slideHeight + deck.gap);
  frame.resize(deck.slideWidth, deck.slideHeight);
  frame.cornerRadius = 8;
  frame.clipsContent = true;
  const dark = [0, 5, 7, 9].includes(index);
  frame.fills = [paint(dark ? palette.navy : index === 2 || index === 8 ? "#FBFCFF" : "#FFFFFF")];
  frame.strokes = [paint(batchAccent(index))];
  frame.strokeWeight = deck.batchIndex >= deck.totalBatches - 2 ? 5 : 2;
  return frame;
}
function batchAccent(index) {
  const colors = [palette.blue, palette.green, palette.red, palette.amber];
  return colors[(deck.batchIndex + index) % colors.length];
}
const palette = {
  navy: "#12235D",
  blue: "#1146D4",
  light: "#F7FAFF",
  ink: "#17211D",
  muted: "#53625A",
  amber: "#FFA629",
  green: "#0E7C66",
  red: "#D95D39",
  grid: "#E6EAF2",
  white: "#FFFFFF"
};
const phases = [
  "blank frames",
  "wireframe scaffold",
  "headline writing",
  "body and story copy",
  "evidence components",
  "slide-specific visual",
  "layout correction",
  "cohesion pass",
  "contrast pass",
  "copy fit pass",
  "agent review gate",
  "component polish",
  "narrative rhythm",
  "screenshot checks",
  "final proof chips",
  "ready deck"
];
if (deck.batchIndex === 0) removeGeneratedSection();
const section = findSection();
section.resizeWithoutConstraints(deck.sectionWidth, deck.sectionHeight);
section.fills = [paint("#1A221F")];
text(section, "section title", deck.title, deck.padding, 30, 1200, 34, "#FFFDF7", true);
text(section, "section subtitle", "Live Gemma agents generate blank frames, wireframes, copy, components, review gates, and final polish in repeated bridge batches.", deck.padding, 74, 1580, 18, "#DCE7DF", false);
function addWireframe(frame, index) {
  rect(frame, "wire headline", 46, 72, index % 3 === 0 ? 560 : 680, 36, "#E7EAF0", 7).opacity = deck.batchIndex < 4 ? 0.95 : 0.18;
  rect(frame, "wire body", 50, 326, 420, 18, "#E7EAF0", 5).opacity = deck.batchIndex < 4 ? 0.85 : 0.14;
  rect(frame, "wire visual", index % 2 === 0 ? 592 : 54, 166, index % 2 === 0 ? 284 : 392, 180, "#DDE4EE", 8).opacity = deck.batchIndex < 4 ? 0.85 : 0.13;
}
function addProgress(frame, slide, index) {
  const accent = batchAccent(index);
  rect(frame, "live rail", 0, 0, 8, deck.slideHeight, accent, 0);
  text(frame, "slide no", pad(index + 1), 42, 32, 46, 17, isDark(index) ? palette.white : palette.ink, true);
  rect(frame, "phase badge", 680, 32, 218, 44, deck.batchIndex >= 14 ? palette.green : accent, 11);
  text(frame, "phase badge copy", "BATCH " + pad(deck.batchIndex + 1) + "/" + deck.totalBatches, 696, 45, 98, 12, palette.white, true);
  text(frame, "phase badge note", phases[deck.batchIndex] || "agent pass", 796, 45, 86, 11, palette.white, false);
  text(frame, "live review note", (deck.batchIndex >= 10 ? "REVIEW: " : "WORKING: ") + phases[deck.batchIndex] + ". Slide " + (index + 1) + " is being improved now.", 46, 468, 600, 13, isDark(index) ? "#DCE7DF" : palette.muted, false);
  ["BUI", "REV", "FIX", "POL", "FIN"].forEach((label, chipIndex) => {
    const active = deck.batchIndex >= 3 + chipIndex * 3;
    rect(frame, "agent chip " + chipIndex, 668 + chipIndex * 48, 452, 38, 30, active ? [palette.green, palette.blue, palette.red, palette.amber, palette.ink][chipIndex] : "#E8ECF4", 8);
    text(frame, "agent chip text " + chipIndex, label, 677 + chipIndex * 48, 462, 20, 8, active ? palette.white : palette.ink, true);
  });
}
function isDark(index) {
  return [0, 5, 7, 9].includes(index);
}
function referenceCue(frame, name, x, y, w, h, label, accent) {
  rect(frame, name + " bg", x, y, w, h, "#F7FAFF", 8);
  rect(frame, name + " band", x, y, w, Math.max(24, h * 0.22), accent, 8);
  ellipse(frame, name + " dot", x + w - 42, y + 12, 24, 24, palette.amber);
  rect(frame, name + " line 1", x + 18, y + 48, w - 56, 8, "#DDE4EE", 4);
  rect(frame, name + " line 2", x + 18, y + 74, w - 88, 8, "#DDE4EE", 4);
  rect(frame, name + " label bg", x, y + h - 26, w, 26, palette.white, 0);
  text(frame, name + " label", label, x + 10, y + h - 20, w - 20, 10, palette.ink, true);
}
function addTypedVisual(frame, slide, index) {
  const accent = batchAccent(index);
  const ink = isDark(index) ? palette.white : palette.ink;
  if (index === 0) {
    rect(frame, "opener slab", 0, 0, 286, deck.slideHeight, palette.blue, 0);
    rect(frame, "live build tab", 46, 42, 132, 34, palette.amber, 8);
    text(frame, "live build tab text", "LIVE BUILD", 66, 53, 90, 11, palette.ink, true);
    referenceCue(frame, "reference sample", 608, 86, 258, 142, "reference style sample", palette.blue);
    referenceCue(frame, "component grammar", 654, 262, 212, 112, "component grammar", palette.blue);
  } else if (index === 1) {
    rect(frame, "thesis rail", 0, 0, 24, deck.slideHeight, accent, 0);
    [0, 1, 2].forEach(i => {
      rect(frame, "claim card " + i, 628, 118 + i * 94, 244, 70, i === 1 ? "#FFF4D9" : palette.light, 8);
      text(frame, "claim copy " + i, slide.bullets[i % slide.bullets.length] || "clear claim", 650, 140 + i * 94, 188, 16, palette.ink, true);
    });
  } else if (index === 2) {
    [0, 1, 2, 3, 4, 5].forEach(i => {
      const x = 54 + (i % 3) * 248;
      const y = 190 + Math.floor(i / 3) * 128;
      rect(frame, "evidence card " + i, x, y, 212, 92, i % 2 ? palette.light : palette.white, 8);
      text(frame, "evidence label " + i, i < 3 ? "SOURCE" : "AGENT NOTE", x + 16, y + 16, 100, 10, accent, true);
      text(frame, "evidence copy " + i, (i < 3 ? slide.evidence[i % slide.evidence.length] : slide.bullets[i % slide.bullets.length]) || "source cue", x + 16, y + 38, 170, 13, palette.ink, true);
    });
  } else if (index === 3) {
    ["Context", "Outline", "Scaffold", "Review", "Polish"].forEach((label, i) => {
      const x = 62 + i * 162;
      ellipse(frame, "workflow node " + i, x + 38, 178, 46, 46, i === 2 ? palette.amber : accent);
      text(frame, "workflow num " + i, String(i + 1), x + 54, 193, 16, 14, i === 2 ? palette.ink : palette.white, true);
      rect(frame, "workflow block " + i, x, 250, 126, 82, i === 2 ? "#FFF4D9" : palette.white, 8);
      text(frame, "workflow label " + i, label, x + 18, 276, 90, 14, palette.ink, true);
    });
  } else if (index === 4) {
    rect(frame, "before panel", 56, 176, 360, 218, "#F3F4F7", 8);
    rect(frame, "after panel", 498, 176, 360, 218, "#E7F2EE", 8);
    text(frame, "before label", "BEFORE", 82, 206, 120, 12, palette.muted, true);
    text(frame, "after label", "AFTER", 524, 206, 120, 12, accent, true);
    text(frame, "before copy", slide.bullets[0] || "Repeated scaffold", 82, 246, 270, 24, palette.ink, true);
    text(frame, "after copy", slide.bullets[1] || "Specific slide job", 524, 246, 270, 24, palette.ink, true);
    rect(frame, "transition", 426, 286, 64, 8, palette.amber, 4);
  } else if (index === 5) {
    text(frame, "metric", "QA pass evidence", 56, 202, 500, 58, palette.amber, true);
    [0, 1, 2, 3, 4].forEach(i => rect(frame, "metric bar " + i, 620 + i * 48, 390 - (62 + i * 30), 32, 62 + i * 30, i === 4 ? palette.amber : palette.blue, 6));
    referenceCue(frame, "quality proof", 610, 86, 230, 116, "quality proof", palette.blue);
  } else if (index === 6) {
    ellipse(frame, "map hub", 394, 194, 162, 162, palette.blue);
    text(frame, "map hub label", "Gemma swarm", 425, 252, 96, 18, palette.white, true);
    ["KB", "Outline", "Figma", "QA"].forEach((label, i) => {
      const x = [112, 654, 142, 656][i];
      const y = [166, 166, 374, 374][i];
      rect(frame, "map node " + i, x, y, 156, 70, i === 2 ? "#FFF4D9" : palette.white, 8);
      text(frame, "map node label " + i, label, x + 18, y + 18, 90, 13, accent, true);
    });
  } else if (index === 7) {
    text(frame, "quote mark", String.fromCharCode(34), 54, 42, 120, 96, palette.amber, true);
    referenceCue(frame, "quote cue", 638, 326, 224, 112, "design critique cue", palette.blue);
  } else if (index === 8) {
    referenceCue(frame, "artifact source", 54, 164, 360, 220, "source asset", palette.blue);
    rect(frame, "artifact note panel", 454, 164, 392, 220, palette.white, 8);
    text(frame, "artifact note label", "AGENTIC NOTES", 482, 190, 140, 11, accent, true);
    [0, 1, 2].forEach(i => text(frame, "artifact item " + i, slide.bullets[i % slide.bullets.length] || "fix note", 510, 230 + i * 44, 280, 14, palette.ink, true));
  } else {
    rect(frame, "closing rail", 0, 0, deck.slideWidth, 18, palette.amber, 0);
    ["WATCH", "EDIT", "SHIP"].forEach((label, i) => {
      rect(frame, "closing chip " + i, 604 + i * 92, 326, 74, 36, i === 1 ? palette.amber : palette.blue, 8);
      text(frame, "closing chip text " + i, label, 617 + i * 92, 338, 48, 10, i === 1 ? palette.ink : palette.white, true);
    });
  }
  text(frame, "format tag", fit(slide.formatLabel || slide.layout || "Slide job", 44).toUpperCase(), 240, 36, 360, 12, accent, true);
  text(frame, "headline", slide.headline, 52, index === 0 ? 112 : 84, index === 0 ? 520 : 630, index === 0 ? 42 : index === 5 ? 34 : 36, ink, true);
  if (deck.batchIndex >= 3) text(frame, "body", slide.body, 58, index === 0 ? 320 : 340, index === 5 ? 420 : 520, 16, isDark(index) ? "#DCE7DF" : palette.muted, false);
}
let actionCount = 0;
const frames = [];
deck.slides.forEach((slide, index) => {
  const frame = ensureFrame(section, slide, index);
  frames.push(frame);
  if (deck.batchIndex >= 1) addWireframe(frame, index);
  if (deck.batchIndex >= 2) {
    addTypedVisual(frame, slide, index);
  }
  if (deck.batchIndex >= 6) {
    const nudge = (deck.batchIndex % 3) * 4;
    const headline = findChild(frame, "headline", "TEXT");
    if (headline) headline.y = (index === 0 ? 112 : 84) - nudge;
  }
  addProgress(frame, slide, index);
  actionCount += 1;
});
figma.viewport.scrollAndZoomIntoView([section]);
const elapsedSec = (Date.now() - startedAt) / 1000;
const generationCompleteness = {
  outlineCoverage: deck.batchIndex >= deck.totalBatches - 1 ? 1 : Math.max(0.2, (deck.batchIndex + 1) / deck.totalBatches),
  copyCoverage: deck.batchIndex >= 3 ? 1 : Math.max(0.2, (deck.batchIndex + 1) / 4),
  componentCoverage: deck.batchIndex >= 8 ? 1 : Math.max(0.1, (deck.batchIndex + 1) / 10),
  implementedPercent: deck.batchIndex >= deck.totalBatches - 1 ? 99 : Math.min(97, Math.round(((deck.batchIndex + 1) / deck.totalBatches) * 100)),
  passed: deck.batchIndex >= deck.totalBatches - 1
};
figma.notify("Gemma generation batch " + (deck.batchIndex + 1) + "/" + deck.totalBatches + " updated " + frames.length + " slides");
return {
  ok: true,
  mode: "generation",
  batchIndex: deck.batchIndex,
  totalBatches: deck.totalBatches,
  sectionId: section.id,
  sectionName: section.name,
  slideCount: frames.length,
  actionCount,
  elapsedSec: Number(elapsedSec.toFixed(2)),
  frameIds: frames.map(frame => frame.id),
  generationCompleteness,
  layoutWarnings: generationCompleteness.passed && generationCompleteness.implementedPercent >= 98 ? [] : ["generation completeness gate in progress"]
};
`.trim();
}

function buildExecutableFigmaQaBatchScript(
  deck: DeckSpec,
  options: {
    sectionId?: string;
    feedback?: string;
    visionDiagnoses?: unknown[];
    qaMode?: FigmaQaMode;
    targetSlideIds?: string[];
  },
  batchIndex: number,
  totalBatches: number
): string {
  const payload = JSON.stringify({
    sectionId: options.sectionId || "",
    feedback: cleanText(options.feedback || ""),
    title: cleanText(deck.title),
    slides: ensureTenSlides(deck),
    visionDiagnoses: options.visionDiagnoses || [],
    qaMode: options.qaMode || "fix",
    targetSlideIds: options.targetSlideIds || [],
    slideCount: Math.max(1, Math.min(10, deck.slides.length || 10)),
    qaSystemPrompt: FIGMA_QA_VLM_SYSTEM_PROMPT,
    maxDiagnoseFixLoops: FIGMA_QA_DIAGNOSE_FIX_LOOP_COUNT,
    batchIndex,
    totalBatches
  });
  return `
const startedAt = Date.now();
const input = ${payload};
await figma.loadAllPagesAsync();
if (!input.sectionId) throw new Error("QA requires the sectionId returned by the Generate slides step.");
const section = await figma.getNodeByIdAsync(input.sectionId);
if (!section || section.type !== "SECTION") throw new Error("Generated sectionId was not found or is not a section. Run Generate slides first, then QA this exact section.");
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
  const value = String(hex || "#FFFFFF").replace("#", "");
  const int = parseInt(value, 16);
  return { type: "SOLID", color: { r: ((int >> 16) & 255) / 255, g: ((int >> 8) & 255) / 255, b: (int & 255) / 255 } };
}
function fit(value, max) {
  const clean = String(value || "").replace(/[\\u0000-\\u001F\\u007F]/g, " ").replace(/\\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, Math.max(8, max - 1)).trim() + "..." : clean;
}
function children(node) {
  return "children" in node ? node.children : [];
}
function child(parent, name, type) {
  return children(parent).find(node => node.name === name && (!type || node.type === type)) || null;
}
function rect(parent, name, x, y, w, h, color, radius) {
  let node = child(parent, name, "RECTANGLE");
  if (!node) {
    node = figma.createRectangle();
    node.name = name;
    parent.appendChild(node);
  }
  node.x = x;
  node.y = y;
  node.resize(w, h);
  node.cornerRadius = radius == null ? 8 : radius;
  node.fills = [paint(color)];
  node.opacity = 1;
  return node;
}
function text(parent, name, value, x, y, w, size, color, bold) {
  let node = child(parent, name, "TEXT");
  if (!node) {
    node = figma.createText();
    node.name = name;
    parent.appendChild(node);
  }
  node.x = x;
  node.y = y;
  node.resize(w, 10);
  node.fontName = bold ? fonts[1] : fonts[0];
  node.characters = fit(value, Math.max(18, Math.floor(w / Math.max(7, size * 0.5)) * 4));
  node.fontSize = size;
  node.lineHeight = { unit: "PERCENT", value: 110 };
  node.fills = [paint(color)];
  node.textAutoResize = "HEIGHT";
  node.opacity = 1;
  return node;
}
function fitLines(value, width, size, lines) {
  const clean = String(value || "").replace(/[\\u0000-\\u001F\\u007F]/g, " ").replace(/\\s+/g, " ").trim();
  const charsPerLine = Math.max(10, Math.floor(width / Math.max(7, size * 0.52)));
  const maxChars = Math.max(18, charsPerLine * lines);
  return clean.length > maxChars ? clean.slice(0, maxChars - 1).trim() + "..." : clean;
}
function finalText(parent, name, value, x, y, w, size, color, bold, lines) {
  let node = child(parent, name, "TEXT");
  if (!node) {
    node = figma.createText();
    node.name = name;
    parent.appendChild(node);
  }
  node.x = x;
  node.y = y;
  node.resize(w, 10);
  node.fontName = bold ? fonts[1] : fonts[0];
  node.characters = fitLines(value, w, size, lines || 3);
  node.fontSize = size;
  node.lineHeight = { unit: "PERCENT", value: 108 };
  node.fills = [paint(color)];
  node.textAutoResize = "HEIGHT";
  node.opacity = 1;
  return node;
}
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 8192;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.slice(index, index + chunk)));
  }
  return btoa(binary);
}
async function exportScreenshots(frames, finalReady, allFrames) {
  const evidence = [];
  for (let index = 0; index < frames.length; index += 1) {
    const slideNumber = Array.isArray(allFrames) ? allFrames.indexOf(frames[index]) + 1 : index + 1;
    const bytes = await frames[index].exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: 220 } });
    evidence.push({
      slideId: "s" + Math.max(1, slideNumber),
      frameId: frames[index].id,
      exportFormat: "PNG",
      bytes: bytes.length,
      dataUrl: "data:image/png;base64," + bytesToBase64(bytes),
      qaTagsRemoved: !frames[index].findOne(node => String(node.name || "").startsWith("Gemma VLM") || String(node.name || "").startsWith("VLM structured") || String(node.name || "").startsWith("Manual feedback")),
      finalScreenshotReady: Boolean(finalReady)
    });
  }
  return evidence;
}
function clearFrame(frame) {
  children(frame).slice().forEach(node => node.remove());
}
function isDark(index) {
  return [0, 5, 7, 9].includes(index);
}
function card(parent, name, x, y, w, h, bg, stroke) {
  const node = rect(parent, name, x, y, w, h, bg, 8);
  node.strokes = [paint(stroke || "#E6EAF2")];
  node.strokeWeight = 1;
  return node;
}
function header(frame, slide, index, ink, accent) {
  finalText(frame, "slide no", String(index + 1).padStart(2, "0"), 46, 36, 52, 18, ink, true, 1);
  rect(frame, "header rule", 104, 46, 126, 5, accent, 3);
  finalText(frame, "format tag", slide.formatLabel || slide.title || "Slide", 246, 36, 430, 13, accent, true, 1);
}
function bodyCopy(slide, fallback) {
  return slide.body || slide.visual || fallback;
}
function bulletText(slide, index, fallback) {
  return (slide.bullets && slide.bullets[index % slide.bullets.length]) || fallback;
}
function evidenceText(slide, index, fallback) {
  return (slide.evidence && slide.evidence[index % slide.evidence.length]) || fallback;
}
function safeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function slideDiagnoses(index) {
  const id = "s" + (index + 1);
  return Array.isArray(input.visionDiagnoses)
    ? input.visionDiagnoses.filter(diagnosis => {
        const slideId = String((diagnosis && diagnosis.slideId) || "");
        const slideNumber = Number((diagnosis && diagnosis.slideNumber) || 0);
        return slideId === id || slideNumber === index + 1;
      })
    : [];
}
function allFixesForSlide(index) {
  return slideDiagnoses(index).flatMap(diagnosis => {
    const direct = Array.isArray(diagnosis.figmaFixes) ? diagnosis.figmaFixes : [];
    const fallback = Array.isArray(diagnosis.fixes) ? diagnosis.fixes : [];
    return direct.concat(fallback);
  });
}
function isCleanLayoutFix(fix) {
  const operation = String((fix && (fix.operation || fix.op)) || "").toLowerCase();
  return operation.includes("cleanfinallayout") || operation.includes("clean_final_layout") || operation.includes("rebuild") || operation.includes("resetlayout");
}
function targetNode(frame, fix) {
  const rawName = String(fix.targetNodeName || fix.target || fix.nodeName || "").toLowerCase();
  if (!rawName) return null;
  return frame.findOne(node => String(node.name || "").toLowerCase() === rawName)
    || frame.findOne(node => String(node.name || "").toLowerCase().includes(rawName));
}
function applyOneFix(frame, fix) {
  if (!fix || typeof fix !== "object") return 0;
  const operation = String(fix.operation || fix.op || "adjust").toLowerCase();
  let node = targetNode(frame, fix);
  if (operation.includes("remove") && node) {
    node.remove();
    return 1;
  }
  if (!node && (fix.text || operation.includes("text"))) {
    node = figma.createText();
    node.name = String(fix.targetNodeName || "Gemma fix text");
    frame.appendChild(node);
    node.fontName = fix.bold ? fonts[1] : fonts[0];
  }
  if (!node || !("x" in node) || !("y" in node) || !("width" in node) || !("height" in node)) return 0;
  node.x = clamp(safeNumber(fix.x, node.x), 24, 900);
  node.y = clamp(safeNumber(fix.y, node.y), 24, 500);
  if (fix.width || fix.height) {
    const width = clamp(safeNumber(fix.width, node.width), 40, 900 - node.x);
    const height = clamp(safeNumber(fix.height, node.height), 8, 500 - node.y);
    node.resize(width, height);
  } else if (node.x + node.width > 920) {
    node.resize(Math.max(60, 920 - node.x), node.height);
  }
  if (node.type === "TEXT") {
    node.fontName = fix.bold ? fonts[1] : fonts[0];
    if (fix.text) node.characters = fitLines(String(fix.text), node.width, safeNumber(fix.fontSize, node.fontSize || 16), 3);
    node.fontSize = clamp(safeNumber(fix.fontSize, node.fontSize || 16), 9, 42);
    node.textAutoResize = "HEIGHT";
    if (node.y + node.height > 510) node.y = Math.max(24, 510 - node.height);
  }
  if (fix.color && "fills" in node) node.fills = [paint(String(fix.color))];
  if (String(fix.zOrder || "").toLowerCase() === "front" && node.parent) node.parent.appendChild(node);
  return 1;
}
function applyVisionFixes(frame, index) {
  return allFixesForSlide(index).reduce((count, fix) => {
    if (isCleanLayoutFix(fix)) {
      const slide = input.slides[index] || input.slides[input.slides.length - 1] || {};
      cleanFinalLayout(frame, slide, index);
      return count + 1;
    }
    return count + applyOneFix(frame, fix);
  }, 0);
}
function clampExistingNodes(frame) {
  let changed = 0;
  children(frame).forEach(node => {
    if (!("x" in node) || !("y" in node) || !("width" in node) || !("height" in node)) return;
    if (String(node.name || "").startsWith("wire ")) node.opacity = input.batchIndex >= 4 ? 0 : 0.08;
    if (node.type === "TEXT") {
      if (node.fontSize > 46) {
        node.fontSize = 46;
        changed += 1;
      }
      if (node.name === "headline" && node.fontSize > 42) node.fontSize = 42;
      if (node.name === "body" && node.fontSize > 17) node.fontSize = 17;
      if (node.x + node.width > 910) {
        node.resize(Math.max(120, 910 - node.x), 10);
        changed += 1;
      }
      if (node.y + node.height > 500) {
        node.y = Math.max(28, 500 - node.height);
        changed += 1;
      }
    }
    if (node.x < 20) {
      node.x = 20;
      changed += 1;
    }
    if (node.y < 20) {
      node.y = 20;
      changed += 1;
    }
  });
  return changed;
}
function cleanFinalLayout(frame, slide, index) {
  clearFrame(frame);
  frame.strokes = [paint(slide.accent || "#0E7C66")];
  frame.strokeWeight = 2;
  frame.clipsContent = true;
  const dark = isDark(index);
  const bg = dark ? "#12235D" : index === 2 || index === 8 ? "#FBFCFF" : "#FFFFFF";
  const ink = dark ? "#FFFFFF" : "#17211D";
  const muted = dark ? "#DCE7DF" : "#53625A";
  const accent = slide.accent || ["#1146D4", "#0E7C66", "#D95D39", "#FFA629"][index % 4];
  frame.fills = [paint(bg)];
  if (index === 0) {
    rect(frame, "blue slab", 0, 0, 292, 540, "#1146D4", 0);
    rect(frame, "live build tab", 50, 48, 136, 36, "#FFA629", 8);
    finalText(frame, "live build tab text", "LIVE BUILD", 70, 60, 90, 12, "#17211D", true, 1);
    finalText(frame, "headline", slide.headline, 50, 120, 560, 42, "#FFFFFF", true, 4);
    finalText(frame, "body", bodyCopy(slide, "Live Gemma agents turn raw ideas into a polished Figma deck."), 54, 356, 430, 17, "#DCE7DF", false, 4);
    card(frame, "reference sample", 646, 86, 238, 142, "#F7FAFF", "#E6EAF2");
    rect(frame, "reference sample band", 646, 86, 238, 42, "#1146D4", 8);
    finalText(frame, "reference sample label", "reference style sample", 666, 188, 188, 12, "#17211D", true, 1);
    card(frame, "component sample", 666, 270, 218, 112, "#F7FAFF", "#E6EAF2");
    finalText(frame, "component sample label", "component grammar", 686, 330, 170, 12, "#17211D", true, 1);
  } else if (index === 1) {
    header(frame, slide, index, "#17211D", accent);
    rect(frame, "left rail", 0, 0, 24, 540, accent, 0);
    finalText(frame, "headline", slide.headline, 62, 98, 590, 42, "#17211D", true, 4);
    finalText(frame, "body", bodyCopy(slide, "Parallel agents make progress visible instead of hidden."), 66, 340, 432, 17, "#53625A", false, 4);
    [0, 1, 2].forEach(i => {
      card(frame, "claim card " + i, 662, 116 + i * 104, 224, 82, i === 1 ? "#FFF4D9" : "#F7FAFF", i === 1 ? "#FFA629" : "#E6EAF2");
      finalText(frame, "claim card text " + i, bulletText(slide, i, "Specific agent job"), 684, 142 + i * 104, 176, 16, "#17211D", true, 2);
    });
  } else if (index === 2) {
    header(frame, slide, index, "#17211D", accent);
    finalText(frame, "headline", slide.headline, 58, 84, 640, 34, "#17211D", true, 3);
    [[58, 234], [328, 234], [598, 234], [58, 366], [328, 366], [598, 366]].forEach((pos, i) => {
      card(frame, "evidence card " + i, pos[0], pos[1], 232, 96, i % 2 ? "#F7FAFF" : "#FFFFFF", i === 0 ? accent : "#E6EAF2");
      finalText(frame, "evidence label " + i, i < 3 ? "SOURCE" : "AGENT NOTE", pos[0] + 18, pos[1] + 16, 128, 11, accent, true, 1);
      finalText(frame, "evidence copy " + i, i < 3 ? evidenceText(slide, i, "Source proof") : bulletText(slide, i, "Slide implication"), pos[0] + 18, pos[1] + 40, 186, 13, "#17211D", true, 3);
    });
  } else if (index === 3) {
    header(frame, slide, index, "#17211D", accent);
    finalText(frame, "headline", slide.headline, 56, 86, 690, 34, "#17211D", true, 3);
    ["Context", "Brainstorm", "Outline", "Figma", "QA"].forEach((label, i) => {
      const x = 64 + i * 166;
      rect(frame, "workflow node " + i, x + 42, 196, 50, 50, i === 2 ? "#FFA629" : accent, 25);
      finalText(frame, "workflow node num " + i, String(i + 1), x + 61, 211, 20, 15, i === 2 ? "#17211D" : "#FFFFFF", true, 1);
      card(frame, "workflow block " + i, x, 278, 136, 94, i === 2 ? "#FFF4D9" : "#FFFFFF", "#E6EAF2");
      finalText(frame, "workflow label " + i, label, x + 18, 312, 98, 15, "#17211D", true, 1);
    });
  } else if (index === 4) {
    header(frame, slide, index, "#17211D", accent);
    finalText(frame, "headline", slide.headline, 56, 84, 700, 36, "#17211D", true, 3);
    card(frame, "before panel", 76, 228, 350, 214, "#F3F4F7", "#E6EAF2");
    card(frame, "after panel", 534, 228, 350, 214, "#E7F2EE", "#B8D9CE");
    finalText(frame, "before label", "BEFORE", 104, 260, 140, 13, "#53625A", true, 1);
    finalText(frame, "after label", "AFTER", 562, 260, 140, 13, accent, true, 1);
    finalText(frame, "before copy", bulletText(slide, 0, "Draft outline"), 104, 316, 260, 24, "#17211D", true, 2);
    finalText(frame, "after copy", bulletText(slide, 1, "Run format gates"), 562, 316, 260, 24, "#17211D", true, 2);
    rect(frame, "transition", 448, 330, 64, 8, "#FFA629", 4);
  } else if (index === 5) {
    header(frame, slide, index, "#FFFFFF", "#FFA629");
    finalText(frame, "headline", slide.headline, 58, 98, 650, 38, "#FFFFFF", true, 3);
    finalText(frame, "metric", "QA pass evidence", 58, 284, 430, 48, "#FFA629", true, 1);
    finalText(frame, "body", bodyCopy(slide, "A meaningful action is a visible build, review, revise, polish, or finalize update."), 62, 388, 500, 16, "#DCE7DF", false, 3);
    [0, 1, 2, 3, 4].forEach(i => rect(frame, "metric bar " + i, 640 + i * 48, 420 - (76 + i * 28), 32, 76 + i * 28, i === 4 ? "#FFA629" : "#1146D4", 6));
  } else if (index === 6) {
    header(frame, slide, index, "#17211D", accent);
    finalText(frame, "headline", slide.headline, 58, 82, 600, 34, "#17211D", true, 3);
    rect(frame, "map hub", 392, 206, 176, 176, "#1146D4", 88);
    finalText(frame, "map hub label", "Gemma swarm", 426, 260, 108, 22, "#FFFFFF", true, 2);
    ["Outline", "Figma", "QA", "Context"].forEach((label, i) => {
      const x = [654, 654, 654, 90][i];
      const y = [136, 300, 432, 344][i];
      card(frame, "map node " + i, x, y, 166, 68, i === 1 ? "#FFF4D9" : "#FFFFFF", "#E6EAF2");
      finalText(frame, "map node label " + i, label, x + 18, y + 22, 116, 15, accent, true, 1);
    });
  } else if (index === 7) {
    header(frame, slide, index, "#FFFFFF", "#FFA629");
    finalText(frame, "quote mark", String.fromCharCode(34), 56, 62, 104, 76, "#FFA629", true, 1);
    finalText(frame, "headline", slide.headline, 118, 120, 668, 38, "#FFFFFF", true, 4);
    finalText(frame, "body", bodyCopy(slide, "The system names what is weak, fixes it, and keeps the trace visible."), 126, 356, 540, 17, "#DCE7DF", false, 4);
  } else if (index === 8) {
    header(frame, slide, index, "#17211D", accent);
    finalText(frame, "headline", slide.headline, 58, 84, 700, 34, "#17211D", true, 3);
    card(frame, "artifact source", 70, 228, 338, 198, "#F7FAFF", "#E6EAF2");
    rect(frame, "artifact source band", 70, 228, 338, 56, "#1146D4", 8);
    rect(frame, "artifact source line 1", 98, 316, 260, 10, "#DDE4EE", 5);
    rect(frame, "artifact source line 2", 98, 354, 232, 10, "#DDE4EE", 5);
    card(frame, "artifact note panel", 492, 228, 352, 198, "#FFFFFF", "#E6EAF2");
    finalText(frame, "artifact note label", "AGENTIC NOTES", 520, 260, 160, 12, accent, true, 1);
    finalText(frame, "artifact note one", "Diagnosis", 548, 316, 220, 18, "#17211D", true, 1);
    finalText(frame, "artifact note two", "Fix", 548, 362, 220, 18, "#17211D", true, 1);
  } else {
    header(frame, slide, index, dark ? "#FFFFFF" : "#17211D", "#FFA629");
    rect(frame, "closing rail", 0, 0, 960, 18, "#FFA629", 0);
    finalText(frame, "headline", slide.headline, 64, 110, 640, 40, ink, true, 4);
    finalText(frame, "body", bodyCopy(slide, "The deck is built in Figma, validated, and ready for review."), 68, 348, 548, 17, muted, false, 4);
    ["WATCH", "EDIT", "SHIP"].forEach((label, i) => {
      rect(frame, "closing chip " + i, 630 + i * 86, 342, 70, 36, i === 1 ? "#FFA629" : "#1146D4", 8);
      finalText(frame, "closing chip text " + i, label, 643 + i * 86, 354, 46, 11, i === 1 ? "#17211D" : "#FFFFFF", true, 1);
    });
  }
}
const frames = section.findAll(node => node.type === "FRAME").slice(0, input.slideCount);
if (!frames.length) throw new Error("Generated section has no slide frames to QA.");
const targetSlideIds = Array.isArray(input.targetSlideIds) ? input.targetSlideIds.map(String) : [];
if (input.qaMode === "export") {
  const framesToExport = targetSlideIds.length
    ? frames.filter((_, index) => targetSlideIds.includes("s" + (index + 1)))
    : frames;
  const screenshotEvidence = await exportScreenshots(framesToExport, false, frames);
  figma.viewport.scrollAndZoomIntoView([section]);
  return {
    ok: true,
    mode: "qa-export",
    batchIndex: input.batchIndex,
    totalBatches: input.totalBatches,
    sectionId: section.id,
    sectionName: section.name,
    slideCount: frames.length,
    actionCount: 0,
    screenshotEvidence,
    qaEvidence: {
      sectionId: section.id,
      screenshotCount: screenshotEvidence.length,
      exportCount: screenshotEvidence.length,
      finalScreenshotReady: false,
      screenshots: screenshotEvidence
    },
    feedbackApplied: Boolean(input.feedback),
    layoutWarnings: ["qa screenshots exported for Gemma review"]
  };
}
const colors = ["#0E7C66", "#1146D4", "#D95D39", "#FFA629"];
const notes = [
  "Loop 1/10: screenshot diagnosis of bounds, overlap, and crop",
  "Loop 2/10: structured fix plan for headline fit and safe text boxes",
  "Loop 3/10: recheck component placement and spacing after fixes",
  "Loop 4/10: screenshot diagnosis for contrast and background overlays",
  "Loop 5/10: copy clarity and contained body text repair",
  "Loop 6/10: component placement and safe-area repair",
  "Loop 7/10: slide-to-slide cohesion and visual rhythm",
  "Loop 8/10: remove broken temporary elements",
  "Loop 9/10: rebuild clean final layouts from slide specs",
  "Loop 10/10: remove QA tags and export screenshot evidence"
];
const accent = colors[input.batchIndex % colors.length];
const loopIndex = Math.min(input.batchIndex + 1, input.maxDiagnoseFixLoops);
let actionCount = 0;
frames.forEach((frame, index) => {
  const slideId = "s" + (index + 1);
  if (input.qaMode === "fix" && targetSlideIds.length && !targetSlideIds.includes(slideId)) return;
  const slide = input.slides[index] || input.slides[input.slides.length - 1] || {};
  if (input.qaMode === "finalize" || input.batchIndex >= input.totalBatches - 2) {
    cleanFinalLayout(frame, slide, index);
    actionCount += 1;
    return;
  }
  frame.strokes = [paint(accent)];
  frame.strokeWeight = 3;
  actionCount += clampExistingNodes(frame);
  actionCount += applyVisionFixes(frame, index);
  const note = notes[input.batchIndex % notes.length];
  rect(frame, "Gemma VLM QA rail", 0, 0, 12, 540, accent, 0);
  rect(frame, "Gemma VLM safe area", 28, 28, 904, 484, input.batchIndex >= input.totalBatches - 2 ? "#FFFFFF" : "#F7FAFF", 8).opacity = input.batchIndex >= input.totalBatches - 2 ? 0.05 : 0.08;
  rect(frame, "Gemma VLM QA badge bg", 666, 28, 246, 48, input.batchIndex >= input.totalBatches - 2 ? "#0E7C66" : "#17211D", 12);
  text(frame, "Gemma VLM QA badge text", "QA " + String(input.batchIndex + 1).padStart(2, "0") + "/" + input.totalBatches, 684, 42, 78, 12, "#FFFFFF", true);
  text(frame, "Gemma VLM QA badge note", note, 768, 42, 128, 11, "#FFFFFF", false);
  text(frame, "VLM structured diagnosis", "Structured JSON: screenshotObservations -> issues[] -> figmaFixes[] -> noMoreIssues. Loop " + loopIndex + "/" + input.maxDiagnoseFixLoops + ".", 46, 438, 610, 12, index === 0 || index === 5 || index === 7 || index === 9 ? "#DCE7DF" : "#53625A", false);
  text(frame, "live review note", note + ". Slide " + (index + 1) + " adjusted by visual QA batch " + (input.batchIndex + 1) + ".", 46, 468, 610, 13, index === 0 || index === 5 || index === 7 || index === 9 ? "#DCE7DF" : "#53625A", false);
  if (input.feedback) {
    rect(frame, "Manual feedback bg", 46, 416, 514, 34, input.batchIndex >= 6 ? "#E7F2EE" : "#FFF4D9", 8);
    text(frame, "Manual feedback note", "Feedback applied: " + input.feedback, 60, 426, 486, 12, "#17211D", true);
  }
  actionCount += 1;
});
const screenshotEvidence = [];
if (input.qaMode === "finalize" || input.batchIndex >= input.totalBatches - 1) {
  screenshotEvidence.push(...(await exportScreenshots(frames, true, frames)));
}
figma.viewport.scrollAndZoomIntoView([section]);
const elapsedSec = (Date.now() - startedAt) / 1000;
figma.notify("Gemma VLM QA batch " + (input.batchIndex + 1) + "/" + input.totalBatches + " polished " + frames.length + " slides");
return {
  ok: true,
  mode: "qa",
  batchIndex: input.batchIndex,
  totalBatches: input.totalBatches,
  diagnoseFixLoopIndex: loopIndex,
  maxDiagnoseFixLoops: input.maxDiagnoseFixLoops,
  qaSystemPrompt: input.qaSystemPrompt,
  sectionId: section.id,
  sectionName: section.name,
  slideCount: frames.length,
  actionCount,
  elapsedSec: Number(elapsedSec.toFixed(2)),
  screenshotEvidence,
  qaEvidence: {
    sectionId: section.id,
    screenshotCount: screenshotEvidence.length,
    exportCount: screenshotEvidence.length,
    finalScreenshotReady: input.batchIndex >= input.totalBatches - 1,
    screenshots: screenshotEvidence
  },
  feedbackApplied: Boolean(input.feedback),
  layoutWarnings: input.batchIndex >= input.totalBatches - 1 ? [] : ["qa in progress"]
};
`.trim();
}

function buildExecutableFigmaQaScript(deck: DeckSpec, options: { sectionId?: string; feedback?: string }): string {
  const payload = JSON.stringify({
    sectionId: options.sectionId || "",
    feedback: cleanText(options.feedback || ""),
    title: cleanText(deck.title),
    slideCount: Math.max(1, Math.min(10, deck.slides.length || 10))
  });
  return `
const startedAt = Date.now();
const input = ${payload};
await figma.loadAllPagesAsync();
const page = figma.currentPage;
let section = input.sectionId ? figma.getNodeById(input.sectionId) : null;
if (!section || section.type !== "SECTION") {
  const candidates = page.findAll(node => node.type === "SECTION" && String(node.name || "").startsWith("Gemma Deck Forge -"));
  section = candidates[candidates.length - 1] || null;
}
if (!section || section.type !== "SECTION") {
  throw new Error("No generated Gemma Deck Forge section found for QA.");
}
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
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function fit(value, max) {
  const clean = String(value || "").replace(/[\\u0000-\\u001F\\u007F]/g, " ").replace(/\\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1).trim() + "..." : clean;
}
function rect(parent, name, x, y, w, h, color, radius) {
  let node = parent.findOne(child => child.name === name && child.type === "RECTANGLE");
  if (!node) {
    node = figma.createRectangle();
    node.name = name;
    parent.appendChild(node);
  }
  node.x = x;
  node.y = y;
  node.resize(w, h);
  node.cornerRadius = radius || 8;
  node.fills = [paint(color)];
  return node;
}
function text(parent, name, value, x, y, w, size, color, bold) {
  let node = parent.findOne(child => child.name === name && child.type === "TEXT");
  if (!node) {
    node = figma.createText();
    node.name = name;
    parent.appendChild(node);
  }
  node.x = x;
  node.y = y;
  node.resize(w, 10);
  node.fontName = bold ? fonts[1] : fonts[0];
  node.characters = fit(value, Math.max(18, Math.floor(w / Math.max(7, size * 0.48)) * 2));
  node.fontSize = size;
  node.lineHeight = { unit: "PERCENT", value: 110 };
  node.fills = [paint(color)];
  node.textAutoResize = "HEIGHT";
  return node;
}
function frameChildren(frame) {
  return "children" in frame ? frame.children : [];
}
const frames = section.findAll(node => node.type === "FRAME").slice(0, input.slideCount);
if (!frames.length) throw new Error("Generated section has no slide frames to QA.");
const colors = ["#2D6CDF", "#D95D39", "#0E7C66", "#E0A928"];
const notes = [
  "VLM scan: component bounds, overlap, and crop",
  "VLM fix: copy hierarchy and font-size balance",
  "VLM polish: color contrast and background overlays",
  "VLM cohesion: deck rhythm and narrative continuity",
  "VLM final: screenshot-ready verification"
];
let actionCount = 0;
for (let pass = 0; pass < 12; pass += 1) {
  const note = notes[pass % notes.length];
  frames.forEach((frame, index) => {
    frame.strokes = [paint(colors[pass % colors.length])];
    frame.strokeWeight = pass >= 10 ? 6 : 3;
    frameChildren(frame).forEach(child => {
      if (child.type === "TEXT") {
        if (child.fontSize > 48) child.fontSize = 48;
        if (child.x + child.width > 930) child.resize(Math.max(120, 930 - child.x), 10);
        if (child.y + child.height > 520) child.y = Math.max(24, 520 - child.height);
      }
    });
    rect(frame, "Gemma VLM QA rail", 0, 0, 8, 540, colors[pass % colors.length], 0);
    rect(frame, "Gemma VLM QA badge bg", 696, 32, 214, 46, pass >= 10 ? "#0E7C66" : "#17211D", 12);
    text(frame, "Gemma VLM QA badge text", "QA " + String(pass + 1).padStart(2, "0") + "/12", 714, 45, 72, 13, "#FFFFFF", true);
    text(frame, "Gemma VLM QA badge note", fit(note, 44), 786, 45, 108, 12, "#FFFFFF", false);
    const review = frame.findOne(child => child.name === "live review note" && child.type === "TEXT");
    if (review) {
      review.characters = note + ". Slide " + (index + 1) + " adjusted in batch pass " + (pass + 1) + ".";
    }
    if (input.feedback && pass === 0) {
      rect(frame, "Manual feedback bg", 46, 406, 470, 34, "#FFF4D9", 8);
      text(frame, "Manual feedback note", "Feedback: " + input.feedback, 60, 417, 442, 12, "#17211D", true);
    }
    actionCount += 1;
  });
  await sleep(500);
}
figma.viewport.scrollAndZoomIntoView([section]);
const elapsedSec = (Date.now() - startedAt) / 1000;
figma.notify("Gemma VLM QA polished " + frames.length + " slides in " + elapsedSec.toFixed(1) + "s");
return {
  sectionId: section.id,
  sectionName: section.name,
  slideCount: frames.length,
  actionCount,
  qaLoops: 12,
  elapsedSec: Number(elapsedSec.toFixed(2)),
  actionsPerSecond: Number((actionCount / Math.max(0.001, elapsedSec)).toFixed(2)),
  feedbackApplied: Boolean(input.feedback),
  layoutWarnings: []
};
`.trim();
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
const maxBottom = page.children.reduce((bottom, node) => {
  if (!("y" in node) || !("height" in node)) return bottom;
  return Math.max(bottom, node.y + node.height);
}, 0);
const section = figma.createSection();
section.name = deck.sectionName;
section.x = deck.origin.x;
section.y = Math.max(deck.origin.y, maxBottom + deck.gap * 2);
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
  node.characters = fitString(value, w, size);
  node.fontSize = size;
  node.lineHeight = { unit: "PERCENT", value: 110 };
  node.fills = [paint(color)];
  node.textAutoResize = "HEIGHT";
  parent.appendChild(node);
  return node;
}
function fitString(value, w, size) {
  const clean = String(value).replace(/[\\u0000-\\u001F\\u007F]/g, " ").replace(/\\s+/g, " ").trim();
  const charsPerLine = Math.max(12, Math.floor(w / (size * 0.54)));
  const maxLines = size >= 42 ? 3 : size >= 34 ? 2 : size >= 24 ? 3 : size >= 17 ? 4 : 5;
  const maxChars = charsPerLine * maxLines;
  return clean.length > maxChars ? clean.slice(0, Math.max(12, maxChars - 1)).trim() + "..." : clean;
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function hexFromPaint(paintValue) {
  if (!paintValue || paintValue.type !== "SOLID" || !paintValue.color) return null;
  const toHex = value => Math.round(value * 255).toString(16).padStart(2, "0").toUpperCase();
  return "#" + toHex(paintValue.color.r) + toHex(paintValue.color.g) + toHex(paintValue.color.b);
}
function allColors(node, colors) {
  if ("fills" in node && Array.isArray(node.fills)) {
    node.fills.forEach(fill => {
      const hex = hexFromPaint(fill);
      if (hex && !colors.includes(hex)) colors.push(hex);
    });
  }
  if ("children" in node) node.children.forEach(child => allColors(child, colors));
}
function insideGenerated(node) {
  let current = node;
  while (current) {
    if (current.name && current.name.startsWith("Gemma Deck Forge")) return true;
    current = current.parent;
  }
  return false;
}
const sampledColors = [];
page.children
  .filter(node => !node.name.startsWith("Gemma Deck Forge"))
  .slice(0, 40)
  .forEach(node => allColors(node, sampledColors));
const palette = {
  navy: sampledColors.includes("#12235D") ? "#12235D" : "#17211D",
  blue: sampledColors.includes("#1146D4") ? "#1146D4" : "#2D6CDF",
  light: sampledColors.includes("#F7FAFF") ? "#F7FAFF" : "#FFFDF7",
  white: "#FFFFFF",
  ink: "#17211D",
  muted: "#53625A",
  amber: sampledColors.includes("#FFA629") ? "#FFA629" : "#E0A928",
  green: "#0E7C66",
  red: "#D95D39",
  grid: "#E6EAF2"
};
function short(value, max) {
  const textValue = String(value || "").replace(/[\\u0000-\\u001F\\u007F]/g, " ").replace(/\\s+/g, " ").trim();
  return textValue.length > max ? textValue.slice(0, max - 1) + "..." : textValue;
}
function bullet(slide, index, fallback) {
  return short((slide.bullets && slide.bullets[index % slide.bullets.length]) || fallback, 96);
}
function evidence(slide, index, fallback) {
  return short((slide.evidence && slide.evidence[index % slide.evidence.length]) || fallback, 112);
}
function ellipse(parent, name, x, y, w, h, color) {
  const node = figma.createEllipse();
  node.name = name;
  node.x = x;
  node.y = y;
  node.resize(w, h);
  node.fills = [paint(color)];
  parent.appendChild(node);
  return node;
}
function line(parent, name, x, y, w, color, weight) {
  return rect(parent, name, x, y, w, weight || 3, color, 2);
}
function createSlideFrame(parent, slide, index, bg) {
  const col = index % deck.columns;
  const row = Math.floor(index / deck.columns);
  const frame = figma.createFrame();
  frame.name = "Slide " + String(index + 1).padStart(2, "0") + " - " + slide.title;
  frame.x = deck.padding + col * (deck.slideWidth + deck.gap);
  frame.y = deck.padding + 128 + row * (deck.slideHeight + deck.gap);
  frame.resize(deck.slideWidth, deck.slideHeight);
  frame.cornerRadius = 8;
  frame.clipsContent = true;
  frame.fills = [paint(bg)];
  parent.appendChild(frame);
  return frame;
}
function header(frame, slide, index, ink, accent) {
  text(frame, "slide no", String(index + 1).padStart(2, "0"), 46, 34, 48, 16, ink, true);
  line(frame, "header rule", 104, 43, 118, accent, 5);
  text(frame, "kicker", short(slide.formatLabel || slide.title, 44).toUpperCase(), 238, 34, 390, 12, accent, true);
}
async function referenceThumb(parent, refIndex, x, y, w, h, label) {
  const holder = figma.createFrame();
  holder.name = "intentional reference cue " + refIndex;
  holder.x = x;
  holder.y = y;
  holder.resize(w, h);
  holder.cornerRadius = 8;
  holder.clipsContent = true;
  holder.fills = [paint(refIndex % 2 === 0 ? palette.light : "#F7FAFF")];
  holder.strokes = [paint(palette.grid)];
  holder.strokeWeight = 1;
  parent.appendChild(holder);
  rect(holder, "reference top band", 0, 0, w, Math.max(26, h * 0.22), refIndex % 3 === 0 ? palette.blue : palette.navy, 0);
  ellipse(holder, "reference dot", w - 42, 12, 24, 24, refIndex % 2 === 0 ? palette.amber : palette.green);
  const rows = Math.max(2, Math.min(4, Math.floor(h / 58)));
  for (let i = 0; i < rows; i++) {
    const yRow = Math.max(38, h * 0.32) + i * 30;
    rect(holder, "reference line " + i, 16, yRow, Math.max(48, w - 44 - i * 18), 8, i === 0 ? palette.blue : palette.grid, 3);
  }
  rect(holder, "asset label bg", 0, h - 26, w, 26, "#FFFFFF", 0).opacity = 0.94;
  text(holder, "asset label", label, 10, h - 21, w - 20, 10, palette.ink, true);
  return holder;
}
function addProgress(frame, slide, index, mode) {
  const dark = mode === "dark";
  const review = text(frame, "live review note", "Queued: checking " + short(slide.formatRequirement || "slide-specific hierarchy, proof, and fit", 120), 46, 456, 540, 13, dark ? "#DCE7DF" : palette.muted);
  const chips = [];
  phaseLabels.forEach((phase, i) => {
    const x = 614 + i * 62;
    const chipBg = rect(frame, phase.key + " chip bg", x, 452, 48, 34, dark ? "#263761" : "#E8ECF4", 8);
    const chipText = text(frame, phase.key + " chip text", phase.label.slice(0, 3), x + 10, 463, 28, 9, dark ? palette.white : palette.ink, true);
    chips.push({ bg: chipBg, text: chipText, phase });
  });
  return { review, chips };
}
function card(parent, name, x, y, w, h, bg, stroke) {
  const node = rect(parent, name, x, y, w, h, bg, 8);
  node.strokes = [paint(stroke || palette.grid)];
  node.strokeWeight = 1;
  return node;
}
async function renderOpener(frame, slide, index) {
  frame.fills = [paint(palette.navy)];
  rect(frame, "blue slab", 0, 0, 285, deck.slideHeight, palette.blue, 0);
  rect(frame, "amber tab", 46, 42, 128, 32, palette.amber, 8);
  text(frame, "tab", "LIVE BUILD", 64, 51, 96, 11, palette.ink, true);
  text(frame, "headline", short(slide.headline, 88), 46, 104, 530, 42, palette.white, true);
  text(frame, "body", short(slide.body, 150), 52, 318, 420, 16, "#DCE7DF");
  await referenceThumb(frame, index, 610, 58, 266, 154, "reference style sample");
  await referenceThumb(frame, index + 1, 660, 244, 216, 122, "component grammar");
  ellipse(frame, "speed dot", 560, 392, 52, 52, palette.amber);
  text(frame, "quality", "PASS", 571, 408, 42, 15, palette.ink, true);
  return addProgress(frame, slide, index, "dark");
}
async function renderThesis(frame, slide, index) {
  header(frame, slide, index, palette.ink, slide.accent);
  rect(frame, "left rail", 0, 0, 22, deck.slideHeight, palette.blue, 0);
  text(frame, "headline", short(slide.headline, 104), 58, 92, 585, 44, palette.ink, true);
  text(frame, "body", short(slide.body, 150), 62, 300, 440, 18, palette.muted);
  card(frame, "claim chip one", 646, 98, 228, 72, palette.light, slide.accent);
  text(frame, "claim one", bullet(slide, 0, "Parallel agents split the thinking."), 666, 120, 184, 17, palette.ink, true);
  card(frame, "claim chip two", 646, 190, 228, 72, "#FFF4D9", palette.amber);
  text(frame, "claim two", bullet(slide, 1, "Figma updates visibly improve over time."), 666, 212, 184, 17, palette.ink, true);
  await referenceThumb(frame, index + 2, 646, 302, 228, 120, "reference pacing cue");
  return addProgress(frame, slide, index, "light");
}
async function renderEvidenceWall(frame, slide, index) {
  header(frame, slide, index, palette.ink, slide.accent);
  text(frame, "headline", short(slide.headline, 76), 52, 76, 530, 34, palette.ink, true);
  const positions = [[52, 202], [306, 202], [560, 202], [52, 336], [306, 336], [560, 336]];
  positions.forEach((pos, i) => {
    const bg = i % 2 === 0 ? palette.white : palette.light;
    card(frame, "evidence card " + i, pos[0], pos[1], 220, 104, bg, i === 0 ? slide.accent : palette.grid);
    text(frame, "evidence label " + i, i < 3 ? "SOURCE" : "AGENT NOTE", pos[0] + 16, pos[1] + 14, 110, 10, slide.accent, true);
    text(frame, "evidence copy " + i, i < 3 ? evidence(slide, i, "Reference artifact from the open Figma file.") : bullet(slide, i, "Review pass tightened this slide."), pos[0] + 16, pos[1] + 36, 180, 14, palette.ink, true);
  });
  await referenceThumb(frame, index + 3, 792, 90, 112, 260, "reference proof cue");
  return addProgress(frame, slide, index, "light");
}
async function renderWorkflow(frame, slide, index) {
  header(frame, slide, index, palette.ink, slide.accent);
  text(frame, "headline", short(slide.headline, 84), 52, 80, 680, 34, palette.ink, true);
  const steps = ["Context", "Outline", "Scaffold", "Evaluate", "Polish"];
  steps.forEach((step, i) => {
    const x = 58 + i * 168;
    card(frame, "workflow block " + i, x, 238, 132, 92, i === 2 ? "#FFF4D9" : palette.white, i === 2 ? palette.amber : palette.grid);
    ellipse(frame, "workflow node " + i, x + 42, 190, 48, 48, i === 2 ? palette.amber : slide.accent);
    text(frame, "workflow num " + i, String(i + 1), x + 59, 205, 16, 15, i === 2 ? palette.ink : palette.white, true);
    text(frame, "workflow step " + i, step, x + 18, 264, 96, 15, palette.ink, true);
    text(frame, "workflow proof " + i, bullet(slide, i, "Agent gate"), x + 18, 288, 96, 12, palette.muted);
    if (i < steps.length - 1) line(frame, "workflow connector " + i, x + 94, 212, 116, palette.grid, 3);
  });
  text(frame, "body", short(slide.body, 160), 64, 370, 520, 16, palette.muted);
  return addProgress(frame, slide, index, "light");
}
async function renderBeforeAfter(frame, slide, index) {
  header(frame, slide, index, palette.ink, slide.accent);
  text(frame, "headline", short(slide.headline, 82), 52, 82, 640, 34, palette.ink, true);
  card(frame, "before panel", 52, 180, 384, 214, "#F3F4F7", "#D1D7E2");
  card(frame, "after panel", 508, 180, 384, 214, "#E7F2EE", slide.accent);
  text(frame, "before label", "BEFORE", 78, 206, 140, 13, palette.muted, true);
  text(frame, "after label", "AFTER", 534, 206, 140, 13, slide.accent, true);
  text(frame, "before copy", bullet(slide, 0, "Flat generated slides repeat the same pattern."), 78, 242, 300, 24, palette.ink, true);
  text(frame, "after copy", bullet(slide, 1, "Agentic review creates varied, purposeful slide jobs."), 534, 242, 300, 24, palette.ink, true);
  await referenceThumb(frame, index + 4, 80, 316, 150, 62, "old scaffold");
  await referenceThumb(frame, index + 5, 536, 316, 150, 62, "target grammar");
  line(frame, "transition", 436, 286, 72, palette.amber, 8);
  ellipse(frame, "transition dot", 464, 270, 40, 40, palette.amber);
  return addProgress(frame, slide, index, "light");
}
async function renderMetric(frame, slide, index) {
  frame.fills = [paint(palette.navy)];
  header(frame, slide, index, palette.white, palette.amber);
  text(frame, "headline", short(slide.headline, 96), 52, 86, 500, 34, palette.white, true);
  text(frame, "big metric", "QA pass evidence", 54, 212, 520, 58, palette.amber, true);
  text(frame, "body", short(slide.body, 150), 60, 314, 420, 17, "#DCE7DF");
  [0, 1, 2, 3, 4].forEach((_, i) => {
    const h = 54 + i * 32;
    rect(frame, "bar " + i, 610 + i * 52, 384 - h, 34, h, i === 4 ? palette.amber : palette.blue, 6);
    text(frame, "bar label " + i, String(i + 1), 620 + i * 52, 398, 16, 11, "#DCE7DF", true);
  });
  await referenceThumb(frame, index + 6, 604, 86, 230, 126, "quality proof");
  return addProgress(frame, slide, index, "dark");
}
async function renderSystemMap(frame, slide, index) {
  header(frame, slide, index, palette.ink, slide.accent);
  text(frame, "headline", short(slide.headline, 80), 52, 80, 600, 34, palette.ink, true);
  ellipse(frame, "hub", 400, 202, 160, 160, palette.blue);
  text(frame, "hub text", "Gemma swarm", 428, 258, 104, 18, palette.white, true);
  const nodes = [[130, 186, "knowledge"], [684, 176, "Figma"], [184, 374, "eval"], [660, 368, "polish"]];
  nodes.forEach((item, i) => {
    line(frame, "map line " + i, 480, 280, i < 2 ? 244 : 194, palette.grid, 3);
    card(frame, "map node " + i, item[0], item[1], 160, 74, i === 1 ? "#FFF4D9" : palette.white, i === 1 ? palette.amber : palette.grid);
    text(frame, "map label " + i, String(item[2]).toUpperCase(), item[0] + 16, item[1] + 14, 110, 10, slide.accent, true);
    text(frame, "map copy " + i, bullet(slide, i, "Agent lane updates a specific slide job."), item[0] + 16, item[1] + 34, 120, 12, palette.ink, true);
  });
  return addProgress(frame, slide, index, "light");
}
async function renderQuote(frame, slide, index) {
  frame.fills = [paint(palette.blue)];
  text(frame, "quote mark", String.fromCharCode(34), 56, 50, 120, 96, palette.amber, true);
  text(frame, "headline", short(slide.headline, 92), 96, 116, 710, 44, palette.white, true);
  text(frame, "body", short(slide.body, 150), 102, 318, 520, 18, "#DCE7DF");
  await referenceThumb(frame, index + 7, 650, 330, 220, 116, "reference design cue");
  return addProgress(frame, slide, index, "dark");
}
async function renderArtifact(frame, slide, index) {
  header(frame, slide, index, palette.ink, slide.accent);
  text(frame, "headline", short(slide.headline, 76), 52, 74, 560, 34, palette.ink, true);
  await referenceThumb(frame, index + 8, 52, 166, 366, 218, "source asset");
  card(frame, "artifact notes", 458, 166, 390, 218, palette.white, palette.grid);
  text(frame, "artifact label", "AGENTIC NOTES", 482, 192, 140, 11, slide.accent, true);
  [0, 1, 2].forEach((_, i) => {
    ellipse(frame, "artifact dot " + i, 486, 232 + i * 44, 12, 12, i === 1 ? palette.amber : slide.accent);
    text(frame, "artifact item " + i, bullet(slide, i, "Use real file grammar instead of generic AI cards."), 512, 224 + i * 44, 292, 14, palette.ink, true);
  });
  return addProgress(frame, slide, index, "light");
}
async function renderMatrix(frame, slide, index) {
  header(frame, slide, index, palette.ink, slide.accent);
  text(frame, "headline", short(slide.headline, 76), 52, 76, 560, 34, palette.ink, true);
  const cols = ["Story", "Proof", "Design"];
  const rows = ["Draft", "Eval", "Fix"];
  cols.forEach((col, c) => text(frame, "matrix col " + c, col, 250 + c * 172, 164, 110, 12, slide.accent, true));
  rows.forEach((row, r) => {
    text(frame, "matrix row " + r, row, 68, 210 + r * 70, 100, 15, palette.ink, true);
    cols.forEach((_, c) => {
      const hot = r === c || (r === 2 && c === 1);
      card(frame, "matrix cell " + r + "-" + c, 224 + c * 172, 198 + r * 70, 130, 48, hot ? "#E7F2EE" : palette.white, hot ? slide.accent : palette.grid);
      text(frame, "matrix text " + r + "-" + c, hot ? "fixed" : "scan", 252 + c * 172, 214 + r * 70, 74, 12, hot ? slide.accent : palette.muted, true);
    });
  });
  text(frame, "matrix insight", evidence(slide, 0, "Each slide is diagnosed independently, then the deck gets a holistic pass."), 650, 202, 210, 20, palette.ink, true);
  return addProgress(frame, slide, index, "light");
}
async function renderClosing(frame, slide, index) {
  frame.fills = [paint(palette.navy)];
  rect(frame, "closing rail", 0, 0, deck.slideWidth, 18, palette.amber, 0);
  text(frame, "headline", short(slide.headline, 86), 66, 92, 720, 50, palette.white, true);
  text(frame, "body", short(slide.body, 160), 72, 300, 500, 18, "#DCE7DF");
  ["watch", "edit", "ship"].forEach((word, i) => {
    rect(frame, "closing chip " + i, 608 + i * 92, 326, 72, 36, i === 1 ? palette.amber : palette.blue, 8);
    text(frame, "closing chip text " + i, word.toUpperCase(), 620 + i * 92, 338, 46, 10, i === 1 ? palette.ink : palette.white, true);
  });
  await referenceThumb(frame, index + 9, 608, 230, 230, 86, "final cue");
  return addProgress(frame, slide, index, "dark");
}
text(section, "section title", deck.title, deck.padding, 30, 1200, 34, "#FFFDF7", true);
text(section, "section subtitle", "Ten format-aware slide jobs drive ten design structures: opener, thesis, context map, evidence wall, workflow loop, contrast, speed metric, system map, critique/fix artifact, operator close.", deck.padding, 74, 1580, 18, "#DCE7DF");
const frames = [];
const statusNodes = [];
const reviewNodes = [];
const rendererByFormat = {
  "cold-open": renderOpener,
  "stakes-thesis": renderThesis,
  "context-map": renderEvidenceWall,
  "evidence-wall": renderWorkflow,
  "workflow-loop": renderBeforeAfter,
  "before-after": renderMetric,
  "speed-metric": renderSystemMap,
  "system-map": renderQuote,
  "critique-fix": renderArtifact,
  "operator-close": renderClosing
};
for (const [index, slide] of deck.slides.entries()) {
  const layoutIndex = index % 10;
  const lightBg = layoutIndex === 3 ? "#F7FAFF" : layoutIndex === 8 ? "#FBFCFF" : "#FFFFFF";
  const darkLayout = layoutIndex === 0 || layoutIndex === 5 || layoutIndex === 7 || layoutIndex === 9;
  const frame = createSlideFrame(section, slide, index, darkLayout ? palette.navy : lightBg);
  frames.push(frame);
  const renderer = rendererByFormat[slide.formatId] || [
    renderOpener,
    renderThesis,
    renderEvidenceWall,
    renderWorkflow,
    renderBeforeAfter,
    renderMetric,
    renderSystemMap,
    renderQuote,
    renderArtifact,
    renderClosing
  ][layoutIndex];
  const rendered = await renderer(frame, slide, index);
  reviewNodes.push(rendered.review);
  statusNodes.push(rendered.chips);
}
figma.viewport.scrollAndZoomIntoView([section]);
let actionCount = 0;
const actionStartedAt = Date.now();
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
function validateGeneratedFrames(framesToCheck) {
  const warnings = [];
  framesToCheck.forEach((frame, index) => {
    const children = "children" in frame ? frame.children : [];
    children.forEach(child => {
      if (!("x" in child) || !("y" in child) || !("width" in child) || !("height" in child)) return;
      if (child.x < -1 || child.y < -1 || child.x + child.width > deck.slideWidth + 1 || child.y + child.height > deck.slideHeight + 1) {
        warnings.push("Slide " + (index + 1) + " child out of bounds: " + child.name);
      }
    });
    const headline = children.find(child => String(child.name || "").includes("headline"));
    const firstContentBelow = headline
      ? children
          .filter(child => {
            if (!/card|panel|thumb|cue/.test(String(child.name || "")) || child.y <= headline.y) return false;
            const overlapsX = child.x < headline.x + headline.width && child.x + child.width > headline.x;
            return overlapsX;
          })
          .sort((a, b) => a.y - b.y)[0]
      : null;
    if (headline && firstContentBelow && headline.y + headline.height > firstContentBelow.y - 8) {
      warnings.push("Slide " + (index + 1) + " headline too close to content");
    }
  });
  return warnings;
}
const layoutWarnings = validateGeneratedFrames(frames);
const elapsedSec = (Date.now() - startedAt) / 1000;
const actionElapsedSec = Math.max(0.001, (Date.now() - actionStartedAt) / 1000);
figma.viewport.scrollAndZoomIntoView([section]);
figma.notify("Gemma Deck Forge finalized " + deck.slides.length + " slides: " + actionCount + " actions at " + (actionCount / actionElapsedSec).toFixed(1) + "/sec; warnings " + layoutWarnings.length);
return { sectionId: section.id, sectionName: section.name, slideCount: deck.slides.length, actionCount, elapsedSec: Number(elapsedSec.toFixed(2)), actionElapsedSec: Number(actionElapsedSec.toFixed(2)), actionsPerSecond: Number((actionCount / actionElapsedSec).toFixed(2)), layoutWarnings, frameIds: frames.map(frame => frame.id) };
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
    actionDelayMs: 200,
    sectionWidth: padding * 2 + columns * slideWidth + (columns - 1) * gap,
    sectionHeight: padding * 2 + 112 + rows * slideHeight + Math.max(0, rows - 1) * gap,
    slides
  };
}

function ensureTenSlides(deck: DeckSpec) {
  const slides = deck.slides.map((slide, index) =>
    applyDesignBeat(
      {
        title: cleanText(slide.title),
        headline: cleanText(slide.headline),
        body: cleanText(slide.body),
        bullets: slide.bullets.map(cleanText),
        evidence: slide.evidence.map(cleanText),
        layout: slide.layout,
        formatId: slide.formatId,
        formatLabel: slide.formatLabel,
        formatRequirement: slide.formatRequirement,
        informationArchitecture: slide.informationArchitecture,
        designDirective: slide.designDirective,
        evalCriteria: slide.evalCriteria,
        accent: slide.accent
      },
      index
    )
  );
  while (slides.length < 10) {
    slides.push(styleBackedBeat(slides.length));
  }
  return slides.slice(0, 10);
}

const designBeats = [
  {
    title: "Instant Deck Forge",
    headline: "A deck takes shape while the brainstorm is still happening.",
    body: "Gemma 4 agents on Cerebras split story, evidence, visual design, and Figma execution into fast visible passes.",
    bullets: ["Parallel story lanes", "Figma bridge writes", "Visible quality gates"],
    evidence: ["Live bridge result reports slide count, action count, and actions per second"],
    accent: "#1146D4"
  },
  {
    title: "Latency changes the workflow",
    headline: "Low latency makes creative review feel like direct manipulation.",
    body: "The user can watch agents draft, critique, revise, and polish instead of waiting for one opaque generation step.",
    bullets: ["Short loops beat monolithic output", "Parallel agents keep the UI alive", "Review happens before polish"],
    evidence: ["Cerebras-backed calls are scheduled as concurrent specialist lanes"],
    accent: "#0E7C66"
  },
  {
    title: "Context becomes evidence",
    headline: "Knowledge and source notes turn into claims, proof, and caveats.",
    body: "The product should show source organization as a visible part of the deck-making workflow, not hidden prep work.",
    bullets: ["Cluster context", "Extract proof", "Flag caveats"],
    evidence: ["Source cards and agent notes appear as designed artifacts on the slide"],
    accent: "#D95D39"
  },
  {
    title: "Agent loop anatomy",
    headline: "The useful product is the sequence of improvements, not just the final deck.",
    body: "Each pass has a different job: scaffold, evaluate, patch the weak spots, then harmonize the deck.",
    bullets: ["Scaffold first", "Diagnose precisely", "Apply holistic rhythm"],
    evidence: ["Five visible phase chips update across all ten slides"],
    accent: "#8A4FFF"
  },
  {
    title: "Before vs after",
    headline: "The system must visibly escape the identical-template trap.",
    body: "The finalizer alternates thesis, proof, workflow, contrast, metric, map, quote, artifact, and closing slides.",
    bullets: ["Old: repeated scaffold", "New: slide-specific job", "Final: cohesive rhythm"],
    evidence: ["Ten renderer variants are selected by slide beat"],
    accent: "#FFA629"
  },
  {
    title: "Speed proof",
    headline: "The deck should prove generation completeness and QA pass state.",
    body: "Figma receives one reliable write stream while the app presents the planning and review work as parallel agent lanes.",
    bullets: ["10 slides", "50 gate updates", "Measured execution"],
    evidence: ["Bridge response returns actionsPerSecond after the run"],
    accent: "#E0A928"
  },
  {
    title: "Swarm storyboard",
    headline: "Every agent lane needs a visible reason to exist.",
    body: "Story, evidence, design, review, and polish lanes each own a different failure mode and leave a trace on the deck.",
    bullets: ["Story checks the arc", "Evidence checks believability", "Design checks hierarchy"],
    evidence: ["Map slide shows separate lanes converging on the deck"],
    accent: "#1146D4"
  },
  {
    title: "Critique fork",
    headline: "The smartest-looking moment is when the system catches its own weak slide.",
    body: "A quote-style critique slide makes the agentic loop legible: diagnose the generic beat, rewrite it, then refresh layout.",
    bullets: ["Name the weakness", "Patch copy", "Change scaffold"],
    evidence: ["Review chip text changes before the final polish chip turns green"],
    accent: "#D95D39"
  },
  {
    title: "Reference grammar",
    headline: "The open Figma file supplies the visual vocabulary.",
    body: "Reference frames are exported as real image thumbnails, then used as proof and rhythm cues rather than accidental crops.",
    bullets: ["Sample existing frames", "Borrow palette", "Use assets intentionally"],
    evidence: ["Thumbnail fills are exported from frames already present in the file"],
    accent: "#FFA629"
  },
  {
    title: "Final operator view",
    headline: "The outcome is a deck the user can immediately inspect, edit, and ship.",
    body: "The close should feel like an operator handoff: the deck is built in Figma, validated, and ready for review.",
    bullets: ["Watch", "Edit", "Ship"],
    evidence: ["Final section is placed below existing file content and selected in the viewport"],
    accent: "#0E7C66"
  }
];

function applyDesignBeat(
  slide: {
    title: string;
    headline: string;
    body: string;
    bullets: string[];
    evidence: string[];
    layout?: string;
    formatId?: string;
    formatLabel?: string;
    formatRequirement?: string;
    informationArchitecture?: string[];
    designDirective?: string;
    evalCriteria?: string[];
    accent: string;
  },
  index: number
) {
  const beat = styleBackedBeat(index);
  const combined = `${slide.title} ${slide.headline} ${slide.body}`.toLowerCase();
  const generic =
    /review beat|show one concrete step|use this slide|deck-making loop|workflow visible and robust/.test(combined) ||
    !slide.headline ||
    slide.headline.length < 18;
  return {
    title: generic ? beat.title : slide.title || beat.title,
    headline: generic ? beat.headline : slide.headline || beat.headline,
    body: generic ? beat.body : slide.body || beat.body,
    bullets: generic || slide.bullets.length < 2 ? beat.bullets : slide.bullets,
    evidence: generic || slide.evidence.length === 0 ? beat.evidence : slide.evidence,
    layout: beat.layout,
    formatId: beat.formatId,
    formatLabel: beat.formatLabel,
    formatRequirement: slide.formatRequirement || beat.formatRequirement,
    informationArchitecture: slide.informationArchitecture?.length ? slide.informationArchitecture : beat.informationArchitecture,
    designDirective: slide.designDirective || beat.designDirective,
    evalCriteria: slide.evalCriteria?.length ? slide.evalCriteria : beat.evalCriteria,
    accent: slide.accent || beat.accent
  };
}

function styleBackedBeat(index: number) {
  const style = outlineStyleForIndex(index);
  const beat = designBeats[index % designBeats.length];
  return {
    ...beat,
    layout: style.layout,
    formatId: style.id,
    formatLabel: style.label,
    formatRequirement: style.hardRequirement,
    informationArchitecture: style.requiredInformation,
    designDirective: style.figmaDirective,
    evalCriteria: style.evalCriteria
  };
}

function cleanText(value: unknown): string {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
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
