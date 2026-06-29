export type AgentId =
  | "story"
  | "evidence"
  | "visual"
  | "figma"
  | "critic"
  | "synthesizer"
  | "polisher";

export type SlideLayout =
  | "opener"
  | "thesis"
  | "evidence"
  | "workflow"
  | "before-after"
  | "metric"
  | "demo"
  | "system-map"
  | "quote"
  | "artifact"
  | "closing";

export interface GbrainHit {
  source: string;
  title: string;
  excerpt: string;
  score?: number;
  url?: string;
}

export interface AgentFinding {
  agentId: AgentId;
  label: string;
  summary: string;
  slideIdeas: Array<{
    title: string;
    headline: string;
    visual: string;
    evidence: string;
  }>;
  risks: string[];
  latencyMs?: number;
  tokensPerSecond?: number;
}

export interface SlideSpec {
  id: string;
  title: string;
  headline: string;
  body: string;
  bullets: string[];
  evidence: string[];
  visual: string;
  layout: SlideLayout;
  formatId?: string;
  formatLabel?: string;
  formatRequirement?: string;
  informationArchitecture?: string[];
  designDirective?: string;
  evalCriteria?: string[];
  accent: string;
  speakerNotes: string;
}

export interface DeckSpec {
  title: string;
  audience: string;
  thesis: string;
  narrativeArc: string[];
  slides: SlideSpec[];
  demoScript: string[];
  figmaSpec: FigmaDeckSpec;
}

export interface FigmaDeckSpec {
  deckTitle: string;
  theme: {
    background: string;
    ink: string;
    accent: string;
    secondaryAccent: string;
  };
  slides: Array<{
    id: string;
    title: string;
    headline: string;
    layout: SlideLayout;
    formatId?: string;
    formatLabel?: string;
    formatRequirement?: string;
    informationArchitecture?: string[];
    designDirective?: string;
    evalCriteria?: string[];
    blocks: Array<{
      kind: "headline" | "body" | "bullets" | "evidence" | "visual" | "requirement" | "design";
      text: string;
    }>;
    notes: string;
  }>;
}

export type FigmaBuildPhase = "build" | "review" | "revise" | "polish" | "finalize";

export interface FigmaSlideBuildStage {
  slideId: string;
  title: string;
  phase: FigmaBuildPhase;
  status: "queued" | "running" | "done";
  summary: string;
}

export interface FigmaBuildPlan {
  script: string;
  stages: FigmaSlideBuildStage[];
  checklist: string[];
  target: "figma-design-frames" | "figma-slides";
}

export interface FigmaBridgeStatus {
  ok: boolean;
  serverRunning: boolean;
  port?: number;
  connected: boolean;
  fileName?: string;
  fileKey?: string;
  currentPage?: string;
  detectedFigmaPorts?: number[];
  message: string;
}

export interface FigmaBuildResponse {
  ok: boolean;
  status: FigmaBridgeStatus;
  plan?: FigmaBuildPlan;
  result?: unknown;
  error?: string;
}

export interface FeedbackEntry {
  id: string;
  createdAt: string;
  deckTitle: string;
  rating: number;
  notes: string;
  keep: string;
  change: string;
}

export interface GenerateRequest {
  idea: string;
  audience: string;
  brainstormNotes: string;
  gbrainContext: string;
  slideCount: number;
}

export interface PolishRequest {
  deck: DeckSpec;
  instruction: string;
}

export interface BrainstormResponse {
  questions: string[];
  sharperAngle: string;
  assumptions: string[];
  agentDrafts?: SwarmTextDraft[];
  finalBrief?: string;
  keyMessages?: string[];
  audience?: string;
}

export interface SwarmTextDraft {
  agentId: string;
  label: string;
  angle: string;
  draft: string;
  diagnosis?: string;
  revision?: string;
  status: "running" | "done" | "error";
  elapsedMs?: number;
}

export interface ApiErrorShape {
  error: string;
  detail?: string;
}

export const DEFAULT_ACCENTS = ["#0E7C66", "#D95D39", "#2D6CDF", "#E0A928", "#8A4FFF"];

export function isDeckSpec(value: unknown): value is DeckSpec {
  const deck = value as DeckSpec;
  return Boolean(
    deck &&
      typeof deck.title === "string" &&
      typeof deck.thesis === "string" &&
      Array.isArray(deck.slides) &&
      deck.slides.every((slide) => typeof slide.title === "string" && Array.isArray(slide.bullets))
  );
}
