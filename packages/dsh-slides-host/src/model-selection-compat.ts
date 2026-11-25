import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection, type ModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { runModelSwitchTransaction } from "./model-switch.js";

/** rc.5 起 Agent 自带的实时模型读写。rc.2 没有这个对象。 */
export type LiveAgentModelLike = {
  current?: () => Readonly<ModelSelection> | undefined;
  select?: (selection: ModelSelection) => void | Promise<void>;
};

/** rc.2 的 ModelSelectionRef，以及仍要同步给工具绑定的可变副本。 */
export type ModelSelectionCompatRef = {
  current: ModelSelection | undefined;
  assembled?: ModelSelection | undefined;
};

export type ModelSelectionInstaller = (agentCtx: Context, ref?: ModelSelectionCompatRef) => () => void;

/**
 * rc.5 的 installModelSelection 只收 agentCtx（length <= 1）。
 * rc.2 还要把可变 ref 传进去，prompt 装配才会跟上切换。
 */
export function installModelSelectionCompat(
  agentCtx: Context,
  ref: ModelSelectionCompatRef,
  installer: ModelSelectionInstaller = installModelSelection as ModelSelectionInstaller,
): () => void {
  if (installer.length <= 1) return installer(agentCtx);
  return installer(agentCtx, ref);
}

/** rc.2 的 Agent 类型没有 model。运行时若补上了，只读取 current/select。 */
export function liveModelOf(agent: object | null | undefined): LiveAgentModelLike | undefined {
  if (!agent || !("model" in agent)) return undefined;
  const model = (agent as { model?: unknown }).model;
  if (!model || typeof model !== "object") return undefined;
  return model as LiveAgentModelLike;
}

export function readLiveModelSelection(
  agent: { model?: LiveAgentModelLike } | undefined,
  fallbackRef?: ModelSelectionCompatRef,
): ModelSelection | undefined {
  if (typeof agent?.model?.current === "function") {
    return agent.model.current() ?? fallbackRef?.current;
  }
  return fallbackRef?.current;
}

export async function applyLiveModelSelection(
  agent: { model?: LiveAgentModelLike } | undefined,
  next: ModelSelection,
  fallbackRef?: ModelSelectionCompatRef,
): Promise<void> {
  if (typeof agent?.model?.select === "function") {
    await agent.model.select(next);
    if (fallbackRef) fallbackRef.current = next;
    return;
  }
  if (fallbackRef) fallbackRef.current = next;
}

export function modelSelectionFor(provider: string, model: string, reasoningEffort?: string): ModelSelection {
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort: ReasoningEffortId(reasoningEffort) } : {}),
  };
}

/**
 * rc.5 用 agent.model.select 切实时模型；rc.2 只有 selection ref。
 * liveSelectionApplied 由调用方持有：只在即将 select 时置真，
 * apply 阶段抛错时 rollback 不再写一条多余的 model/selection。
 */
export async function runGuardedLiveModelSwitch(input: {
  agent: object | null | undefined;
  sessionId: string;
  selection: ModelSelectionCompatRef | undefined;
  next: ModelSelection;
  prior: ModelSelection | undefined;
  markLiveApplied: () => void;
  liveSelectionApplied: () => boolean;
  apply: () => void;
  resume: () => void | Promise<void>;
  rollbackStore: () => void;
}): Promise<void> {
  const live = { model: liveModelOf(input.agent) };
  const canSelectLive = typeof live.model?.select === "function";
  if (input.agent && input.selection === undefined && !canSelectLive) {
    throw new Error(`live session ${input.sessionId} has no mutable model selection`);
  }
  await runModelSwitchTransaction({
    apply: input.apply,
    activate: async () => {
      if (input.agent && (input.selection !== undefined || canSelectLive)) {
        input.markLiveApplied();
        await applyLiveModelSelection(live, input.next, input.selection);
        return;
      }
      await input.resume();
    },
    rollback: () => {
      input.rollbackStore();
      if (!input.liveSelectionApplied()) return;
      return rollbackLiveModelSelection(live, input.prior, input.selection);
    },
  });
}

export async function rollbackLiveModelSelection(
  agent: { model?: LiveAgentModelLike } | undefined,
  prior: ModelSelection | undefined,
  fallbackRef?: ModelSelectionCompatRef,
): Promise<void> {
  if (fallbackRef) fallbackRef.current = prior;
  if (!prior || typeof agent?.model?.select !== "function") return;
  try {
    await agent.model.select(prior);
  } catch {
    // select 回滚失败不能盖住最初的切换错误。
  }
}
