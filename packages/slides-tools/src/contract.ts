/**
 * Host-neutral slide tool contract. Every host (DSH Hub run, MCP server, the
 * core agent loop) consumes the same definitions; none of these types may
 * reference a host SDK.
 */

/** Who is calling a tool. `id` is stable per run/client/tab. */
export type SlideCallerKind = "hub-run" | "mcp" | "editor-human";

export type SlideCaller = {
  readonly kind: SlideCallerKind;
  /** e.g. `hub-run:<sessionId>`, `mcp:<clientId>`, `editor-human:<tab>`. */
  readonly id: string;
  readonly label?: string;
};

export type SlideToolContext = {
  readonly projectId: string;
  /** Absolute PPTD project root. Empty only for tools with `requiresProject: false`. */
  readonly projectRoot: string;
  readonly callId: string;
  readonly signal?: AbortSignal;
  readonly caller: SlideCaller;
  /** Run/session identity used for receipts and serial gates; defaults to caller.id. */
  readonly sessionId?: string;
  /**
   * Whether the host can deliver image content blocks to the model. When false,
   * a tool that must stream an image fails closed with an explicit error.
   */
  readonly acceptsImageContent?: boolean;
};

export type SlideImageMediaType = "image/png" | "image/jpeg";

export type SlideTextBlock = { readonly type: "text"; readonly text: string };

export type SlideImageBlock = {
  readonly type: "image";
  readonly data: Uint8Array;
  readonly mediaType: SlideImageMediaType;
  readonly width?: number;
  readonly height?: number;
  readonly name?: string;
};

export type SlideContentBlock = SlideTextBlock | SlideImageBlock;

export type SlideToolResult = {
  readonly data: Record<string, unknown>;
  readonly content?: readonly SlideContentBlock[];
  readonly isError?: boolean;
  /**
   * Called by the host after every image block in `content` reached the model
   * (e.g. to record that a page raster was emitted). Hosts that drop images
   * must not call it.
   */
  readonly onContentDelivered?: () => Promise<void>;
};

/** How a host renders `data` as model text. */
export type SlideToolRender = "json" | "vision" | ((data: Record<string, unknown>) => string);

export type SlideToolDefinition = {
  readonly name: string;
  readonly description: string;
  /** Standard JSON Schema (object root). */
  readonly inputSchema: Record<string, unknown>;
  /** Read-only tools never take the project writer lease and never mutate disk. */
  readonly readOnly: boolean;
  /** False only for `open_project`, which creates the binding. */
  readonly requiresProject?: boolean;
  readonly render: SlideToolRender;
  readonly concurrencySafe?: boolean;
  /**
   * Pure argument check (no disk access). Hosts may call it before resolving
   * the project binding; `execute` runs it again. Throws SlideToolArgsError.
   */
  validate?(args: Record<string, unknown>): void;
  execute(args: Record<string, unknown>, ctx: SlideToolContext): Promise<SlideToolResult>;
};

/** Invalid model arguments. Hosts map this to their own invalid-args error. */
export class SlideToolArgsError extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super(`invalid arguments: ${violations.join("; ")}`);
    this.name = "SlideToolArgsError";
    this.violations = [...violations];
  }
}

export function isSlideToolArgsError(error: unknown): error is SlideToolArgsError {
  return error instanceof SlideToolArgsError;
}

/** Context handed to a post-turn hook after the host finishes one agent turn. */
export type PostTurnHookContext = {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly caller: SlideCaller;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  /** Names of tools that ran during the turn, in call order. */
  readonly toolNames: readonly string[];
};

export type PostTurnHookResult = {
  /** Optional note the host may surface to the user or trace. */
  readonly note?: string;
  readonly changed?: boolean;
};

/**
 * Extension seam for overlays that need custom post-turn actions. Core ships
 * none; hosts run registered hooks in order and contain their failures.
 */
export type PostTurnHook = {
  readonly name: string;
  run(ctx: PostTurnHookContext): Promise<PostTurnHookResult | void>;
};

export async function runPostTurnHooks(
  hooks: readonly PostTurnHook[],
  ctx: PostTurnHookContext,
): Promise<{ name: string; ok: boolean; result?: PostTurnHookResult; error?: string }[]> {
  const out: { name: string; ok: boolean; result?: PostTurnHookResult; error?: string }[] = [];
  for (const hook of hooks) {
    if (ctx.signal?.aborted) break;
    try {
      const result = await hook.run(ctx);
      out.push({ name: hook.name, ok: true, ...(result ? { result } : {}) });
    } catch (error) {
      out.push({ name: hook.name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}
