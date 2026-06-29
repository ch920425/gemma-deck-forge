import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import {
  FIGMA_BATCH_INTERVAL_MS,
  FIGMA_GENERATION_BATCH_INTERVAL_MS,
  FIGMA_QA_BATCH_INTERVAL_MS,
  buildFigmaBuildPlan,
  buildFigmaGenerationBatchScripts,
  buildFigmaHandoffPrompt,
  buildFigmaQaBatchScript,
  buildFigmaQaPlan
} from "../shared/figma";
import { buildBrainstormPrompt } from "../shared/prompts";
import type { BrainstormResponse, DeckSpec, GenerateRequest, PolishRequest } from "../shared/schema";
import { callCerebrasJson, fallbackBrainstorm, hasCerebrasKey } from "./cerebras";
import { runContextSwarm } from "./contextSwarm";
import { generateDeck, polishDeck } from "./deck";
import { readFeedbackEntries, readFeedbackMemory, saveFeedback } from "./feedbackStore";
import { detectEstablishedFigmaBridgePorts, getFigmaBridgeServer, type FigmaBridgeServer } from "./figmaBridge";
import { runGbrainQuery } from "./gbrain";
import { runBrainstormSwarm, runContextWritingSwarm } from "./textSwarms";

export function gemmaDeckApiPlugin(): Plugin {
  return {
    name: "gemma-deck-api",
    configureServer(server) {
      const figmaBridge = getFigmaBridgeServer();
      void figmaBridge.start().catch(() => undefined);
      server.httpServer?.once("close", () => {
        void figmaBridge.stop();
      });

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) {
          next();
          return;
        }
        try {
          await routeApi(req, res);
        } catch (error) {
          sendJson(res, 500, {
            error: "api_error",
            detail: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }
  };
}

async function routeApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      cerebrasConfigured: hasCerebrasKey(),
      model: process.env.CEREBRAS_MODEL || "gemma-4-31b",
      feedbackMemory: await readFeedbackMemory()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/context/gbrain") {
    const body = (await readJson(req)) as { query?: string; limit?: number };
    sendJson(res, 200, await runGbrainQuery(body.query || "", body.limit || 8));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/context/swarm/stream") {
    const body = (await readJson(req)) as { query?: string; idea?: string; existingContext?: string; limit?: number };
    startSse(res);
    await runContextSwarm(
      {
        query: body.query || "",
        idea: body.idea || "",
        existingContext: body.existingContext || "",
        limit: body.limit || 8
      },
      (event, payload) => sendSse(res, event, payload)
    );
    sendSse(res, "done", { ok: true });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/brainstorm") {
    const body = (await readJson(req)) as { idea?: string; context?: string };
    if (!hasCerebrasKey()) {
      sendJson(res, 200, fallbackBrainstorm());
      return;
    }
    const result = await callCerebrasJson<BrainstormResponse>(
      [
        { role: "system", content: "You are a concise AI product brainstorming partner." },
        { role: "user", content: buildBrainstormPrompt(body.idea || "", body.context || "") }
      ],
      700
    );
    sendJson(res, 200, result.value);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/context/write/stream") {
    const body = (await readJson(req)) as { idea?: string; context?: string; audience?: string };
    startSse(res);
    await runContextWritingSwarm(
      {
        idea: body.idea || "",
        context: body.context || "",
        audience: body.audience || defaultAudience()
      },
      (event, payload) => sendSse(res, event, payload)
    );
    sendSse(res, "done", { ok: true });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/brainstorm/stream") {
    const body = (await readJson(req)) as { idea?: string; context?: string; audience?: string };
    startSse(res);
    await runBrainstormSwarm(
      {
        idea: body.idea || "",
        context: body.context || "",
        audience: body.audience || defaultAudience()
      },
      (event, payload) => sendSse(res, event, payload)
    );
    sendSse(res, "done", { ok: true });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate/stream") {
    const body = (await readJson(req)) as GenerateRequest;
    startSse(res);
    await generateDeck(body, (event, payload) => sendSse(res, event, payload));
    sendSse(res, "done", { ok: true });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/polish/stream") {
    const body = (await readJson(req)) as PolishRequest;
    startSse(res);
    await polishDeck(body, (event, payload) => sendSse(res, event, payload));
    sendSse(res, "done", { ok: true });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/feedback") {
    sendJson(res, 200, {
      entries: await readFeedbackEntries(),
      memory: await readFeedbackMemory()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/feedback") {
    const body = (await readJson(req)) as {
      deckTitle?: string;
      rating?: number;
      notes?: string;
      keep?: string;
      change?: string;
    };
    const entry = await saveFeedback({
      deckTitle: body.deckTitle || "Untitled deck",
      rating: body.rating || 4,
      notes: body.notes || "",
      keep: body.keep || "",
      change: body.change || ""
    });
    sendJson(res, 200, { entry, memory: await readFeedbackMemory() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/export/figma") {
    const body = (await readJson(req)) as { deck?: DeckSpec };
    if (!body.deck) {
      sendJson(res, 400, { error: "missing_deck" });
      return;
    }
    sendJson(res, 200, {
      figmaSpec: body.deck.figmaSpec,
      handoffPrompt: buildFigmaHandoffPrompt(body.deck)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/figma/status") {
    const bridge = getFigmaBridgeServer();
    await bridge.start();
    await bridge.waitForConnection(300);
    const status = bridge.status();
    const detectedPorts = status.connected ? [] : await detectEstablishedFigmaBridgePorts();
    sendJson(res, 200, {
      ...status,
      detectedFigmaPorts: detectedPorts,
      message:
        !status.connected && detectedPorts.length > 0
          ? `Gemma Deck Forge bridge is waiting on port ${status.port}. Figma is connected to other bridge port(s) ${detectedPorts.join(", ")}; keep the Desktop Bridge plugin open or press Reconnect so it attaches here too.`
          : status.message
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/figma/build-plan") {
    const body = (await readJson(req)) as { deck?: DeckSpec };
    if (!body.deck) {
      sendJson(res, 400, { error: "missing_deck" });
      return;
    }
    sendJson(res, 200, buildFigmaBuildPlan(body.deck));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/figma/build") {
    const body = (await readJson(req)) as { deck?: DeckSpec };
    if (!body.deck) {
      sendJson(res, 400, { error: "missing_deck" });
      return;
    }
    const bridge = getFigmaBridgeServer();
    await bridge.start();
    const plan = buildFigmaBuildPlan(body.deck);
    const connected = await bridge.waitForConnection(12_000);
    if (!connected) {
      const status = bridge.status();
      const detectedPorts = await detectEstablishedFigmaBridgePorts();
      sendJson(res, 409, {
        ok: false,
        status: {
          ...status,
          detectedFigmaPorts: detectedPorts,
          message:
            detectedPorts.length > 0
              ? `Gemma Deck Forge bridge on port ${status.port} is not attached. Figma is connected to other bridge port(s) ${detectedPorts.join(", ")}; press Reconnect in the Figma Desktop Bridge plugin or rerun it so it attaches to this app bridge.`
              : status.message
        },
        plan,
        error: "Figma Desktop Bridge is not connected to the Gemma Deck Forge app bridge."
      });
      return;
    }
    try {
      const result = await executeFigmaBatchSequence(
        bridge,
        buildFigmaGenerationBatchScripts(body.deck),
        "generation",
        FIGMA_GENERATION_BATCH_INTERVAL_MS
      );
      sendJson(res, 200, {
        ok: true,
        status: bridge.status(),
        plan,
        result: { success: true, result }
      });
    } catch (error) {
      sendJson(res, 409, {
        ok: false,
        status: bridge.status(),
        plan,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/figma/qa") {
    const body = (await readJson(req)) as { deck?: DeckSpec; sectionId?: string; feedback?: string };
    if (!body.deck) {
      sendJson(res, 400, { error: "missing_deck" });
      return;
    }
    if (!body.sectionId?.trim()) {
      sendJson(res, 400, {
        ok: false,
        error: "missing_section_id",
        detail: "Run Generate slides first so QA can pin and polish the exact generated Figma section."
      });
      return;
    }
    const bridge = getFigmaBridgeServer();
    await bridge.start();
    const plan = buildFigmaQaPlan(body.deck, {
      sectionId: body.sectionId,
      feedback: body.feedback
    });
    const connected = await bridge.waitForConnection(12_000);
    if (!connected) {
      const status = bridge.status();
      const detectedPorts = await detectEstablishedFigmaBridgePorts();
      sendJson(res, 409, {
        ok: false,
        status: {
          ...status,
          detectedFigmaPorts: detectedPorts,
          message:
            detectedPorts.length > 0
              ? `Gemma Deck Forge bridge on port ${status.port} is not attached. Figma is connected to other bridge port(s) ${detectedPorts.join(", ")}; press Reconnect in the Figma Desktop Bridge plugin or rerun it so it attaches to this app bridge.`
              : status.message
        },
        plan,
        error: "Figma Desktop Bridge is not connected to the Gemma Deck Forge app bridge."
      });
      return;
    }
    try {
      const result = await executeFigmaQaSequence(bridge, body.deck, {
        sectionId: body.sectionId,
        feedback: body.feedback
      });
      sendJson(res, 200, {
        ok: true,
        status: bridge.status(),
        plan,
        result: { success: true, result }
      });
    } catch (error) {
      sendJson(res, 409, {
        ok: false,
        status: bridge.status(),
        plan,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

function defaultAudience(): string {
  return "Cerebras x Gemma hackathon judges and enterprise AI buyers";
}

async function executeFigmaBatchSequence(
  bridge: FigmaBridgeServer,
  scripts: string[],
  mode: "generation" | "qa",
  intervalMs = FIGMA_BATCH_INTERVAL_MS
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const batchResults: Array<Record<string, unknown>> = [];
  let actionCount = 0;
  let slideCount = 0;
  let sectionId = "";
  let sectionName = "";
  let frameIds: string[] = [];
  let layoutWarnings: string[] = [];
  let feedbackApplied = false;
  let generationCompleteness: Record<string, unknown> | undefined;

  for (let index = 0; index < scripts.length; index += 1) {
    const batchStartedAt = Date.now();
    const rawResult = await bridge.executeCode(scripts[index], 2_000);
    const payload = unwrapBridgeResult(rawResult);
    batchResults.push(payload);
    actionCount += numeric(payload.actionCount);
    slideCount = Math.max(slideCount, numeric(payload.slideCount));
    sectionId = stringValue(payload.sectionId) || sectionId;
    sectionName = stringValue(payload.sectionName) || sectionName;
    if (Array.isArray(payload.frameIds)) frameIds = payload.frameIds.map(String);
    if (Array.isArray(payload.layoutWarnings)) layoutWarnings = payload.layoutWarnings.map(String);
    if (payload.generationCompleteness && typeof payload.generationCompleteness === "object") {
      generationCompleteness = payload.generationCompleteness as Record<string, unknown>;
    }
    feedbackApplied = feedbackApplied || payload.feedbackApplied === true;

    if (index < scripts.length - 1) {
      const elapsedMs = Date.now() - batchStartedAt;
      await sleep(Math.max(0, intervalMs - elapsedMs));
    }
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  return {
    mode,
    batchCount: scripts.length,
    bridgeCommandCount: scripts.length,
    batchIntervalMs: intervalMs,
    sectionId,
    sectionName,
    slideCount,
    frameIds,
    actionCount,
    elapsedSec: Number(elapsedSec.toFixed(2)),
    actionsPerSecond: Number((actionCount / Math.max(0.001, elapsedSec)).toFixed(2)),
    feedbackApplied,
    generationCompleteness,
    layoutWarnings,
    batchResults
  };
}

async function executeFigmaQaSequence(
  bridge: FigmaBridgeServer,
  deck: DeckSpec,
  options: { sectionId: string; feedback?: string }
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const batchResults: Array<Record<string, unknown>> = [];
  let actionCount = 0;
  let slideCount = 0;
  let sectionId = options.sectionId;
  let sectionName = "";
  let frameIds: string[] = [];
  let layoutWarnings: string[] = [];
  let feedbackApplied = Boolean(options.feedback?.trim());
  let qaEvidence: Record<string, unknown> = {
    sectionId,
    screenshotCount: 0,
    exportCount: 0,
    finalScreenshotReady: false,
    screenshots: [],
    visionDiagnoses: []
  };
  let visionDiagnoses: unknown[] = [];

  for (let index = 0; index < 10; index += 1) {
    const batchStartedAt = Date.now();
    const script = buildFigmaQaBatchScript(
      deck,
      {
        sectionId: options.sectionId,
        feedback: options.feedback,
        visionDiagnoses
      },
      index,
      10
    );
    const rawResult = await bridge.executeCode(script, index === 0 || index === 9 ? 8_000 : 3_000);
    const payload = unwrapBridgeResult(rawResult);
    batchResults.push(payload);
    actionCount += numeric(payload.actionCount);
    slideCount = Math.max(slideCount, numeric(payload.slideCount));
    sectionId = stringValue(payload.sectionId) || sectionId;
    sectionName = stringValue(payload.sectionName) || sectionName;
    if (Array.isArray(payload.frameIds)) frameIds = payload.frameIds.map(String);
    if (Array.isArray(payload.layoutWarnings)) layoutWarnings = payload.layoutWarnings.map(String);
    feedbackApplied = feedbackApplied || payload.feedbackApplied === true;

    const screenshots = extractScreenshotEvidence(payload);
    if (screenshots.length) {
      const sanitizedScreenshots = screenshots.map(({ dataUrl: _dataUrl, ...screenshot }) => ({
        ...screenshot,
        hasImageInput: Boolean(_dataUrl)
      }));
      qaEvidence = {
        sectionId,
        screenshotCount: screenshots.length,
        exportCount: screenshots.length,
        finalScreenshotReady: payload.qaEvidence && typeof payload.qaEvidence === "object"
          ? Boolean((payload.qaEvidence as { finalScreenshotReady?: unknown }).finalScreenshotReady)
          : index === 9,
        screenshots: sanitizedScreenshots,
        visionDiagnoses
      };
      if (index === 0) {
        visionDiagnoses = await runGemmaSlideVisionQa(deck, screenshots, index, visionDiagnoses);
      }
    }

    if (index < 9) {
      const elapsedMs = Date.now() - batchStartedAt;
      await sleep(Math.max(0, FIGMA_QA_BATCH_INTERVAL_MS - elapsedMs));
    }
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  return {
    mode: "qa",
    batchCount: 10,
    bridgeCommandCount: 10,
    batchIntervalMs: FIGMA_QA_BATCH_INTERVAL_MS,
    sectionId,
    sectionName,
    slideCount,
    frameIds,
    actionCount,
    elapsedSec: Number(elapsedSec.toFixed(2)),
    actionsPerSecond: Number((actionCount / Math.max(0.001, elapsedSec)).toFixed(2)),
    feedbackApplied,
    layoutWarnings,
    maxDiagnoseFixLoops: 10,
    qaEvidence,
    batchResults
  };
}

interface ScreenshotEvidence {
  slideId?: string;
  frameId?: string;
  exportFormat?: string;
  bytes?: number;
  dataUrl?: string;
  qaTagsRemoved?: boolean;
  finalScreenshotReady?: boolean;
}

function extractScreenshotEvidence(payload: Record<string, unknown>): ScreenshotEvidence[] {
  if (Array.isArray(payload.screenshotEvidence)) {
    return payload.screenshotEvidence.filter((item): item is ScreenshotEvidence => Boolean(item && typeof item === "object"));
  }
  const qaEvidence = payload.qaEvidence as { screenshots?: unknown[] } | undefined;
  if (Array.isArray(qaEvidence?.screenshots)) {
    return qaEvidence.screenshots.filter((item): item is ScreenshotEvidence => Boolean(item && typeof item === "object"));
  }
  return [];
}

async function runGemmaSlideVisionQa(
  deck: DeckSpec,
  screenshots: ScreenshotEvidence[],
  loopIndex: number,
  previousDiagnoses: unknown[]
): Promise<unknown[]> {
  if (!hasCerebrasKey() || process.env.NODE_ENV === "test" || process.env.GEMMA_ENABLE_LIVE_VISION_QA === "0") {
    return screenshots.map((screenshot, index) => ({
      slideId: screenshot.slideId || `s${index + 1}`,
      loopIndex: loopIndex + 1,
      status: "diagnosed",
      screenshotObservations: ["Screenshot exported for Gemma VLM review."],
      issues: [],
      figmaFixes: [
        {
          operation: "cleanFinalLayout",
          targetNodeName: screenshot.frameId || `frame-${index + 1}`,
          reason: "Deterministic cleanup keeps text inside safe bounds and removes QA tags."
        }
      ],
      noMoreIssues: loopIndex >= 8
    }));
  }

  const diagnoses: unknown[] = [];
  for (let offset = 0; offset < screenshots.length; offset += 5) {
    const group = screenshots.slice(offset, offset + 5).filter((screenshot) => screenshot.dataUrl);
    if (!group.length) continue;
    try {
      const result = await callCerebrasJson<{ diagnoses?: unknown[] }>(
        [
          {
            role: "system",
            content:
              "You are Gemma 4 VLM slide QA. Inspect each slide image for overlap, clipped text, text outside components, unreadable sizing, crop, contrast, and bad slide design. Return compact JSON only with diagnoses[]. Each diagnosis must include slideId, issues[], figmaFixes[], noMoreIssues, and confidence."
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    deckTitle: deck.title,
                    loopIndex: loopIndex + 1,
                    previousDiagnoses,
                    instruction:
                      "Review every provided slide image. Produce Figma EXECUTE-optimized fixes that keep all text inside safe bounds and remove broken visual artifacts."
                  },
                  null,
                  2
                )
              },
              ...group.map((screenshot) => ({
                type: "image_url" as const,
                image_url: { url: screenshot.dataUrl || "" }
              }))
            ]
          }
        ],
        1400
      );
      diagnoses.push(...(Array.isArray(result.value.diagnoses) ? result.value.diagnoses : []));
    } catch (error) {
      diagnoses.push({
        loopIndex: loopIndex + 1,
        status: "vision_error_fallback",
        error: error instanceof Error ? error.message : String(error),
        figmaFixes: [{ operation: "cleanFinalLayout", reason: "Vision call failed, deterministic layout cleanup continues." }]
      });
    }
  }
  return diagnoses.length ? diagnoses : previousDiagnoses;
}

function unwrapBridgeResult(rawResult: unknown): Record<string, unknown> {
  const wrapper = rawResult as { result?: unknown };
  const payload = wrapper && typeof wrapper === "object" && "result" in wrapper ? wrapper.result : rawResult;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("\n");
}

function sendSse(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
