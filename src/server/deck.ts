import { buildFigmaSpec } from "../shared/figma";
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
  const deck = await synthesizeDeck(normalized, findings, feedbackMemory);
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
    slideCount: Math.min(Math.max(Number(input.slideCount) || 6, 3), 10)
  };
}

export async function synthesizeDeck(
  input: GenerateRequest,
  findings: AgentFinding[],
  feedbackMemory: string
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
          content: buildSynthesisPrompt(input, JSON.stringify(findings, null, 2), feedbackMemory)
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
  const slides = base.slides.slice(0, slideTarget).map((slide, index) => normalizeSlide(slide, index));
  while (slides.length < slideTarget) {
    slides.push(
      normalizeSlide(
        {
          id: `s${slides.length + 1}`,
          title: `Demo beat ${slides.length + 1}`,
          headline: "Show one concrete step in the idea to Figma Slides loop.",
          body: "Use this slide to make the workflow visible and fast.",
          bullets: ["Context enters", "Gemma agents run", "Slides improve"],
          evidence: ["Live app state"],
          visual: "Workflow strip with one highlighted transition.",
          layout: "workflow",
          accent: DEFAULT_ACCENTS[slides.length % DEFAULT_ACCENTS.length],
          speakerNotes: "Narrate the concrete product step."
        },
        slides.length
      )
    );
  }

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
  const layout = normalizeLayout(slide.layout);
  return {
    id: slide.id || `s${index + 1}`,
    title: String(slide.title || `Slide ${index + 1}`).slice(0, 90),
    headline: String(slide.headline || slide.title || "Make the product value obvious.").slice(0, 180),
    body: String(slide.body || "").slice(0, 360),
    bullets: Array.isArray(slide.bullets) ? slide.bullets.map(String).filter(Boolean).slice(0, 5) : [],
    evidence: Array.isArray(slide.evidence) ? slide.evidence.map(String).filter(Boolean).slice(0, 4) : [],
    visual: String(slide.visual || "Strong single visual object with sparse labels.").slice(0, 280),
    layout,
    accent: /^#[0-9A-Fa-f]{6}$/.test(slide.accent || "")
      ? String(slide.accent)
      : DEFAULT_ACCENTS[index % DEFAULT_ACCENTS.length],
    speakerNotes: String(slide.speakerNotes || "").slice(0, 500)
  };
}

function normalizeLayout(layout: unknown): SlideSpec["layout"] {
  const allowed: SlideSpec["layout"][] = [
    "opener",
    "thesis",
    "evidence",
    "workflow",
    "before-after",
    "metric",
    "demo",
    "closing"
  ];
  return allowed.includes(layout as SlideSpec["layout"]) ? (layout as SlideSpec["layout"]) : "evidence";
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
  const idea = normalizeGenerateRequest(input).idea;
  const proof = findings.flatMap((finding) => finding.slideIdeas).slice(0, 3);
  const slides: SlideSpec[] = [
    {
      id: "s1",
      title: "Instant Deck Forge",
      headline: "A deck takes shape while the brainstorm is still happening.",
      body: "Gemma 4 agents on Cerebras split the work into story, evidence, visuals, Figma handoff, and critique.",
      bullets: ["Idea in", "Parallel agents", "Figma-ready slides"],
      evidence: ["Per-agent latency chips in the product UI"],
      visual: "Full-bleed app screenshot style: idea panel on left, five agent lanes racing on right.",
      layout: "opener",
      accent: "#0E7C66",
      speakerNotes: "Open on speed: this is not a batch deck generator, it is live co-authoring."
    },
    {
      id: "s2",
      title: "Why Cerebras matters",
      headline: "Low latency changes the shape of the workflow.",
      body: "The product uses parallel calls so each specialist agent can finish while the user keeps thinking.",
      bullets: ["No waiting for one giant response", "Visible agent collaboration", "Fast enough for live review"],
      evidence: ["Cerebras request timing surfaced in each run"],
      visual: "Latency race chart with agent lanes converging into slide cards.",
      layout: "metric",
      accent: "#D95D39",
      speakerNotes: "Judges should see speed as product behavior, not a benchmark footnote."
    },
    {
      id: "s3",
      title: "Gbrain becomes deck evidence",
      headline: "Private context turns into claims, proof, and caveats.",
      body: "The Supabase CLI path searches gbrain tables and feeds only relevant snippets into the agents.",
      bullets: ["Search pages and chunks", "Keep source excerpts", "Avoid invented proof"],
      evidence: [input.gbrainContext || "Supabase query output"],
      visual: "Evidence tray flowing into slide proof blocks.",
      layout: "evidence",
      accent: "#2D6CDF",
      speakerNotes: "This is the enterprise hook: internal knowledge becomes usable presentation evidence."
    },
    {
      id: "s4",
      title: "Feedback loop",
      headline: "Every run teaches the next run what to keep and what to change.",
      body: "Ratings and notes are saved locally, summarized, and injected into the next generation prompt.",
      bullets: ["Save signal", "Reuse preference", "Polish in parallel"],
      evidence: ["Feedback JSONL memory in the app data directory"],
      visual: "Loop from deck review to memory to next prompt.",
      layout: "workflow",
      accent: "#E0A928",
      speakerNotes: "The product improves without requiring a heavy training loop."
    },
    {
      id: "s5",
      title: "Figma handoff",
      headline: "The output is built for direct Figma Slides mutation.",
      body: "When the Desktop Bridge is connected, the generated spec can be handed to a Figma agent to create slides in place.",
      bullets: ["Structured layout spec", "Layer-ready text blocks", "Bridge prompt included"],
      evidence: ["Recovered Figma Slides MCP workflow"],
      visual: "Slide spec JSON transforming into Figma slide thumbnails.",
      layout: "demo",
      accent: "#8A4FFF",
      speakerNotes: "Be explicit if the bridge is disconnected during the live demo."
    },
    {
      id: "s6",
      title: "The bet",
      headline: "Cerebras speed makes multi-agent creative tools feel interactive.",
      body: `For ${idea}, the winning demo is the moment many agents finish useful slide work at once.`,
      bullets: proof.map((item) => item.headline).filter(Boolean).slice(0, 3),
      evidence: ["Live generation, live polish, Figma-ready export"],
      visual: "Before/after: blank prompt to polished slide outline in one screen.",
      layout: "closing",
      accent: "#0E7C66",
      speakerNotes: "Close by replaying the speed and the concrete deck output."
    }
  ];

  return {
    title: "Gemma Deck Forge",
    audience: input.audience,
    thesis: "Cerebras speed turns multi-agent slide generation into an interactive product loop.",
    narrativeArc: ["Raw idea", "Parallel interpretation", "Evidence grounding", "Figma-ready output", "Feedback improvement"],
    slides,
    demoScript: [
      "Paste idea and run a gbrain query.",
      "Show five Gemma agents completing in parallel with latency.",
      "Open the generated slide cards and Figma handoff.",
      "Save feedback, then polish slides in parallel."
    ],
    figmaSpec: buildFigmaSpec({
      title: "Gemma Deck Forge",
      audience: input.audience,
      thesis: "Cerebras speed turns multi-agent slide generation into an interactive product loop.",
      narrativeArc: [],
      slides,
      demoScript: []
    })
  };
}
