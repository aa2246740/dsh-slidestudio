import type { ToolDefinition, ToolRuntime } from "@deepseek-ai/dsh-tools";
import { DISCUSSION_TOOLS } from "./assistant-conversation.js";
import { isProduceToolAllowed } from "./produce-request-header.js";

/** rc.2 的 register 类型只有一个参数；rc.5 用第二参数 when 做步级可见性。 */
type SliceToolActivation = {
  readonly agent?: { readonly id?: string };
};

type RegisterSliceTool = (
  definition: ToolDefinition,
  options?: { readonly when?: (context: SliceToolActivation) => boolean },
) => () => void;

/** 调用方可能是 rc.2（没有 restrict）或 rc.5 的 ToolsService。 */
export type GlobalToolGate = {
  restrict?: (filter: { deny: readonly string[] }) => () => void;
  get?: (name: string) => unknown;
};

export function registerToolWithWhen(
  tools: ToolRuntime,
  definition: ToolDefinition,
  when: (context: SliceToolActivation) => boolean,
): () => void {
  // 必须保留方法调用。拆出来再 call 会让 cordis 的 shadow 对不上，
  // 工具被注册到错误的 scope。rc.2 会忽略第二参数。
  const runtime = tools as ToolRuntime & { register: RegisterSliceTool };
  return runtime.register(definition, { when });
}

export function sliceToolGuard(allowed: ReadonlySet<string>) {
  // A bare "forbidden" leaves the model dead-ended: it retries the same tool or
  // gives up and reports a fake system block. Naming the allowed write
  // surfaces lets it self-correct in the same step.
  const WRITE_SURFACES = [
    "write_page",
    "edit_elements",
    "edit_page_background",
    "delete_pages",
    "reorder_pages",
    "write_todo",
    "update_deck",
  ];
  return (exec: { name: string }): string | undefined => {
    if (exec.name.startsWith("_")) return undefined;
    if (allowed.has(exec.name)) return undefined;
    const alternatives = WRITE_SURFACES.filter((name) => allowed.has(name));
    return `slides preset forbids ${exec.name}${
      alternatives.length ? `; the write tools available this turn: ${alternatives.join(", ")}` : ""
    }`;
  };
}

/**
 * 本步是否把该工具交给模型。讨论模式只认 DISCUSSION_TOOLS；
 * 其余模式先按 produce 规则去掉 web_search，再走 sliceToolGuard 的能力裁剪。
 */
export function isSliceToolStepVisible(name: string, allowed: ReadonlySet<string>): boolean {
  if (allowed === DISCUSSION_TOOLS) return allowed.has(name);
  if (!isProduceToolAllowed(name, allowed)) return false;
  return sliceToolGuard(allowed)({ name }) === undefined;
}

/**
 * rc.5 的全局工具在 system-prompt waterfall 之后才拼进 assembly.tools。
 * `when` 和 produce patch 都看不见这一步，只能对已知全局工具 deny。
 * rc.2 没有 restrict，直接返回空 disposer。
 */
export function restrictGlobalToolsCompat(tools: GlobalToolGate, names: readonly string[]): () => void {
  if (typeof tools.restrict !== "function") return () => undefined;
  const targets = typeof tools.get === "function" ? names.filter((name) => tools.get?.(name) != null) : names;
  if (targets.length === 0) return () => undefined;
  try {
    // 保留方法调用，cordis traceable 才能把 this.ctx 绑回当前 scope。
    return tools.restrict({ deny: targets });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unknown global tool|requires a scoped context/i.test(message)) return () => undefined;
    throw error;
  }
}
