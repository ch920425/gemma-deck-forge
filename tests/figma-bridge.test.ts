import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FigmaBridgeServer, getFigmaBridgeServer, resetFigmaBridgeServerForTests } from "../src/server/figmaBridge";

let server: FigmaBridgeServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("Figma Desktop Bridge server", () => {
  it("accepts a real WebSocket plugin connection and executes the bridge command contract", async () => {
    server = new FigmaBridgeServer({ preferredPort: 0 });
    await server.start();
    const status = server.status();
    expect(status.serverRunning).toBe(true);
    expect(status.port).toBeGreaterThan(0);

    const { client, messages } = await connectPlugin(server, "Bridge Test");
    expect(server.status().fileName).toBe("Bridge Test");

    const execution = server.executeCode("return { ok: true }", 500);
    const command = await nextCommand(messages);
    expect(command?.params).toMatchObject({ timeout: 500 });
    expect(String((command?.params as { code: string }).code)).toContain("return { ok: true }");

    client.send(
      JSON.stringify({
        id: command?.id,
        result: {
          success: true,
          result: { ok: true, actionCount: 50 },
          fileContext: { fileName: "Bridge Test", fileKey: "figma-test-file" }
        }
      })
    );

    await expect(execution).resolves.toMatchObject({
      success: true,
      result: { ok: true, actionCount: 50 }
    });
    client.close();
    await waitForClose(client);
  });

  it("returns a clear error when no Figma plugin has connected", async () => {
    server = new FigmaBridgeServer({ preferredPort: 0 });
    await server.start();
    await expect(server.executeCode("return true", 50)).rejects.toThrow("No Figma Desktop Bridge connection");
  });

  it("waits for a Desktop Bridge plugin that attaches after the app starts", async () => {
    server = new FigmaBridgeServer({ preferredPort: 0 });
    await server.start();
    const waiting = server.waitForConnection(1_000);
    const latePluginPromise = new Promise<Awaited<ReturnType<typeof connectPlugin>>>((resolve) => {
      setTimeout(() => {
        void connectPlugin(server!, "Late Plugin", "late-plugin").then(resolve);
      }, 100);
    });
    await expect(waiting).resolves.toBe(true);
    expect(server.status()).toMatchObject({
      connected: true,
      fileName: "Late Plugin",
      fileKey: "late-plugin"
    });
    const latePlugin = await latePluginPromise;
    latePlugin.client.close();
    await waitForClose(latePlugin.client);
  });

  it("reports HTTP health and ignores malformed plugin messages before file info arrives", async () => {
    server = new FigmaBridgeServer({ preferredPort: 0 });
    await server.start();
    const port = server.status().port;
    const health = (await fetch(`http://localhost:${port}/`).then((response) => response.json())) as { serverRunning: boolean };
    expect(health.serverRunning).toBe(true);

    const client = new WebSocket(`ws://localhost:${port}`);
    await waitForOpen(client);
    client.send("not json");
    client.send(
      JSON.stringify({
        type: "FILE_INFO",
        data: { fileName: "Malformed Recovery", fileKey: "recovery", currentPage: "Page 2" }
      })
    );
    await waitFor(() => server?.status().fileName === "Malformed Recovery");
    expect(server.status().currentPage).toBe("Page 2");
    client.close();
    await waitForClose(client);
  });

  it("surfaces plugin execution errors and replaces stale plugin sockets", async () => {
    server = new FigmaBridgeServer({ preferredPort: 0 });
    await server.start();
    const first = await connectPlugin(server, "Old File", "old-file");
    const second = await connectPlugin(server, "New File", "new-file");
    await waitForClose(first.client);
    expect(server.status().fileName).toBe("New File");

    const execution = server.executeCode("return fail", 500);
    const command = await nextCommand(second.messages);
    second.client.send(
      JSON.stringify({
        id: command.id,
        result: {
          success: false,
          error: "Plugin syntax failed"
        }
      })
    );
    await expect(execution).rejects.toThrow("Plugin syntax failed");
    second.client.close();
    await waitForClose(second.client);
  });

  it("rejects pending executions when the plugin disconnects or the bridge stops", async () => {
    server = new FigmaBridgeServer({ preferredPort: 0 });
    await server.start();
    const first = await connectPlugin(server, "Disconnect File", "disconnect-file");
    const disconnectedExecution = server.executeCode("return slow", 500);
    await nextCommand(first.messages);
    first.client.close();
    await waitForClose(first.client);
    await expect(disconnectedExecution).rejects.toThrow("disconnected");

    const second = await connectPlugin(server, "Stop File", "stop-file");
    const stoppedExecution = server.executeCode("return slower", 500);
    await nextCommand(second.messages);
    await server.stop();
    await expect(stoppedExecution).rejects.toThrow("stopped");
  });

  it("moves medium and large bridge payloads over real WebSocket frames", async () => {
    server = new FigmaBridgeServer({ preferredPort: 0 });
    await server.start();
    const { client, messages } = await connectPlugin(server, "Large Payload");

    const mediumExecution = server.executeCode("return " + JSON.stringify("m".repeat(500)), 500);
    const mediumCommand = await nextCommand(messages);
    expect(String((mediumCommand.params as { code: string }).code)).toContain("m".repeat(100));
    client.send(JSON.stringify({ id: mediumCommand.id, result: { success: true, result: "ok" } }));
    await expect(mediumExecution).resolves.toMatchObject({ success: true });

    const primitiveExecution = server.executeCode("return 42", 500);
    const primitiveCommand = await nextCommand(messages, mediumCommand.id as string);
    client.send(JSON.stringify({ id: primitiveCommand.id, result: 42 }));
    await expect(primitiveExecution).resolves.toMatchObject({ success: true, result: 42 });

    const largeText = "l".repeat(70_000);
    const largeExecution = server.executeCode("return " + JSON.stringify(largeText), 500);
    const largeCommand = await nextCommand(messages, primitiveCommand.id as string);
    expect(String((largeCommand.params as { code: string }).code).length).toBeGreaterThan(65_535);
    client.send(JSON.stringify({ id: largeCommand.id, result: { success: true, result: largeText } }));
    await expect(largeExecution).resolves.toMatchObject({ success: true, result: largeText });

    client.close();
    await waitForClose(client);
  });

  it("handles timeouts and transport-level command errors", async () => {
    server = new FigmaBridgeServer({ preferredPort: 0 });
    await server.start();
    const { client, messages } = await connectPlugin(server, "Timeouts");

    const timedOut = server.executeCode("return never", 1);
    const timeoutCommand = await nextCommand(messages);
    expect(timeoutCommand.method).toBe("EXECUTE_CODE");
    await expect(timedOut).rejects.toThrow("timed out");

    const failed = server.executeCode("return transport", 500);
    const failedCommand = await nextCommand(messages, timeoutCommand.id as string);
    client.send(JSON.stringify({ id: failedCommand.id, error: "Transport failure" }));
    await expect(failed).rejects.toThrow("Transport failure");

    client.close();
    await waitForClose(client);
  });

  it("handles bad upgrades and websocket ping frames without breaking the bridge", async () => {
    server = new FigmaBridgeServer({ preferredPort: 0 });
    await server.start();
    const port = server.status().port!;

    const badSocket = net.connect(port, "localhost");
    await waitForRawConnect(badSocket);
    badSocket.write("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    badSocket.destroy();
    await waitForRawClose(badSocket);

    const rawSocket = await openRawWebSocket(port);
    rawSocket.write(maskedFrame(Buffer.from("ping"), 0x9));
    await waitForRawData(rawSocket, (chunk) => chunk.includes(0x8a));
    rawSocket.end();
    await waitForRawClose(rawSocket);
  });

  it("falls back from an occupied preferred port and reports startup failures", async () => {
    const blocker = createHttpServer();
    await new Promise<void>((resolve) => blocker.listen(0, "localhost", resolve));
    const address = blocker.address();
    const occupiedPort = typeof address === "object" && address ? address.port : 0;

    server = new FigmaBridgeServer({ preferredPort: occupiedPort, fallbackPorts: [0] });
    await server.start();
    expect(server.status().serverRunning).toBe(true);
    expect(server.status().port).not.toBe(occupiedPort);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));

    const failing = new FigmaBridgeServer({ preferredPort: 0, host: "256.256.256.256" });
    await expect(failing.start()).rejects.toThrow("Could not start Figma bridge");
    expect(failing.status().serverRunning).toBe(false);
  });

  it("constructs the shared bridge singleton without starting a listener", () => {
    const previousGemmaPort = process.env.GEMMA_FIGMA_BRIDGE_PORT;
    const previousPort = process.env.FIGMA_BRIDGE_PORT;
    process.env.FIGMA_BRIDGE_PORT = "not-a-port";
    delete process.env.GEMMA_FIGMA_BRIDGE_PORT;
    resetFigmaBridgeServerForTests();
    const singleton = getFigmaBridgeServer();
    expect(singleton.status().serverRunning).toBe(false);
    resetFigmaBridgeServerForTests();
    restoreEnv("GEMMA_FIGMA_BRIDGE_PORT", previousGemmaPort);
    restoreEnv("FIGMA_BRIDGE_PORT", previousPort);
  });
});

