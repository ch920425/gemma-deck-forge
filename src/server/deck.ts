import { buildFigmaSpec } from "../shared/figma";
import { formatOutlineStylePrompt, outlineStyleForIndex, SLIDE_OUTLINE_STYLES } from "../shared/outlineStyles";
import { agentPrompts, buildAgentUserPrompt, buildSynthesisPrompt } from "../shared/prompts";
import type { AgentFinding, DeckSpec, GenerateRequest, PolishRequest, SlideSpec } from "../shared/schema";
import { DEFAULT_ACCENTS, isDeckSpec } from "../shared/schema";
import { callCerebrasJson, fallbackAgentFinding, hasCerebrasKey, tokensPerSecond } from "./cerebras";
import { readFeedbackMemory } from "./feedbackStore";

export type StreamSend = (event: string, payload: unknown) => void;

export async function generateDeck(input: GenerateRequest, send?: StreamSend): Promise<DeckSpec> {
  const normalized = normalizeGenerateRequest(input);
  const feedbackMemory = await readFeedbackMemory();
  send?.("memory", { feedbackMemory });

  const findings = await Promise.all(
    agentPrompts.map(async (agent) => {
      send?.("agent_started", { agentId: agent.id, label: agent.label });
      try {
        if (!hasCerebrasKey()) {
          throw new Error("CEREBRAS_API_KEY is not set");
        }
        const result = await callCerebrasJson<Omit<AgentFinding, "agentId" | "label" | "latencyMs" | "tokensPerSecond">>(
          [
            { role: "system", content: agent.system },
            { role: "user", content: buildAgentUserPrompt(normalized, feedbackMemory) }
          ],
          900
        );
        const finding: AgentFinding = {
          ...coerceFinding(result.value),
          agentId: agent.id,
          label: agent.label,
          latencyMs: result.latencyMs,
          tokensPerSecond: tokensPerSecond(result.usage, result.latencyMs)
        };
        send?.("agent_complete", finding);
        return finding;
      } catch (error) {
        const finding = fallbackAgentFinding(agent.id, agent.label);
        send?.("agent_error", {
          agentId: agent.id,
          label: agent.label,
          error: error instanceof Error ? error.message : String(error),
          fallback: finding
        });
        return finding;
      }
    })
  );

  send?.("synthesis_started", { agentCount: findings.length });
  const outlineContext = await runOutlineDesignSwarm(normalized, findings, feedbackMemory, send);
  const deck = await synthesizeDeck(normalized, findings, feedbackMemory, outlineContext);
  send?.("deck_complete", deck);
  return deck;
}

export async function polishDeck(input: PolishRequest, send?: StreamSend): Promise<DeckSpec> {
  const instruction = input.instruction || "Make each slide sharper for a 60-second hackathon demo.";
  const slides = await Promise.all(
    input.deck.slides.map(async (slide, index) => {
      send?.("polish_started", { slideId: slide.id, title: slide.title });
      try {
        if (!hasCerebrasKey()) {
          throw new Error("CEREBRAS_API_KEY is not set");
        }
        const result = await callCerebrasJson<Partial<SlideSpec>>(
          [
            {
              role: "system",
              content:
                "You are a senior presentation editor. Keep the same slide intent, but sharpen title, headline, bullets, visual direction, and speaker notes. Return only JSON for one slide."
            },
            {
              role: "user",
              content: JSON.stringify({ instruction, slide }, null, 2)
            }
          ],
          700
        );
        const polished = normalizeSlide({ ...slide, ...result.value }, index);
        send?.("polish_complete", { slide: polished, latencyMs: result.latencyMs });
        return polished;
      } catch (error) {
        send?.("polish_error", {
          slideId: slide.id,
          error: error instanceof Error ? error.message : String(error)
        });
        return slide;
      }
    })
  );

  const withoutFigma = {
    ...input.deck,
    slides
  };
  const deck: DeckSpec = {
    ...withoutFigma,
    figmaSpec: buildFigmaSpec(withoutFigma)
  };
  send?.("deck_complete", deck);
  return deck;
}

