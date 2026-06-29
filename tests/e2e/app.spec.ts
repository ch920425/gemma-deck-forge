import { test, expect } from "@playwright/test";

const hiddenAudience = "Cerebras x Gemma hackathon judges and enterprise AI buyers";

test("starts with a clean idea-only screen and no raw implementation artifacts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Figma Gem: Super-AI Speed Slide Prep" })).toBeVisible();
  await expect(page.getByText(/CEREBRAL AGENT SWARM/i)).toBeVisible();
  await expect(page.getByText(/staged workflow|swarm loops/i)).toHaveCount(0);
  await expect(page.getByLabel("High-level idea")).toBeVisible();
  await expect(page.getByLabel(/^Audience$/i)).toHaveCount(0);
  await expect(page.getByLabel(/^Slides$/i)).toHaveCount(0);
  await expect(page.getByText(hiddenAudience)).toHaveCount(0);
  await expect(page.getByText("Figma JSON")).toHaveCount(0);
  await expect(page.getByText(/deckTitle|actionsPerSecond/)).toHaveCount(0);
});

test("runs context retrieval and five-agent context writing as a staged swarm", async ({ page }) => {
  await page.goto("/");
  await stageBoard(page).getByRole("button", { name: /^Next/i }).click();
  await stageBoard(page).getByRole("button", { name: /Retrieve context from KB/i }).click();

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
  await stageBoard(page).getByRole("button", { name: /^Next/i }).click();
  await stageBoard(page).getByRole("button", { name: /Retrieve context from KB/i }).click();
  await expect(page.getByLabel("Context writing swarm").locator(".agentLane")).toHaveCount(5, { timeout: 30_000 });

  await stageBoard(page).getByRole("button", { name: /^Next/i }).click();
  await stageBoard(page).getByRole("button", { name: /Run brainstorm swarm/i }).click();
  await expect(page.getByLabel("Brainstorm agents")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Brainstorm agents").locator(".agentLane")).toHaveCount(5);
  await expect(page.getByText("Final brainstorm brief")).toBeVisible();

  await stageBoard(page).getByRole("button", { name: /^Next/i }).click();
  const outlineStartedAt = Date.now();
  await stageBoard(page).getByRole("button", { name: /Draft slide outline/i }).click();
  await expect(page.locator(".slideCard")).toHaveCount(10, { timeout: 90_000 });
  expect(Date.now() - outlineStartedAt).toBeGreaterThanOrEqual(9_500);
  await expect(page.locator(".slideRequirement")).toHaveCount(10);
  await expect(page.locator(".slideCard .layout", { hasText: "Critique / Fix Pass" })).toHaveCount(1);
  await expect(page.getByLabel("workflow steps").getByRole("button", { name: /^Figma Build/i })).toBeVisible();
  await expect(stageBoard(page).getByRole("button", { name: /^Generate slides/i })).toBeVisible();
  await expect(stageBoard(page).getByRole("button", { name: /^Figma Build/i })).toHaveCount(0);

  const figmaHarness = await connectFigmaHarness(page);
  const figmaStartedAt = Date.now();
  await stageBoard(page).getByRole("button", { name: /^Generate slides/i }).click();
  await expect(page.getByRole("heading", { name: "Figma Slide Generation Swarm" })).toBeVisible();
  await figmaHarness.completeExecuteCommands(16, "generation");
  expect(figmaHarness.executeCount()).toBe(16);
  await expect(page.getByText(/Slides generated through/i)).toBeVisible({ timeout: 30_000 });
  expect(Date.now() - figmaStartedAt).toBeGreaterThanOrEqual(7_000);
  await expect(page.locator(".stageCard")).toHaveCount(50);
  await expect(page.getByLabel("Figma agent activity")).toBeVisible();

  const qaStartedAt = Date.now();
  await stageBoard(page).getByRole("button", { name: /^Run Figma QA Loop/i }).click();
  await expect(page.getByRole("heading", { name: "Gemma VLM QA + Polish Swarm" })).toBeVisible();
  await expect(page.getByText(/screenshot.*structured diagnosis|screenshot.*VLM input/i).first()).toBeVisible();
  await figmaHarness.completeExecuteCommands(7, "qa");
  expect(figmaHarness.executeCount()).toBe(23);
  await expect(page.getByText(/VLM QA\/polish complete/i)).toBeVisible({ timeout: 30_000 });
  expect(Date.now() - qaStartedAt).toBeGreaterThanOrEqual(6_000);

  await page.getByLabel("Feedback for Figma QA").fill("Make slide 5 more metric-heavy and tighten the final CTA.");
  const feedbackStartedAt = Date.now();
  await stageBoard(page).getByRole("button", { name: /^Apply feedback with QA loop/i }).click();
  await figmaHarness.completeExecuteCommands(7, "qa-feedback");
  expect(figmaHarness.executeCount()).toBe(30);
  await expect(page.getByText(/Feedback applied: yes/i)).toBeVisible({ timeout: 30_000 });
  expect(Date.now() - feedbackStartedAt).toBeGreaterThanOrEqual(6_000);

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
  receivedAt: number;
}

async function connectFigmaHarness(page: import("@playwright/test").Page) {
  const status = await page.evaluate(async () => {
    return fetch("/api/figma/status").then((response) => response.json() as Promise<{ port?: number }>);
  });
  if (!status.port) throw new Error("Figma bridge status did not expose a port");

  const socket = new WebSocket(`ws://localhost:${status.port}`);
  const messages: FigmaHarnessCommand[] = [];
  const completedIds = new Set<string>();
  socket.addEventListener("message", (event) => {
    messages.push({ ...(JSON.parse(String(event.data)) as FigmaHarnessCommand), receivedAt: Date.now() });
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
        .poll(
          () => messages.find((message) => message.method === "EXECUTE_CODE" && !completedIds.has(message.id))?.id || "",
          { timeout: 20_000 }
        )
        .not.toBe("");
      return messages.find((message) => message.method === "EXECUTE_CODE" && !completedIds.has(message.id))!;
    },
    async completeExecuteCommands(count: number, mode: "generation" | "qa" | "qa-feedback") {
      const receivedCommands: FigmaHarnessCommand[] = [];
      for (let index = 0; index < count; index += 1) {
        const command = await this.nextExecuteCommand();
        expect(Number(command.params?.timeout)).toBeLessThanOrEqual(2_000);
        if (mode === "generation" && index === 0) expect(String(command.params?.code || "")).toContain("figma.createSection");
        if (mode !== "generation") expect(String(command.params?.code || "")).toContain("Gemma VLM");
        if (mode !== "generation") expect(String(command.params?.code || "")).toMatch(/maxDiagnoseFixLoops"?\s*:\s*5/);
        receivedCommands.push(command);
        completedIds.add(command.id);
        socket.send(
          JSON.stringify({
            id: command.id,
            result: {
              success: true,
              result: {
                sectionId: "section-e2e",
                sectionName: "Gemma Deck Forge - E2E",
                slideCount: 10,
                actionCount: 10,
                actionsPerSecond: 18,
                batchIndex: index,
                totalBatches: count,
                feedbackApplied: mode === "qa-feedback",
                layoutWarnings: [],
                frameIds: Array.from({ length: 10 }, (_, slideIndex) => `frame-${slideIndex + 1}`)
              }
            }
          })
        );
      }
      expect(receivedCommands).toHaveLength(count);
      expect(receivedCommands.map((command) => command.method)).toEqual(Array(count).fill("EXECUTE_CODE"));
      expectCommandCadence(receivedCommands, mode === "generation" ? 500 : 1_000);
    },
    executeCount() {
      return messages.filter((message) => message.method === "EXECUTE_CODE").length;
    },
    complete(id: string, result: unknown) {
      socket.send(JSON.stringify({ id, result }));
    },
    close() {
      socket.close();
    }
  };
}

function stageBoard(page: import("@playwright/test").Page) {
  return page.locator(".stageBoard");
}

function expectCommandCadence(commands: FigmaHarnessCommand[], expectedIntervalMs: number) {
  for (let index = 1; index < commands.length; index += 1) {
    expect(commands[index].receivedAt - commands[index - 1].receivedAt).toBeGreaterThanOrEqual(expectedIntervalMs - 150);
  }
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Figma harness socket failed to open")), { once: true });
  });
}
