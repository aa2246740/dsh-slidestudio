/**
 * Shared plumbing for canonical slide tools: runtime ports, the presentation
 * command bridge, argument validation, and the project writer-lease gate.
 */
import { withProjectWriteLock } from "@open-slidestudio/pptd-v2";
import {
  inspectProjectCapabilities,
  type CapabilitySnapshot,
  type CommandContext,
  type CommandReceipt,
  type PresentationRun,
} from "@open-slidestudio/presentation-run";
import {
  SlideToolArgsError,
  type SlideContentBlock,
  type SlideToolContext,
  type SlideToolDefinition,
  type SlideToolRender,
  type SlideToolResult,
} from "./contract.js";
import { acquireProjectLease, withProjectLeaseLock } from "./project-lease.js";
import { localizePlanArgIssues } from "./design-aspects-parameter.js";
import { closeSchemaRoot, compileParameterSpec } from "./schema-dsl.js";

export type SlideSchemaValidator = (schema: Record<string, unknown>, value: unknown) => string[];

export type OpenedSlideProject = {
  readonly created: boolean;
  readonly projectId: string;
  readonly projectRoot: string;
  /** Root as shown to the model (may be workspace-relative). */
  readonly displayRoot: string;
  readonly design:
    { readonly kind: "self-directed" } | { readonly kind: "explicit-style"; readonly designSystemId: string };
  /** True when the port ran `input.initialize` atomically before publishing the project dir. */
  readonly initialized?: boolean;
  /** Returned when `input.initialize` refused creation before publishing. */
  readonly refusal?: SlideToolResult;
};

/** Host port that creates or reopens the project bound to the caller. */
export type SlideProjectPort = {
  /** Return an already-bound project root without mutating disk, when one exists. */
  peekExisting?(ctx: SlideToolContext): string | undefined;
  open(input: {
    readonly ctx: SlideToolContext;
    readonly title: string;
    readonly initialize?: (targetRoot: string, design: OpenedSlideProject["design"]) => SlideToolResult | undefined;
  }): OpenedSlideProject;
  /** Roll back a freshly created project directory and binding when post-open setup fails. */
  rollbackCreated?(projectRoot: string, ctx: SlideToolContext): void;
};

export type SlideToolRuntimeDeps = {
  readonly presentation: PresentationRun;
  /** Native editor origin, e.g. `http://127.0.0.1:55200`. */
  readonly editorBaseUrl: string;
  /** JSON Schema validator supplied by the host; required for production hosts. */
  readonly validateSchema?: SlideSchemaValidator;
  /** Capability snapshot for a project; defaults to the persisted project snapshot. */
  readonly capabilities?: (ctx: SlideToolContext) => CapabilitySnapshot;
  readonly projects?: SlideProjectPort;
  /** Re-bind hosted media credentials before web/image tools. */
  readonly ensureMediaEnv?: () => void;
  /** Writer-lease TTL; `false` disables the gate (tests of other behaviour only). */
  readonly writerLease?: { readonly ttlMs?: number } | false;
};

export function sessionKeyOf(ctx: SlideToolContext): string {
  return ctx.sessionId ?? ctx.caller.id;
}

export function capabilitiesFor(deps: SlideToolRuntimeDeps, ctx: SlideToolContext): CapabilitySnapshot {
  return deps.capabilities ? deps.capabilities(ctx) : inspectProjectCapabilities(ctx.projectRoot);
}

export function isLeaseRefusalData(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === "lease-conflict" || outcome === "lease-preempted-by-editor";
}

function abortedWriteResult() {
  const detail = "tool execution was aborted or timed out before committing";
  return {
    ok: false as const,
    summary: "tool-aborted",
    detail,
    payload: { ok: false, outcome: "tool-aborted", error: "tool-aborted", detail, painted: false },
  };
}

function writeAuthorityGate(deps: SlideToolRuntimeDeps, ctx: SlideToolContext): CommandContext["runAuthorizedWrite"] {
  if (!ctx.projectRoot) return undefined;
  if (deps.writerLease === false) {
    if (!ctx.signal) return undefined;
    return (commit) => (ctx.signal?.aborted ? abortedWriteResult() : { ok: true as const, value: commit() });
  }
  return (commit) =>
    withProjectLeaseLock(ctx.projectRoot, () => {
      if (ctx.signal?.aborted) return abortedWriteResult();
      const refusal = leaseRefusal(deps, ctx);
      if (refusal) {
        return {
          ok: false as const,
          summary: String(refusal.data.outcome ?? "lease-conflict"),
          detail: String(refusal.data.detail ?? "writer lease refused"),
          payload: refusal.data,
        };
      }
      return { ok: true as const, value: commit() };
    });
}

/** Run a synchronous post-commit side effect only while holding both locks and the writer lease. */
export function runAuthorizedSideEffect(deps: SlideToolRuntimeDeps, ctx: SlideToolContext, write: () => void): void {
  if (!ctx.projectRoot || ctx.signal?.aborted) return;
  if (deps.writerLease === false) {
    withProjectWriteLock(ctx.projectRoot, () => {
      if (!ctx.signal?.aborted) write();
    });
    return;
  }
  withProjectWriteLock(ctx.projectRoot, () =>
    withProjectLeaseLock(ctx.projectRoot, () => {
      if (ctx.signal?.aborted || leaseRefusal(deps, ctx)) return;
      write();
    }),
  );
}

