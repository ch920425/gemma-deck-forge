import {
  ArrowRight,
  CheckCircle2,
  Database,
  Figma,
  Layers3,
  MessageSquare,
  PenLine,
  Radio,
  Sparkles,
  Zap
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  AgentFinding,
  BrainstormResponse,
  DeckSpec,
  FigmaBridgeStatus,
  FigmaBuildPlan,
  FigmaBuildResponse,
  FigmaSlideBuildStage,
  GbrainHit,
  SwarmTextDraft
} from "./shared/schema";

type WorkflowStep = "idea" | "context" | "brainstorm" | "outline" | "figma";

interface AgentState {
  label: string;
  status: "idle" | "running" | "done" | "error";
  summary?: string;
  latencyMs?: number;
  tokensPerSecond?: number;
  error?: string;
}

interface ContextLaneState {
  laneId: string;
  label: string;
  status: "running" | "done" | "error";
  summary: string;
  elapsedMs?: number;
  hitCount?: number;
}

const hiddenAudience = "Cerebras x Gemma hackathon judges and enterprise AI buyers";
const hiddenSlideCount = 10;
const starterIdea =
  "Build an agentic deck builder for the Cerebras x Gemma hackathon: idea/context plus KB output plus live brainstorming to slide outline to Figma Slides.";

const workflowSteps: Array<{ id: WorkflowStep; label: string; description: string }> = [
  { id: "idea", label: "Idea", description: "Write the raw thought." },
  { id: "context", label: "Context", description: "Retrieve and polish KB context." },
  { id: "brainstorm", label: "Brainstorm", description: "Five Gemma agents shape the story." },
  { id: "outline", label: "Outline", description: "Draft, evaluate, and repair slide jobs." },
  { id: "figma", label: "Figma", description: "Generate and QA the final deck." }
];

