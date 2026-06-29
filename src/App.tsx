import {
  CheckCircle2,
  Clipboard,
  Database,
  Figma,
  Layers3,
  MessageSquare,
  Radio,
  RefreshCw,
  Sparkles,
  Zap
} from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentFinding, BrainstormResponse, DeckSpec, GbrainHit } from "./shared/schema";
import type { FigmaBuildPlan, FigmaSlideBuildStage } from "./shared/schema";

interface AgentState {
  label: string;
  status: "idle" | "running" | "done" | "error";
  summary?: string;
  latencyMs?: number;
  tokensPerSecond?: number;
  error?: string;
}

const starterIdea =
  "Build an agentic deck builder for the Cerebras x Gemma hackathon: idea/context plus gbrain output plus live brainstorming to slide outline to Figma Slides.";

export function App() {
  const [idea, setIdea] = useState(starterIdea);
  const [audience, setAudience] = useState("Cerebras x Gemma hackathon judges and enterprise AI buyers");
  const [slideCount, setSlideCount] = useState(6);
  const [gbrainQuery, setGbrainQuery] = useState("Gemma Cerebras Figma slide deck agentic gbrain");
  const [gbrainHits, setGbrainHits] = useState<GbrainHit[]>([]);
  const [gbrainStatus, setGbrainStatus] = useState("idle");
  const [gbrainContext, setGbrainContext] = useState("");
  const [brainstorm, setBrainstorm] = useState<BrainstormResponse | null>(null);
  const [brainstormNotes, setBrainstormNotes] = useState("");
  const [agents, setAgents] = useState<Record<string, AgentState>>({});
  const [deck, setDeck] = useState<DeckSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [figmaPrompt, setFigmaPrompt] = useState("");
  const [figmaBuildPlan, setFigmaBuildPlan] = useState<FigmaBuildPlan | null>(null);
  const [figmaStages, setFigmaStages] = useState<FigmaSlideBuildStage[]>([]);
  const [feedback, setFeedback] = useState({ rating: 5, keep: "", change: "", notes: "" });
  const [feedbackMemory, setFeedbackMemory] = useState("");
  const deckJson = useMemo(() => (deck ? JSON.stringify(deck.figmaSpec, null, 2) : ""), [deck]);

  async function runGbrain() {
    setGbrainStatus("running");
    const response = await fetch("/api/context/gbrain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gbrainQuery, limit: 8 })
    });
    const payload = await response.json();
    if (payload.ok) {
      setGbrainHits(payload.hits || []);
      const context = (payload.hits || [])
        .map((hit: GbrainHit) => `${hit.source}: ${hit.title}\n${hit.excerpt}`)
        .join("\n\n");
      setGbrainContext(context);
      setGbrainStatus(`${payload.hits?.length || 0} hits`);
    } else {
      setGbrainHits([]);
      setGbrainStatus("cli unavailable");
      setGbrainContext(`Supabase CLI query did not return context.\n${payload.error || payload.raw || ""}`);
    }
  }

  async function runBrainstorm() {
    setBusy(true);
    try {
      const response = await fetch("/api/brainstorm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea, context: gbrainContext })
      });
      const payload = (await response.json()) as BrainstormResponse;
      setBrainstorm(payload);
      setBrainstormNotes([payload.sharperAngle, ...payload.questions.map((q) => `Q: ${q}`)].join("\n"));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setDeck(null);
    setFigmaPrompt("");
    setFigmaBuildPlan(null);
    setFigmaStages([]);
    setAgents({});
    await postSse(
      "/api/generate/stream",
      { idea, audience, brainstormNotes, gbrainContext, slideCount },
      handleStreamEvent
    );
    setBusy(false);
  }

  async function polish() {
    if (!deck) return;
    setBusy(true);
    await postSse(
      "/api/polish/stream",
      { deck, instruction: "Sharpen each slide for a 60-second Cerebras x Gemma hackathon demo." },
      handleStreamEvent
    );
    setBusy(false);
  }

  async function exportFigma() {
    if (!deck) return;
    const response = await fetch("/api/export/figma", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deck })
    });
    const payload = await response.json();
    setFigmaPrompt(payload.handoffPrompt || "");
  }

  async function prepareFigmaBuild() {
    if (!deck) return;
    const response = await fetch("/api/figma/build-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deck })
    });
    const payload = (await response.json()) as FigmaBuildPlan;
    setFigmaBuildPlan(payload);
    setFigmaPrompt(payload.script);
    setFigmaStages(payload.stages);
    const phases = ["build", "review", "revise", "polish", "finalize"];
    phases.forEach((phase, phaseIndex) => {
      window.setTimeout(() => {
        setFigmaStages((prev) =>
          prev.map((stage) =>
            stage.phase === phase
              ? { ...stage, status: "done" }
              : phases.indexOf(stage.phase) === phaseIndex + 1
                ? { ...stage, status: "running" }
                : stage
          )
        );
      }, 260 * (phaseIndex + 1));
    });
  }

  async function saveFeedbackSignal() {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...feedback, deckTitle: deck?.title || "Untitled deck" })
    });
    const payload = await response.json();
    setFeedbackMemory(payload.memory || "");
  }

  function handleStreamEvent(event: string, payload: unknown) {
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
    if (event === "polish_started") {
      setAgents((prev) => ({ ...prev, polisher: { label: "Parallel Slide Polish", status: "running" } }));
      return;
    }
    if (event === "polish_complete") {
      setAgents((prev) => ({ ...prev, polisher: { label: "Parallel Slide Polish", status: "done" } }));
      return;
    }
    if (event === "deck_complete") {
      setDeck(payload as DeckSpec);
    }
  }

  return (
    <main className="shell">
      <section className="topbar" aria-label="status">
        <div>
          <p className="eyebrow">Gemma 4 on Cerebras</p>
          <h1>Gemma Deck Forge</h1>
        </div>
        <div className="statusPills">
          <span>
            <Radio size={16} /> parallel agents
          </span>
          <span>
            <Zap size={16} /> low latency
          </span>
          <span>
            <Figma size={16} /> Figma spec
          </span>
        </div>
      </section>

      <section className="workspace">
        <aside className="controlPanel">
          <label>
            <span>Idea</span>
            <textarea value={idea} onChange={(event) => setIdea(event.target.value)} rows={7} />
          </label>
          <label>
            <span>Audience</span>
            <input value={audience} onChange={(event) => setAudience(event.target.value)} />
          </label>
          <div className="row">
            <label>
              <span>Slides</span>
              <input
                type="number"
                min={3}
                max={10}
                value={slideCount}
                onChange={(event) => setSlideCount(Number(event.target.value))}
              />
            </label>
            <button className="iconButton" onClick={runBrainstorm} disabled={busy} title="Brainstorm">
              <MessageSquare size={18} />
              Brainstorm
            </button>
          </div>

          <label>
            <span>Gbrain query</span>
            <input value={gbrainQuery} onChange={(event) => setGbrainQuery(event.target.value)} />
          </label>
          <button className="secondaryButton" onClick={runGbrain} disabled={gbrainStatus === "running"}>
            <Database size={18} />
            {gbrainStatus === "running" ? "Querying" : "Fetch gbrain context"}
          </button>
          <p className="fieldStatus" data-testid="gbrain-status">
            {gbrainStatus}
          </p>

          <label>
            <span>Brainstorm notes</span>
            <textarea value={brainstormNotes} onChange={(event) => setBrainstormNotes(event.target.value)} rows={8} />
          </label>

          <div className="actionStack">
            <button className="primaryButton" onClick={generate} disabled={busy}>
              <Sparkles size={18} />
              Generate deck
            </button>
            <button className="secondaryButton" onClick={polish} disabled={busy || !deck}>
              <RefreshCw size={18} />
              Polish slides
            </button>
          </div>
        </aside>

        <section className="mainPanel">
          <div className="agentBoard">
            {["story", "evidence", "visual", "figma", "critic", "polisher"].map((id) => {
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

          {brainstorm ? (
            <section className="strip">
              <strong>{brainstorm.sharperAngle}</strong>
              <span>{brainstorm.assumptions.join(" / ")}</span>
            </section>
          ) : null}

          {gbrainHits.length ? (
            <section className="evidenceTray">
              {gbrainHits.slice(0, 3).map((hit, index) => (
                <article key={`${hit.title}-${index}`}>
                  <strong>{hit.title}</strong>
                  <p>{hit.excerpt}</p>
                </article>
              ))}
            </section>
          ) : null}

          {deck ? (
            <>
              <section className="deckHeader">
                <div>
                  <p className="eyebrow">{deck.audience}</p>
                  <h2>{deck.title}</h2>
                  <p>{deck.thesis}</p>
                </div>
                <button className="iconButton" onClick={exportFigma}>
                  <Figma size={18} />
                  Figma handoff
                </button>
                <button className="iconButton" onClick={prepareFigmaBuild}>
                  <Zap size={18} />
                  Build in Figma
                </button>
              </section>

              {figmaBuildPlan ? (
                <section className="figmaBuildPanel">
                  <div>
                    <p className="eyebrow">Desktop Bridge plan</p>
                    <h2>Parallel Figma Finalizer</h2>
                  </div>
                  <div className="stageGrid">
                    {figmaStages.map((stage) => (
                      <article key={`${stage.phase}-${stage.slideId}`} className={`stageCard ${stage.status}`}>
                        <span>{stage.phase}</span>
                        <strong>{stage.title}</strong>
                        <p>{stage.summary}</p>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="slideGrid">
                {deck.slides.map((slide, index) => (
                  <article className="slideCard" key={slide.id} style={{ borderTopColor: slide.accent }}>
                    <div className="slideNumber">{String(index + 1).padStart(2, "0")}</div>
                    <p className="layout">{slide.layout}</p>
                    <h3>{slide.headline}</h3>
                    <p>{slide.body}</p>
                    <ul>
                      {slide.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                    <div className="visual">
                      <Layers3 size={16} />
                      {slide.visual}
                    </div>
                  </article>
                ))}
              </section>

              <section className="feedbackPanel">
                <h2>Feedback memory</h2>
                <div className="feedbackGrid">
                  <label>
                    <span>Rating</span>
                    <input
                      type="number"
                      min={1}
                      max={5}
                      value={feedback.rating}
                      onChange={(event) => setFeedback((prev) => ({ ...prev, rating: Number(event.target.value) }))}
                    />
                  </label>
                  <label>
                    <span>Keep</span>
                    <input
                      value={feedback.keep}
                      onChange={(event) => setFeedback((prev) => ({ ...prev, keep: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>Change</span>
                    <input
                      value={feedback.change}
                      onChange={(event) => setFeedback((prev) => ({ ...prev, change: event.target.value }))}
                    />
                  </label>
                </div>
                <textarea
                  value={feedback.notes}
                  onChange={(event) => setFeedback((prev) => ({ ...prev, notes: event.target.value }))}
                  rows={3}
                />
                <button className="secondaryButton" onClick={saveFeedbackSignal}>
                  <CheckCircle2 size={18} />
                  Save feedback
                </button>
                {feedbackMemory ? <pre>{feedbackMemory}</pre> : null}
              </section>
            </>
          ) : (
            <section className="emptyState">
              <Sparkles size={30} />
              <h2>Ready</h2>
              <p>Generate a deck to fill the slide board.</p>
            </section>
          )}
        </section>

        <aside className="artifactPanel">
          <div className="artifactHeader">
            <span>Figma JSON</span>
            <button
              className="tinyButton"
              onClick={() => navigator.clipboard.writeText(figmaPrompt || deckJson)}
              disabled={!deck}
              title="Copy"
            >
              <Clipboard size={16} />
            </button>
          </div>
          <pre>{figmaPrompt || deckJson || "No deck yet."}</pre>
        </aside>
      </section>
    </main>
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
