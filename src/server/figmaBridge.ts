import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import type { FigmaBridgeStatus } from "../shared/schema";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_PORT_RANGE = Array.from({ length: 10 }, (_, index) => 9223 + index).reverse();

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

interface ConnectedFile {
  fileName: string;
  fileKey: string;
  currentPage?: string;
  editorType?: string;
  connectedAt: number;
}

interface FigmaBridgeOptions {
  preferredPort?: number;
  host?: string;
}

interface WebSocketFrame {
  opcode: number;
  payload: Buffer;
}

export class FigmaBridgeServer {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private file: ConnectedFile | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private actualPort: number | undefined;
  private startPromise: Promise<void> | null = null;
  private frameBuffer = Buffer.alloc(0);
  private readonly host: string;
  private readonly preferredPort?: number;

  constructor(options: FigmaBridgeOptions = {}) {
    this.host = options.host || "localhost";
    this.preferredPort = options.preferredPort;
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startOnAvailablePort().catch((error) => {
      this.startPromise = null;
      throw error;
    });

    return this.startPromise;
  }

  async stop(): Promise<void> {
    for (const [, request] of this.pending) {
      clearTimeout(request.timeoutId);
      request.reject(new Error("Figma bridge server stopped"));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
    this.file = null;
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
    this.actualPort = undefined;
    this.startPromise = null;
  }

  status(): FigmaBridgeStatus {
    const connected = Boolean(this.socket && !this.socket.destroyed && this.file);
    return {
      ok: connected,
      serverRunning: Boolean(this.server?.listening),
      port: this.actualPort,
      connected,
      fileName: this.file?.fileName,
      fileKey: this.file?.fileKey,
      currentPage: this.file?.currentPage,
      message: connected
        ? `Connected to Figma Desktop file "${this.file?.fileName}" on port ${this.actualPort}.`
        : this.server?.listening
          ? `Waiting for Figma Desktop Bridge to connect on port ${this.actualPort}.`
          : "Figma bridge server is not running."
    };
  }

  async executeCode(code: string, timeoutMs = 30_000): Promise<unknown> {
    await this.start();
    if (!this.socket || this.socket.destroyed || !this.file) {
      throw new Error(
        `No Figma Desktop Bridge connection on port ${this.actualPort}. Re-run or reconnect the Figma Desktop Bridge plugin.`
      );
    }

    const id = `gemma_${++this.requestCounter}_${Date.now()}`;
    const response = await new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Figma EXECUTE_CODE timed out after ${timeoutMs}ms`));
      }, timeoutMs + 2_000);
      this.pending.set(id, { resolve, reject, timeoutId });
      this.sendJson(this.socket, { id, method: "EXECUTE_CODE", params: { code, timeout: timeoutMs } });
    });

    const result = normalizePluginResult(response);
    if (!result.success) {
      throw new Error(result.error || "Figma Desktop Bridge reported an unknown execution error");
    }
    return result;
  }

  private async startOnAvailablePort(): Promise<void> {
    const ports = this.preferredPort
      ? [this.preferredPort, ...DEFAULT_PORT_RANGE.filter((port) => port !== this.preferredPort)]
      : DEFAULT_PORT_RANGE;

    let lastError: unknown;
    for (const port of ports) {
      try {
        await this.listen(port);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Could not start Figma bridge on ports 9223-9232: ${String(lastError)}`);
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(this.status()));
      });
      server.on("upgrade", (req, socket) => {
        const key = req.headers["sec-websocket-key"];
        if (typeof key !== "string") {
          socket.destroy();
          return;
        }
        const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            ""
          ].join("\r\n")
        );
        this.registerSocket(socket as Socket);
      });
      server.once("error", (error) => {
        server.close();
        reject(error);
      });
      server.listen(port, this.host, () => {
        this.server = server;
        server.unref();
        const address = server.address();
        this.actualPort = typeof address === "object" && address ? address.port : port;
        resolve();
      });
    });
  }

  private registerSocket(socket: Socket): void {
    if (this.socket && this.socket !== socket) {
      this.socket.destroy();
    }
    this.socket = socket;
    socket.unref();
    this.file = null;
    this.frameBuffer = Buffer.alloc(0);
    this.sendJson(socket, {
      type: "SERVER_HELLO",
      data: {
        port: this.actualPort,
        pid: process.pid,
        serverVersion: "gemma-deck-forge",
        startedAt: Date.now()
      }
    });

    socket.on("data", (chunk) => this.handleSocketData(chunk));
    socket.on("close", () => this.handleSocketClose(socket));
    socket.on("error", () => this.handleSocketClose(socket));
  }

  private handleSocketData(chunk: Buffer): void {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    while (true) {
      const parsed = readFrame(this.frameBuffer);
      if (!parsed) return;
      this.frameBuffer = this.frameBuffer.subarray(parsed.bytesRead);
      this.handleFrame(parsed.frame);
    }
  }

  private handleFrame(frame: WebSocketFrame): void {
    if (frame.opcode === 0x8) {
      this.socket?.end();
      return;
    }
    if (frame.opcode === 0x9) {
      this.sendFrame(this.socket, frame.payload, 0xA);
      return;
    }
    if (frame.opcode !== 0x1) return;

    let message: unknown;
    try {
      message = JSON.parse(frame.payload.toString("utf8"));
    } catch {
      return;
    }
    this.handleMessage(message);
  }

  private handleMessage(message: unknown): void {
    const payload = message as { id?: string; error?: string; result?: unknown; type?: string; data?: Record<string, unknown> };
    if (payload.id && this.pending.has(payload.id)) {
      const request = this.pending.get(payload.id);
      if (!request) return;
      clearTimeout(request.timeoutId);
      this.pending.delete(payload.id);
      if (payload.error) {
        request.reject(new Error(payload.error));
      } else {
        request.resolve(payload.result);
      }
      return;
    }

    if (payload.type === "FILE_INFO" && payload.data) {
      this.file = {
        fileName: String(payload.data.fileName || "Untitled"),
        fileKey: String(payload.data.fileKey || "unknown"),
        currentPage: payload.data.currentPage ? String(payload.data.currentPage) : undefined,
        editorType: payload.data.editorType ? String(payload.data.editorType) : undefined,
        connectedAt: Date.now()
      };
    }
  }

  private handleSocketClose(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.file = null;
    for (const [, request] of this.pending) {
      clearTimeout(request.timeoutId);
      request.reject(new Error("Figma Desktop Bridge disconnected"));
    }
    this.pending.clear();
  }

  private sendJson(socket: Socket | null, payload: unknown): void {
    if (!socket || socket.destroyed) return;
    this.sendFrame(socket, Buffer.from(JSON.stringify(payload), "utf8"), 0x1);
  }

  private sendFrame(socket: Socket | null, payload: Buffer, opcode: number): void {
    if (!socket || socket.destroyed) return;
    socket.write(createFrame(payload, opcode));
  }
}

