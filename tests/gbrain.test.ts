import { describe, expect, it } from "vitest";
import { buildGbrainSql, parseSupabaseRows, runCommand, runGbrainQuery } from "../src/server/gbrain";

describe("gbrain Supabase CLI query", () => {
  it("builds a bounded full text search over pages and chunks", () => {
    const sql = buildGbrainSql("Gemma's fastest deck", 50);
    expect(sql).toContain("public.pages");
    expect(sql).toContain("public.content_chunks");
    expect(sql).toContain("Gemma''s fastest deck");
    expect(sql).toContain("limit 20");
  });

  it("parses Supabase JSON output into evidence hits", () => {
    const hits = parseSupabaseRows(
      JSON.stringify([
        {
          source: "page",
          title: "Gemma notes",
          excerpt: "Cerebras speed matters",
          score: "0.42"
        }
      ])
    );
    expect(hits).toEqual([
      {
        source: "page",
        title: "Gemma notes",
        excerpt: "Cerebras speed matters",
        score: 0.42
      }
    ]);
  });

  it("parses data-wrapper output and skips empty rows", () => {
    const hits = parseSupabaseRows(
      JSON.stringify({
        data: [
          null,
          {},
          { source: "chunk", title: "Chunk", excerpt: "Useful chunk", url: "https://example.com" }
        ]
      })
    );
    expect(hits).toEqual([
      {
        source: "chunk",
        title: "Chunk",
        excerpt: "Useful chunk",
        score: undefined,
        url: "https://example.com"
      }
    ]);
  });

  it("returns no hits for empty or unrelated JSON output", () => {
    expect(parseSupabaseRows("")).toEqual([]);
    expect(parseSupabaseRows(JSON.stringify({ warning: "no rows" }))).toEqual([]);
  });

  it("parses current Supabase CLI JSON with login prelude and rows wrapper", () => {
    const hits = parseSupabaseRows(`Initialising login role...
{
  "boundary": "abc",
  "rows": [
    {
      "source": "page",
      "title": "Linked",
      "excerpt": "remote query worked",
      "score": "1"
    }
  ]
}`);
    expect(hits[0]).toMatchObject({ source: "page", title: "Linked", excerpt: "remote query worked", score: 1 });
  });

  it("parses table-shaped CLI output when JSON is unavailable", () => {
    const hits = parseSupabaseRows(
      [" source | title | excerpt | score", " --- | --- | --- | ---", " page | Deck | Useful proof | 0.7"].join("\n")
    );
    expect(hits[0]).toMatchObject({ source: "page", title: "Deck", excerpt: "Useful proof", score: 0.7 });
  });

  it.runIf(Boolean(process.env.SUPABASE_WORKDIR))("runs a live linked gbrain query through Supabase CLI", async () => {
    const result = await runGbrainQuery("Gemma Cerebras Figma", 2);
    expect(result.ok).toBe(true);
    expect(result.sql).toContain("public.content_chunks");
    expect(Array.isArray(result.hits)).toBe(true);
  }, 30_000);

  it("handles real child-process timeout and spawn errors", async () => {
    const timedOut = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], 10);
    expect(timedOut.stderr).toContain("Timed out");

    const missing = await runCommand("definitely-not-a-real-gbrain-command", [], 1000);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBeTruthy();
  });
});