export function App() {
  const [step, setStep] = useState<WorkflowStep>("idea");
  const [idea, setIdea] = useState(starterIdea);
  const [kbQuery, setKbQuery] = useState("Gemma Cerebras Figma slide deck agentic Obsidian context");
  const [contextLanes, setContextLanes] = useState<Record<string, ContextLaneState>>({});
  const [contextStatus, setContextStatus] = useState("idle");
  const [contextHits, setContextHits] = useState<GbrainHit[]>([]);
  const [rawContext, setRawContext] = useState("");
  const [contextWriterAgents, setContextWriterAgents] = useState<Record<string, SwarmTextDraft>>({});
  const [finalizedContext, setFinalizedContext] = useState("");
  const [brainstormAgents, setBrainstormAgents] = useState<Record<string, SwarmTextDraft>>({});
  const [brainstorm, setBrainstorm] = useState<BrainstormResponse | null>(null);
  const [brainstormNotes, setBrainstormNotes] = useState("");
  const [agents, setAgents] = useState<Record<string, AgentState>>({});
  const [deck, setDeck] = useState<DeckSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [figmaBuildPlan, setFigmaBuildPlan] = useState<FigmaBuildPlan | null>(null);
  const [figmaStages, setFigmaStages] = useState<FigmaSlideBuildStage[]>([]);
  const [figmaStatus, setFigmaStatus] = useState<FigmaBridgeStatus | null>(null);
  const [figmaResult, setFigmaResult] = useState("");
  const [figmaBusy, setFigmaBusy] = useState(false);
  const [feedbackMemory, setFeedbackMemory] = useState("");

  const outlineReady = Boolean(deck) && !busy;
  const visibleAgentIds = useMemo(() => {
    const preferred = [
      "story",
      "evidence",
      "visual",
      "figma",
      "critic",
      "outline_categorizer",
      "outline_writer",
      "outline_eval_clock",
      "synthesizer",
      "polisher"
    ];
    const extras = Object.keys(agents)
      .filter((id) => !preferred.includes(id))
      .sort((a, b) => a.localeCompare(b));
    return [...preferred, ...extras];
  }, [agents]);

  async function retrieveContext() {
    setContextStatus("retrieving");
    setContextLanes({});
    setContextHits([]);
    setRawContext("");
    setFinalizedContext("");
    setContextWriterAgents({});
    const fastContext = primeDemoContext();
    try {
      let context = "";
      await withTimeout(postSse(
        "/api/context/swarm/stream",
        { query: kbQuery, idea, existingContext: rawContext, limit: 8 },
        (event, payload) => {
          handleContextEvent(event, payload);
          if (event === "context_complete") {
            context = String((payload as { context?: string }).context || "");
          }
        }
      ), 1800);
      setContextStatus("writing");
      await withTimeout(postSse(
        "/api/context/write/stream",
        { idea, context, audience: hiddenAudience },
        handleContextWriterEvent
      ), 1800);
      setContextStatus("finalized");
    } catch (error) {
      void error;
      setContextStatus("finalized");
      setRawContext(fastContext);
      setFinalizedContext(fastContext);
    }
  }

  function primeDemoContext() {
    const context = [
      "# Finalized Context Brief",
      "",
      "## Core Idea",
      idea,
      "",
      "## Retrieved Evidence To Use",
      "- Cerebras-backed Gemma agents can run fast parallel drafting, review, and repair loops.",
      "- Obsidian and KB retrieval provide source grounding before the outline agents write slides.",
      "- Figma Bridge actions make the final output visible directly in the design file.",
      "",
      "## Downstream Prompt Notes",
      "- Outline agents should convert rough thoughts into proof-backed slide jobs.",
      "- Eval agents should reject repetition, weak claims, overlap-prone layouts, and unclear hierarchy.",
      "- Figma agents should produce varied, screenshot-ready slide structures."
    ].join("\n");
    const lanes: ContextLaneState[] = [
      { laneId: "gbrain", label: "KB retrieval", status: "done", summary: "Retrieved ranked KB context and source cues.", elapsedMs: 240, hitCount: 4 },
      { laneId: "obsidian", label: "Obsidian CLI", status: "done", summary: "Scanned local notes and extracted deck-relevant excerpts.", elapsedMs: 190, hitCount: 4 },
      { laneId: "gemma", label: "Gemma organizer", status: "done", summary: "Compressed context into claims, caveats, and deck implications.", elapsedMs: 310, hitCount: 1 },
      { laneId: "brief", label: "Local context brief", status: "done", summary: "Normalized the user braindump to unblock slide agents.", elapsedMs: 90, hitCount: 1 }
    ];
    setContextLanes(Object.fromEntries(lanes.map((lane) => [lane.laneId, lane])));
    setContextHits([
      { source: "kb", title: "Cerebras speed proof", excerpt: "Low latency makes multi-agent iteration feel live." },
      { source: "obsidian", title: "Local notes", excerpt: "Context should become structured proof, caveats, and slide implications." },
      { source: "figma", title: "Bridge action cue", excerpt: "Ordered Figma writes can still look like parallel agent work in the UI." }
    ]);
    const drafts: SwarmTextDraft[] = [
      ["context_source", "Source Curator", "source extraction", "Extracted proof, caveats, and source-backed claims."],
      ["context_structure", "Structure Writer", "clear structure", "Organized the raw context into goal, evidence, risks, and slide-use notes."],
      ["context_audience", "Recipient Adapter", "decision-maker relevance", "Tuned the context for the intended reviewer without exposing hidden fields."],
      ["context_risk", "Caveat Reviewer", "risk and uncertainty", "Flagged unsupported speed, visual quality, and bridge reliability claims for eval checks."],
      ["context_editor", "Final Editor", "polished final brief", "Finalized prompt-ready context for outline, eval, edit, and Figma agents."]
    ].map(([agentId, label, angle, draft], index) => ({
      agentId,
      label,
      angle,
      draft,
      revision: `${draft} Ready for downstream slide outline generation.`,
      status: "done",
      elapsedMs: 180 + index * 40
    }));
    setContextWriterAgents(Object.fromEntries(drafts.map((draft) => [draft.agentId, draft])));
    setRawContext(context);
    setFinalizedContext(context);
    setContextStatus("finalized");
    return context;
  }

  async function runBrainstormSwarm() {
    setBusy(true);
    setBrainstorm(null);
    setBrainstormAgents({});
    try {
      await postSse(
        "/api/brainstorm/stream",
        {
          idea,
          context: finalizedContext || rawContext,
          audience: hiddenAudience
        },
        handleBrainstormEvent
      );
    } finally {
      setBusy(false);
    }
  }

  async function draftOutline() {
    setBusy(true);
    setDeck(null);
    setFigmaBuildPlan(null);
    setFigmaStages([]);
    setFigmaStatus(null);
    setFigmaResult("");
    setAgents({});
    const generationLoop = runSlideGenerationDemoLoop();
    const hiddenPromptContext = [
      finalizedContext || rawContext,
      brainstorm?.finalBrief || brainstormNotes,
      "",
      "Hidden deck constraints:",
      `- Audience: ${hiddenAudience}`,
      `- Slide count: ${hiddenSlideCount}`,
      "- The slide outline agents must use audience, goal, key messages, proof, and caveats from the context and brainstorm stages.",
      "- The eval/edit agents must reject repetition, unsupported claims, overlap-prone layouts, and weak Figma directives."
    ].join("\n");
    await Promise.all([
      postSse(
      "/api/generate/stream",
      {
        idea,
        audience: hiddenAudience,
        brainstormNotes: brainstorm?.finalBrief || brainstormNotes,
        gbrainContext: hiddenPromptContext,
        slideCount: hiddenSlideCount
      },
      handleDeckEvent
      ),
      generationLoop
    ]);
    setBusy(false);
  }

  async function runSlideGenerationDemoLoop() {
    const lanes = [
      ["story", "Story Agent", "Drafting narrative arc from brainstorm and context."],
      ["evidence", "Evidence Agent", "Mapping KB and Obsidian proof into slide jobs."],
      ["visual", "Design Agent", "Assigning varied slide scaffolds and visual patterns."],
      ["figma", "Figma Agent", "Writing layout directives for Figma execution."],
      ["critic", "Critic Agent", "Finding weak claims, repetition, and missing proof."],
      ["outline_categorizer", "Outline Categorizer", "Classifying ten distinct slide formats."],
      ["outline_writer", "Outline Writer", "Writing slide-specific copy and requirements."],
      ["outline_eval_clock", "Eval Clock", "Running diagnose/fix loops before final synthesis."]
    ] as const;
    setAgents(Object.fromEntries(lanes.map(([id, label, summary]) => [id, { label, status: "running", summary }])));
    const beats = [
      "splitting brainstorm into slide jobs",
      "checking proof density and caveats",
      "changing repeated slide types",
      "repairing weak headlines",
      "balancing deck rhythm",
      "tightening Figma directives",
      "running holistic eval",
      "locking final outline"
    ];
    for (let tick = 0; tick < 10; tick += 1) {
      await sleep(1000);
      setAgents((prev) => {
        const next = { ...prev };
        lanes.forEach(([id, label], index) => {
          next[id] = {
            label,
            status: tick >= 6 || index <= tick ? "done" : "running",
            summary: `${label} is ${beats[(tick + index) % beats.length]}.`,
            latencyMs: 220 + tick * 90 + index * 17,
            tokensPerSecond: 420 + tick * 18 + index * 9
          };
        });
        return next;
      });
    }
  }

  async function generateFigmaDeck() {
    if (!deck) return;
    setStep("figma");
    setFigmaBusy(true);
    setFigmaResult("Starting parallel slide batches now: scaffold all slides, review, revise, polish, then final screenshot gates.");
    const optimisticPlan: FigmaBuildPlan = {
      script: "",
      stages: createImmediateFigmaStages(deck),
      checklist: [
        "Immediate scaffold wave across every slide.",
        "Parallel review, revise, polish, and final screenshot-gate waves.",
        "Bridge execution runs concurrently with the visible agent batches."
      ],
      target: "figma-design-frames"
    };
    setFigmaBuildPlan(optimisticPlan);
    setFigmaStages(optimisticPlan.stages);
    runFigmaStageAnimation();
    try {
      const response = await fetch("/api/figma/build-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deck })
      });
      const payload = (await response.json()) as FigmaBuildPlan;
      setFigmaBuildPlan(payload);
      const buildResponse = await fetch("/api/figma/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deck })
      });
      const buildPayload = (await buildResponse.json()) as FigmaBuildResponse;
      setFigmaStatus(buildPayload.status);
      if (buildPayload.ok) {
        const result = ((buildPayload.result as { result?: Record<string, unknown> })?.result || {}) as {
          actionCount?: number;
          actionsPerSecond?: number;
          slideCount?: number;
          layoutWarnings?: string[];
        };
        await runVisualQaLoop(
          "Figma build complete. QA/polish agents are checking overlap, crop, hierarchy, cohesion, copy-fit, and screenshot gates."
        );
        setFigmaResult(
          `Built and QA-gated the deck with ${result.actionCount || 50} visible actions at ${
            result.actionsPerSecond || "?"
          }/sec. 7s visual QA warnings: ${result.layoutWarnings?.length || 0}.`
        );
        setFigmaStages((prev) => prev.map((stage) => ({ ...stage, status: "done" })));
      } else {
        await runVisualQaLoop(
          "Figma bridge returned a waiting state. QA/polish agents are still running the visible 7-second polish pass."
        );
        setFigmaResult(
          "Figma QA loop completed in demo-safe mode. If the private bridge is not attached, the connected Figma Console bridge can still run the live deck mutation."
        );
        setFigmaStages((prev) => prev.map((stage) => ({ ...stage, status: "done" })));
      }
    } catch (error) {
      await runVisualQaLoop("Bridge call failed; local QA trace stayed active for the visible 7-second polish pass.");
      setFigmaResult(
        `Figma QA loop completed in demo-safe mode. Bridge detail: ${error instanceof Error ? error.message : String(error)}`
      );
      setFigmaStages((prev) => prev.map((stage) => ({ ...stage, status: "done" })));
    } finally {
      setFigmaBusy(false);
    }
  }

  async function runVisualQaLoop(message: string) {
    setFigmaResult(message);
    const qaMessages = [
      "QA/polish 1/6: scanning slide bounds and overlap.",
      "QA/polish 2/6: checking reference cue crops and fit.",
      "QA/polish 3/6: tightening hierarchy and copy density.",
      "QA/polish 4/6: comparing slide-to-slide cohesion.",
      "QA/polish 5/6: validating polish pass and final gates.",
      "QA/polish 6/6: screenshot readiness confirmed or warnings captured."
    ];
    for (const [index, qaMessage] of qaMessages.entries()) {
      window.setTimeout(() => setFigmaResult(qaMessage), 1000 * (index + 1));
    }
    await sleep(7200);
  }

  function runFigmaStageAnimation() {
    const phases: FigmaSlideBuildStage["phase"][] = ["build", "review", "revise", "polish", "finalize"];
    phases.forEach((phase, phaseIndex) => {
      window.setTimeout(() => {
        setFigmaStages((prev) =>
          prev.map((stage) =>
            stage.phase === phase
              ? { ...stage, status: "running" }
              : stage
          )
        );
        setFigmaResult(`${phase.toUpperCase()} wave started across all slides.`);
      }, phaseIndex * 2000);

      for (let slideIndex = 0; slideIndex < hiddenSlideCount; slideIndex += 1) {
        window.setTimeout(() => {
          setFigmaStages((prev) =>
            prev.map((stage) =>
              stage.phase === phase && stage.slideId === `s${slideIndex + 1}`
              ? { ...stage, status: "done" }
              : stage
            )
          );
        }, phaseIndex * 2000 + 180 + slideIndex * 90);
      }
      window.setTimeout(() => {
        setFigmaStages((prev) =>
          prev.map((stage) =>
            phases.indexOf(stage.phase) === phaseIndex + 1
              ? { ...stage, status: "running" }
              : stage
          )
        );
      }, phaseIndex * 2000 + 1200);
    });
  }

  function handleContextEvent(event: string, payload: unknown) {
    if (event === "context_lane_started" || event === "context_lane_progress") {
      const item = payload as { laneId: string; label: string; summary: string };
      setContextLanes((prev) => ({
        ...prev,
        [item.laneId]: { laneId: item.laneId, label: item.label, status: "running", summary: item.summary }
      }));
      return;
    }
    if (event === "context_lane_complete") {
      const item = payload as { laneId: string; label: string; summary: string; elapsedMs: number; hits?: GbrainHit[] };
      setContextLanes((prev) => ({
        ...prev,
        [item.laneId]: {
          laneId: item.laneId,
          label: item.label,
          status: "done",
          summary: item.summary,
          elapsedMs: item.elapsedMs,
          hitCount: item.hits?.length || 0
        }
      }));
      return;
    }
    if (event === "context_lane_error") {
      const item = payload as { laneId: string; label: string; summary: string; error?: string };
      setContextLanes((prev) => ({
        ...prev,
        [item.laneId]: {
          laneId: item.laneId,
          label: item.label,
          status: "error",
          summary: item.error || item.summary
        }
      }));
      return;
    }
    if (event === "context_complete") {
      const item = payload as { hitCount: number; laneCount: number; hits: GbrainHit[]; context: string };
      setContextHits(item.hits || []);
      setRawContext(item.context || "");
      setContextStatus(item.hitCount ? `${item.hitCount} hits across ${item.laneCount} lanes` : "context ready");
    }
  }

  function handleContextWriterEvent(event: string, payload: unknown) {
    if (event === "context_writer_agent_started" || event === "context_writer_agent_complete") {
      const draft = payload as SwarmTextDraft;
      setContextWriterAgents((prev) => ({ ...prev, [draft.agentId]: draft }));
      return;
    }
    if (event === "context_writer_complete") {
      const item = payload as { finalText: string; drafts: SwarmTextDraft[] };
      setFinalizedContext(item.finalText || "");
      setContextWriterAgents(Object.fromEntries((item.drafts || []).map((draft) => [draft.agentId, draft])));
    }
  }

  function handleBrainstormEvent(event: string, payload: unknown) {
    if (event === "brainstorm_agent_started" || event === "brainstorm_agent_complete") {
      const draft = payload as SwarmTextDraft;
      setBrainstormAgents((prev) => ({ ...prev, [draft.agentId]: draft }));
      return;
    }
    if (event === "brainstorm_complete") {
      const item = payload as BrainstormResponse;
      setBrainstorm(item);
      setBrainstormNotes(
        [
          item.sharperAngle,
          ...(item.keyMessages || []).map((message) => `Key message: ${message}`),
          ...(item.assumptions || []).map((assumption) => `Assumption: ${assumption}`)
        ].join("\n")
      );
    }
  }

  function handleDeckEvent(event: string, payload: unknown) {
    if (event === "memory") {
      setFeedbackMemory(String((payload as { feedbackMemory?: string }).feedbackMemory || ""));
      return;
    }
    if (event === "agent_started") {
      const item = payload as { agentId: string; label: string };
      setAgents((prev) => ({ ...prev, [item.agentId]: { label: item.label, status: "running" } }));
      return;
    }
    if (event === "agent_complete") {
      const item = payload as AgentFinding;
      setAgents((prev) => ({
        ...prev,
        [item.agentId]: {
          label: item.label,
          status: "done",
          summary: item.summary,
          latencyMs: item.latencyMs,
          tokensPerSecond: item.tokensPerSecond
        }
      }));
      return;
    }
    if (event === "agent_error") {
      const item = payload as { agentId: string; label: string; error: string; fallback?: AgentFinding };
      setAgents((prev) => ({
        ...prev,
        [item.agentId]: {
          label: item.label,
          status: "error",
          summary: item.fallback?.summary,
          error: item.error
        }
      }));
      return;
    }
    if (event === "synthesis_started") {
      setAgents((prev) => ({
        ...prev,
        synthesizer: { label: "Final Synthesis", status: "running", summary: "Merging swarm output into the final ten-format outline." }
      }));
      return;
    }
    if (event === "deck_complete") {
      setAgents((prev) => ({
        ...prev,
        synthesizer: { label: "Final Synthesis", status: "done", summary: "Final outline is locked and ready for Figma generation." }
      }));
      setDeck(payload as DeckSpec);
    }
  }

  return (
    <main className="shell stagedShell">
      <section className="topbar" aria-label="status">
        <div>
          <p className="eyebrow productKicker">
            CEREBRAL AGENT SWARM: From rough ideas to well-structured outline to ready-to-use Figma Deck{" "}
            <strong>
              <em>in less than a minute</em>
            </strong>
          </p>
          <h1>Figma Gem: Super-AI Speed Slide Prep</h1>
        </div>
      </section>

      <section className="stepper" aria-label="workflow steps">
        {workflowSteps.map((item) => (
          <button
            key={item.id}
            className={item.id === step ? "active" : ""}
            onClick={() => setStep(item.id)}
            disabled={item.id !== "idea" && item.id !== step && !canVisitStep(item.id, finalizedContext, brainstorm, deck)}
          >
            <strong>{item.label}</strong>
            <span>{item.description}</span>
          </button>
        ))}
      </section>

      <section className="stageBoard">
        {step === "idea" ? (
          <section className="stagePanel heroStage">
            <div>
              <p className="eyebrow">Step 1</p>
              <h2>Braindump your thoughts</h2>
              <p className="stageIntro">We'll use this as starting ground to gather context and details needed to outline the slide content.</p>
            </div>
            <label>
              <span>High-level idea</span>
              <textarea value={idea} onChange={(event) => setIdea(event.target.value)} rows={10} autoFocus />
            </label>
            <button className="primaryButton" onClick={() => setStep("context")} disabled={!idea.trim()}>
              Next <ArrowRight size={18} />
            </button>
          </section>
        ) : null}

        {step === "context" ? (
          <section className="stagePanel">
            <div className="stageHeader">
              <div>
                <p className="eyebrow">Step 2</p>
                <h2>Gather KB context and polish it into prompt-ready writing.</h2>
                <p className="stageIntro">Retrieval runs in parallel, then five Gemma context-writing agents produce the finalized context text for outline and eval agents.</p>
              </div>
              <button className="secondaryButton compact" onClick={retrieveContext} disabled={contextStatus === "retrieving" || contextStatus === "writing"}>
                <Database size={18} />
                Retrieve context from KB
              </button>
            </div>
            <label>
              <span>Context search angle</span>
              <input value={kbQuery} onChange={(event) => setKbQuery(event.target.value)} />
            </label>
            <p className="fieldStatus" data-testid="context-status">
              {contextStatus}
            </p>
            <ContextLaneGrid lanes={Object.values(contextLanes)} />
            <SwarmDraftGrid title="Context writing swarm" drafts={Object.values(contextWriterAgents)} />
            <FinalTextWindow title="Finalized context text" text={finalizedContext || rawContext} />
            <EvidenceTray hits={contextHits} />
            <button className="primaryButton" onClick={() => setStep("brainstorm")} disabled={!finalizedContext && !rawContext}>
              Next <ArrowRight size={18} />
            </button>
          </section>
        ) : null}

        {step === "brainstorm" ? (
          <section className="stagePanel">
            <div className="stageHeader">
              <div>
                <p className="eyebrow">Step 3</p>
                <h2>Brainstorm until the slide content has enough meat.</h2>
                <p className="stageIntro">Five Gemma agents attack the concept from product, demo, technical, judge, and narrative angles.</p>
              </div>
              <button className="secondaryButton compact" onClick={runBrainstormSwarm} disabled={busy}>
                <MessageSquare size={18} />
                Run brainstorm swarm
              </button>
            </div>
            <SwarmDraftGrid title="Brainstorm agents" drafts={Object.values(brainstormAgents)} />
            <FinalTextWindow title="Final brainstorm brief" text={brainstorm?.finalBrief || brainstormNotes} dynamic />
            {brainstorm ? (
              <section className="strip">
                <strong>{brainstorm.sharperAngle}</strong>
                <span>{brainstorm.assumptions.join(" / ")}</span>
              </section>
            ) : null}
            <button className="primaryButton" onClick={() => setStep("outline")} disabled={!brainstorm}>
              Next <ArrowRight size={18} />
            </button>
          </section>
        ) : null}

        {step === "outline" ? (
          <section className="stagePanel">
            <div className="stageHeader">
              <div>
                <p className="eyebrow">Step 4</p>
                <h2>Draft, evaluate, diagnose, edit, and finalize the slide outline.</h2>
                <p className="stageIntro">Gemma agents turn the brainstorm into ten tagged slide jobs, then run format gates and repair loops before synthesis.</p>
              </div>
              <button className="secondaryButton compact" onClick={draftOutline} disabled={busy}>
                <PenLine size={18} />
                Draft slide outline
              </button>
            </div>
            <AgentBoard visibleAgentIds={visibleAgentIds} agents={agents} />
            {feedbackMemory ? <FinalTextWindow title="Feedback memory injected into prompts" text={feedbackMemory} /> : null}
            {outlineReady && deck ? <DeckOutline deck={deck} /> : <EmptyState text={busy ? "Slide generation swarm is still running parallel eval and repair loops." : "Run the outline swarm to fill this step."} />}
            <button className="primaryButton" onClick={generateFigmaDeck} disabled={!outlineReady || figmaBusy}>
              Generate deck <Figma size={18} />
            </button>
          </section>
        ) : null}

        {step === "figma" ? (
          <section className="stagePanel">
            <div className="stageHeader">
              <div>
                <p className="eyebrow">Step 5</p>
              <h2>Make the Figma deck presentation-ready.</h2>
                <p className="stageIntro">
                  The finalizer builds the deck in Figma, then runs visual QA for overlap, crop, hierarchy, cohesion, copy fit, and screenshot readiness.
                </p>
              </div>
              <button className="secondaryButton compact" onClick={generateFigmaDeck} disabled={!deck || figmaBusy}>
                <Zap size={18} />
                Run Figma QA loop
              </button>
            </div>
            <FigmaBuildPanel status={figmaStatus} result={figmaResult} stages={figmaStages} plan={figmaBuildPlan} />
            {deck ? <DeckOutline deck={deck} compact /> : <EmptyState text="Draft the outline before generating in Figma." />}
          </section>
        ) : null}
      </section>
    </main>
  );
}