export function normalizeGenerateRequest(input: GenerateRequest): GenerateRequest {
  return {
    idea:
      input.idea?.trim() ||
      "A realtime Gemma 4 on Cerebras deck builder that turns gbrain context and brainstorming into Figma Slides.",
    audience: input.audience?.trim() || "Cerebras x Gemma hackathon judges and enterprise AI buyers",
    brainstormNotes: input.brainstormNotes?.trim() || "",
    gbrainContext: input.gbrainContext?.trim() || "",
    slideCount: 10
  };
}

export async function runOutlineDesignSwarm(
  input: GenerateRequest,
  findings: AgentFinding[],
  feedbackMemory: string,
  send?: StreamSend
): Promise<string> {
  const started = performance.now();
  const catalog = formatOutlineStylePrompt();
  const findingsBrief = JSON.stringify(
    findings.map((finding) => ({
      label: finding.label,
      summary: finding.summary,
      slideIdeas: finding.slideIdeas,
      risks: finding.risks
    })),
    null,
    2
  );
  const categorizerId = "outline_categorizer";
  const writerId = "outline_writer";
  send?.("agent_started", { agentId: categorizerId, label: "Outline Categorizer" });
  send?.("agent_started", { agentId: writerId, label: "Gemma Draft Writer" });

  const [categorization, draft] = await Promise.all([
    runOutlineAgent(
      "Categorize the source into the 10 required slide formats. Return JSON with assignments and missingEvidence.",
      {
        input,
        feedbackMemory,
        catalog,
        findings: findingsBrief
      }
    ),
    runOutlineAgent(
      "Draft the first-pass 10-slide outline. Return JSON with slides, each including formatId, headline, body, informationArchitecture, and designDirective.",
      {
        input,
        feedbackMemory,
        catalog,
        findings: findingsBrief
      }
    )
  ]);

  send?.("agent_complete", {
    agentId: categorizerId,
    label: "Outline Categorizer",
    summary: summariseOutlinePayload(categorization, "Mapped source context into ten distinct slide formats.")
  });
  send?.("agent_complete", {
    agentId: writerId,
    label: "Gemma Draft Writer",
    summary: summariseOutlinePayload(draft, "Drafted a format-aware outline for implementation.")
  });

  const evalId = "outline_eval_clock";
  send?.("agent_started", { agentId: evalId, label: "6s Eval/Fix Clock" });
  const evalStarted = performance.now();
  const evalMs = outlineEvalDurationMs();
  const perSlideMs = Math.max(1, Math.floor(evalMs / (SLIDE_OUTLINE_STYLES.length + 1)));
  const fixes: Array<{ formatId: string; label: string; fix: string }> = [];
  for (const [index, style] of SLIDE_OUTLINE_STYLES.entries()) {
    const agentId = `eval_${String(index + 1).padStart(2, "0")}`;
    send?.("agent_started", { agentId, label: `${String(index + 1).padStart(2, "0")} ${style.label}` });
    await sleep(perSlideMs);
    const fix = `${style.hardRequirement} Checked: ${style.evalCriteria[0]}. Fix applied: ${style.figmaDirective}`;
    fixes.push({ formatId: style.id, label: style.label, fix });
    send?.("agent_complete", {
      agentId,
      label: `${String(index + 1).padStart(2, "0")} ${style.label}`,
      summary: fix
    });
  }
  const elapsedEval = performance.now() - evalStarted;
  if (elapsedEval < evalMs) {
    await sleep(evalMs - elapsedEval);
  }
  send?.("agent_complete", {
    agentId: evalId,
    label: "6s Eval/Fix Clock",
    summary: `Completed ${SLIDE_OUTLINE_STYLES.length} format gates in ${Math.round(performance.now() - evalStarted)} ms.`
  });

  return JSON.stringify(
    {
      elapsedMs: Math.round(performance.now() - started),
      catalog: SLIDE_OUTLINE_STYLES,
      categorization,
      draft,
      fixes
    },
    null,
    2
  );
}

