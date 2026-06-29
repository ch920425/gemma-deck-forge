import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gemmaDeckApiPlugin } from "../src/server/apiPlugin";
import { normalizeDeck } from "../src/server/deck";
import { getFigmaBridgeServer, resetFigmaBridgeServerForTests, type FigmaBridgeServer } from "../src/server/figmaBridge";
import { FIGMA_GENERATION_BATCH_COUNT } from "../src/shared/figma";
import type { DeckSpec } from "../src/shared/schema";

interface BridgeCommand {
  id: string;
  method?: string;
  params?: {
    code?: string;
    timeout?: number;
  };
}

type ApiMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

let apiServer: Server | null = null;
let apiBaseUrl = "";
let bridge: FigmaBridgeServer | null = null;
let bridgeClient: WebSocket | null = null;
let previousBridgePort: string | undefined;

beforeEach(async () => {
  previousBridgePort = process.env.GEMMA_FIGMA_BRIDGE_PORT;
  process.env.GEMMA_FIGMA_BRIDGE_PORT = "0";
  resetFigmaBridgeServerForTests();
  bridge = getFigmaBridgeServer();
  apiBaseUrl = await startApiServer();
});

afterEach(async () => {
  bridgeClient?.close();
  bridgeClient = null;
  await stopServer(apiServer);
  apiServer = null;
  await bridge?.stop();
  bridge = null;
  resetFigmaBridgeServerForTests();
  restoreEnv("GEMMA_FIGMA_BRIDGE_PORT", previousBridgePort);
});

