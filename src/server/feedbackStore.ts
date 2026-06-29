import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeedbackEntry } from "../shared/schema";

export function getDataDir(): string {
  return path.resolve(process.env.GEMMA_DECK_DATA_DIR || path.join(process.cwd(), "data"));
}

export function feedbackPath(): string {
  return path.join(getDataDir(), "feedback.jsonl");
}

export async function saveFeedback(input: Omit<FeedbackEntry, "id" | "createdAt">): Promise<FeedbackEntry> {
  await mkdir(getDataDir(), { recursive: true });
  const entry: FeedbackEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    deckTitle: input.deckTitle || "Untitled deck",
    rating: Math.min(Math.max(Number(input.rating) || 0, 1), 5),
    notes: input.notes || "",
    keep: input.keep || "",
    change: input.change || ""
  };
  const previous = await readFeedbackEntries();
  const next = [...previous, entry].slice(-50);
  await writeFile(feedbackPath(), `${next.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return entry;
}

export async function readFeedbackEntries(): Promise<FeedbackEntry[]> {
  try {
    const raw = await readFile(feedbackPath(), "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FeedbackEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function readFeedbackMemory(): Promise<string> {
  const entries = (await readFeedbackEntries()).slice(-8);
  if (!entries.length) {
    return "";
  }
  return entries
    .map((entry) => {
      const signals = [
        entry.keep && `keep: ${entry.keep}`,
        entry.change && `change: ${entry.change}`,
        entry.notes && `notes: ${entry.notes}`
      ]
        .filter(Boolean)
        .join("; ");
      return `Rating ${entry.rating}/5 for ${entry.deckTitle}: ${signals}`;
    })
    .join("\n");
}