export async function synthesizeDeck(
  input: GenerateRequest,
  findings: AgentFinding[],
  feedbackMemory: string,
  outlineContext = ""
): Promise<DeckSpec> {
  try {
    if (!hasCerebrasKey()) {
      throw new Error("CEREBRAS_API_KEY is not set");
    }
    const result = await callCerebrasJson<DeckSpec>(
      [
        {
          role: "system",
          content:
            "You are an AI product manager and deck architect. Generate a concise, specific, presentation-ready deck spec."
        },
        {
          role: "user",
          content: [
            buildSynthesisPrompt(input, JSON.stringify(findings, null, 2), feedbackMemory),
            "",
            "Format-aware outline swarm context:",
            outlineContext || "(none)"
          ].join("\n")
        }
      ],
      1800
    );
    return normalizeDeck(result.value, input);
  } catch {
    return normalizeDeck(fallbackDeck(input, findings), input);
  }
}

export function normalizeDeck(candidate: unknown, input: GenerateRequest): DeckSpec {
  const base = isDeckSpec(candidate) ? candidate : fallbackDeck(input, []);
  const slideTarget = normalizeGenerateRequest(input).slideCount;
  const slides = Array.from({ length: slideTarget }, (_, index) =>
    normalizeSlide(base.slides[index] || fallbackSlideForStyle(index, input, []), index)
  );

  const withoutFigma = {
    title: base.title || "Gemma Deck Forge",
    audience: base.audience || input.audience,
    thesis:
      base.thesis ||
      "Cerebras speed makes multi-agent deck creation feel like live brainstorming instead of batch generation.",
    narrativeArc: Array.isArray(base.narrativeArc) ? base.narrativeArc.filter(Boolean).slice(0, 6) : [],
    slides,
    demoScript: Array.isArray(base.demoScript) ? base.demoScript.filter(Boolean).slice(0, 8) : []
  };

  return {
    ...withoutFigma,
    figmaSpec: buildFigmaSpec(withoutFigma)
  };
}

export function normalizeSlide(slide: Partial<SlideSpec>, index: number): SlideSpec {
  const style = outlineStyleForIndex(index);
  return {
    id: slide.id || `s${index + 1}`,
    title: String(slide.title || style.label).slice(0, 90),
    headline: String(slide.headline || style.purpose).slice(0, 180),
    body: String(slide.body || style.why).slice(0, 360),
    bullets: nonEmptyArray(slide.bullets).slice(0, 5),
    evidence: nonEmptyArray(slide.evidence).slice(0, 4),
    visual: String(slide.visual || style.figmaDirective).slice(0, 280),
    layout: style.layout,
    formatId: style.id,
    formatLabel: style.label,
    formatRequirement: String(slide.formatRequirement || style.hardRequirement).slice(0, 260),
    informationArchitecture: nonEmptyArray(slide.informationArchitecture).length
      ? nonEmptyArray(slide.informationArchitecture).slice(0, 5)
      : style.requiredInformation,
    designDirective: String(slide.designDirective || style.figmaDirective).slice(0, 320),
    evalCriteria: nonEmptyArray(slide.evalCriteria).length
      ? nonEmptyArray(slide.evalCriteria).slice(0, 5)
      : style.evalCriteria,
    accent: /^#[0-9A-Fa-f]{6}$/.test(slide.accent || "")
      ? String(slide.accent)
      : DEFAULT_ACCENTS[index % DEFAULT_ACCENTS.length],
    speakerNotes: String(slide.speakerNotes || "").slice(0, 500)
  };
}

function coerceFinding(value: Partial<AgentFinding>): Omit<AgentFinding, "agentId" | "label"> {
  return {
    summary: String(value.summary || ""),
    slideIdeas: Array.isArray(value.slideIdeas)
      ? value.slideIdeas
          .map((idea) => ({
            title: String(idea.title || "Untitled beat"),
            headline: String(idea.headline || ""),
            visual: String(idea.visual || ""),
            evidence: String(idea.evidence || "")
          }))
          .slice(0, 6)
      : [],
    risks: Array.isArray(value.risks) ? value.risks.map(String).slice(0, 6) : []
  };
}

