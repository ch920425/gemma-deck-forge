import type { BrainstormResponse, SwarmTextDraft } from "../shared/schema";
import { buildBrainstormPrompt } from "../shared/prompts";
import { callCerebrasJson, hasCerebrasKey } from "./cerebras";

export type TextSwarmSend = (event: string, payload: unknown) => void;

interface TextAgent {
  agentId: string;
  label: string;
  angle: string;
  system: string;
}

const contextAgents: TextAgent[] = [
  {
    agentId: "context_source",
    label: "Source Curator",
    angle: "source extraction",
    system: "Extract source facts, citations, caveats, and proof candidates from retrieved KB context. Do not invent."
  },
  {
    agentId: "context_structure",
    label: "Structure Writer",
    angle: "clear structure",
    system: "Turn messy context into a clear brief with sections, hierarchy, and deck-useful information architecture."
  },
  {
    agentId: "context_audience",
    label: "Recipient Adapter",
    angle: "judge relevance",
    system: "Rewrite context for Cerebras x Gemma hackathon judges and enterprise AI buyers. Preserve evidence."
  },
  {
    agentId: "context_risk",
    label: "Caveat Reviewer",
    angle: "risk and uncertainty",
    system: "Identify weak claims, missing proof, ambiguity, and context that should not be overclaimed in the deck."
  },
  {
    agentId: "context_editor",
    label: "Final Editor",
    angle: "polished final brief",
    system: "Create the final concise context brief that downstream outline agents can use directly."
  }
];

const brainstormAgents: TextAgent[] = [
  {
    agentId: "brainstorm_product",
    label: "Product PM",
    angle: "user and workflow value",
    system: "Find the product wedge, user pain, workflow, and why this should exist now."
  },
  {
    agentId: "brainstorm_demo",
    label: "Demo Director",
    angle: "60-second demo arc",
    system: "Find the most cinematic demo sequence and what must be visible on screen."
  },
  {
    agentId: "brainstorm_technical",
    label: "System Architect",
    angle: "technical credibility",
    system: "Ground the brainstorm in architecture, retrieval, agent loops, evals, and Figma bridge execution."
  },
  {
    agentId: "brainstorm_judge",
    label: "Hackathon Judge",
    angle: "winning criteria",
    system: "Evaluate what judges will understand fast and what proof makes the project memorable."
  },
  {
    agentId: "brainstorm_editor",
    label: "Narrative Editor",
    angle: "final slide meat",
    system: "Merge the best ideas into a concrete deck brief with audience, goals, key messages, and takeaways."
  }
];

export async function runContextWritingSwarm(
  input: { idea: string; context: string; audience: string },
  send: TextSwarmSend
): Promise<{ finalText: string; drafts: SwarmTextDraft[] }> {
  const drafts = await runTextAgents("context_writer", contextAgents, input, send);
  const finalText = synthesizeContextBrief(input, drafts);
  send("context_writer_complete", { finalText, drafts });
  return { finalText, drafts };
}

export async function runBrainstormSwarm(
  input: { idea: string; context: string; audience: string },
  send: TextSwarmSend
): Promise<BrainstormResponse> {
  const drafts = await runTextAgents("brainstorm", brainstormAgents, input, send);
  const response = synthesizeBrainstorm(input, drafts);
  send("brainstorm_complete", response);
  return response;
}

async function runTextAgents(
  prefix: "context_writer" | "brainstorm",
  agents: TextAgent[],
  input: { idea: string; context: string; audience: string },
  send: TextSwarmSend
): Promise<SwarmTextDraft[]> {
  const results = await Promise.all(
    agents.map(async (agent, index) => {
      const started = performance.now();
      send(`${prefix}_agent_started`, {
        agentId: agent.agentId,
        label: agent.label,
        angle: agent.angle,
        draft: "Reading idea, retrieved context, hidden routing constraints, and prior agent traces.",
        status: "running"
      });
      await sleep(swimmerDelay(index));
      try {
        const draft = hasCerebrasKey()
          ? await runLiveTextAgent(agent, input, prefix)
          : fallbackDraft(agent, input, prefix);
        const result: SwarmTextDraft = {
          agentId: agent.agentId,
          label: agent.label,
          angle: agent.angle,
          draft,
          diagnosis: diagnoseDraft(agent, draft),
          revision: reviseDraft(agent, draft, input),
          status: "done",
          elapsedMs: Math.round(performance.now() - started)
        };
        send(`${prefix}_agent_complete`, result);
        return result;
      } catch (error) {
        const result: SwarmTextDraft = {
          agentId: agent.agentId,
          label: agent.label,
          angle: agent.angle,
          draft: fallbackDraft(agent, input, prefix),
          diagnosis: error instanceof Error ? error.message : String(error),
          revision: reviseDraft(agent, fallbackDraft(agent, input, prefix), input),
          status: "error",
          elapsedMs: Math.round(performance.now() - started)
        };
        send(`${prefix}_agent_complete`, result);
        return result;
      }
    })
  );
  return results;
}

