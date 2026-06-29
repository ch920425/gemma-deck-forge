import { describe, expect, it } from "vitest";
import { callCerebrasJson, hasCerebrasKey } from "../src/server/cerebras";

describe("live Cerebras Gemma 4 smoke", () => {
  it.runIf(hasCerebrasKey())("returns structured JSON from the configured Gemma model", async () => {
    const result = await callCerebrasJson<{ project: string; slides: number }>(
      [
        { role: "system", content: "Return only compact JSON." },
        {
          role: "user",
          content: "Return {\"project\":\"Gemma Deck Forge\",\"slides\":3}. No prose."
        }
      ],
      80
    );
    expect(result.model).toContain("gemma");
    expect(result.value.project).toBe("Gemma Deck Forge");
    expect(result.value.slides).toBe(3);
    expect(result.latencyMs).toBeGreaterThan(0);
  });
});