describe("Figma API route bridge batching", () => {
  it("builds a deck through repeated short EXECUTE_CODE batches", async () => {
    const harness = await connectBridgeHarness("Build Route Harness");
    const { body, commands, status } = await postFigmaRouteWithBatchResponses("/api/figma/build", { deck: buildDeck() }, harness);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    const result = ((body.result as { result?: Record<string, unknown> }).result || {}) as Record<string, unknown>;
    expect(commands).toHaveLength(FIGMA_GENERATION_BATCH_COUNT);
    expect(commands.every((command) => command.method === "EXECUTE_CODE")).toBe(true);
    expect(commands.every((command) => Number(command.params?.timeout) <= 2_000)).toBe(true);
    expect(result.batchIntervalMs).toBe(1000);
    expect(result.bridgeCommandCount).toBe(FIGMA_GENERATION_BATCH_COUNT);
    expect(result.sectionId).toBe("section-generated-api");
    expect(result.slideCount).toBe(10);
    expect(result.layoutWarnings).toEqual([]);
    expect(new Set(commands.map((command) => String(command.params?.code || ""))).size).toBeGreaterThan(1);
  }, 35_000);

  it("runs QA through a deterministic screenshot export, visual polish, and final export bridge sweep", async () => {
    const harness = await connectBridgeHarness("QA Route Harness");
    const { body, commands, status } = await postFigmaRouteWithBatchResponses(
      "/api/figma/qa",
      { deck: buildDeck(), sectionId: "section-1", feedback: "Tighten hierarchy and check overlap." },
      harness
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    const result = ((body.result as { result?: Record<string, unknown> }).result || {}) as Record<string, unknown>;
    const qaEvidence = result.qaEvidence as { screenshotCount?: number; exportCount?: number; finalScreenshotReady?: boolean; screenshots?: unknown[] };
    const commandCodes = commands.map((command) => String(command.params?.code || ""));
    const fixCommands = commandCodes.filter((code) => code.includes('"qaMode":"fix"'));
    const exportCommands = commandCodes.filter((code) => code.includes('"qaMode":"export"'));
    const finalizeCommands = commandCodes.filter((code) => code.includes('"qaMode":"finalize"'));

    expect(commands).toHaveLength(3);
    expect(commands.every((command) => command.method === "EXECUTE_CODE")).toBe(true);
    expect(commands.every((command) => Number(command.params?.timeout) <= 15_000)).toBe(true);
    expect(commands.every((command) => String(command.params?.code || "").includes('"sectionId":"section-1"'))).toBe(true);
    expect(commands.every((command) => !String(command.params?.code || "").includes("figma.createSection"))).toBe(true);
    expect(commandCodes[0]).toContain('"qaMode":"export"');
    expect(commandCodes[1]).toContain('"qaMode":"fix"');
    expect(commandCodes[1]).toContain("cleanFinalLayout");
    expect(fixCommands).toHaveLength(1);
    expect(exportCommands).toHaveLength(1);
    expect(finalizeCommands).toHaveLength(1);
    expect(result.agenticLoopMode).toBe("deterministic-visual-polish-with-screenshot-evidence");
    expect(result.batchIntervalMs).toBeNull();
    expect(result.bridgeCommandCount).toBe(commands.length);
    expect(result.maxDiagnoseFixLoops).toBe(10);
    expect(result.passedSlideCount).toBe(10);
    expect(result.slideQaStates).toHaveLength(10);
    expect(qaEvidence.screenshotCount).toBe(10);
    expect(qaEvidence.exportCount).toBe(10);
    expect(qaEvidence.finalScreenshotReady).toBe(true);
    expect(qaEvidence.screenshots).toHaveLength(10);
    expect(new Set(commands.map((command) => String(command.params?.code || ""))).size).toBeGreaterThan(1);
  }, 35_000);

  it("rejects QA without a generated section id before bridge execution", async () => {
    const response = await fetch(`${apiBaseUrl}/api/figma/qa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deck: buildDeck() })
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: "missing_section_id" });
  });
});

async function startApiServer(): Promise<string> {
  let middleware: ApiMiddleware | undefined;
  const plugin = gemmaDeckApiPlugin();
  const serverLike = {
    httpServer: new EventEmitter(),
    middlewares: {
      use(handler: ApiMiddleware) {
        middleware = handler;
      }
    }
  } as never;
  const configureServer = plugin.configureServer as
    | ((server: typeof serverLike) => void)
    | { handler: (server: typeof serverLike) => void }
    | undefined;
  if (typeof configureServer === "function") {
    configureServer(serverLike);
  } else {
    configureServer?.handler(serverLike);
  }

  if (!middleware) throw new Error("API middleware was not registered");

  apiServer = createServer((req, res) => {
    middleware?.(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => apiServer?.listen(0, "localhost", resolve));
  const address = apiServer.address();
  if (!address || typeof address === "string") throw new Error("API server did not expose a port");
  return `http://localhost:${address.port}`;
}

async function connectBridgeHarness(fileName: string) {
  await bridge?.start();
  const status = bridge?.status();
  if (!status?.port) throw new Error("Bridge did not expose a port");

  const client = new WebSocket(`ws://localhost:${status.port}`);
  const messages: BridgeCommand[] = [];
  client.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as BridgeCommand);
  });
  await waitForOpen(client);
  client.send(
    JSON.stringify({
      type: "FILE_INFO",
      data: {
        fileName,
        fileKey: fileName.toLowerCase().replace(/\s+/g, "-"),
        currentPage: "Page 1",
        editorType: "figma"
      }
    })
  );
  await waitFor(() => bridge?.status().fileName === fileName);
  bridgeClient = client;
  return { client, messages };
}

async function postFigmaRouteWithBatchResponses(
  path: "/api/figma/build" | "/api/figma/qa",
  payload: Record<string, unknown>,
  harness: { client: WebSocket; messages: BridgeCommand[] }
) {
  let responseSettled = false;
  const responsePromise = fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).then(async (response) => {
    responseSettled = true;
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>
    };
  });

  const commands: BridgeCommand[] = [];
  for (let index = 0; index < 80 && !responseSettled; index += 1) {
    const command = await Promise.race([
      nextExecuteCommand(harness.messages, commands.at(-1)?.id),
      responsePromise.then(() => null)
    ]);
    if (!command) break;
    commands.push(command);
    const code = String(command.params?.code || "");
    const qaMode = code.includes('"qaMode":"finalize"')
      ? "finalize"
      : code.includes('"qaMode":"fix"')
        ? "fix"
        : code.includes('"qaMode":"export"')
          ? "export"
          : "";
    const targetSlideIds = qaMode ? extractTargetSlideIds(code) : [];
    const totalBatches = path === "/api/figma/build" ? FIGMA_GENERATION_BATCH_COUNT : 10;
    const isFinal = index >= totalBatches - 1;
    const qaScreenshots =
      path === "/api/figma/qa" && (qaMode === "export" || qaMode === "finalize")
        ? screenshotEvidenceFor(targetSlideIds.length ? targetSlideIds : Array.from({ length: 10 }, (_, slideIndex) => `s${slideIndex + 1}`), qaMode === "finalize")
        : [];
    harness.client.send(
      JSON.stringify({
        id: command.id,
        result: {
          success: true,
          result: {
            mode: path === "/api/figma/build" ? "generation" : qaMode === "export" ? "qa-export" : "qa",
            batchIndex: index,
            totalBatches,
            batchCount: index + 1,
            sectionId: path === "/api/figma/build" ? "section-generated-api" : String((payload as { sectionId?: string }).sectionId || "section-1"),
            sectionName: "Gemma Deck Forge - API Harness",
            slideCount: 10,
            frameIds: Array.from({ length: 10 }, (_, slideIndex) => `frame-${slideIndex + 1}`),
            actionCount: 10,
            generationCompleteness:
              path === "/api/figma/build"
                ? { implementedPercent: isFinal ? 99 : 70, passed: isFinal }
                : undefined,
            screenshotEvidence: qaScreenshots,
            qaEvidence:
              path === "/api/figma/qa" && qaScreenshots.length
                ? {
                    sectionId: String((payload as { sectionId?: string }).sectionId || "section-1"),
                    screenshotCount: qaScreenshots.length,
                    exportCount: qaScreenshots.length,
                    finalScreenshotReady: qaMode === "finalize",
                    screenshots: qaScreenshots
                  }
                : undefined,
            feedbackApplied: path === "/api/figma/qa",
            layoutWarnings: isFinal ? [] : [`${path} in progress`]
          }
        }
      })
    );
  }

  const response = await withTimeout(responsePromise, 2_000, `${path} did not finish after acknowledged batches`);
  return { ...response, commands };
}

