import type { AgentId, GenerateRequest } from "./schema";
import { formatOutlineStylePrompt } from "./outlineStyles";

export interface AgentPrompt {
  id: Exclude<AgentId, "synthesizer" | "polisher">;
  label: string;
  system: string;
}

export const agentPrompts: AgentPrompt[] = [
  {
    id: "story",
    label: "Story Architect",
    system:
      "You are a ruthless product storyteller. Find the sharpest narrative arc, name the wedge, and convert messy idea/context into executive slide beats."
  },
  {
    id: "evidence",
    label: "Knowledge Evidence Miner",
    system:
      "You are an enterprise evidence miner. Extract concrete proof points, useful caveats, and artifacts from supplied knowledge or Supabase context. Do not invent evidence."
  },
  {
    id: "visual",
    label: "Visual Director",
    system:
      "You are a presentation visual director. Design slide-level visual concepts that show speed, parallelism, and product impact without generic diagrams or decorative filler."
  },
  {
    id: "figma",
    label: "Figma Builder",
    system:
      "You are a Figma Slides implementation planner. Convert narrative beats into slide layouts and layer instructions that can be rendered by an agent through Figma Desktop Bridge."
  },
  {
    id: "critic",
    label: "Hackathon Critic",
    system:
      "You are a hackathon judge. Find what will win: Cerebras speed in action, Gemma 4 multimodality, multi-agent collaboration, enterprise impact, and a product story that is immediately clear."
  }
];

export function buildAgentUserPrompt(input: GenerateRequest, feedbackMemory: string): string {
  return [
    "Build a Cerebras x Gemma 4 hackathon deck plan from this source.",
    "The final deck is fixed at 10 slides. Each slide must use a different outline format from this exact catalog:",
    formatOutlineStylePrompt(),
    "",
    `Idea: ${input.idea}`,
    `Audience: ${input.audience}`,
    "Target slide count: 10",
    "",
    "Interactive brainstorm notes:",
    input.brainstormNotes || "(none)",
    "",
    "Knowledge/Supabase context:",
    input.sourceContext || "(none supplied)",
    "",
    "Feedback memory to incorporate:",
    feedbackMemory || "(none yet)",
    "",
    "Return JSON with keys: summary, slideIdeas, risks. slideIdeas should include title, headline, visual, evidence."
  ].join("\n");
}

export function buildSynthesisPrompt(input: GenerateRequest, agentJson: string, feedbackMemory: string): string {
  return [
    "Synthesize the parallel agent findings into a final deck spec.",
    "",
    "Hard constraints:",
    "- The deck is exactly 10 slides.",
    "- The 10 slides must use these 10 distinct outline formats in order:",
    formatOutlineStylePrompt(),
    "- The deck must showcase Cerebras speed and Gemma 4 31B as central to the product.",
    "- The app concept is: idea/context plus knowledge output plus interactive brainstorming to slide outline to Figma Slides.",
    "- Make the deck useful for live hackathon review and later product inspection.",
    "- Each slide has one job, one headline claim, concrete visual direction, and speaker notes.",
    "- Each slide's formatRequirement, informationArchitecture, designDirective, and evalCriteria must dictate its Figma design.",
    "- Use the feedback memory as a product improvement signal.",
    "",
    `Idea: ${input.idea}`,
    `Audience: ${input.audience}`,
    "Slide count: 10",
    `Feedback memory: ${feedbackMemory || "(none yet)"}`,
    "",
    "Agent findings:",
    agentJson,
    "",
    "Return only valid JSON matching this shape:",
    JSON.stringify(
      {
        title: "string",
        audience: "string",
        thesis: "string",
        narrativeArc: ["string"],
        slides: [
          {
            id: "s1",
            title: "string",
            headline: "string",
            body: "string",
            bullets: ["string"],
            evidence: ["string"],
            visual: "string",
            layout: "opener|thesis|evidence|workflow|before-after|metric|system-map|quote|artifact|closing",
            formatId: "cold-open|stakes-thesis|context-map|evidence-wall|workflow-loop|before-after|speed-metric|system-map|critique-fix|operator-close",
            formatLabel: "string",
            formatRequirement: "string",
            informationArchitecture: ["string"],
            designDirective: "string",
            evalCriteria: ["string"],
            accent: "#0E7C66",
            speakerNotes: "string"
          }
        ],
        demoScript: ["string"]
      },
      null,
      2
    )
  ].join("\n");
}

export function buildBrainstormPrompt(idea: string, context: string): string {
  return [
    "You are running a concise interactive PM brainstorm before deck generation.",
    "Ask only high-leverage questions, then propose the sharper angle.",
    "",
    `Idea: ${idea}`,
    "",
    "Context:",
    context || "(none)",
    "",
    "Return JSON with questions, sharperAngle, assumptions."
  ].join("\n");
}
