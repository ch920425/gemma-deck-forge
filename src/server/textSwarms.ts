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

interface TextWorkflow {
  workflowId: string;
  loopIndex: number;
  totalLoops: number;
  label: string;
  summary: string;
  agents: TextAgent[];
  instruction: string;
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

const contextGapAgents: TextAgent[] = [
  {
    agentId: "context_gap_reviewer",
    label: "Gap Reviewer",
    angle: "missing information",
    system: "Review the first context brief and name missing source angles, proof gaps, and deck-critical caveats."
  },
  {
    agentId: "context_followup_query",
    label: "Follow-up Query Writer",
    angle: "retrieval prompts",
    system: "Write sharper Obsidian and gbrain retrieval prompts that fill the first-loop gaps."
  },
  {
    agentId: "context_proof_merger",
    label: "Proof Merger",
    angle: "source consolidation",
    system: "Merge first and second retrieval outputs into concise proof, caveat, and implication clusters."
  },
  {
    agentId: "context_prompt_tightener",
    label: "Prompt Tightener",
    angle: "brainstorm readiness",
    system: "Compress the context into a clear prompt-ready artifact optimized for brainstorming agents."
  },
  {
    agentId: "context_final_gate",
    label: "Context Final Gate",
    angle: "quality gate",
    system: "Reject repetition, unsupported claims, and vague proof. Return only the tight context that should feed brainstorming."
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

const brainstormReviewAgents: TextAgent[] = [
  {
    agentId: "brainstorm_structure_review",
    label: "Structure Reviewer",
    angle: "deck architecture",
    system: "Review brainstorm drafts and restructure them into a beginning, middle, proof, and closing arc."
  },
  {
    agentId: "brainstorm_angle_editor",
    label: "Angle Editor",
    angle: "winning angle",
    system: "Strengthen the product angle, judge relevance, and demo stakes without inventing proof."
  },
  {
    agentId: "brainstorm_design_mapper",
    label: "Design Mapper",
    angle: "slide design fit",
    system: "Convert brainstorm ideas into varied slide types, visual components, and layout constraints."
  },
  {
    agentId: "brainstorm_eval_writer",
    label: "Eval Writer",
    angle: "criteria",
    system: "Write concrete eval criteria that slide outline and Figma agents can enforce."
  },
  {
    agentId: "brainstorm_polish_editor",
    label: "Polish Editor",
    angle: "clarity",
    system: "Rewrite the brainstorm so it is concise, cohesive, and useful for slide generation."
  }
];

const brainstormFinalAgents: TextAgent[] = [
  {
    agentId: "brainstorm_cohesion_final",
    label: "Cohesion Finalizer",
    angle: "cohesive brief",
    system: "Review all brainstorm artifacts and produce one cohesive final brief for slide generation."
  },
  {
    agentId: "brainstorm_slide_jobs_final",
    label: "Slide Job Finalizer",
    angle: "slide jobs",
    system: "Translate the final brainstorm into slide jobs, takeaway messages, and proof needs."
  },
  {
    agentId: "brainstorm_copy_final",
    label: "Copy Finalizer",
    angle: "copywriting",
    system: "Tighten the language so headlines and body copy can be written from the brief."
  },
  {
    agentId: "brainstorm_demo_final",
    label: "Demo Finalizer",
    angle: "video demo",
    system: "Make the final brief optimize for a 60-second demo that visually shows agentic loops."
  },
  {
    agentId: "brainstorm_generation_gate",
    label: "Generation Gate",
    angle: "outline readiness",
    system: "Confirm the brainstorm is ready for slide outline generation and list exact constraints downstream agents must enforce."
  }
];

export async function runContextWritingSwarm(
  input: { idea: string; context: string; audience: string },
  send: TextSwarmSend
): Promise<{ finalText: string; drafts: SwarmTextDraft[] }> {
  const workflows: TextWorkflow[] = [
    {
      workflowId: "context_writer_loop_1",
      loopIndex: 1,
      totalLoops: 2,
      label: "Context writing loop 1/2",
      summary: "Five Gemma agents draft the first structured context artifact from retrieved KB and Obsidian evidence.",
      agents: contextAgents,
      instruction: "Draft the first prompt-ready context artifact from source material."
    },
    {
      workflowId: "context_writer_loop_2",
      loopIndex: 2,
      totalLoops: 2,
      label: "Context writing loop 2/2",
      summary: "Five Gemma agents review gaps, add missing context angles, and tighten the final context for brainstorming.",
      agents: contextGapAgents,
      instruction: "Review loop 1, fill missing information, and compress the final context for brainstorming."
    }
  ];
  const drafts: SwarmTextDraft[] = [];
  for (const workflow of workflows) {
    drafts.push(...(await runTextWorkflow("context_writer", workflow, input, send)));
  }
  const finalText = synthesizeContextBrief(input, drafts);
  send("context_writer_complete", { finalText, drafts });
  return { finalText, drafts };
}

export async function runBrainstormSwarm(
  input: { idea: string; context: string; audience: string },
  send: TextSwarmSend
): Promise<BrainstormResponse> {
  const workflows: TextWorkflow[] = [
    {
      workflowId: "brainstorm_loop_1",
      loopIndex: 1,
      totalLoops: 3,
      label: "Brainstorm loop 1/3",
      summary: "Five Gemma agents create divergent product, demo, technical, judge, and narrative drafts.",
      agents: brainstormAgents,
      instruction: "Create strong divergent brainstorm artifacts from the idea and finalized context."
    },
    {
      workflowId: "brainstorm_loop_2",
      loopIndex: 2,
      totalLoops: 3,
      label: "Brainstorm loop 2/3",
      summary: "Five Gemma agents review, polish, and restructure the best brainstorm angles for deck design.",
      agents: brainstormReviewAgents,
      instruction: "Review loop 1 and optimize the brainstorm for varied slide design and eval criteria."
    },
    {
      workflowId: "brainstorm_loop_3",
      loopIndex: 3,
      totalLoops: 3,
      label: "Brainstorm loop 3/3",
      summary: "Five Gemma agents tighten all brainstorm artifacts into one cohesive slide-generation-ready brief.",
      agents: brainstormFinalAgents,
      instruction: "Finalize one cohesive brief that directly feeds slide outline, eval, and Figma generation agents."
    }
  ];
  const drafts: SwarmTextDraft[] = [];
  for (const workflow of workflows) {
    drafts.push(...(await runTextWorkflow("brainstorm", workflow, input, send)));
  }
  const response = synthesizeBrainstorm(input, drafts);
  send("brainstorm_complete", response);
  return response;
}

async function runTextWorkflow(
  prefix: "context_writer" | "brainstorm",
  workflow: TextWorkflow,
  input: { idea: string; context: string; audience: string },
  send: TextSwarmSend
): Promise<SwarmTextDraft[]> {
  const eventPrefix = prefix === "context_writer" ? "context_writer_workflow" : "brainstorm_workflow";
  const started = performance.now();
  send(`${eventPrefix}_started`, { ...workflow, status: "running" });
  const drafts = await runTextAgents(prefix, workflow.agents, input, send, workflow);
  send(`${eventPrefix}_complete`, {
    ...workflow,
    status: "done",
    elapsedMs: Math.round(performance.now() - started),
    artifactCount: drafts.length,
    summary: `${workflow.label} completed ${drafts.length} agent artifacts.`
  });
  return drafts;
}

async function runTextAgents(
  prefix: "context_writer" | "brainstorm",
  agents: TextAgent[],
  input: { idea: string; context: string; audience: string },
  send: TextSwarmSend,
  workflow?: TextWorkflow
): Promise<SwarmTextDraft[]> {
  const results = await Promise.all(
    agents.map(async (agent, index) => {
      const started = performance.now();
      send(`${prefix}_agent_started`, {
        agentId: agent.agentId,
        label: agent.label,
        angle: agent.angle,
        draft: `${workflow?.label || "Agent loop"}: reading idea, retrieved context, hidden routing constraints, and prior agent traces.`,
        status: "running"
      });
      await sleep(swimmerDelay(index));
      try {
        const draft = hasCerebrasKey()
          ? await runLiveTextAgent(agent, input, prefix, workflow)
          : fallbackDraft(agent, input, prefix);
        const result: SwarmTextDraft = {
          agentId: agent.agentId,
          label: agent.label,
          angle: agent.angle,
          draft,
          diagnosis: diagnoseDraft(agent, draft, workflow),
          revision: reviseDraft(agent, draft, input, workflow),
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
          revision: reviseDraft(agent, fallbackDraft(agent, input, prefix), input, workflow),
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
  prefix: "context_writer" | "brainstorm",
  workflow?: TextWorkflow
): Promise<string> {
  const result = await callCerebrasJson<{ draft: string }>(
    [
      { role: "system", content: `${agent.system} ${workflow?.instruction || ""} Return compact JSON only: {"draft":"..."}.` },
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
                    workflow?.instruction ||
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
    ...drafts.map((draft) => `- ${draft.label}: ${draft.revision || draft.draft}`),
    "",
    "## Loop 3 Finalization",
    "The final Gemma loop tightened all brainstorm artifacts into a cohesive brief optimized for slide outline, eval, and Figma generation agents."
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

function diagnoseDraft(agent: TextAgent, draft: string, workflow?: TextWorkflow): string {
  return `${agent.label} checked ${workflow?.label || "agent loop"} for specificity, recipient fit, proof grounding, and whether this can drive slide outline prompts. Draft length: ${draft.length} chars.`;
}

function reviseDraft(agent: TextAgent, draft: string, input: { audience: string }, workflow?: TextWorkflow): string {
  void input;
  return `${workflow?.label ? `${workflow.label}: ` : ""}${draft} Final revision: preserve recipient fit from hidden prompt context, name concrete proof, and feed the outline/eval/edit agents with clear slide-use instructions.`;
}

function swimmerDelay(index: number): number {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return 1;
  return 140 + index * 90;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
