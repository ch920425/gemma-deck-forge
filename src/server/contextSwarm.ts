import { existsSync } from "node:fs";
import path from "node:path";
import type { GbrainHit } from "../shared/schema";
import { callCerebrasJson, hasCerebrasKey } from "./cerebras";
import { runCommand, runGbrainQuery } from "./gbrain";

export type ContextLaneId = "gbrain" | "obsidian" | "gemma" | "brief";

export interface ContextSwarmInput {
  idea: string;
  query: string;
  existingContext?: string;
  limit?: number;
}

export interface ContextLaneResult {
  laneId: ContextLaneId;
  label: string;
  ok: boolean;
  summary: string;
  hits: GbrainHit[];
  elapsedMs: number;
  raw?: string;
  error?: string;
}

export type ContextSwarmSend = (event: string, payload: unknown) => void;

const laneLabels: Record<ContextLaneId, string> = {
  gbrain: "Supabase gbrain",
  obsidian: "Obsidian vault",
  gemma: "Gemma organizer",
  brief: "Local context brief"
};

export async function runContextSwarm(input: ContextSwarmInput, send: ContextSwarmSend): Promise<ContextLaneResult[]> {
  const normalized = normalizeContextInput(input);
  const tasks = [
    runLane("gbrain", send, () => runGbrainLane(normalized)),
    runLane("obsidian", send, () => runObsidianLane(normalized)),
    runLane("gemma", send, () => runGemmaLane(normalized)),
    runLane("brief", send, () => runBriefLane(normalized))
  ];
  const results = await Promise.all(tasks);
  send("context_complete", {
    ok: results.some((result) => result.ok),
    laneCount: results.length,
    hitCount: results.flatMap((result) => result.hits).length,
    hits: results.flatMap((result) => result.hits).slice(0, 12),
    context: buildContextDigest(results),
    lanes: results
  });
  return results;
}

export async function runObsidianVaultSearch(
  query: string,
  limit = 6,
  vaultPath = getObsidianVaultPath()
): Promise<ContextLaneResult> {
  const started = performance.now();
  if (!vaultPath || !existsSync(vaultPath)) {
    return {
      laneId: "obsidian",
      label: laneLabels.obsidian,
      ok: false,
      summary: "No Obsidian vault path was available for local context search.",
      hits: [],
      elapsedMs: elapsed(started),
      error: "missing_obsidian_vault"
    };
  }

  const pattern = buildObsidianSearchPattern(query);
  const result = await runCommand(
    "rg",
    ["--with-filename", "--line-number", "--no-heading", "-i", "-m", "2", pattern, vaultPath],
    2200
  );
  if (result.code !== 0 && !result.stdout.trim()) {
    return {
      laneId: "obsidian",
      label: laneLabels.obsidian,
      ok: false,
      summary: "Obsidian CLI search did not find matching local notes.",
      hits: [],
      raw: result.stdout || result.stderr,
      elapsedMs: elapsed(started),
      error: result.stderr || "no_obsidian_matches"
    };
  }

  const hits = parseRipgrepHits(result.stdout, vaultPath).slice(0, limit);
  return {
    laneId: "obsidian",
    label: laneLabels.obsidian,
    ok: true,
    summary: hits.length
      ? `Found ${hits.length} local note excerpts to ground the deck.`
      : "Obsidian scan completed, but no usable excerpts were found.",
    hits,
    raw: result.stdout,
    elapsedMs: elapsed(started)
  };
}

export function buildContextDigest(results: ContextLaneResult[]): string {
  const sections = results.map((result) => {
    const hitText = result.hits
      .slice(0, 5)
      .map((hit) => `- ${hit.source}: ${hit.title}\n  ${hit.excerpt}`)
      .join("\n");
    return [`## ${result.label}`, result.summary, hitText].filter(Boolean).join("\n");
  });
  return sections.join("\n\n").slice(0, 9000);
}

