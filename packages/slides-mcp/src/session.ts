/**
 * One MCP session: JSON-RPC dispatch (`initialize`, `ping`, `tools/list`,
 * `tools/call`, notifications), the project binding, and the writer-lease
 * lifecycle. Every session is one fixed caller `{ kind: "mcp", id: "mcp:<sessionId>" }`;
 * closing it releases every lease that caller still holds and never touches
 * another owner's lease.
 */
import crypto from "node:crypto";
import {
  createSlideTools,
  editorUrlFor,
  isSlideToolArgsError,
  readProjectLease,
  releaseProjectLease,
  type SlideToolContext,
  type SlideToolDefinition,
  type SlideToolResult,
  type SlideToolRuntimeDeps,
} from "@open-slidestudio/slides-tools";
import { toCallToolResult, toolError, type MappedToolResult } from "./content.js";
import type { ImportPolicy } from "./import-material.js";
import { mcpInstructions } from "./instructions.js";
import {
  classifyMessage,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  rpcError,
  rpcResult,
  RpcError,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";
import { mcpOnlyTools } from "./mcp-tools.js";
import { mcpProjectPort, type McpSessionState, type ProjectEnv } from "./project-port.js";
import { slideSchemaValidator } from "./schema-validator.js";

export const SERVER_NAME = "open-slidestudio-slides-mcp";
export const SERVER_VERSION = "0.1.0";
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-03-26", "2024-11-05"];
export const LATEST_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_CLIENT_LABEL = "mcp-client";

export type SessionOptions = ProjectEnv &
  ImportPolicy & {
    readonly acceptsImages: boolean;
    /** Fixed provider label; otherwise taken from `initialize.clientInfo`. */
    readonly clientLabel?: string;
    readonly writerLeaseTtlMs?: number;
    /** Extra host tools appended after the MCP-only tools (embedding hosts and tests). */
    readonly extraTools?: (deps: SlideToolRuntimeDeps, state: McpSessionState) => SlideToolDefinition[];
    readonly log: (line: string) => void;
  };

/** What a transport writes for one incoming message. */
export type SessionOutcome = {
  readonly response?: JsonRpcResponse;
  /** Run after `response` was written to the client (image delivery receipts). */
  readonly afterDelivery?: () => Promise<void>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clientLabelFrom(params: Record<string, unknown>): string | undefined {
  const info = isPlainObject(params.clientInfo) ? params.clientInfo : undefined;
  const name = typeof info?.name === "string" ? info.name.trim() : "";
  if (!name) return undefined;
  const version = typeof info?.version === "string" && info.version.trim() ? `@${info.version.trim()}` : "";
  return `${name}${version}`.replace(/[^\w.@ +:/-]/g, "_").slice(0, 120);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class McpSession {
  readonly id: string;
  readonly state: McpSessionState;
  protocolVersion?: string;
  initialized = false;
  private closed = false;
  private seq = 0;
  private readonly tools = new Map<string, SlideToolDefinition>();
  private readonly inflight = new Map<JsonRpcId, AbortController>();

  constructor(private readonly options: SessionOptions) {
    this.id = crypto.randomUUID();
    this.state = {
      sessionId: this.id,
      callerId: `mcp:${this.id}`,
      label: options.clientLabel ?? DEFAULT_CLIENT_LABEL,
      acceptsImages: options.acceptsImages,
      leasedRoots: new Set<string>(),
    };
    const deps: SlideToolRuntimeDeps = {
      presentation: options.presentation,
      editorBaseUrl: options.editorBaseUrl,
      validateSchema: slideSchemaValidator,
      projects: mcpProjectPort(options, this.state),
      ...(options.writerLeaseTtlMs ? { writerLease: { ttlMs: options.writerLeaseTtlMs } } : {}),
    };
    const all = [
      ...createSlideTools(deps),
      ...mcpOnlyTools(deps, options, this.state, options),
      ...(options.extraTools?.(deps, this.state) ?? []),
    ];
    for (const def of all) this.tools.set(def.name, def);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Handle one parsed JSON-RPC message. Notifications and client responses yield no response. */
  async handle(raw: unknown): Promise<SessionOutcome> {
    const incoming = classifyMessage(raw);
    if (incoming.kind === "response") return {};
    if (incoming.kind === "invalid") return { response: rpcError(incoming.id, INVALID_REQUEST, incoming.detail) };
    if (incoming.kind === "notification") {
      this.notify(incoming.message);
      return {};
    }
    const request = incoming.message;
    if (this.closed) return { response: rpcError(request.id, INVALID_REQUEST, "session closed") };
    try {
      const outcome = await this.dispatch(request);
      return { response: rpcResult(request.id, outcome.result), ...outcome.extra };
    } catch (error) {
      if (error instanceof RpcError) return { response: rpcError(request.id, error.code, error.message, error.data) };
      this.options.log(`[slides-mcp] ${request.method} failed: ${errorText(error)}`);
      return { response: rpcError(request.id, INTERNAL_ERROR, errorText(error)) };
    }
  }

  private notify(message: JsonRpcNotification): void {
    if (message.method === "notifications/initialized") this.initialized = true;
    if (message.method === "notifications/cancelled" && isPlainObject(message.params)) {
      const requestId = message.params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") this.inflight.get(requestId)?.abort();
    }
  }

  private async dispatch(
    request: JsonRpcRequest,
  ): Promise<{ result: unknown; extra?: Pick<SessionOutcome, "afterDelivery"> }> {
    const params = request.params === undefined ? {} : request.params;
    if (!isPlainObject(params)) throw new RpcError(INVALID_PARAMS, "params must be an object");
    switch (request.method) {
      case "initialize":
        return { result: this.initialize(params) };
      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools: this.listTools() } };
      case "tools/call": {
        const mapped = await this.callTool(request.id, params);
        return {
          result: mapped.result,
          ...(mapped.afterDelivery ? { extra: { afterDelivery: mapped.afterDelivery } } : {}),
        };
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${request.method}`);
    }
  }

  private initialize(params: Record<string, unknown>) {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    this.protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
    if (!this.options.clientLabel) this.state.label = clientLabelFrom(params) ?? DEFAULT_CLIENT_LABEL;
    return {
      protocolVersion: this.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: mcpInstructions(),
    };
  }

  listTools() {
    return [...this.tools.values()].map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: { readOnlyHint: def.readOnly, destructiveHint: false, openWorldHint: false },
    }));
  }

  private contextFor(def: SlideToolDefinition, requestId: JsonRpcId, signal: AbortSignal): SlideToolContext {
    const binding = def.requiresProject === false ? undefined : this.state.binding;
    this.seq += 1;
    return {
      projectId: binding?.displayRoot ?? "",
      projectRoot: binding?.projectRoot ?? "",
      callId: `${this.id}:${String(requestId)}:${this.seq}`,
      signal,
      caller: { kind: "mcp", id: this.state.callerId, label: this.state.label },
      sessionId: this.state.binding?.runSessionId ?? this.id,
      acceptsImageContent: this.state.acceptsImages,
    };
  }

  private async callTool(requestId: JsonRpcId, params: Record<string, unknown>): Promise<MappedToolResult> {
    const name = params.name;
    if (typeof name !== "string" || !name) throw new RpcError(INVALID_PARAMS, "tools/call needs a tool name");
    const def = this.tools.get(name);
    if (!def) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isPlainObject(args)) throw new RpcError(INVALID_PARAMS, "tools/call arguments must be an object");
    try {
      def.validate?.(args);
    } catch (error) {
      if (isSlideToolArgsError(error)) {
        return { result: toolError("invalid_arguments", error.message, { violations: error.violations }) };
      }
      throw error;
    }
    if (def.requiresProject !== false && !this.state.binding) {
      return {
        result: toolError(
          "project_not_bound",
          "No project is bound to this session: call open_project or bind_project first.",
        ),
      };
    }
    return this.execute(def, requestId, args);
  }

  private async execute(
    def: SlideToolDefinition,
    requestId: JsonRpcId,
    args: Record<string, unknown>,
  ): Promise<MappedToolResult> {
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    let result: SlideToolResult;
    try {
      result = await def.execute(args, this.contextFor(def, requestId, controller.signal));
    } catch (error) {
      if (isSlideToolArgsError(error)) {
        return { result: toolError("invalid_arguments", error.message, { violations: error.violations }) };
      }
      this.options.log(`[slides-mcp] tool ${def.name} failed: ${errorText(error)}`);
      return { result: toolError("tool_failed", errorText(error)) };
    } finally {
      this.inflight.delete(requestId);
    }
    if (!def.readOnly) this.trackLease();
    return toCallToolResult(def, this.annotate(def, result), this.state.acceptsImages);
  }

  /** Remember a project root this session now holds the writer lease on. */
  private trackLease(): void {
    const root = this.state.binding?.projectRoot;
    if (root && readProjectLease(root).holder?.ownerId === this.state.callerId) this.state.leasedRoots.add(root);
  }

  /** open_project also reports the bind_project id and the editor link for this session. */
  private annotate(def: SlideToolDefinition, result: SlideToolResult): SlideToolResult {
    const binding = this.state.binding;
    if (def.name !== "open_project" || result.isError || !binding) return result;
    return {
      ...result,
      data: {
        ...result.data,
        projectId: binding.projectId,
        editorUrl: editorUrlFor(this.options.editorBaseUrl, binding.displayRoot),
      },
    };
  }

  /** Abort in-flight calls and release every lease this session still holds. Idempotent. */
  close(): string[] {
    if (this.closed) return [];
    this.closed = true;
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    const roots = new Set(this.state.leasedRoots);
    if (this.state.binding) roots.add(this.state.binding.projectRoot);
    const released: string[] = [];
    for (const root of roots) {
      try {
        if (releaseProjectLease(root, this.state.callerId)) released.push(root);
      } catch (error) {
        this.options.log(`[slides-mcp] releasing the writer lease failed: ${errorText(error)}`);
      }
    }
    this.state.leasedRoots.clear();
    return released;
  }
}