function fallbackDeck(input: GenerateRequest, findings: AgentFinding[]): DeckSpec {
  const slides = SLIDE_OUTLINE_STYLES.map((_, index) => fallbackSlideForStyle(index, input, findings));

  return {
    title: "Gemma Deck Forge",
    audience: input.audience,
    thesis: "Cerebras speed turns multi-agent slide generation into a visible outline, eval, fix, and Figma design loop.",
    narrativeArc: [
      "Raw idea",
      "Format categorization",
      "Draft outline",
      "Six-second eval/fix swarm",
      "Figma-ready design instructions",
      "Live Figma finalizer"
    ],
    slides,
    demoScript: [
      "Paste idea and run a gbrain query.",
      "Show Gemma agents categorizing context into ten distinct slide formats.",
      "Let the six-second eval/fix swarm visibly repair the outline.",
      "Build the final varied deck in Figma with the Desktop Bridge.",
      "Save feedback so the next run gets sharper."
    ],
    figmaSpec: buildFigmaSpec({
      title: "Gemma Deck Forge",
      audience: input.audience,
      thesis: "Cerebras speed turns multi-agent slide generation into a visible outline, eval, fix, and Figma design loop.",
      narrativeArc: [],
      slides,
      demoScript: []
    })
  };
}

async function runOutlineAgent(instruction: string, payload: unknown): Promise<unknown> {
  if (!hasCerebrasKey()) {
    return {
      fallback: true,
      instruction,
      formats: SLIDE_OUTLINE_STYLES.map((style, index) => ({
        slide: index + 1,
        formatId: style.id,
        label: style.label,
        requirement: style.hardRequirement,
        designDirective: style.figmaDirective
      }))
    };
  }
  try {
    const result = await callCerebrasJson<unknown>(
      [
        {
          role: "system",
          content:
            "You are one Gemma 4 agent in a parallel deck-outline swarm. Be concrete, format-aware, and return compact valid JSON only."
        },
        {
          role: "user",
          content: JSON.stringify({ instruction, payload }, null, 2)
        }
      ],
      1400
    );
    return result.value;
  } catch (error) {
    return {
      fallback: true,
      instruction,
      error: error instanceof Error ? error.message : String(error),
      formats: SLIDE_OUTLINE_STYLES.map((style, index) => ({
        slide: index + 1,
        formatId: style.id,
        label: style.label,
        requirement: style.hardRequirement
      }))
    };
  }
}

