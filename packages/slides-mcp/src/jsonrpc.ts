/** JSON-RPC 2.0 message shapes and helpers shared by both MCP transports. */

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
};

export type JsonRpcNotification = {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
};

export type JsonRpcErrorObject = { readonly code: number; readonly message: string; readonly data?: unknown };

export type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId | null; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId | null; readonly error: JsonRpcErrorObject };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** Classified incoming message. Client responses are accepted and ignored. */
export type IncomingMessage =
  | { readonly kind: "request"; readonly message: JsonRpcRequest }
  | { readonly kind: "notification"; readonly message: JsonRpcNotification }
  | { readonly kind: "response" }
  | { readonly kind: "invalid"; readonly id: JsonRpcId | null; readonly detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is JsonRpcId {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
}

export function classifyMessage(value: unknown): IncomingMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    const id = isRecord(value) && validId(value.id) ? value.id : null;
    return { kind: "invalid", id, detail: "expected a JSON-RPC 2.0 object" };
  }
  const hasId = Object.hasOwn(value, "id");
  if (typeof value.method !== "string") {
    if (hasId && (Object.hasOwn(value, "result") || Object.hasOwn(value, "error"))) return { kind: "response" };
    return { kind: "invalid", id: validId(value.id) ? value.id : null, detail: "method must be a string" };
  }
  if (!hasId) {
    return { kind: "notification", message: { jsonrpc: "2.0", method: value.method, params: value.params } };
  }
  if (!validId(value.id)) return { kind: "invalid", id: null, detail: "id must be a non-empty string or a number" };
  return { kind: "request", message: { jsonrpc: "2.0", id: value.id, method: value.method, params: value.params } };
}

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** A failure the dispatcher reports as a JSON-RPC error object. */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** Parse one wire payload; a syntax error becomes a JSON-RPC parse-error response. */
export function parseWire(text: string): { ok: true; value: unknown } | { ok: false; response: JsonRpcResponse } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: rpcError(null, PARSE_ERROR, "Parse error: invalid JSON") };
  }
}
