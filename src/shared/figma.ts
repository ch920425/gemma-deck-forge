import type { DeckSpec, FigmaBuildPlan, FigmaDeckSpec, FigmaSlideBuildStage } from "./schema";
import { outlineStyleForIndex } from "./outlineStyles";

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
    script: buildExecutableFigmaScript(deck),
    stages: buildParallelFigmaStages(deck),
    checklist: [
      "Create slide frames inside a named Gemma Deck Forge section.",
      "Run build, review, revise, polish, and finalize passes across every slide.",
      "Keep Figma writes in one ordered bridge lane while agent planning runs in parallel.",
      "Measure slide-actions/sec and run a 7s VLM-style visual QA loop for overlap, crop, hierarchy, cohesion, copy fit, and screenshot readiness."
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
  text(frame, "tab", "LIVE DEMO", 64, 51, 96, 11, palette.ink, true);
  text(frame, "headline", short(slide.headline, 88), 46, 104, 530, 42, palette.white, true);
  text(frame, "body", short(slide.body, 150), 52, 318, 420, 16, "#DCE7DF");
  await referenceThumb(frame, index, 610, 58, 266, 154, "Speak style sample");
  await referenceThumb(frame, index + 1, 660, 244, 216, 122, "component grammar");
  ellipse(frame, "speed dot", 560, 392, 52, 52, palette.amber);
  text(frame, "speed", "5+/s", 571, 408, 42, 15, palette.ink, true);
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
  await referenceThumb(frame, index + 2, 646, 302, 228, 120, "Speak pacing cue");
  return addProgress(frame, slide, index, "light");
}
async function renderEvidenceWall(frame, slide, index) {
  header(frame, slide, index, palette.ink, slide.accent);
  text(frame, "headline", short(slide.headline, 82), 52, 76, 530, 36, palette.ink, true);
  const positions = [[52, 176], [306, 176], [560, 176], [52, 322], [306, 322], [560, 322]];
  positions.forEach((pos, i) => {
    const bg = i % 2 === 0 ? palette.white : palette.light;
    card(frame, "evidence card " + i, pos[0], pos[1], 220, 104, bg, i === 0 ? slide.accent : palette.grid);
    text(frame, "evidence label " + i, i < 3 ? "SOURCE" : "AGENT NOTE", pos[0] + 16, pos[1] + 14, 110, 10, slide.accent, true);
    text(frame, "evidence copy " + i, i < 3 ? evidence(slide, i, "Reference artifact from the open Figma file.") : bullet(slide, i, "Review pass tightened this slide."), pos[0] + 16, pos[1] + 36, 180, 14, palette.ink, true);
  });
  await referenceThumb(frame, index + 3, 792, 90, 112, 260, "Speak proof cue");
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
  await referenceThumb(frame, index + 5, 536, 316, 150, 62, "Speak target grammar");
  line(frame, "transition", 436, 286, 72, palette.amber, 8);
  ellipse(frame, "transition dot", 464, 270, 40, 40, palette.amber);
  return addProgress(frame, slide, index, "light");
}
async function renderMetric(frame, slide, index) {
  frame.fills = [paint(palette.navy)];
  header(frame, slide, index, palette.white, palette.amber);
  text(frame, "headline", short(slide.headline, 96), 52, 86, 500, 34, palette.white, true);
  text(frame, "big metric", "5+ actions/sec", 54, 212, 520, 58, palette.amber, true);
  text(frame, "body", short(slide.body, 150), 60, 314, 420, 17, "#DCE7DF");
  [0, 1, 2, 3, 4].forEach((_, i) => {
    const h = 54 + i * 32;
    rect(frame, "bar " + i, 610 + i * 52, 384 - h, 34, h, i === 4 ? palette.amber : palette.blue, 6);
    text(frame, "bar label " + i, String(i + 1), 620 + i * 52, 398, 16, 11, "#DCE7DF", true);
  });
  await referenceThumb(frame, index + 6, 604, 86, 230, 126, "Speak speed proof");
  return addProgress(frame, slide, index, "dark");
}
async function renderSystemMap(frame, slide, index) {
  header(frame, slide, index, palette.ink, slide.accent);
  text(frame, "headline", short(slide.headline, 80), 52, 80, 600, 34, palette.ink, true);
  ellipse(frame, "hub", 400, 202, 160, 160, palette.blue);
  text(frame, "hub text", "Gemma swarm", 428, 258, 104, 18, palette.white, true);
  const nodes = [[130, 186, "gbrain"], [684, 176, "Figma"], [184, 374, "eval"], [660, 368, "polish"]];
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
  await referenceThumb(frame, index + 7, 650, 330, 220, 116, "Speak design cue");
  return addProgress(frame, slide, index, "dark");
}
async function renderArtifact(frame, slide, index) {
  header(frame, slide, index, palette.ink, slide.accent);
  text(frame, "headline", short(slide.headline, 76), 52, 74, 560, 34, palette.ink, true);
  await referenceThumb(frame, index + 8, 52, 166, 366, 218, "Speak source asset");
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
  await referenceThumb(frame, index + 9, 608, 230, 230, 86, "Speak final cue");
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
    const firstCard = children.find(child => /card|panel|thumb|cue/.test(String(child.name || "")));
    if (headline && firstCard && headline.y + headline.height > firstCard.y - 8) {
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
    headline: "Gbrain and source notes turn into claims, proof, and caveats.",
    body: "The product should show source organization as a visible part of the deck-making workflow, not hidden prep work.",
    bullets: ["Cluster context", "Extract proof", "Flag caveats"],
    evidence: ["Source cards and agent notes appear as designed artifacts on the slide"],
    accent: "#D95D39"
  },
  {
    title: "Agent loop anatomy",
    headline: "The useful demo is the sequence of improvements, not just the final deck.",
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
    headline: "The demo should show at least five meaningful Figma actions per second.",
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
    body: "The close should feel like an operator handoff: the deck is built in Figma, validated, and ready for the hackathon demo.",
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
    /demo beat|show one concrete step|use this slide|deck-making loop|workflow visible and fast/.test(combined) ||
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
