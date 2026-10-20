import { t } from "./i18n.js";
import { unfinishedGenerationReason } from "./generation-reason.js";
import {
  TOOL_TITLES,
  TOOL_VERBS,
  brief,
  failureExplanation,
  objectFrom,
  toolTarget,
} from "./generation-process-details.js";

export { unfinishedGenerationReason } from "./generation-reason.js";
export { PROCESS_STATUS_LABEL, processStatusLabel } from "./generation-process-details.js";

const TERMINAL_FAILURE = new Set(["failed", "needs-attention"]);
const TERMINAL_CANCEL = new Set(["cancelled", "canceled"]);

/**
 * Rows intentionally accumulate optional fields while a tool call moves from
 * running to settled; keeping one row preserves its visible timeline identity.
 * @typedef {{
 *   key: string, kind: string, turn?: number, title: string, detail: string,
 *   at: string, pageId: string, status: string, truncated: boolean,
 *   callId?: string, input?: string, output?: string, sourceIndex?: number,
 *   settled?: boolean, lifecycle?: boolean, parentCanceled?: boolean,
 *   inProcess?: boolean, reviewSubmission?: unknown
 * }} GenerationProcessRow
 */

function text(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function fingerprintText(value) {
  const source = text(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${source.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Return a content fingerprint for persisted model/tool activity.
 * Volatile activity timestamps and the overall busy state are deliberately
 * excluded: only a new event or changed event payload counts as progress.
 */
export function generationActivityProgressSignature(activity) {
  const events = Array.isArray(activity?.events) ? activity.events : [];
  if (!events.length) return "";
  const tail = events.slice(-12);
  return `${events.length}|${tail
    .map((event, index) =>
      [
        text(event?.id) || `event-${events.length - tail.length + index}`,
        text(event?.callId),
        text(event?.kind),
        text(event?.type),
        text(event?.status),
        fingerprintText(event?.detail),
      ].join(":"),
    )
    .join("|")}`;
}

/**
 * Return only the new DSH turns after an editor action started. The full
 * journal remains untouched and can still be shown again once the action ends.
 */
export function generationEventsForTask(events, baselineTurn) {
  const source = Array.isArray(events) ? events : [];
  const floor = Number.isFinite(baselineTurn) ? baselineTurn : -Infinity;
  const turns = source.map((event) => event?.turn).filter((turn) => Number.isFinite(turn) && turn > floor);
  if (!turns.length) return [];
  const firstTurn = Math.min(...turns);
  const start = source.findIndex((event) => event?.turn === firstTurn);
  if (start < 0) return [];
  return source.slice(start).filter((event) => !Number.isFinite(event?.turn) || event.turn > floor);
}

export function humanizeGenerationFault(activity = {}) {
  const code = text(activity?.error?.code);
  const raw = text(activity?.error?.detail || activity?.phaseDetail);
  if (/free tier can only be used from within OpenCode/i.test(raw))
    return t("当前模型的免费通道只能在其官方客户端内使用。请在输入框下方切换到其他已连接的模型，当前对话会保留。");
  if (/Requested model .* not supported/i.test(raw))
    return t("当前供应商已不支持这个模型。请在输入框下方换一个模型，再发送继续要求。");
  if (code === "provider-token-plan" || /2056|Token Plan 用量上限|请升级 Token Plan/i.test(raw)) {
    return t("当前模型的套餐额度已用尽。请换模型或充值后再点继续；自动重试无法恢复额度。");
  }
  if (code === "provider-quota" || /quota|RESOURCE_EXHAUSTED/i.test(raw)) {
    return t("模型额度已用尽。请换模型或充值后再继续。");
  }
  if (code === "provider-rate-limit") return t("模型暂时限流，稍后再继续即可。");
  if (code === "provider-unavailable") return t("模型服务暂时不可用。");
  if (code === "provider-auth") return t("模型登录失效，请重新登录或更换密钥。");
  const stripped = raw.replace(/^provider-[a-z-]+:\s*/i, "").trim();
  const jsonish = stripped.replace(/^429\s*/, "");
  try {
    const parsed = JSON.parse(jsonish);
    const message = parsed?.error?.message || parsed?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    /* keep stripped */
  }
  return stripped.replace(/\{[\s\S]*$/, "").trim() || raw.trim();
}

/** Describe a terminal generation without hiding usable partial output. */
export function generationTerminalPresentation(activity = {}) {
  const phase = text(activity?.phase);
  if (!["paused", "failed", "cancelled", "canceled"].includes(phase)) return null;
  const inspection = activity?.inspection && typeof activity.inspection === "object" ? activity.inspection : {};
  const pages = Array.isArray(inspection.pages) ? inspection.pages : [];
  const pageCount = Math.max(Number(activity?.project?.pageCount) || 0, pages.length);
  const reviewedPageCount = pages.filter((page) => page?.visualReview === "pass").length;
  const missingReferenceCount = Array.isArray(inspection.missingReferenceChunks)
    ? inspection.missingReferenceChunks.length
    : 0;
  const composed = inspection.composed === true;
  const output = pageCount
    ? reviewedPageCount === pageCount
      ? t("已写入并检查 {n} 页", { n: pageCount })
      : t("已写入 {n} 页", { n: pageCount })
    : t("尚未写入页面");
  const finishingBlocked = pageCount > 0 && !composed;
  const faultReason = activity.error ? humanizeGenerationFault(activity) : "";
  const reason =
    faultReason ||
    (finishingBlocked && phase !== "cancelled" && phase !== "canceled"
      ? unfinishedGenerationReason(activity, inspection)
      : "");
  const status =
    phase === "paused"
      ? finishingBlocked
        ? t("已生成 {n} 页，收尾未完成", { n: pageCount })
        : reason
          ? `${t("已暂停")} · ${reason}`
          : t("已暂停，可继续编辑")
      : phase === "failed"
        ? finishingBlocked
          ? t("已保留 {n} 页，收尾失败", { n: pageCount })
          : reason
            ? `${t("未完成")} · ${reason}`
            : t("生成失败")
        : pageCount
          ? t("已取消，保留 {n} 页", { n: pageCount })
          : t("已取消");
  const exits = t("可以直接在编辑器里修改并导出，也可以继续完成生成，或在下方发新的修改要求");
  const action = finishingBlocked
    ? missingReferenceCount
      ? `${t("最终合稿未完成：仍缺 {n} 个参考资料分段", { n: missingReferenceCount })} · ${exits}`
      : `${t("最终合稿未完成")} · ${exits}`
    : phase === "paused"
      ? reason || t("任务已暂停")
      : phase === "failed"
        ? reason || t("生成未完成")
        : t("任务已取消");
  const detail =
    [
      pageCount
        ? reviewedPageCount === pageCount
          ? t("{n} 页已写入并通过页面检查", { n: pageCount })
          : t("{n} 页已写入，其中 {r} 页通过页面检查", { n: pageCount, r: reviewedPageCount })
        : t("尚未写入页面"),
      finishingBlocked
        ? missingReferenceCount
          ? t("最终合稿未完成，仍缺 {n} 个参考资料分段", { n: missingReferenceCount })
          : t("最终合稿未完成")
        : "",
      reason,
    ]
      .filter(Boolean)
      .join(t("；")) + t("。");
  return { status, action, output, detail, reason, pageCount, reviewedPageCount, missingReferenceCount, composed };
}

function generationLedger(snapshot = {}) {
  const inspection = snapshot?.inspection && typeof snapshot.inspection === "object" ? snapshot.inspection : {};
  if (inspection.ledger && typeof inspection.ledger === "object") return inspection.ledger;
  return inspection;
}

/**
 * A composed deck whose only remaining item is "export the current document"
 * is finished work. The user exports it themselves; "继续完成生成" is reserved
 * for a generation that was actually interrupted. A fault on top of that state
 * still means the agent run stopped short and can be resumed.
 */
function generationAwaitingUserExport(execution) {
  return text(execution?.status?.kind) === "ready-to-export" && execution?.fault == null;
}

export function generationResumeCandidate(activity = {}) {
  const phase = text(activity?.phase);
  const execution = activity?.execution;
  if (execution) {
    const statusKind = text(execution.status?.kind);
    if (statusKind === "delivered") return false;
    if (generationAwaitingUserExport(execution)) return false;
    if (execution.recovery?.kind === "continue") return true;
    if (["paused", "failed", "blocked", "ready-to-export"].includes(statusKind)) return true;
    return false;
  }
  const ledger = generationLedger(activity);
  const pages = Array.isArray(ledger.pages) ? ledger.pages : [];
  const pageCount = Math.max(
    Number(activity?.project?.pageCount) || 0,
    Number(activity?.inspection?.pageCount) || 0,
    pages.length,
  );
  if (
    text(activity?.sessionId) &&
    ["paused", "failed", "blocked", "ready-to-export"].includes(phase) &&
    activity?.exportFailed
  ) {
    return true;
  }
  if (text(activity?.sessionId) && ["paused", "failed"].includes(phase) && activity?.allowZeroPage) {
    return true;
  }
  return Boolean(
    text(activity?.sessionId) &&
    ["paused", "failed"].includes(phase) &&
    pageCount > 0 &&
    ledger.composed !== true &&
    activity?.inspection?.composed !== true,
  );
}

export function generationStateCanResume(state = {}, expectedSessionId = "") {
  const sessionId = text(
    state?.execution?.sessionId ||
      state?.inspection?.sessionId ||
      state?.binding?.dshSessionId ||
      state?.binding?.sessionId,
  );
  if (!expectedSessionId || sessionId !== expectedSessionId) return false;
  if (state?.agentStatus !== "idle") return false;

  const execution = state?.execution;
  if (execution) {
    const statusKind = text(execution.status?.kind);
    if (statusKind === "delivered") return false;
    if (generationAwaitingUserExport(execution)) return false;
    if (execution.recovery?.kind === "continue") return true;
    if (["paused", "failed", "blocked", "ready-to-export"].includes(statusKind)) return true;
    return false;
  }

  const phase = text(state?.phase?.kind || state?.phase);
  const ledger = generationLedger(state);
  const pages = Array.isArray(ledger.pages) ? ledger.pages : [];
  const pageCount = Math.max(Number(state?.inspection?.pageCount) || 0, pages.length);

  if (state?.exportFailed || state?.allowZeroPage) {
    return ["paused", "failed", "blocked", "ready-to-export"].includes(phase);
  }

  return Boolean(
    ["paused", "failed"].includes(phase) &&
    pageCount > 0 &&
    ledger.composed !== true &&
    state?.inspection?.composed !== true,
  );
}

export function generationResumeInstruction(state = {}) {
  const execution = state?.execution;
  const ledger = generationLedger(state);
  const pages = Array.isArray(ledger.pages) ? ledger.pages : [];
  const pageCount = pages.length;

  if (
    execution?.status?.kind === "ready-to-export" ||
    (ledger.composed === true && (state?.exportFailed || execution?.status?.kind === "failed"))
  ) {
    return "文稿已完成页面制作与合稿封板，请继续执行导出流程，调用 export_deck 完成最终演示文稿交付；遇到真实阻断时明确报告。";
  }

  if (
    pageCount === 0 &&
    (execution?.plan?.kind === "missing" || execution?.plan?.kind === "legacy-incomplete" || state?.allowZeroPage)
  ) {
    return "继续完成当前演示文稿的生成任务。目前尚未建立完整页面。先调用 inspect_capabilities 确认当前能力。完成页面规划后依次写入页面并执行 render_page；仅在视觉检查可用时执行 review_page，否则执行确定性的排版与 review_pages 检查。完成全套页面后执行 compose_deck 与 export_deck；遇到真实阻断时明确报告。";
  }

  const missing = Array.isArray(ledger.missingReferenceChunks) ? ledger.missingReferenceChunks : [];
  const missingList = missing
    .map((chunk) => {
      const sourceId = text(chunk?.sourceId).trim();
      const chunkIndex = Number(chunk?.chunkIndex);
      return sourceId && Number.isInteger(chunkIndex) && chunkIndex >= 0 ? `${sourceId}#${chunkIndex}` : "";
    })
    .filter(Boolean);
  const referenceStep = missingList.length
    ? `先补读这些缺失的参考资料分段：${missingList.join("、")}。`
    : "先按当前运行账本补齐尚未读取的参考资料分段。";
  return `继续完成当前演示文稿的生成收尾。保留已经持久化的 ${pages.length} 页及其已通过的检查结果，不得删除、重排或为了重做而改写页面。仅允许针对当前权威检查明确点名为失败或需要修订的页面进行必要修复，其他页面保持不变。${referenceStep}随后只补齐账本中尚未完成的审阅、整稿预览与合稿步骤，完成 compose_deck 和 export_deck；遇到真实阻断时明确报告，不得把部分完成表述成全部完成。`;
}

function explicitResultState(event) {
  if (TERMINAL_FAILURE.has(event?.status) || event?.ok === false) return "failed";
  if (TERMINAL_CANCEL.has(event?.status)) return "canceled";
  if (event?.status === "running") return "running";
  const detail = text(event?.detail).trim();
  if (!detail) return event?.callId && event?.status === "complete" ? "success" : "returned";
  if (!detail.startsWith("{") && !detail.startsWith("[")) {
    return event?.callId && event?.status === "complete" ? "success" : "returned";
  }
  if (/^\{\s*"ok"\s*:\s*false\b/.test(detail)) return "failed";
  const value = objectFrom(detail);
  if (!Object.keys(value).length) {
    // A clipped JSON prefix is evidence that a result arrived, not that it succeeded.
    return "returned";
  }
  const outcome = text(value.outcome || value.status).toLowerCase();
  if (value.ok === false || value.success === false || /^(?:reject|rejected|fail|failed|error)$/.test(outcome))
    return "failed";
  if (/^(?:cancel|cancelled|canceled|aborted|interrupted)$/.test(outcome)) return "canceled";
  if (
    value.ok === true ||
    value.success === true ||
    /^(?:ok|success|succeeded|complete|completed|written|committed)$/.test(outcome)
  )
    return "success";
  return event?.callId && event?.status === "complete" ? "success" : "returned";
}

function recoveryKey(row) {
  if (row?.kind !== "tool") return "";
  const name = text(row.title);
  let args = objectFrom(row.input);
  for (
    let index = 0;
    index < 4 && Object.keys(args).length === 1 && args.arguments && typeof args.arguments === "object";
    index += 1
  ) {
    args = args.arguments;
  }
  if (["write_page", "read_page", "render_page", "review_page", "edit_elements"].includes(name)) {
    const pageId = text(args.pageId || args.id);
    return pageId ? `${name}:page:${pageId}` : "";
  }
  if (name === "read_reference") {
    const sourceId = text(args.sourceId);
    const chunkIndex = Number(args.chunkIndex);
    return sourceId && Number.isInteger(chunkIndex) ? `${name}:${sourceId}:${chunkIndex}` : "";
  }
  if (["compose_deck", "review_deck", "render_deck", "finish", "finalize_deck"].includes(name)) {
    return `${name}:deck`;
  }
  return "";
}

function isCanceledBeforeDispatch(row) {
  return row?.kind === "tool" && /tool call aborted before dispatch/i.test(text(row.output));
}

function unfinishedState(context) {
  if (context.active || context.turnActive || context.phase === "disconnected") return "running";
  if (context.error?.code === "operator-stop" || context.phase === "cancelled") return "canceled";
  if (context.phase === "failed" || context.phase === "paused" || context.phase === "complete") return "failed";
  return "canceled";
}

/** @param {Record<string, any>} event @param {number} index @param {string} kind @returns {GenerationProcessRow} */
function baseRow(event, index, kind) {
  return {
    key: text(event.id) || `${kind}:${index}`,
    kind,
    turn: event.turn,
    title: text(event.label) || (kind === "thought" ? t("思考") : t("过程记录")),
    detail: text(event.detail),
    at: text(event.at),
    pageId: text(event.pageId),
    status: kind === "ledger" ? "info" : "returned",
    truncated: event.truncated === true,
  };
}

function coalesceAssistantDeltas(events) {
  const rows = [];
  const positions = new Map();
  for (const event of events) {
    const kind = event?.kind;
    const assistant = kind === "think" || kind === "reasoning" || kind === "message";
    const id = assistant && event?.id ? `${kind === "think" ? "reasoning" : kind}:${event.id}` : "";
    if (!id || !positions.has(id)) {
      if (id) positions.set(id, rows.length);
      rows.push(event);
      continue;
    }
    const index = positions.get(id);
    const previous = rows[index];
    const delta = /(?:chunk|delta)/i.test(String(event.type || ""));
    rows[index] = {
      ...previous,
      ...event,
      detail: delta ? `${text(previous.detail)}${text(event.detail)}` : text(event.detail) || text(previous.detail),
      truncated: event.truncated === true || previous.truncated === true,
    };
  }
  return rows;
}

/** Project persisted generation events into stable cards without inventing pairings. */
export function projectGenerationProcess(events, context = {}) {
  const source = coalesceAssistantDeltas(Array.isArray(events) ? events : []);
  /** @type {GenerationProcessRow[]} */
  const rows = [];
  /** @type {GenerationProcessRow[]} */
  const pending = [];
  /** @type {Map<string, GenerationProcessRow>} */
  const pendingByCallId = new Map();

  for (let index = 0; index < source.length; index += 1) {
    const event = source[index] || {};
    const kind = event.kind || (String(event.type || "").startsWith("tool.") ? "tool" : "ledger");
    if (kind === "user") {
      rows.push({
        ...baseRow(event, index, "user"),
        title: t("你"),
        status: "info",
        reviewSubmission: event.reviewSubmission,
      });
      continue;
    }
    if (kind === "think" || kind === "reasoning" || kind === "message") {
      const row = baseRow(event, index, kind === "message" ? "message" : "thought");
      if (kind === "think") row.title = t("过程说明");
      row.status =
        event.status === "running"
          ? "running"
          : TERMINAL_FAILURE.has(event.status)
            ? "failed"
            : TERMINAL_CANCEL.has(event.status)
              ? "canceled"
              : "info";
      rows.push(row);
      continue;
    }
    if (kind === "tool") {
      const legacySettled = !event.callId && event.type !== "agent.tool" && event.status !== "running";
      const row = {
        ...baseRow(event, index, "tool"),
        key: event.callId ? `tool:${event.callId}` : text(event.id) || `tool:${index}`,
        title: text(event.name) || text(event.label).replace(/^调用\s*/, "") || t("工具调用"),
        input: text(event.detail),
        output: "",
        callId: text(event.callId),
        status: legacySettled ? explicitResultState(event) : "running",
        sourceIndex: index,
        settled: legacySettled,
      };
      rows.push(row);
      if (!legacySettled) {
        pending.push(row);
        if (row.callId) pendingByCallId.set(row.callId, row);
      }
      continue;
    }
    if (kind === "result") {
      const resultCallId = text(event.callId);
      let match = resultCallId ? pendingByCallId.get(resultCallId) : undefined;
      if (!resultCallId) {
        const legacyPending = pending.filter((row) => !row.settled && !row.callId);
        if (event.name) {
          const named = legacyPending.filter((row) => row.title === event.name);
          if (named.length === 1) match = named[0];
        }
        if (!match) {
          const previous = legacyPending.find((row) => row.sourceIndex === index - 1);
          if (legacyPending.length === 1 && previous) match = previous;
        }
      }
      if (match) {
        match.output = text(event.detail);
        match.status = explicitResultState(event);
        match.truncated = match.truncated || event.truncated === true;
        match.settled = true;
        if (match.callId) pendingByCallId.delete(match.callId);
      } else {
        const row = baseRow(event, index, "tool");
        row.title = text(event.name) || t("工具结果");
        row.input = "";
        row.output = text(event.detail);
        row.status = explicitResultState(event);
        row.settled = true;
        rows.push(row);
      }
      continue;
    }
    const row = baseRow(event, index, "ledger");
    row.lifecycle = kind === "turn";
    row.status = TERMINAL_FAILURE.has(event.status)
      ? "failed"
      : TERMINAL_CANCEL.has(event.status)
        ? "canceled"
        : "info";
    rows.push(row);
  }

  for (const row of pending) {
    if (!row.settled) row.status = unfinishedState(context);
    delete row.sourceIndex;
    delete row.settled;
  }
  for (const row of rows) {
    if (isCanceledBeforeDispatch(row)) {
      row.status = "canceled";
      row.parentCanceled = true;
    }
  }
  const recoveredKeys = new Set();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const key = recoveryKey(row);
    if (!key) continue;
    if (row.status === "success") recoveredKeys.add(key);
    else if (row.status === "failed" && recoveredKeys.has(key)) row.status = "recovered";
  }
  const last = rows.at(-1);
  if (context.active && last && (last.kind === "thought" || last.kind === "message") && last.status === "info") {
    last.status = "running";
  }
  // Narration leading into tools belongs to the optional process log. Keep each
  // turn's actual answer visible, even when later user turns run more tools.
  let laterTool = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === "user") laterTool = false;
    else if (row.kind === "tool") laterTool = true;
    else if (row.kind === "message" && laterTool) row.inProcess = true;
  }
  return rows.filter((row) => !row.lifecycle).map(describeProcessRow);
}

function describeProcessRow(row) {
  if (row.kind !== "tool") return row;
  const input = objectFrom(row.input);
  let args = input;
  for (let i = 0; i < 4 && Object.keys(args).length === 1 && args.arguments && typeof args.arguments === "object"; i++)
    args = args.arguments;
  const result = objectFrom(row.output);
  const payload = result.payload && typeof result.payload === "object" ? result.payload : {};
  const countSummary = row.output.match(/\"summary\"\s*:\s*\"(\d+) sources · (\d+) visuals\"/);
  const name = row.title;
  const facts = [];
  const add = (label, value) => {
    if (typeof value === "string" && value.trim()) facts.push({ label, value: brief(value, 120) });
  };
  add(t("页面"), args.title || args.pageId || row.pageId);
  add(t("搜索内容"), args.query);
  if (args.sourceId) add(t("资料"), String(args.sourceId).split("/").slice(-2).join("/"));
  add(t("设计参考"), args.designSystemId);
  if (Array.isArray(args.slidePlan)) add(t("页面安排"), t(`{p0} 页`, { p0: args.slidePlan.length }));
  if (Array.isArray(args.items)) add(t("制作任务"), t(`{p0} 项`, { p0: args.items.length }));
  if (name === "generate_image") add(t("图片描述"), args.prompt);
  if (name === "write_page" && Array.isArray(args.elements)) add("页面内容", `${args.elements.length} 个元素`);
  if (name === "edit_elements" && Array.isArray(args.elements)) add("所选对象", `${args.elements.length} 个`);
  if (countSummary && !Number.isFinite(payload.sourceFiles))
    add("找到资料", `${countSummary[1]} 份资料，${countSummary[2]} 份视觉参考`);
  if (Number.isFinite(payload.sourceFiles))
    add(
      "找到资料",
      `${payload.sourceFiles} 份资料${Number.isFinite(payload.visualFiles) ? `，${payload.visualFiles} 份视觉参考` : ""}`,
    );
  let summary =
    row.status === "running"
      ? "正在执行，结果返回后会更新。"
      : row.status === "canceled"
        ? row.parentCanceled
          ? "这次调用尚未执行，所在任务已中止。"
          : "这次操作已停止。"
        : row.status === "recovered"
          ? `${failureExplanation(row.output, name).replace(/。$/, "")}；后续重试已成功。`
          : row.status === "failed"
            ? failureExplanation(row.output, name)
            : row.status === "returned"
              ? "已收到结果，尚未确认是否完成。"
              : "这一步已完成。";
  if (row.status === "success") {
    const summaries = {
      inspect_capabilities: "已检查本次任务可以使用的能力。",
      list_references: "参考资料目录已读取。",
      read_reference: "已读取这份资料，供后续制作使用。",
      view_design_reference: "设计参考已打开。",
      commit_design: "设计与页面安排已保存。",
      write_todo: "页面制作任务已记录。",
      open_project: "演示文稿已准备好。",
      write_page: "页面内容已写入，等待后续检查。",
      edit_elements: Array.isArray(args.elements)
        ? `${args.elements.length} 个所选对象已更新，等待后续检查。`
        : "所选对象已更新，等待后续检查。",
      render_page: "页面预览已生成。",
      generate_image: "配图已生成，可用于页面排版。",
      review_page: "页面检查已返回，结论见下方。",
      export_deck: "导出操作已完成。",
    };
    summary = summaries[name] || summary;
    if (name === "review_page") {
      const decision = payload.verdict || payload.status || result.verdict;
      if (["pass", "passed"].includes(decision)) summary = "本次页面检查通过。";
      else if (["fail", "failed", "needs-revision"].includes(decision)) summary = "页面检查发现需要修改的地方。";
      else summary = "已收到页面检查结果。";
    }
    const human = [result.summary, result.detail].find(
      (x) => typeof x === "string" && /[\u4e00-\u9fff]/.test(x) && !/[{}]/.test(x),
    );
    if (human) add("结果", human);
  }
  return {
    ...row,
    displayTitle: TOOL_TITLES[name] || "执行扩展操作",
    technicalName: name,
    verb: TOOL_VERBS[name] || "Tool",
    target: toolTarget(name, args, row),
    summary,
    facts,
  };
}
