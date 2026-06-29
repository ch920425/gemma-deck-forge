import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildContextDigest,
  buildLocalNotesSearchPattern,
  runContextSwarm,
  runLocalNotesSearch
} from "../src/server/contextSwarm";
import type { ContextLaneResult } from "../src/server/contextSwarm";

let vaultDir = "";
let previousPrimary: string | undefined;
let previousBackup: string | undefined;
let previousKeyList: string | undefined;
let previousSupabaseWorkdir: string | undefined;
let previousLocalNotesPath: string | undefined;
let previousKnowledgeTimeout: string | undefined;

beforeEach(async () => {
  vaultDir = await mkdtemp(path.join(tmpdir(), "gemma-local-notes-"));
  previousPrimary = process.env.CEREBRAS_API_KEY;
  previousBackup = process.env.CEREBRAS_BACKUP_API_KEY;
  previousKeyList = process.env.CEREBRAS_API_KEYS;
  previousSupabaseWorkdir = process.env.KNOWLEDGE_SUPABASE_WORKDIR;
  previousLocalNotesPath = process.env.LOCAL_NOTES_PATH;
  previousKnowledgeTimeout = process.env.GEMMA_CONTEXT_KNOWLEDGE_TIMEOUT_MS;
  delete process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_BACKUP_API_KEY;
  delete process.env.CEREBRAS_API_KEYS;
  process.env.KNOWLEDGE_SUPABASE_WORKDIR = vaultDir;
  process.env.LOCAL_NOTES_PATH = vaultDir;
  process.env.GEMMA_CONTEXT_KNOWLEDGE_TIMEOUT_MS = "50";
});

afterEach(async () => {
  restoreEnv("CEREBRAS_API_KEY", previousPrimary);
  restoreEnv("CEREBRAS_BACKUP_API_KEY", previousBackup);
  restoreEnv("CEREBRAS_API_KEYS", previousKeyList);
  restoreEnv("KNOWLEDGE_SUPABASE_WORKDIR", previousSupabaseWorkdir);
  restoreEnv("LOCAL_NOTES_PATH", previousLocalNotesPath);
  restoreEnv("GEMMA_CONTEXT_KNOWLEDGE_TIMEOUT_MS", previousKnowledgeTimeout);
  await rm(vaultDir, { recursive: true, force: true });
});

describe("context swarm helpers", () => {
  it("builds a bounded rg pattern from the query terms", () => {
    expect(buildLocalNotesSearchPattern("Gemma Cerebras Figma deck agentic knowledge")).toBe(
      "Gemma|Cerebras|Figma|deck|agentic|knowledge"
    );
    expect(buildLocalNotesSearchPattern("a to of")).toContain("Gemma");
  });

  it("uses a real CLI search over a local notes-style vault", async () => {
    await mkdir(path.join(vaultDir, "Notes"), { recursive: true });
    await writeFile(
      path.join(vaultDir, "Notes", "deck.md"),
      [
        "# Gemma deck notes",
        "Cerebras speed makes the Figma slide builder feel live.",
        "Agentic context organization should keep moving while knowledge is slow."
      ].join("\n"),
      "utf8"
    );

    const result = await runLocalNotesSearch("Gemma Cerebras Figma", 4, vaultDir);
    expect(result.ok).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].source).toBe("local_notes");
    expect(result.hits.map((hit) => hit.excerpt).join(" ")).toContain("Cerebras speed");
  });

  it("returns structured failures for missing vaults and no-match scans", async () => {
    const missing = await runLocalNotesSearch("Gemma", 4, path.join(vaultDir, "missing"));
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("missing_local_notes_vault");

    await mkdir(path.join(vaultDir, "Notes"), { recursive: true });
    await writeFile(path.join(vaultDir, "Notes", "other.md"), "unrelated note", "utf8");
    const noMatch = await runLocalNotesSearch("Cerebras", 4, vaultDir);
    expect(noMatch.ok).toBe(false);
    expect(noMatch.summary).toContain("did not find");
  });

  it("streams all context lanes and completes even when live providers fall back", async () => {
    await mkdir(path.join(vaultDir, "Notes"), { recursive: true });
    await writeFile(
      path.join(vaultDir, "Notes", "swarm.md"),
      "Gemma agents should organize knowledge and local notes context while the UI keeps moving.",
      "utf8"
    );

    const events: string[] = [];
    const payloads: unknown[] = [];
    const results = await runContextSwarm(
      {
        idea: "Make querying look like a working context swarm.",
        query: "Gemma knowledge local notes context",
        existingContext: "manual note",
        limit: 4
      },
      (event, payload) => {
        events.push(event);
        payloads.push(payload);
      }
    );

    expect(results).toHaveLength(8);
    expect(events.filter((event) => event === "context_workflow_started")).toHaveLength(2);
    expect(events.filter((event) => event === "context_workflow_complete")).toHaveLength(2);
    expect(events.filter((event) => event === "context_lane_started")).toHaveLength(8);
    expect(events).toContain("context_complete");
    expect(results.some((result) => result.laneId === "gemma" && result.ok)).toBe(true);
    expect(results.some((result) => result.laneId === "gemma_gap_review" && result.ok)).toBe(true);
    expect(results.some((result) => result.laneId === "local_notes" && result.hits.length > 0)).toBe(true);
    expect(JSON.stringify(payloads.at(-1))).toContain("context");
  });

  it("keeps the swarm alive when the Gemma organizer provider path fails", async () => {
    process.env.CEREBRAS_API_KEY = ["csk", "invalidcredentialforredaction"].join("-");
    await mkdir(path.join(vaultDir, "Notes"), { recursive: true });
    await writeFile(
      path.join(vaultDir, "Notes", "fallback.md"),
      "Gemma context fallback should not block local notes evidence.",
      "utf8"
    );

    const events: string[] = [];
    const results = await runContextSwarm(
      {
        idea: "Make context querying look alive.",
        query: "Gemma context fallback local notes",
        limit: 2
      },
      (event) => events.push(event)
    );

    const gemma = results.find((result) => result.laneId === "gemma");
    expect(gemma?.ok).toBe(false);
    expect(gemma?.error).toMatch(/Cerebras API|fetch|invalid|401/i);
    expect(results.some((result) => result.laneId === "local_notes" && result.ok)).toBe(true);
    expect(events).toContain("context_lane_error");
    expect(events).toContain("context_complete");
  }, 30_000);

  it("builds a digest from multiple context lanes", () => {
    const results: ContextLaneResult[] = [
      {
        laneId: "brief",
        label: "Local context brief",
        ok: true,
        summary: "Ready immediately",
        elapsedMs: 10,
        hits: [{ source: "brief", title: "Idea", excerpt: "Make querying feel parallel." }]
      },
      {
        laneId: "local_notes",
        label: "Local notes search",
        ok: true,
        summary: "Found notes",
        elapsedMs: 20,
        hits: [{ source: "local_notes", title: "deck.md:2", excerpt: "Local note evidence." }]
      }
    ];
    const digest = buildContextDigest(results);
    expect(digest).toContain("Local context brief");
    expect(digest).toContain("Local notes search");
    expect(digest).toContain("Make querying feel parallel.");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
