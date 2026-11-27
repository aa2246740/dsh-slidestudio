import { t } from "./i18n.js";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseProviderRoster(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.providers)) {
    throw new Error(t("供应商列表无效"));
  }
  const providers = [];
  const ids = new Set();
  for (const row of data.providers) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const id = text(row.id);
    const models = Array.isArray(row.models)
      ? [
          ...new Set(
            row.models.map((model) => (typeof model === "string" ? model.trim() : text(model?.id))).filter(Boolean),
          ),
        ]
      : [];
    if (!id || ids.has(id) || !models.length) continue;
    ids.add(id);
    providers.push(
      Object.freeze({
        id,
        name: text(row.name) || id,
        ready: row.ready === true,
        models: Object.freeze(models),
      }),
    );
  }
  if (!providers.length) throw new Error(t("没有可用的生成模型"));
  return Object.freeze({
    connection:
      data.connection && typeof data.connection === "object" && !Array.isArray(data.connection)
        ? Object.freeze({ ...data.connection })
        : Object.freeze({}),
    providers: Object.freeze(providers),
  });
}

export function modelOptionValue(provider, model) {
  return `${provider}/${model}`;
}

export function selectedModelFromRoster(roster, value) {
  const raw = text(value);
  const slash = raw.indexOf("/");
  if (slash <= 0) throw new Error(t("请选择供应商和模型"));
  const provider = raw.slice(0, slash);
  const model = raw.slice(slash + 1);
  const row = roster?.providers?.find((item) => item.id === provider && item.models.includes(model));
  if (!row) throw new Error(t("所选模型不在当前供应商列表中"));
  return Object.freeze({ provider, model });
}

export function currentModelFromState(state = {}) {
  const provider = text(state?.execution?.model?.provider || state?.binding?.provider?.providerId);
  const model = text(state?.execution?.model?.model || state?.binding?.provider?.modelId);
  if (!provider || !model || provider === "unknown") return null;
  return Object.freeze({ provider, model });
}

/** Build the exact /turn payload. Does not send editorEdit or page-edit scopes. */
export function buildGenerationTurnRequest({
  instruction,
  resumeGeneration,
  modelSelection,
  expectedAttemptId,
  currentModel,
} = {}) {
  const textValue = text(instruction);
  if (!textValue) throw new Error(t("请填写继续或纠偏说明"));
  const body = { text: textValue };
  if (resumeGeneration === true) body.resumeGeneration = true;
  if (modelSelection) {
    const provider = text(modelSelection.provider);
    const model = text(modelSelection.model);
    if (!provider || !model) throw new Error(t("请选择供应商和模型"));
    const unchanged =
      currentModel &&
      currentModel.provider === provider &&
      currentModel.model === model &&
      !text(modelSelection.reasoningEffort);
    if (!unchanged) {
      body.modelSelection = Object.freeze({
        provider,
        model,
        ...(text(modelSelection.reasoningEffort) ? { reasoningEffort: text(modelSelection.reasoningEffort) } : {}),
      });
    }
  }
  const attempt = text(expectedAttemptId);
  if (attempt) body.expectedAttemptId = attempt;
  return Object.freeze(body);
}

/**
 * @param {{
 *   agentStatus?: string,
 *   execution?: Record<string, any>,
 *   recoveryKind?: string,
 *   hasError?: boolean,
 *   phase?: string | { kind?: string }
 * }} [options]
 */
export function generationComposerMode({ agentStatus, execution, recoveryKind, hasError = false, phase = "" } = {}) {
  const recovery = text(recoveryKind || execution?.recovery?.kind);
  if (agentStatus === "busy" || recovery === "wait-or-stop") return "wait-or-stop";
  if (recovery === "resolve") return "resolve";
  // "continue" also covers a composed deck that only wants a fresh export.
  // That export belongs to the editor's own 导出 button, not to another Agent turn.
  const effectivePhase = text(typeof phase === "object" ? phase?.kind : phase);
  const awaitingUserExport =
    text(execution?.status?.kind) === "ready-to-export" &&
    execution?.fault == null &&
    !hasError &&
    !["paused", "failed"].includes(effectivePhase);
  if (awaitingUserExport) return "hidden";
  if (recovery === "continue") return "continue";
  return "hidden";
}
