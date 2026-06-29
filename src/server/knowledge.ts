import { spawn } from "node:child_process";
import type { KnowledgeHit } from "../shared/schema";

export interface KnowledgeQueryResult {
  ok: boolean;
  query: string;
  sql: string;
  hits: KnowledgeHit[];
  raw: string;
  error?: string;
}

export function buildKnowledgeSql(query: string, limit: number): string {
  const safeLimit = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const q = sqlLiteral(query.trim() || "Gemma Cerebras slide deck");
  return `
with hits as (
  select
    'page' as source,
    coalesce(title, 'Untitled page') as title,
    left(coalesce(compiled_truth, timeline, ''), 1200) as excerpt,
    ts_rank(search_vector, plainto_tsquery('english', ${q})) as score
  from public.pages
  where search_vector @@ plainto_tsquery('english', ${q})
  union all
  select
    'chunk' as source,
    coalesce(symbol_name_qualified, doc_comment, page_id::text, 'Untitled chunk') as title,
    left(coalesce(chunk_text, ''), 1200) as excerpt,
    ts_rank(search_vector, plainto_tsquery('english', ${q})) as score
  from public.content_chunks
  where search_vector @@ plainto_tsquery('english', ${q})
)
select source, title, excerpt, round(score::numeric, 4) as score
from hits
where excerpt <> ''
order by score desc
limit ${safeLimit};
`.trim();
}

export async function runKnowledgeQuery(query: string, limit = 8, timeoutMs = 20_000): Promise<KnowledgeQueryResult> {
  const sql = buildKnowledgeSql(query, limit);
  const args = ["db", "query", "--output", "json"];
  if (process.env.KNOWLEDGE_SUPABASE_DB_URL) {
    args.push("--db-url", process.env.KNOWLEDGE_SUPABASE_DB_URL);
  } else {
    args.push("--linked");
  }
  const workdir = process.env.KNOWLEDGE_SUPABASE_WORKDIR;
  if (workdir) {
    args.push("--workdir", workdir);
  }
  args.push(sql);

  const result = await runCommand("supabase", args, timeoutMs);
  if (result.code !== 0) {
    return {
      ok: false,
      query,
      sql,
      hits: [],
      raw: result.stdout || result.stderr,
      error: result.stderr || result.stdout || `supabase exited with ${result.code}`
    };
  }

  const hits = parseSupabaseRows(result.stdout);
  return {
    ok: true,
    query,
    sql,
    hits,
    raw: result.stdout
  };
}

export function parseSupabaseRows(raw: string): KnowledgeHit[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(extractJson(trimmed)) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(rowToHit).filter(Boolean) as KnowledgeHit[];
    }
    if (parsed && typeof parsed === "object") {
      const rows = (parsed as { data?: unknown[]; rows?: unknown[] }).data || (parsed as { rows?: unknown[] }).rows;
      if (Array.isArray(rows)) {
        return rows.map(rowToHit).filter(Boolean) as KnowledgeHit[];
      }
    }
  } catch {
    return parseTableRows(trimmed);
  }
  return [];
}

function extractJson(raw: string): string {
  const objectStart = raw.indexOf("{");
  const arrayStart = raw.indexOf("[");
  const start =
    objectStart === -1 ? arrayStart : arrayStart === -1 ? objectStart : Math.min(objectStart, arrayStart);
  return start > 0 ? raw.slice(start) : raw;
}

function parseTableRows(raw: string): KnowledgeHit[] {
  return raw
    .split("\n")
    .filter((line) => line.includes("|") && !line.includes("---"))
    .slice(1)
    .map((line) => {
      const [source, title, excerpt, score] = line.split("|").map((part) => part.trim());
      return {
        source,
        title,
        excerpt,
        score: Number(score) || undefined
      };
    })
    .filter((hit) => hit.title && hit.excerpt);
}

function rowToHit(row: unknown): KnowledgeHit | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const record = row as Record<string, unknown>;
  const title = String(record.title || "");
  const excerpt = String(record.excerpt || "");
  if (!title && !excerpt) {
    return null;
  }
  return {
    source: String(record.source || "knowledge"),
    title,
    excerpt,
    score: Number(record.score) || undefined,
    url: record.url ? String(record.url) : undefined
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''").slice(0, 240)}'`;
}

export function runCommand(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += `\nTimed out after ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message });
    });
  });
}
