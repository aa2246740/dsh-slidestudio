/**
 * Loopback-only Streamable HTTP transport (`POST /mcp`, `DELETE /mcp`).
 *
 * - Binds only to `127.0.0.1`, `localhost` or `::1`; any other host throws.
 * - DNS-rebinding guard: `Host` must name a loopback host and a present `Origin`
 *   must be a loopback origin, otherwise 403.
 * - Optional bearer token compared with `crypto.timingSafeEqual` (401 on mismatch).
 * - Bodies over 4 MiB get 413. `initialize` mints `Mcp-Session-Id`; every later
 *   request must carry a live id. Notification-only posts get 202.
 * - `DELETE /mcp` ends the session and releases its writer leases; `close()` ends all.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { classifyMessage, INVALID_REQUEST, parseWire, rpcError, type JsonRpcResponse } from "./jsonrpc.js";
import type { SlidesMcpServer } from "./server.js";
import type { McpSession, SessionOutcome } from "./session.js";

export const MCP_PATH = "/mcp";
export const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SESSION_HEADER = "mcp-session-id";

export type HttpTransportOptions = {
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
};

export type HttpTransport = {
  readonly server: http.Server;
  listen(): Promise<AddressInfo>;
  /** `http://<host>:<port>/mcp` once listening. */
  url(): string;
  close(): Promise<void>;
};

/** Strip brackets and lowercase a host name from a URL or Host header. */
function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

const LOOPBACK_HOST_HEADER_RE = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i;

function validPort(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function hostHeaderName(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = LOOPBACK_HOST_HEADER_RE.exec(header.trim());
  if (!match || !validPort(match[2])) return undefined;
  return normalizeHost(match[1]!);
}

function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const match = LOOPBACK_ORIGIN_RE.exec(origin.trim());
  return Boolean(match && validPort(match[2]));
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  const given = match?.[1]?.trim() ?? "";
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b) && given.length > 0;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
}

function sendStatus(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  sendJson(res, status, rpcError(null, INVALID_REQUEST, message), headers);
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) return reject(new BodyTooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    let ended = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        req.removeAllListeners("data");
        req.resume();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      ended = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("close", () => {
      if (!ended) reject(new Error("request stream closed before body completed"));
    });
    req.on("error", reject);
  });
}

function isInitialize(value: unknown): boolean {
  const message = classifyMessage(value);
  return message.kind === "request" && message.message.method === "initialize";
}

function hasRequest(messages: readonly unknown[]): boolean {
  return messages.some((value) => classifyMessage(value).kind === "request");
}

async function runAll(session: McpSession, messages: readonly unknown[]): Promise<SessionOutcome[]> {
  const out: SessionOutcome[] = [];
  for (const message of messages) out.push(await session.handle(message));
  return out;
}

function afterFinish(res: http.ServerResponse, outcomes: readonly SessionOutcome[], log: (line: string) => void) {
  const hooks = outcomes.flatMap((outcome) => (outcome.afterDelivery ? [outcome.afterDelivery] : []));
  if (!hooks.length) return;
  res.once("finish", () => {
    if (res.destroyed || !res.writableEnded) return;
    void (async () => {
      for (const hook of hooks) await hook();
    })().catch((error: unknown) => log(`[slides-mcp] delivery hook failed: ${String(error)}`));
  });
}

export function createHttpTransport(server: SlidesMcpServer, options: HttpTransportOptions = {}): HttpTransport {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`slides-mcp HTTP binds only to loopback (127.0.0.1, localhost, ::1); refused host ${host}`);
  }
  const token = options.authToken?.trim() || undefined;
  const httpSessions = new Set<string>();
  const log = (line: string) => process.stderr.write(`${line}\n`);

  const respond = (res: http.ServerResponse, outcomes: SessionOutcome[], batch: boolean, extra = {}) => {
    const responses = outcomes.flatMap((outcome) => (outcome.response ? [outcome.response] : []));
    if (!responses.length) {
      res.writeHead(202, extra);
      res.end();
      return;
    }
    afterFinish(res, outcomes, log);
    sendJson(res, 200, batch ? responses : (responses[0] as JsonRpcResponse), extra);
  };

  const handlePost = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let text: string;
    try {
      text = await readBody(req);
    } catch (error) {
      if (error instanceof BodyTooLarge)
        return sendStatus(res, 413, "request body exceeds 4 MiB", { connection: "close" });
      throw error;
    }
    const parsed = parseWire(text);
    if (!parsed.ok) return sendJson(res, 400, parsed.response);
    const batch = Array.isArray(parsed.value);
    const messages: unknown[] = batch ? (parsed.value as unknown[]) : [parsed.value];
    if (!messages.length) return sendStatus(res, 400, "empty batch");
    if (messages.some(isInitialize)) {
      if (messages.length !== 1) return sendStatus(res, 400, "initialize must be sent alone");
      const session = server.createSession();
      httpSessions.add(session.id);
      return respond(res, await runAll(session, messages), false, { "mcp-session-id": session.id });
    }
    const id = req.headers[SESSION_HEADER];
    if (typeof id !== "string" || !id) return sendStatus(res, 400, "missing Mcp-Session-Id header");
    const session = httpSessions.has(id) ? server.session(id) : undefined;
    if (!session || session.isClosed) return sendStatus(res, 404, "unknown or terminated MCP session");
    if (!hasRequest(messages)) {
      await runAll(session, messages);
      res.writeHead(202);
      res.end();
      return;
    }
    respond(res, await runAll(session, messages), batch);
  };

  const handleDelete = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const id = req.headers[SESSION_HEADER];
    if (typeof id !== "string" || !httpSessions.has(id))
      return sendStatus(res, 404, "unknown or terminated MCP session");
    httpSessions.delete(id);
    server.closeSession(id);
    res.writeHead(204);
    res.end();
  };

  const guard = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    const hostName = hostHeaderName(req.headers.host);
    if (!hostName || !isLoopbackHost(hostName) || !originAllowed(req.headers.origin)) {
      sendStatus(res, 403, "forbidden: non-loopback Host or Origin");
      return false;
    }
    if (token && !tokenMatches(token, req.headers.authorization)) {
      sendStatus(res, 401, "unauthorized", { "www-authenticate": 'Bearer realm="slides-mcp"' });
      return false;
    }
    return true;
  };

  const httpServer = http.createServer((req, res) => {
    if (!guard(req, res)) return;
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== MCP_PATH) return sendStatus(res, 404, "not found");
    if (req.method === "POST") {
      handlePost(req, res).catch((error: unknown) => {
        log(`[slides-mcp] HTTP request failed: ${String(error)}`);
        if (!res.headersSent) sendStatus(res, 500, "internal error");
        else res.end();
      });
      return;
    }
    if (req.method === "DELETE") return handleDelete(req, res);
    sendStatus(res, 405, "method not allowed", { allow: "POST, DELETE" });
  });

  let address: AddressInfo | undefined;
  return {
    server: httpServer,
    listen: () =>
      new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(options.port ?? 0, host, () => {
          httpServer.off("error", reject);
          address = httpServer.address() as AddressInfo;
          resolve(address);
        });
      }),
    url() {
      if (!address) throw new Error("HTTP transport is not listening");
      const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
      return `http://${shown}:${address.port}${MCP_PATH}`;
    },
    close: () =>
      new Promise((resolve) => {
        for (const id of httpSessions) server.closeSession(id);
        httpSessions.clear();
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      }),
  };
}