function extractTargetSlideIds(code: string): string[] {
  const match = code.match(/"targetSlideIds":\[(.*?)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function screenshotEvidenceFor(slideIds: string[], finalReady: boolean) {
  return slideIds.map((slideId, index) => ({
    slideId,
    frameId: `frame-${slideId.replace(/\D/g, "") || index + 1}`,
    exportFormat: "PNG",
    bytes: 1200 + index,
    dataUrl: "data:image/png;base64,ZmFrZQ==",
    qaTagsRemoved: finalReady,
    finalScreenshotReady: finalReady
  }));
}

async function nextExecuteCommand(messages: BridgeCommand[], afterId?: string): Promise<BridgeCommand> {
  const startIndex = afterId ? Math.max(messages.findIndex((message) => message.id === afterId) + 1, 0) : 0;
  await waitFor(() => messages.slice(startIndex).some((message) => message.method === "EXECUTE_CODE"), 2_000);
  const command = messages.slice(startIndex).find((message) => message.method === "EXECUTE_CODE");
  if (!command) throw new Error("No EXECUTE_CODE command received");
  return command;
}

function buildDeck(): DeckSpec {
  return normalizeDeck(
    {
      title: "Bridge Batch Demo",
      audience: "Judges",
      thesis: "Bridge execution should be visibly incremental.",
      slides: [
        {
          title: "One",
          headline: "Incremental Figma writes",
          body: "The API should send short bridge batches instead of one monolithic script.",
          bullets: ["Build", "Inspect", "Polish"],
          evidence: ["Desktop Bridge EXECUTE_CODE stream"],
          visual: "Visible stage-by-stage Figma mutations",
          layout: "demo",
          accent: "#0E7C66",
          speakerNotes: "Show the bridge loop."
        }
      ]
    },
    {
      idea: "Figma bridge batching",
      audience: "Judges",
      brainstormNotes: "",
      gbrainContext: "",
      slideCount: 1
    }
  );
}

function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.addEventListener("open", () => resolve(), { once: true });
    client.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function stopServer(server: Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