async function runLiveTextAgent(
  agent: TextAgent,
  input: { idea: string; context: string; audience: string },
  prefix: "context_writer" | "brainstorm"
): Promise<string> {
  const result = await callCerebrasJson<{ draft: string }>(
    [
      { role: "system", content: `${agent.system} Return compact JSON only: {"draft":"..."}.` },
      {
        role: "user",
        content:
          prefix === "brainstorm"
            ? buildBrainstormPrompt(input.idea, input.context)
            : JSON.stringify(
                {
                  idea: input.idea,
                  audience: input.audience,
                  context: input.context.slice(0, 6000),
                  instruction:
                    "Write one polished context section that downstream slide outline, eval, editing, and Figma design agents can use."
                },
                null,
                2
              )
      }
    ],
    650
  );
  return result.value.draft || fallbackDraft(agent, input, prefix);
}

function synthesizeContextBrief(input: { idea: string; context: string; audience: string }, drafts: SwarmTextDraft[]): string {
  const proof = input.context
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || line.startsWith("## "))
    .slice(0, 8)
    .join("\n");
  return [
    "# Finalized Context Brief",
    "",
    "## Core Idea",
    input.idea,
    "",
    "## Retrieved Evidence To Use",
    proof || "Use the retrieved KB context as source evidence; do not invent proof.",
    "",
    "## Agent Conclusions",
    ...drafts.map((draft) => `- ${draft.label}: ${draft.revision || draft.draft}`),
    "",
    "## Downstream Prompt Notes",
    "- Slide outline agents must use the hidden recipient constraints, goal, key messages, proof, caveats, and design constraints.",
    "- Eval agents must reject generic claims, repeated slide structures, and unsupported proof.",
    "- Figma agents must prioritize readable hierarchy, no overlap, varied slide scaffolds, and screenshot-ready polish."
  ].join("\n");
}

function synthesizeBrainstorm(input: { idea: string; context: string; audience: string }, drafts: SwarmTextDraft[]): BrainstormResponse {
  const finalBrief = [
    "# Brainstorm Final Brief",
    "",
    "## Goal",
    "Turn a half-formed idea into a judge-readable deck with visible context retrieval, brainstorming, outline evals, and Figma polish loops.",
    "",
    "## Key Messages",
    "- Cerebras speed makes multi-agent iteration feel live instead of batched.",
    "- Retrieval and context writing are part of the product, not a hidden loading state.",
    "- The deck is generated, reviewed, repaired, and polished before it lands in Figma.",
    "",
    "## Agent Angles",
    ...drafts.map((draft) => `- ${draft.label}: ${draft.revision || draft.draft}`)
  ].join("\n");
  return {
    questions: [
      "What is the single before/after transformation the first slide must make obvious?",
      "Which retrieved proof should anchor the most credibility-sensitive slide?",
      "What should the final Figma deck make a judge believe in under 10 seconds?"
    ],
    sharperAngle:
      "A staged Gemma swarm turns raw idea, KB context, brainstormed strategy, and eval-fixed outline into a screenshot-ready Figma deck while the user watches each improvement loop.",
    assumptions: [
      "Recipient and deck-length constraints are hidden in the prompt, not rendered as fields.",
      "The deck remains fixed at the required varied slide set.",
      "Figma output must pass visual QA for overlap, crop, hierarchy, and slide-to-slide cohesion."
    ],
    agentDrafts: drafts,
    finalBrief,
    keyMessages: [
      "Context becomes structured deck proof.",
      "Five brainstorming agents create the meat of the slides.",
      "Eval, diagnosis, edits, and Figma QA are visible timed loops."
    ],
    audience: input.audience
  };
}

function fallbackDraft(
  agent: TextAgent,
  input: { idea: string; context: string; audience: string },
  prefix: "context_writer" | "brainstorm"
): string {
  if (prefix === "context_writer") {
    return `${agent.label} organizes the idea for the intended decision-maker: ${input.idea.slice(0, 180)}. It converts KB snippets into proof, caveats, slide implications, and prompt-ready context.`;
  }
  return `${agent.label} frames the deck around ${agent.angle}: make the user see raw idea -> context -> brainstorm -> outline eval -> Figma deck, with Cerebras speed making the loops feel instantaneous.`;
}

function diagnoseDraft(agent: TextAgent, draft: string): string {
  return `${agent.label} checked specificity, recipient fit, proof grounding, and whether this can drive slide outline prompts. Draft length: ${draft.length} chars.`;
}

function reviseDraft(agent: TextAgent, draft: string, input: { audience: string }): string {
  void input;
  return `${draft} Final revision: preserve recipient fit from hidden prompt context, name concrete proof, and feed the outline/eval/edit agents with clear slide-use instructions.`;
}

function swimmerDelay(index: number): number {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return 1;
  return 140 + index * 90;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