/** Run one presentation-run domain command for the calling project. */
export function present(
  deps: SlideToolRuntimeDeps,
  ctx: SlideToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CommandReceipt> {
  const sessionId = sessionKeyOf(ctx);
  const runAuthorizedWrite = writeAuthorityGate(deps, ctx);
  return deps.presentation.execute(
    { name, args },
    {
      runId: sessionId,
      sessionId,
      toolCallId: ctx.callId,
      projectRoot: ctx.projectRoot,
      abortSignal: ctx.signal ?? new AbortController().signal,
      ...(runAuthorizedWrite ? { runAuthorizedWrite } : {}),
    },
  );
}

/** Detach a value into plain JSON (drops undefined, functions, prototypes). */
export function toJsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
}

export function result(value: unknown, content?: readonly SlideContentBlock[]): SlideToolResult {
  const data = toJsonRecord(value);
  return {
    ...(isLeaseRefusalData(data) ? { isError: true } : {}),
    data,
    ...(content?.length ? { content } : {}),
  };
}

export function receiptResult(receipt: CommandReceipt): SlideToolResult {
  if (!receipt.ok && isLeaseRefusalData(receipt.payload)) {
    return { isError: true, data: toJsonRecord(receipt.payload) };
  }
  return result(receipt);
}

export function textOfJson(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

export type SlideToolSpec = {
  readonly name: string;
  readonly description: string;
  /** Either a parameter DSL map or a full JSON Schema (`schema`). */
  readonly parameters?: Record<string, unknown>;
  readonly schema?: Record<string, unknown>;
  /** Close the schema root (`additionalProperties: false`). */
  readonly closed?: boolean;
  readonly readOnly: boolean;
  readonly requiresProject?: boolean;
  readonly render?: SlideToolRender;
  readonly concurrencySafe?: boolean;
  /**
   * Custom pure validator replacing the schema check (tools that normalize
   * before validating). Runs before the writer lease; throws SlideToolArgsError.
   */
  readonly validate?: (args: Record<string, unknown>) => void;
  /** Rewrite host-validator issues into domain vocabulary. */
  readonly localizeIssues?: (issues: string[], args: unknown) => string[];
  execute(args: Record<string, unknown>, ctx: SlideToolContext): Promise<SlideToolResult>;
};

export function validateArgs(
  deps: SlideToolRuntimeDeps,
  schema: Record<string, unknown>,
  args: unknown,
  localize?: (issues: string[], args: unknown) => string[],
): void {
  if (!deps.validateSchema) return;
  const raw = deps.validateSchema(schema, args);
  const issues = localize ? localize(raw, args) : raw;
  if (issues.length) throw new SlideToolArgsError(issues);
}

export function leaseRefusal(deps: SlideToolRuntimeDeps, ctx: SlideToolContext): SlideToolResult | undefined {
  if (deps.writerLease === false || !ctx.projectRoot) return undefined;
  const lease = acquireProjectLease(ctx.projectRoot, {
    kind: ctx.caller.kind,
    ownerId: ctx.caller.id,
    ...(ctx.caller.label ? { label: ctx.caller.label } : {}),
    ...(deps.writerLease?.ttlMs ? { ttlMs: deps.writerLease.ttlMs } : {}),
  });
  if (lease.ok) return undefined;
  const holder = "holder" in lease ? lease.holder : undefined;
  return {
    isError: true,
    data: toJsonRecord({
      ok: false,
      outcome: lease.outcome,
      error: lease.outcome,
      detail: lease.detail,
      painted: false,
      ...(holder ? { holder } : {}),
    }),
  };
}

/** Build a canonical definition with schema compilation, validation and the writer-lease gate. */
export function defineSlideTool(spec: SlideToolSpec): SlideToolDefinition {
  const base = spec.schema ?? compileParameterSpec(spec.parameters ?? {});
  const inputSchema = spec.closed ? closeSchemaRoot(base) : base;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema,
    readOnly: spec.readOnly,
    ...(spec.requiresProject === false ? { requiresProject: false } : {}),
    render: spec.render ?? "json",
    ...(spec.concurrencySafe ? { concurrencySafe: true } : {}),
    execute: spec.execute,
  };
}

/**
 * Wrap a definition with the runtime pipeline every host shares: validate,
 * then (for mutating tools) take the writer lease, then run the body.
 */
export function withRuntimeGates(
  deps: SlideToolRuntimeDeps,
  spec: Pick<SlideToolSpec, "validate" | "localizeIssues">,
  definition: SlideToolDefinition,
): SlideToolDefinition {
  const validate = (args: Record<string, unknown>): void => {
    if (spec.validate) spec.validate(args);
    else validateArgs(deps, definition.inputSchema, args, spec.localizeIssues);
  };
  return {
    ...definition,
    validate,
    async execute(args, ctx) {
      validate(args);
      if (ctx.signal?.aborted) {
        return {
          isError: true,
          data: toJsonRecord(abortedWriteResult().payload),
        };
      }
      if (!definition.readOnly && definition.requiresProject !== false) {
        const refusal = leaseRefusal(deps, ctx);
        if (refusal) return refusal;
      }
      return definition.execute(args, ctx);
    },
  };
}

/** Define and gate in one step (the common case). Closed roots localize plan-field issues. */
export function slideTool(deps: SlideToolRuntimeDeps, spec: SlideToolSpec): SlideToolDefinition {
  const definition = defineSlideTool(spec);
  const localizeIssues =
    spec.localizeIssues ?? (spec.closed ? localizePlanArgIssues(definition.inputSchema) : undefined);
  return withRuntimeGates(deps, { validate: spec.validate, localizeIssues }, definition);
}