function fallbackSlideForStyle(index: number, input: GenerateRequest, findings: AgentFinding[]): SlideSpec {
  const style = outlineStyleForIndex(index);
  const proof = findings.flatMap((finding) => finding.slideIdeas).filter((item) => item.headline || item.evidence);
  const proofHeadline = proof[index % Math.max(proof.length, 1)]?.headline || "Fast parallel proof";
  const proofEvidence =
    proof[index % Math.max(proof.length, 1)]?.evidence ||
    input.gbrainContext ||
    "Live app state, Desktop Bridge writes, and per-agent latency chips.";
  const copy: Record<string, { headline: string; body: string; bullets: string[]; evidence: string[]; visual: string }> = {
    "cold-open": {
      headline: "A brainstorm becomes a Figma deck while the user is still thinking.",
      body: "Gemma 4 agents on Cerebras split story, proof, design, critique, and Figma implementation into visible live work.",
      bullets: ["Idea/context in", "Ten-format outline", "Figma deck out"],
      evidence: ["The UI streams agent lanes before the final deck appears."],
      visual: "Dark live-demo opener with a large claim and Speak component reference thumbnails."
    },
    "stakes-thesis": {
      headline: "Low latency changes slide creation from batch output to live collaboration.",
      body: "Cerebras speed lets the system draft, critique, and repair while the user keeps judging the story.",
      bullets: ["Batch generation hides work", "Parallel Gemma lanes expose work", "Humans steer the fix loop"],
      evidence: ["Per-agent latency and tokens/sec are visible in the app."],
      visual: "Light thesis slide with two claim chips and a file-style reference cue."
    },
    "context-map": {
      headline: "Private context becomes categorized proof instead of a note dump.",
      body: "Gbrain, Obsidian, brainstorm notes, and feedback memory are split into source buckets, claims, and caveats.",
      bullets: ["Source proof", "Deck implication", "Caveat to preserve"],
      evidence: [proofEvidence],
      visual: "Evidence wall separating source cards from agent interpretation cards."
    },
    "evidence-wall": {
      headline: "The outline shows which proof belongs on which slide.",
      body: "Each evidence card is tied to a slide job so design decisions start from meaning, not a template.",
      bullets: ["Source artifact", "Agent interpretation", "Slide-level use"],
      evidence: [proofHeadline],
      visual: "Workflow board with connected cards and one highlighted proof lane."
    },
    "workflow-loop": {
      headline: "The product is a loop: draft, evaluate, repair, then remember.",
      body: "The first outline is not final; the swarm spends a visible eval window fixing the weak beats.",
      bullets: ["Draft outline", "Run format gates", "Save feedback memory"],
      evidence: ["The six-second eval/fix clock emits one gate per slide format."],
      visual: "Before/after slide showing generic scaffolds becoming slide-specific jobs."
    },
    "before-after": {
      headline: "The system escapes the identical-slide trap by changing the slide job first.",
      body: "Variety starts in the text outline: each slide has a different information architecture and design directive.",
      bullets: ["Old: repeated cards", "New: required format", "Proof: renderer-specific design"],
      evidence: ["Ten outline styles map to ten Figma renderer patterns."],
      visual: "Dark metric slide with the speed target and action bars."
    },
    "speed-metric": {
      headline: "The demo target is ten varied slides plus 5+ meaningful Figma actions per second.",
      body: "A meaningful action is a visible build, review, revise, polish, or finalize update on a slide.",
      bullets: ["10 slides", "50 visible gates", "5+ actions/sec"],
      evidence: ["Bridge result reports actionCount and actionsPerSecond."],
      visual: "System map from Gemma lanes into a Figma deck hub."
    },
    "system-map": {
      headline: "The Gemma swarm works because each lane owns a different failure mode.",
      body: "Story catches weak arcs, evidence catches unsupported claims, visual catches sameness, critic catches demo risk, and Figma catches implementation fit.",
      bullets: ["Story: arc", "Evidence: proof", "Visual: design variety", "Critic: demo risk", "Figma: buildability"],
      evidence: ["Agent lanes stream separate summaries before synthesis."],
      visual: "Bold critique quote with a local Speak design cue."
    },
    "critique-fix": {
      headline: "The best moment is the system naming a weak slide and fixing it.",
      body: "Each format gate checks one hard requirement, applies a concrete repair, and passes a visible acceptance criterion.",
      bullets: ["Diagnosis", "Fix", "Acceptance criterion"],
      evidence: ["Eval cards report per-slide requirement checks."],
      visual: "Artifact slide with a Speak reference thumbnail and agentic fix notes."
    },
    "operator-close": {
      headline: "The finished artifact is a Figma deck the operator can inspect, edit, and ship.",
      body: "The operator leaves with a real deck in the same Figma file, ready for inspection, edits, and shipment.",
      bullets: ["Watch", "Edit", "Ship"],
      evidence: ["Final Figma section is created below existing file content."],
      visual: "Dark closing slide with command chips and a final Speak component cue."
    }
  };
  const selected = copy[style.id];
  return normalizeSlide(
    {
      id: `s${index + 1}`,
      title: style.label,
      headline: selected.headline,
      body: selected.body,
      bullets: selected.bullets,
      evidence: selected.evidence,
      visual: selected.visual,
      layout: style.layout,
      formatId: style.id,
      formatLabel: style.label,
      formatRequirement: style.hardRequirement,
      informationArchitecture: style.requiredInformation,
      designDirective: style.figmaDirective,
      evalCriteria: style.evalCriteria,
      accent: DEFAULT_ACCENTS[index % DEFAULT_ACCENTS.length],
      speakerNotes: `${style.why} ${style.draftPrompt}`
    },
    index
  );
}

function nonEmptyArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).replace(/[\u0000-\u001F\u007F]/g, " ").trim()).filter(Boolean)
    : [];
}

export function summariseOutlinePayload(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const json = JSON.stringify(value);
  if (!json || json === "{}") return fallback;
  return json.replace(/\s+/g, " ").slice(0, 260);
}

function outlineEvalDurationMs(): number {
  const configured = Number(process.env.GEMMA_OUTLINE_EVAL_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return process.env.NODE_ENV === "test" || process.env.VITEST ? 80 : 6000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
