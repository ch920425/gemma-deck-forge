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

  const figmaHarness = await connectFigmaHarness(page);
  const figmaStartedAt = Date.now();
  await page.getByRole("button", { name: /Generate deck/i }).click();
  const command = await figmaHarness.nextExecuteCommand();
  expect(String(command.params?.code || "")).toContain("figma.createSection");
  await new Promise((resolve) => setTimeout(resolve, 8_200));
  figmaHarness.complete(command.id, {
    success: true,
    result: { slideCount: 10, actionCount: 50, actionsPerSecond: 5.9, layoutWarnings: [] }
  });
  await expect(page.getByRole("heading", { name: "Pixel-perfect Figma Deck Finalizer" })).toBeVisible();
  await expect(page.getByText(/visual QA|overlap|screenshot/i).first()).toBeVisible();
  await expect(page.locator(".stageCard")).toHaveCount(50);
  await expect(page.getByText(/Built and QA-gated/i)).toBeVisible({ timeout: 40_000 });
  expect(Date.now() - figmaStartedAt).toBeGreaterThanOrEqual(14_800);
  await expect(page.getByText(/demo-safe mode|Bridge detail/i)).toHaveCount(0);
  await expect(page.getByText("Figma JSON")).toHaveCount(0);
  await expect(page.getByText(/deckTitle|actionsPerSecond/)).toHaveCount(0);
  await expect(page.getByText(hiddenAudience)).toHaveCount(0);
  figmaHarness.close();
});

interface FigmaHarnessCommand {
  id: string;
  method?: string;
  params?: { code?: string; timeout?: number };
}

async function connectFigmaHarness(page: import("@playwright/test").Page) {
  const status = await page.evaluate(async () => {
    return fetch("/api/figma/status").then((response) => response.json() as Promise<{ port?: number }>);
  });
  if (!status.port) throw new Error("Figma bridge status did not expose a port");

  const socket = new WebSocket(`ws://localhost:${status.port}`);
  const messages: FigmaHarnessCommand[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as FigmaHarnessCommand);
  });
  await waitForSocketOpen(socket);
  socket.send(
    JSON.stringify({
      type: "FILE_INFO",
      data: {
        fileName: "Gemma Deck Forge E2E Harness",
        fileKey: "e2e-harness",
        currentPage: "Page 1",
        editorType: "figma"
      }
    })
  );

  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const response = await fetch("/api/figma/status");
          const status = (await response.json()) as { connected?: boolean; fileName?: string };
          return `${status.connected}:${status.fileName || ""}`;
        }),
      { timeout: 5_000 }
    )
    .toBe("true:Gemma Deck Forge E2E Harness");

  return {
    async nextExecuteCommand() {
      await expect
        .poll(() => messages.find((message) => message.method === "EXECUTE_CODE")?.id || "", { timeout: 20_000 })
        .not.toBe("");
      return messages.find((message) => message.method === "EXECUTE_CODE")!;
    },
    complete(id: string, result: unknown) {
      socket.send(JSON.stringify({ id, result }));
    },
    close() {
      socket.close();
    }
  };
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Figma harness socket failed to open")), { once: true });
  });
}
