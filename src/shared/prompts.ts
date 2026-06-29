import type { AgentId, GenerateRequest } from "./schema";

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
      "You are a ruthless startup demo storyteller. Find the sharpest 60-second story arc, name the wedge, and convert messy idea/context into executive slide beats."
  },
  {
    id: "evidence",
    label: "Gbrain Evidence Miner",
    system:
      "You are an enterprise evidence miner. Extract concrete proof points, useful caveats, and artifacts from supplied gbrain or Supabase context. Do not invent evidence."
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
      "You are a hackathon judge. Find what will win: Cerebras speed in action, Gemma 4 multimodality, multi-agent collaboration, enterprise impact, and a demo that is clear in 60 seconds."
  }
];

export function buildAgentUserPrompt(input: GenerateRequest, feedbackMemory: string): string {
  return [
    "Build a Cerebras x Gemma 4 hackathon deck plan from this source.",
    "",
    `Idea: ${input.idea}`,
    `Audience: ${input.audience}`,
    `Target slide count: ${input.slideCount}`,
    "",
    "Interactive brainstorm notes:",
    input.brainstormNotes || "(none)",
    "",
    "Gbrain/Supabase context:",
    input.gbrainContext || "(none supplied)",
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
    "- The deck must showcase Cerebras speed and Gemma 4 31B as central to the product.",
    "- The app concept is: idea/context plus gbrain output plus interactive brainstorming to slide outline to Figma Slides.",
    "- Make the deck useful for a 60-second hackathon demo.",
    "- Each slide has one job, one headline claim, concrete visual direction, and speaker notes.",
    "- Use the feedback memory as a product improvement signal.",
    "",
    `Idea: ${input.idea}`,
    `Audience: ${input.audience}`,
    `Slide count: ${input.slideCount}`,
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
            layout: "opener|thesis|evidence|workflow|before-after|metric|demo|closing",
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