async function connectPlugin(server: FigmaBridgeServer, fileName: string, fileKey = "figma-test-file") {
  const port = server.status().port;
  const client = new WebSocket(`ws://localhost:${port}`);
  const messages: Array<Record<string, unknown>> = [];
  client.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  await waitForOpen(client);
  client.send(
    JSON.stringify({
      type: "FILE_INFO",
      data: {
        fileName,
        fileKey,
        currentPage: "Page 1",
        editorType: "figma"
      }
    })
  );
  await waitFor(() => server.status().fileName === fileName);
  return { client, messages };
}

async function nextCommand(messages: Array<Record<string, unknown>>, afterId?: string) {
  const startIndex = afterId ? Math.max(messages.findIndex((message) => message.id === afterId) + 1, 0) : 0;
  await waitFor(() => messages.slice(startIndex).some((message) => message.method === "EXECUTE_CODE"));
  return messages.slice(startIndex).find((message) => message.method === "EXECUTE_CODE")!;
}

function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.addEventListener("open", () => resolve(), { once: true });
    client.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
  });
}

function waitForClose(client: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (client.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    client.addEventListener("close", () => resolve(), { once: true });
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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function waitForRawConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function waitForRawClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 500);
    socket.once("close", () => resolve());
    socket.once("close", () => clearTimeout(timeout));
  });
}

function waitForRawData(socket: net.Socket, predicate: (chunk: Buffer) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for raw socket data")), 1_000);
    socket.on("data", function onData(chunk: Buffer) {
      if (!predicate(chunk)) return;
      clearTimeout(timeout);
      socket.off("data", onData);
      resolve();
    });
  });
}

async function openRawWebSocket(port: number): Promise<net.Socket> {
  const socket = net.connect(port, "localhost");
  await waitForRawConnect(socket);
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    [
      "GET / HTTP/1.1",
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      ""
    ].join("\r\n")
  );
  await waitForRawData(socket, (chunk) => chunk.toString("utf8").includes(`Sec-WebSocket-Accept: ${expectedAccept}`));
  return socket;
}

function maskedFrame(payload: Buffer, opcode: number): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = masked[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}