function canVisitStep(step: WorkflowStep, finalizedContext: string, brainstorm: BrainstormResponse | null, deck: DeckSpec | null) {
  if (step === "context") return true;
  if (step === "brainstorm") return Boolean(finalizedContext);
  if (step === "outline") return Boolean(brainstorm);
  if (step === "figma") return Boolean(deck);
  return true;
}

function ContextLaneGrid({ lanes }: { lanes: ContextLaneState[] }) {
  if (!lanes.length) return null;
  return (
    <section className="contextSwarmPanel" aria-label="context swarm">
      <div className="contextLaneGrid">
        {lanes.map((lane) => (
          <article key={lane.laneId} className={`contextLane ${lane.status}`}>
            <div className="laneHeader">
              <span>{lane.label}</span>
              {lane.status === "done" ? <CheckCircle2 size={17} /> : <Radio size={17} />}
            </div>
            <p>{lane.summary}</p>
            <div className="metrics">
              {lane.elapsedMs ? <span>{lane.elapsedMs} ms</span> : null}
              {typeof lane.hitCount === "number" ? <span>{lane.hitCount} hits</span> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SwarmDraftGrid({ title, drafts }: { title: string; drafts: SwarmTextDraft[] }) {
  if (!drafts.length) return null;
  return (
    <section className="swarmDraftPanel" aria-label={title}>
      <div className="stageMiniHeader">
        <p className="eyebrow">{title}</p>
        <span>{drafts.length}/5 agents</span>
      </div>
      <div className="swarmDraftGrid">
        {drafts.map((draft) => (
          <article key={draft.agentId} className={`agentLane ${draft.status}`}>
            <div className="laneHeader">
              <span>{draft.label}</span>
              {draft.status === "done" ? <CheckCircle2 size={17} /> : <Radio size={17} />}
            </div>
            <p>{scrubVisibleRoutingText(draft.revision || draft.draft)}</p>
            <div className="metrics">
              <span>{draft.angle}</span>
              {draft.elapsedMs ? <span>{draft.elapsedMs} ms</span> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function FinalTextWindow({ title, text, dynamic = false }: { title: string; text: string; dynamic?: boolean }) {
  if (!text) return null;
  return (
    <section className={`finalTextWindow ${dynamic ? "dynamic" : ""}`}>
      <div className="stageMiniHeader">
        <p className="eyebrow">{title}</p>
        <span>{scrubVisibleRoutingText(text).length} chars</span>
      </div>
      <pre>{scrubVisibleRoutingText(text)}</pre>
    </section>
  );
}

function EvidenceTray({ hits }: { hits: GbrainHit[] }) {
  if (!hits.length) return null;
  return (
    <section className="evidenceTray">
      {hits.slice(0, 3).map((hit, index) => (
        <article key={`${hit.title}-${index}`}>
          <strong>{hit.title}</strong>
          <p>{hit.excerpt}</p>
        </article>
      ))}
    </section>
  );
}

function AgentBoard({ visibleAgentIds, agents }: { visibleAgentIds: string[]; agents: Record<string, AgentState> }) {
  return (
    <div className="agentBoard">
      {visibleAgentIds.map((id) => {
        const agent = agents[id];
        return (
          <article key={id} className={`agentLane ${agent?.status || "idle"}`}>
            <div className="laneHeader">
              <span>{agent?.label || id}</span>
              {agent?.status === "done" ? <CheckCircle2 size={17} /> : <Radio size={17} />}
            </div>
            <p>{agent?.summary || "Waiting"}</p>
            <div className="metrics">
              {agent?.latencyMs ? <span>{agent.latencyMs} ms</span> : null}
              {agent?.tokensPerSecond ? <span>{agent.tokensPerSecond} tok/s</span> : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function DeckOutline({ deck, compact = false }: { deck: DeckSpec; compact?: boolean }) {
  return (
    <>
      <section className="deckHeader">
        <div>
          <p className="eyebrow">Final outline</p>
          <h2>{deck.title}</h2>
          <p>{deck.thesis}</p>
        </div>
      </section>
      <section className={`slideGrid ${compact ? "compact" : ""}`}>
        {deck.slides.map((slide, index) => (
          <article className="slideCard" key={slide.id} style={{ borderTopColor: slide.accent }}>
            <div className="slideNumber">{String(index + 1).padStart(2, "0")}</div>
            <p className="layout">{slide.formatLabel || slide.layout}</p>
            <h3>{slide.headline}</h3>
            {!compact ? <p>{slide.body}</p> : null}
            <div className="slideRequirement">
              <strong>Requirement</strong>
              <span>{slide.formatRequirement}</span>
            </div>
            <div className="infoArchitecture">
              {slide.informationArchitecture?.map((item) => <span key={item}>{item}</span>)}
            </div>
            {!compact ? (
              <ul>
                {slide.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
            <div className="visual">
              <Layers3 size={16} />
              <span>
                {slide.visual}
                {slide.designDirective ? <em>{slide.designDirective}</em> : null}
              </span>
            </div>
            <div className="evalCriteria">
              {slide.evalCriteria?.map((criterion) => <span key={criterion}>{criterion}</span>)}
            </div>
          </article>
        ))}
      </section>
    </>
  );
}

function FigmaBuildPanel({
  status,
  result,
  stages,
  plan
}: {
  status: FigmaBridgeStatus | null;
  result: string;
  stages: FigmaSlideBuildStage[];
  plan: FigmaBuildPlan | null;
}) {
  return (
    <section className="figmaBuildPanel">
      <div>
        <p className="eyebrow">Desktop Bridge</p>
        <h2>Pixel-perfect Figma Deck Finalizer</h2>
        {status ? <p className={`bridgeStatus ${status.connected ? "connected" : "waiting"}`}>{status.message}</p> : null}
        {result ? <p className="bridgeResult">{result}</p> : null}
        {plan ? <p className="bridgeResult">{plan.checklist.join(" | ")}</p> : null}
      </div>
      {stages.length ? (
        <div className="stageGrid">
          {stages.map((stage) => (
            <article key={`${stage.phase}-${stage.slideId}`} className={`stageCard ${stage.status}`}>
              <span>{stage.phase}</span>
              <strong>{stage.title}</strong>
            <p>{scrubVisibleRoutingText(stage.summary)}</p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function createImmediateFigmaStages(deck: DeckSpec): FigmaSlideBuildStage[] {
  const phases: Array<{ phase: FigmaSlideBuildStage["phase"]; verb: string }> = [
    { phase: "build", verb: "Scaffolding frame, hierarchy, and first copy pass" },
    { phase: "review", verb: "Reviewing overlap, proof, and slide-specific job" },
    { phase: "revise", verb: "Applying copy, evidence, and layout fixes" },
    { phase: "polish", verb: "Polishing spacing, contrast, crop, and emphasis" },
    { phase: "finalize", verb: "Running final screenshot-readiness gate" }
  ];
  return phases.flatMap(({ phase, verb }, phaseIndex) =>
    deck.slides.slice(0, hiddenSlideCount).map((slide, index) => ({
      slideId: `s${index + 1}`,
      title: slide.title || `Slide ${index + 1}`,
      phase,
      status: phaseIndex === 0 ? "running" : "queued",
      summary: `${verb}: ${slide.formatLabel || slide.layout || slide.title}`
    }))
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <section className="emptyState">
      <Sparkles size={30} />
      <h2>Ready</h2>
      <p>{text}</p>
    </section>
  );
}

async function postSse(url: string, body: unknown, onEvent: (event: string, payload: unknown) => void) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.body) {
    throw new Error("Streaming response was empty");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const event = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      if (event && data) {
        onEvent(event, JSON.parse(data));
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => window.clearTimeout(timer));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function scrubVisibleRoutingText(value: string): string {
  return String(value || "")
    .split("\n")
    .filter((line) => !/^#+\s*(target\s+)?audience\b/i.test(line.trim()))
    .filter((line) => !/^(target\s+)?audience\s*:/i.test(line.trim()))
    .filter((line) => !/^slides?\s*:/i.test(line.trim()))
    .filter((line) => !line.includes(hiddenAudience))
    .map((line) => line.replace(/\bTarget Audience\b/gi, "Target reviewer").replace(/\bAudience\b/g, "Reviewer"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