export function buildObsidianSearchPattern(query: string): string {
  const tokens = query
    .split(/[^A-Za-z0-9_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 8);
  return tokens.length ? tokens.map(escapeRegExp).join("|") : "Gemma|Cerebras|Figma|deck|agent";
}

async function runLane(
  laneId: ContextLaneId,
  send: ContextSwarmSend,
  task: () => Promise<ContextLaneResult>
): Promise<ContextLaneResult> {
  const label = laneLabels[laneId];
  send("context_lane_started", { laneId, label, summary: "Starting" });
  const timers = scheduleLaneProgress(laneId, label, send);
  try {
    const result = await task();
    send("context_lane_complete", result);
    return result;
  } catch (error) {
    const result: ContextLaneResult = {
      laneId,
      label,
      ok: false,
      summary: `${label} hit an error and yielded to fallback context.`,
      hits: [],
      elapsedMs: 0,
      error: error instanceof Error ? error.message : String(error)
    };
    send("context_lane_error", result);
    return result;
  } finally {
    timers.forEach((timer) => clearTimeout(timer));
  }
}

async function runGbrainLane(input: Required<ContextSwarmInput>): Promise<ContextLaneResult> {
  const started = performance.now();
  const timeoutMs = Number(process.env.GEMMA_CONTEXT_GBRAIN_TIMEOUT_MS) || 7000;
  const result = await runGbrainQuery(input.query, input.limit, timeoutMs);
  return {
    laneId: "gbrain",
    label: laneLabels.gbrain,
    ok: result.ok,
    summary: result.ok
      ? `Supabase gbrain returned ${result.hits.length} ranked snippets.`
      : "Supabase gbrain was unavailable, so the swarm will continue with other context lanes.",
    hits: result.hits,
    raw: result.raw,
    error: result.error,
    elapsedMs: elapsed(started)
  };
}

async function runObsidianLane(input: Required<ContextSwarmInput>): Promise<ContextLaneResult> {
  return runObsidianVaultSearch(`${input.query} ${input.idea}`, Math.min(input.limit, 8));
}

async function runGemmaLane(input: Required<ContextSwarmInput>): Promise<ContextLaneResult> {
  const started = performance.now();
  if (!hasCerebrasKey()) {
    return {
      laneId: "gemma",
      label: laneLabels.gemma,
      ok: true,
      summary: "Gemma organizer fallback grouped the request around speed, evidence, and Figma proof.",
      hits: [contextHit("gemma", "Fallback organization", fallbackGemmaContext(input))],
      elapsedMs: elapsed(started)
    };
  }

  const result = await callCerebrasJson<{ summary: string; bullets: string[]; searchAngles: string[] }>(
    [
      {
        role: "system",
        content:
          "You are a fast context organizer in a parallel Gemma swarm. Return compact JSON only. Organize the user's idea into evidence angles, Obsidian/gbrain search angles, and deck implications."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            idea: input.idea,
            query: input.query,
            existingContext: input.existingContext.slice(0, 3000)
          },
          null,
          2
        )
      }
    ],
    500
  );
  const summary = result.value.summary || "Gemma organized context angles for the deck swarm.";
  return {
    laneId: "gemma",
    label: laneLabels.gemma,
    ok: true,
    summary,
    hits: [
      contextHit(
        "gemma",
        "Context organization",
        [...(result.value.bullets || []), ...(result.value.searchAngles || [])].join(" ")
      )
    ],
    elapsedMs: elapsed(started)
  };
}

async function runBriefLane(input: Required<ContextSwarmInput>): Promise<ContextLaneResult> {
  const started = performance.now();
  await sleep(180);
  return {
    laneId: "brief",
    label: laneLabels.brief,
    ok: true,
    summary: "Local brief is ready immediately, so the deck agents do not wait on slow retrieval.",
    hits: [
      contextHit(
        "brief",
        "User brief",
        [input.idea, input.existingContext || "No manual context supplied yet."].join("\n")
      )
    ],
    elapsedMs: elapsed(started)
  };
}

function parseRipgrepHits(raw: string, vaultPath: string): GbrainHit[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) return null;
      const [, filePath, lineNumber, excerpt] = match;
      return {
        source: "obsidian",
        title: `${path.relative(vaultPath, filePath)}:${lineNumber}`,
        excerpt: cleanExcerpt(excerpt),
        url: filePath
      };
    })
    .filter(Boolean) as GbrainHit[];
}

function normalizeContextInput(input: ContextSwarmInput): Required<ContextSwarmInput> {
  return {
    idea: input.idea?.trim() || "Agentic Gemma deck builder",
    query: input.query?.trim() || "Gemma Cerebras Figma deck agentic",
    existingContext: input.existingContext?.trim() || "",
    limit: Math.min(Math.max(Number(input.limit) || 8, 1), 12)
  };
}

function getObsidianVaultPath(): string {
  return process.env.OBSIDIAN_VAULT_PATH || "/Users/chaseungjae/Vaults/obsidian";
}

function scheduleLaneProgress(laneId: ContextLaneId, label: string, send: ContextSwarmSend): NodeJS.Timeout[] {
  const messages: Record<ContextLaneId, string[]> = {
    gbrain: ["Supabase CLI query issued", "Ranking page and chunk hits", "Still waiting; other lanes keep working"],
    obsidian: ["Scanning local notes", "Extracting matching note excerpts", "Local search fallback is bounded"],
    gemma: ["Gemma is organizing retrieval angles", "Compressing context into deck-useful claims", "Preparing late-context merge notes"],
    brief: ["Normalizing user brief", "Preparing immediate fallback context", "Ready to unblock deck agents"]
  };
  return [700, 1800, 4200].map((delay, index) =>
    setTimeout(() => {
      send("context_lane_progress", {
        laneId,
        label,
        summary: messages[laneId][index]
      });
    }, delay)
  );
}

function fallbackGemmaContext(input: Required<ContextSwarmInput>): string {
  return [
    `Deck idea: ${input.idea}`,
    "Useful context angles: speed as UX, parallel agents as visible work, Figma mutation as proof, gbrain/Obsidian retrieval as grounding.",
    "Demo implication: start agents immediately from the brief, then merge late CLI context as evidence cards and critique notes."
  ].join(" ");
}

function contextHit(source: string, title: string, excerpt: string): GbrainHit {
  return {
    source,
    title,
    excerpt: cleanExcerpt(excerpt || title)
  };
}

function cleanExcerpt(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