let singleton: FigmaBridgeServer | null = null;

export function getFigmaBridgeServer(): FigmaBridgeServer {
  if (!singleton) {
    singleton = new FigmaBridgeServer({
      preferredPort: parsePort(process.env.GEMMA_FIGMA_BRIDGE_PORT || process.env.FIGMA_BRIDGE_PORT)
    });
  }
  return singleton;
}

export function resetFigmaBridgeServerForTests(): void {
  singleton = null;
}

function normalizePluginResult(value: unknown): { success: boolean; error?: string; [key: string]: unknown } {
  if (value && typeof value === "object" && "success" in value) {
    return value as { success: boolean; error?: string; [key: string]: unknown };
  }
  return { success: true, result: value };
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 ? port : undefined;
}

function readFrame(buffer: Buffer): { frame: WebSocketFrame; bytesRead: number } | null {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
    length = Number(bigLength);
    offset += 8;
  }

  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index] ^ mask[index % 4];
    }
  }

  return {
    frame: { opcode, payload },
    bytesRead: offset + length
  };
}

function createFrame(payload: Buffer, opcode: number): Buffer {
  const headerLength = payload.length <= 125 ? 2 : payload.length <= 65_535 ? 4 : 10;
  const header = Buffer.alloc(headerLength);
  header[0] = 0x80 | opcode;
  if (payload.length <= 125) {
    header[1] = payload.length;
  } else if (payload.length <= 65_535) {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
