import { test, expect } from "@playwright/test";

const hiddenAudience = "Cerebras x Gemma hackathon judges and enterprise AI buyers";

test("starts with a clean idea-only screen and no raw implementation artifacts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Figma Gem: Super-AI Speed Slide Prep" })).toBeVisible();
  await expect(page.getByText(/CEREBRAL AGENT SWARM/i)).toBeVisible();
  await expect(page.getByText(/staged workflow|swarm loops|Figma QA/i)).toHaveCount(0);
  await expect(page.getByLabel("High-level idea")).toBeVisible();
  await expect(page.getByLabel(/^Audience$/i)).toHaveCount(0);
  await expect(page.getByLabel(/^Slides$/i)).toHaveCount(0);
  await expect(page.getByText(hiddenAudience)).toHaveCount(0);
  await expect(page.getByText("Figma JSON")).toHaveCount(0);
  await expect(page.getByText(/deckTitle|actionsPerSecond/)).toHaveCount(0);
});

test("runs context retrieval and five-agent context writing as a staged swarm", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Next/i }).click();
  await page.getByRole("button", { name: /Retrieve context from KB/i }).click();

  await expect(page.getByLabel("context swarm")).toBeVisible({ timeout: 3_000 });
  await expect(page.locator(".contextLane")).toHaveCount(4, { timeout: 30_000 });
  await expect(page.getByLabel("Context writing swarm")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Context writing swarm").locator(".agentLane")).toHaveCount(5);
  await expect(page.getByText("Finalized context text", { exact: true })).toBeVisible();
  await expect(page.getByText(hiddenAudience)).toHaveCount(0);
});

test("runs brainstorm, outline, and Figma finalizer without exposing raw JSON", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/");
  await page.getByRole("button", { name: /^Next/i }).click();
  await page.getByRole("button", { name: /Retrieve context from KB/i }).click();
  await expect(page.getByLabel("Context writing swarm").locator(".agentLane")).toHaveCount(5, { timeout: 30_000 });

  await page.getByRole("button", { name: /^Next/i }).click();
  await page.getByRole("button", { name: /Run brainstorm swarm/i }).click();
  await expect(page.getByLabel("Brainstorm agents")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Brainstorm agents").locator(".agentLane")).toHaveCount(5);
  await expect(page.getByText("Final brainstorm brief")).toBeVisible();

  await page.getByRole("button", { name: /^Next/i }).click();
  const outlineStartedAt = Date.now();
  await page.getByRole("button", { name: /Draft slide outline/i }).click();
  await expect(page.locator(".slideCard")).toHaveCount(10, { timeout: 90_000 });
  expect(Date.now() - outlineStartedAt).toBeGreaterThanOrEqual(9_500);
  await expect(page.locator(".slideRequirement")).toHaveCount(10);
  await expect(page.locator(".slideCard .layout", { hasText: "Critique / Fix Pass" })).toHaveCount(1);

  const figmaStartedAt = Date.now();
  await page.getByRole("button", { name: /Generate deck/i }).click();
  await expect(page.getByRole("heading", { name: "Pixel-perfect Figma Deck Finalizer" })).toBeVisible();
  await expect(page.getByText(/visual QA|overlap|screenshot/i).first()).toBeVisible();
  await expect(page.locator(".stageCard")).toHaveCount(50);
  await expect(page.getByText(/QA-gated|demo-safe mode|Bridge detail/i)).toBeVisible({ timeout: 30_000 });
  expect(Date.now() - figmaStartedAt).toBeGreaterThanOrEqual(6_800);
  await expect(page.getByText("Figma JSON")).toHaveCount(0);
  await expect(page.getByText(/deckTitle|actionsPerSecond/)).toHaveCount(0);
  await expect(page.getByText(hiddenAudience)).toHaveCount(0);
});
