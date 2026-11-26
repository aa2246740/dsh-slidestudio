/** Offline fixtures for slides-mcp tests: temp roots, image bytes, and stdio/HTTP/in-process clients. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import type { McpSession } from "./session.js";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_PATH = path.join(PACKAGE_ROOT, "dist", "cli.js");

export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `slides-mcp-${prefix}-`)));
}

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A real, decodable RGB PNG filled with one colour. */
export function pngBytes(
  width: number,
  height: number,
  rgb: readonly [number, number, number] = [37, 99, 235],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG header carrying a baseline SOF0 frame size (enough for size sniffing). */
export function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3]);
  const comps = Buffer.from([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, comps, Buffer.from([0xff, 0xd9])]);
}

export type RpcMessage = {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

type ToolContent = { type: string; text?: string; data?: string; mimeType?: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

/** The JSON object a tool rendered as its first text block. */
export function toolData(result: ToolResult | Record<string, unknown> | undefined): Record<string, unknown> {
  const content = (result as ToolResult | undefined)?.content;
  const text = content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`no text content in ${JSON.stringify(result)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** Drive an in-process session with JSON-RPC requests. */
export class SessionClient {
  private next = 1;
  constructor(readonly session: McpSession) {}

  async request(method: string, params?: unknown): Promise<RpcMessage> {
    const outcome = await this.session.handle({ jsonrpc: "2.0", id: this.next++, method, params });
    await outcome.afterDelivery?.();
    return (outcome.response ?? {}) as RpcMessage;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const response = await this.request("tools/call", { name, arguments: args });
    if (response.error) throw new Error(`tools/call ${name}: ${response.error.message}`);
    return response.result as unknown as ToolResult;
  }
}

/** A `slides-mcp` child process spoken to over newline-delimited stdio. */
export class StdioClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutLines: string[] = [];
  stderr = "";
  private buffer = "";
  private next = 1;
  private readonly waiting = new Map<number, (message: RpcMessage) => void>();
  readonly exited: Promise<number | null>;

  constructor(args: readonly string[], env: NodeJS.ProcessEnv = {}, opts: { readonly cwd?: string } = {}) {
    const clean = { ...process.env, ...env };
    delete clean.SLIDESTUDIO_MCP_IMPORT_ROOTS;
    delete clean.OPEN_SLIDESTUDIO_ROOT;
    if (env.SLIDESTUDIO_MCP_IMPORT_ROOTS) clean.SLIDESTUDIO_MCP_IMPORT_ROOTS = env.SLIDESTUDIO_MCP_IMPORT_ROOTS;
    if (env.OPEN_SLIDESTUDIO_ROOT) clean.OPEN_SLIDESTUDIO_ROOT = env.OPEN_SLIDESTUDIO_ROOT;
    this.child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: clean,
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.stdoutLines.push(line);
      const message = JSON.parse(line) as RpcMessage;
      if (typeof message.id === "number") this.waiting.get(message.id)?.(message);
      index = this.buffer.indexOf("\n");
    }
  }

  /** Write raw bytes to the server's stdin (framing tests). */
  writeRaw(text: string): void {
    this.child.stdin.write(text);
  }

  expect(id: number): Promise<RpcMessage> {
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  request(method: string, params?: unknown): Promise<RpcMessage> {
    const id = this.next++;
    const reply = this.expect(id);
    this.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return reply;
  }

  notify(method: string, params?: unknown): void {
    this.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const response = await this.request("tools/call", { name, arguments: args });
    if (response.error) throw new Error(`tools/call ${name}: ${response.error.message}`);
    return response.result as unknown as ToolResult;
  }

  async end(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}

export type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

/** A raw HTTP request with full control over Host/Origin headers. */
export function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        host: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port,
        path: target.pathname,
        method: options.method ?? "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...options.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export function rpcBody(id: number | undefined, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });
}

export const INIT_PARAMS = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "slides-mcp-test", version: "1.0.0" },
};

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
