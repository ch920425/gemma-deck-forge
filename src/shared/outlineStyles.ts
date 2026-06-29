import type { SlideLayout } from "./schema";

export type SlideFormatId =
  | "cold-open"
  | "stakes-thesis"
  | "context-map"
  | "evidence-wall"
  | "workflow-loop"
  | "before-after"
  | "speed-metric"
  | "system-map"
  | "critique-fix"
  | "operator-close";

export interface SlideOutlineStyle {
  id: SlideFormatId;
  label: string;
  layout: SlideLayout;
  purpose: string;
  hardRequirement: string;
  requiredInformation: string[];
  why: string;
  draftPrompt: string;
  evalCriteria: string[];
  figmaDirective: string;
}

export const SLIDE_OUTLINE_STYLES: SlideOutlineStyle[] = [
  {
    id: "cold-open",
    label: "Cold Open Demo Promise",
    layout: "opener",
    purpose: "Open with the live product promise and make speed visible before explaining architecture.",
    hardRequirement: "Must state the demoable transformation in one sentence and name the real artifact created in Figma.",
    requiredInformation: ["raw input", "agent swarm output", "Figma Slides artifact"],
    why: "Judges need to understand the product in under five seconds.",
    draftPrompt:
      "Write a punchy opener that makes the viewer expect a live idea-to-Figma transformation, not a generic AI slide generator.",
    evalCriteria: ["headline is under 15 words", "names Figma output", "does not use vague AI hype"],
    figmaDirective: "Dark branded opener with one dominant headline and two Speak-style file reference thumbnails."
  },
  {
    id: "stakes-thesis",
    label: "Stakes Thesis",
    layout: "thesis",
    purpose: "Explain why Cerebras latency changes the product category.",
    hardRequirement: "Must compare slow batch generation with live collaborative iteration.",
    requiredInformation: ["latency pain", "Cerebras speed behavior", "human-in-the-loop benefit"],
    why: "This makes the hardware advantage part of UX, not a benchmark footnote.",
    draftPrompt:
      "Write a thesis slide that argues speed changes the workflow shape: users can think while agents keep improving.",
    evalCriteria: ["clear before/after claim", "Cerebras is central", "human judgment remains visible"],
    figmaDirective: "Light thesis layout with a left rail, two claim chips, and one local Speak pacing reference."
  },
  {
    id: "context-map",
    label: "Context Classification Map",
    layout: "evidence",
    purpose: "Show how messy input becomes categorized deck-useful context.",
    hardRequirement: "Must categorize source material into at least three buckets and include one caveat bucket.",
    requiredInformation: ["gbrain or Obsidian source", "theme clusters", "risk or caveat"],
    why: "Grounding is only believable when the organization step is visible.",
    draftPrompt:
      "Classify the user's idea and context into source buckets, deck implications, proof candidates, and caveats.",
    evalCriteria: ["has three or more buckets", "includes a caveat", "does not invent proof"],
    figmaDirective: "Evidence wall with six asymmetric source cards and a vertical Speak component proof strip."
  },
  {
    id: "evidence-wall",
    label: "Evidence Wall",
    layout: "workflow",
    purpose: "Make the strongest proof artifacts visible as a scan-friendly working board.",
    hardRequirement: "Must separate source proof from agent interpretation.",
    requiredInformation: ["source artifact", "agent note", "how it supports the claim"],
    why: "Top-tier decks show why a claim is believable, not just what the claim is.",
    draftPrompt:
      "Draft evidence cards that distinguish direct source snippets from the agent's synthesis of their meaning.",
    evalCriteria: ["source and synthesis are separate", "each card supports one claim", "no unsupported certainty"],
    figmaDirective: "Process board with connected steps and evidence cards, using neutral whitespace and one accent path."
  },
  {
    id: "workflow-loop",
    label: "Agent Workflow Loop",
    layout: "before-after",
    purpose: "Show the sequence from idea to outline to Figma mutation to feedback memory.",
    hardRequirement: "Must describe the loop as ordered stages, not a static architecture diagram.",
    requiredInformation: ["input stage", "agent stage", "Figma write stage", "feedback stage"],
    why: "The demo needs to feel agentic because the loop improves over time.",
    draftPrompt:
      "Write the workflow as a loop where every stage creates a useful artifact that the next stage consumes.",
    evalCriteria: ["ordered stages are explicit", "feedback loop is present", "Figma is a real write target"],
    figmaDirective: "Before/after contrast slide that visually shows generic output being replaced by slide-specific jobs."
  },
  {
    id: "before-after",
    label: "Before / After Contrast",
    layout: "metric",
    purpose: "Call out the exact failure mode the product fixes.",
    hardRequirement: "Must name the old broken state and the new observable behavior.",
    requiredInformation: ["old state", "new state", "observable demo proof"],
    why: "A contrast slide prevents the deck from becoming abstract.",
    draftPrompt:
      "Write a before/after slide that says what was weak before and what becomes visibly better in the demo.",
    evalCriteria: ["old and new states are concrete", "demo proof is included", "no generic productivity claim"],
    figmaDirective: "Dark metric slide with a large speed number and compact bars that prove progress over time."
  },
  {
    id: "speed-metric",
    label: "Speed Metric Proof",
    layout: "system-map",
    purpose: "Quantify the Figma action burst and the visible eval/fix loop.",
    hardRequirement: "Must include a measurable speed target and what counts as a meaningful action.",
    requiredInformation: ["actions per second", "slide count", "eval/fix duration"],
    why: "The hackathon demo needs an unmistakable speed receipt.",
    draftPrompt:
      "Turn the live performance target into a metric claim with a definition of visible Figma action quality.",
    evalCriteria: ["5+ actions/sec target appears", "10 slides appear", "meaningful action is defined"],
    figmaDirective: "System map with lanes converging on a deck hub, showing action rate as an operational path."
  },
  {
    id: "system-map",
    label: "Swarm System Map",
    layout: "quote",
    purpose: "Assign distinct responsibilities to the Gemma agents.",
    hardRequirement: "Must name at least five agent roles and the failure mode each role catches.",
    requiredInformation: ["story role", "evidence role", "visual role", "critic role", "Figma role"],
    why: "Parallelism is more convincing when each lane has a different job.",
    draftPrompt:
      "Write a map of the Gemma army where each role catches a different weakness in the deck creation process.",
    evalCriteria: ["five roles are named", "roles are not redundant", "failure modes are specific"],
    figmaDirective: "Bold quote-style critique slide with a large statement and one local Speak design cue."
  },
  {
    id: "critique-fix",
    label: "Critique / Fix Pass",
    layout: "artifact",
    purpose: "Make self-evaluation and repair visible after the draft outline exists.",
    hardRequirement: "Must show a diagnosis, a concrete fix, and the criterion that made the fix necessary.",
    requiredInformation: ["diagnosis", "fix", "acceptance criterion"],
    why: "The strongest demo moment is the system catching and repairing its own weak work.",
    draftPrompt:
      "Draft a critique/fix slide that proves the system did not just generate once; it evaluated and repaired the deck.",
    evalCriteria: ["diagnosis is specific", "fix is visible", "criterion is testable"],
    figmaDirective: "Artifact slide with a large Speak reference thumbnail and agentic notes on the right."
  },
  {
    id: "operator-close",
    label: "Operator Handoff Close",
    layout: "closing",
    purpose: "Close by showing the user can inspect, edit, and ship the deck in Figma.",
    hardRequirement: "Must end with the concrete operator action after generation.",
    requiredInformation: ["final artifact", "operator action", "why it matters now"],
    why: "The close should leave the judge with a usable product, not only an impressive generation trick.",
    draftPrompt:
      "Write a closing slide that hands the finished Figma deck to the operator and makes the next action obvious.",
    evalCriteria: ["operator action is explicit", "artifact is named", "ending is not a slogan"],
    figmaDirective: "Dark close with three command chips and a final Speak component cue."
  }
];

export function outlineStyleForIndex(index: number): SlideOutlineStyle {
  return SLIDE_OUTLINE_STYLES[index % SLIDE_OUTLINE_STYLES.length];
}

export function formatOutlineStylePrompt(): string {
  return SLIDE_OUTLINE_STYLES.map((style, index) =>
    [
      `${index + 1}. ${style.label} (${style.id}, layout: ${style.layout})`,
      `   Purpose: ${style.purpose}`,
      `   Hard requirement: ${style.hardRequirement}`,
      `   Required information: ${style.requiredInformation.join("; ")}`,
      `   Why: ${style.why}`,
      `   Draft instruction: ${style.draftPrompt}`,
      `   Eval criteria: ${style.evalCriteria.join("; ")}`,
      `   Figma directive: ${style.figmaDirective}`
    ].join("\n")
  ).join("\n");
}
