import { t } from "./i18n.js";

const TERMINAL_FAILURE = new Set(["failed", "needs-attention"]);
const TERMINAL_CANCEL = new Set(["cancelled", "canceled"]);

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
  return `${events.length}|${tail.map((event, index) => [
    text(event?.id) || `event-${events.length - tail.length + index}`,
    text(event?.callId),
    text(event?.kind),
    text(event?.type),
    text(event?.status),
    fingerprintText(event?.detail),
  ].join(":")).join("|")}`;
}

/**
 * Return only the new DSH turns after an editor action started. The full
 * journal remains untouched and can still be shown again once the action ends.
 */
export function generationEventsForTask(events, baselineTurn) {
  const source = Array.isArray(events) ? events : [];
  const floor = Number.isFinite(baselineTurn) ? baselineTurn : -Infinity;
  const turns = source
    .map((event) => event?.turn)
    .filter((turn) => Number.isFinite(turn) && turn > floor);
  if (!turns.length) return [];
  const firstTurn = Math.min(...turns);
  const start = source.findIndex((event) => event?.turn === firstTurn);
  if (start < 0) return [];
  return source.slice(start).filter((event) => !Number.isFinite(event?.turn) || event.turn > floor);
}

export function humanizeGenerationFault(activity = {}) {
  const code = text(activity?.error?.code);
  const raw = text(activity?.error?.detail || activity?.phaseDetail);
  if (/free tier can only be used from within OpenCode/i.test(raw)) return t("当前模型的免费通道只能在其官方客户端内使用。请在输入框下方切换到其他已连接的模型，当前对话会保留。");
  if (/Requested model .* not supported/i.test(raw)) return t("当前供应商已不支持这个模型。请在输入框下方换一个模型，再发送继续要求。");
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

function unfinishedGenerationReason(activity, inspection) {
  const blockers = Array.isArray(activity?.execution?.blockers) ? activity.execution.blockers : [];
  const messages = [];
  const pageCountFor = (code) => new Set(blockers.filter((row) => row.code === code).flatMap((row) => row.pageIds || [])).size;
  for (const code of new Set(blockers.map((row) => row.code))) {
    const n = pageCountFor(code);
    const message = {
      missing_plan: t("页面规划尚未完成"),
      legacy_incomplete_plan: t("页面规划需要补全"),
      missing_pages: t("还有 {n} 页尚未写入", { n }),
      extra_pages: t("页面与当前规划不一致，需要核对"),
      page_render_needed: t("有 {n} 页尚未完成截图与排版检查", { n }),
      page_image_needed: t("有 {n} 页的截图尚未送达当前模型", { n }),
      page_visual_review_needed: t("有 {n} 页尚未完成视觉检查", { n }),
      page_needs_revision: t("有 {n} 页未通过检查，需要修订", { n }),
      structural_review_needed: t("整稿结构检查尚未通过"),
      compose_needed: t("页面检查已通过，尚未完成合稿"),
      export_needed: t("文稿已合稿，尚未完成导出"),
      missing_references: t("必需参考资料尚未读完"),
      project_unreadable: t("项目暂时无法读取，请检查文件是否可访问"),
      identity_collision: t("项目中存在重复页面标识，需要修复后继续"),
      activity_unknown: t("暂时无法确认生成会话状态，请等待连接恢复"),
    }[code];
    if (message) messages.push(message);
  }
  if (!messages.length && Array.isArray(inspection.composeBlockers)) {
    if (inspection.composeBlockers.some((value) => /rendered layout/i.test(text(value)))) {
      messages.push(t("页面截图或排版检查尚未通过"));
    } else if (inspection.composeBlockers.some((value) => /visual review|image content/i.test(text(value)))) {
      messages.push(t("页面截图尚未送达模型，或视觉检查尚未完成"));
    }
  }
  return messages.length ? messages.join(t("；")) : t("模型已结束本轮回复，但尚未完成整稿检查与合稿");
}

/** Describe a terminal generation without hiding usable partial output. */
export function generationTerminalPresentation(activity = {}) {
  const phase = text(activity?.phase);
  if (!["paused", "failed", "cancelled", "canceled"].includes(phase)) return null;
  const inspection = activity?.inspection && typeof activity.inspection === "object"
    ? activity.inspection
    : {};
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
  const reason = faultReason || (finishingBlocked && phase !== "cancelled" && phase !== "canceled"
    ? unfinishedGenerationReason(activity, inspection)
    : "");
  const status = phase === "paused"
    ? finishingBlocked
      ? t("已生成 {n} 页，收尾未完成", { n: pageCount })
      : (reason ? `${t("已暂停")} · ${reason}` : t("已暂停，可继续编辑"))
    : phase === "failed"
      ? finishingBlocked
        ? t("已保留 {n} 页，收尾失败", { n: pageCount })
        : (reason ? `${t("未完成")} · ${reason}` : t("生成失败"))
      : pageCount ? t("已取消，保留 {n} 页", { n: pageCount }) : t("已取消");
  const exits = t("可以直接在编辑器里修改并导出，也可以继续完成生成，或在下方发新的修改要求");
  const action = finishingBlocked
    ? missingReferenceCount
      ? `${t("最终合稿未完成：仍缺 {n} 个参考资料分段", { n: missingReferenceCount })} · ${exits}`
      : `${t("最终合稿未完成")} · ${exits}`
    : phase === "paused"
      ? (reason || t("任务已暂停"))
      : phase === "failed"
        ? (reason || t("生成未完成"))
        : t("任务已取消");
  const detail = [
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
  ].filter(Boolean).join(t("；")) + t("。");
  return { status, action, output, detail, reason, pageCount, reviewedPageCount, missingReferenceCount, composed };
}

function generationLedger(snapshot = {}) {
  const inspection = snapshot?.inspection && typeof snapshot.inspection === "object"
    ? snapshot.inspection
    : {};
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
  const pageCount = Math.max(Number(activity?.project?.pageCount) || 0, Number(activity?.inspection?.pageCount) || 0, pages.length);
  if (text(activity?.sessionId) && ["paused", "failed", "blocked", "ready-to-export"].includes(phase) && activity?.exportFailed) {
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
    activity?.inspection?.composed !== true
  );
}

export function generationStateCanResume(state = {}, expectedSessionId = "") {
  const sessionId = text(
    state?.execution?.sessionId ||
    state?.inspection?.sessionId ||
    state?.binding?.dshSessionId ||
    state?.binding?.sessionId
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
    state?.inspection?.composed !== true
  );
}

export function generationResumeInstruction(state = {}) {
  const execution = state?.execution;
  const ledger = generationLedger(state);
  const pages = Array.isArray(ledger.pages) ? ledger.pages : [];
  const pageCount = pages.length;

  if (execution?.status?.kind === "ready-to-export" || (ledger.composed === true && (state?.exportFailed || execution?.status?.kind === "failed"))) {
    return "文稿已完成页面制作与合稿封板，请继续执行导出流程，调用 export_deck 完成最终演示文稿交付；遇到真实阻断时明确报告。";
  }

  if (pageCount === 0 && (execution?.plan?.kind === "missing" || execution?.plan?.kind === "legacy-incomplete" || state?.allowZeroPage)) {
    return "继续完成当前演示文稿的生成任务。目前尚未建立完整页面。先调用 inspect_capabilities 确认当前能力。完成页面规划后依次写入页面并执行 render_page；仅在视觉检查可用时执行 review_page，否则执行确定性的排版与 review_pages 检查。完成全套页面后执行 compose_deck 与 export_deck；遇到真实阻断时明确报告。";
  }

  const missing = Array.isArray(ledger.missingReferenceChunks) ? ledger.missingReferenceChunks : [];
  const missingList = missing
    .map((chunk) => {
      const sourceId = text(chunk?.sourceId).trim();
      const chunkIndex = Number(chunk?.chunkIndex);
      return sourceId && Number.isInteger(chunkIndex) && chunkIndex >= 0
        ? `${sourceId}#${chunkIndex}`
        : "";
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
  if (value.ok === false || value.success === false || /^(?:reject|rejected|fail|failed|error)$/.test(outcome)) return "failed";
  if (/^(?:cancel|cancelled|canceled|aborted|interrupted)$/.test(outcome)) return "canceled";
  if (value.ok === true || value.success === true || /^(?:ok|success|succeeded|complete|completed|written|committed)$/.test(outcome)) return "success";
  return event?.callId && event?.status === "complete" ? "success" : "returned";
}

function recoveryKey(row) {
  if (row?.kind !== "tool") return "";
  const name = text(row.title);
  let args = objectFrom(row.input);
  for (let index = 0; index < 4 && Object.keys(args).length === 1 && args.arguments && typeof args.arguments === "object"; index += 1) {
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
  const rows = [];
  const pending = [];
  const pendingByCallId = new Map();

  for (let index = 0; index < source.length; index += 1) {
    const event = source[index] || {};
    const kind = event.kind || (String(event.type || "").startsWith("tool.") ? "tool" : "ledger");
    if (kind === "user") { rows.push({ ...baseRow(event, index, "user"), title: t("你"), status: "info", reviewSubmission: event.reviewSubmission }); continue; }
    if (kind === "think" || kind === "reasoning" || kind === "message") {
      const row = baseRow(event, index, kind === "message" ? "message" : "thought");
      if (kind === "think") row.title = t("过程说明");
      row.status = event.status === "running" ? "running" : TERMINAL_FAILURE.has(event.status) ? "failed" : TERMINAL_CANCEL.has(event.status) ? "canceled" : "info";
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
    row.status = TERMINAL_FAILURE.has(event.status) ? "failed" : TERMINAL_CANCEL.has(event.status) ? "canceled" : "info";
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

export const PROCESS_STATUS_LABEL = Object.freeze({
  running: t("运行中"),
  success: t("成功"),
  failed: t("失败"),
  recovered: t("已恢复"),
  canceled: t("已取消"),
  returned: t("结果已返回"),
  info: t("已记录"),
});

/** Translate a status key for display; the frozen map stays as source keys. */
export function processStatusLabel(status) {
  return t(PROCESS_STATUS_LABEL[status] || status || "");
}

const TOOL_VERBS = {
  open_project: "Read", inspect_capabilities: "Inspect",
  list_references: "Search", read_reference: "Read",
  view_design_reference: "Read", commit_design: "Write",
  write_todo: "Write", read_page: "Read", write_page: "Write", edit_elements: "Edit",
  render_page: "Read", review_page: "Read",
  search_image: "Search", generate_image: "Write", web_search: "Search",
  review_pages: "Read", render_deck: "Read", review_deck: "Read", compose_deck: "Write",
  export_deck: "Write", finish: "Write", finalize_deck: "Write",
};

function toolTarget(name, args, row) {
  if (args.sourceId) {
    const source = String(args.sourceId).replace(/^openkimi:/, "");
    return Number.isInteger(Number(args.chunkIndex)) ? `${source} #${args.chunkIndex}` : source;
  }
  if (args.pageId || (name === "write_page" && args.id)) return String(args.pageId || args.id);
  if (args.query) return String(args.query);
  if (args.designSystemId) return String(args.designSystemId);
  if (name === "inspect_capabilities") return "capabilities";
  if (name === "list_references") return "references";
  if (name === "write_todo") return "todo";
  if (name === "compose_deck") return "deck";
  if (name === "export_deck") return "export";
  if (row.pageId) return String(row.pageId);
  return name;
}

const TOOL_TITLES = {
  open_project: t('准备演示文稿'), inspect_capabilities: t('检查可用能力'),
  list_references: t('查找参考资料'), read_reference: t('阅读参考资料'),
  view_design_reference: t('查看设计参考'), commit_design: t('确定设计与页面安排'),
  write_todo: t('安排页面制作任务'), read_page: t('读取页面'), write_page: t('撰写页面'), edit_elements: t('修改所选对象'),
  render_page: t('生成页面预览'), review_page: t('检查页面效果'),
  search_image: t('寻找配图'), generate_image: t('生成配图'), web_search: t('检索资料'),
  review_pages: t('检查页面结构'), render_deck: t('生成整稿预览'), review_deck: t('检查整份演示文稿'), compose_deck: t('确认最终稿'),
  export_deck: t('导出演示文稿'), finish: t('完成制作'), finalize_deck: t('完成制作'),
};
const FIELD_NAMES = {items:t('任务列表'),slidePlan:t('页面安排'),id:t('页面或图片编号'),pageId:t('页面编号'),prompt:t('图片描述'),sourceId:t('资料来源'),chunkIndex:t('资料分段'),elements:t('页面内容'),query:t('搜索词')};
function objectFrom(value) {
  const raw = typeof value === 'string' ? value.trim() : value;
  const candidates = typeof raw === 'string'
    ? [raw, raw.replace(/\s*\[image content omitted\]\s*$/i, '')]
    : [raw];
  for (const candidate of candidates) {
    try {
      const parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}
function brief(value, limit = 160) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, limit) : '';
}
function failureExplanation(output, name) {
  const value = objectFrom(output);
  const raw = [value.summary, value.detail, value.payload?.error, output].filter(x=>typeof x==='string').join('\n');
  const missing = [...raw.matchAll(/missing required property ["']([^"']+)["']/g)].map(x=>(x[1]==='id' && name==='write_page' ? t('页面编号') : x[1]==='id' && name==='generate_image' ? t('图片编号') : FIELD_NAMES[x[1]]) || x[1]);
  if (missing.length) return t(`这次调用未执行：缺少{p0}。`, { p0: [...new Set(missing)].join('、') });
  if (/taste execution gate is not enabled/.test(raw)) return t('本次任务未启用设计参考预览，无法打开这张参考图。');
  if (/unknown OpenKimi source id/.test(raw)) return t('没有找到指定的参考资料。');
  if (/deck overview was not emitted/i.test(raw)) return t('整稿检查尚未执行：缺少整稿预览。');
  const unread = raw.match(/compose gate failed:\s*(\d+) required source chunks unread/i);
  if (unread) return t(`最终合稿尚未完成：仍有 {p0} 个参考资料分段未读取。`, { p0: unread[1] });
  if (/page image was not emitted/i.test(raw)) return t('页面检查尚未执行：缺少该页预览。');
  if (/footer_zone|\boverlap\b/i.test(raw)) return t('页面内容未写入：检测到布局冲突。');
  if (/tool call aborted before dispatch/i.test(raw)) return t('工具调用在派发前中止。');
  if (/unauthorized|authentication|invalid.api.key|\b401\b/i.test(raw)) return t('服务未通过身份验证，这次调用失败。');
  if (/rate.limit|\b429\b/i.test(raw)) return t('服务请求过于频繁，这次调用未完成。');
  if (/timeout|timed out/i.test(raw)) return t('等待服务响应超时，这次调用未完成。');
  const chinese = [value.summary, value.detail].find(x=>typeof x==='string' && /[\u4e00-\u9fff]/.test(x));
  return chinese ? brief(chinese) : t('这次操作没有完成，具体错误保留在技术详情中。');
}
function describeProcessRow(row) {
  if (row.kind !== 'tool') return row;
  const input = objectFrom(row.input);
  let args = input;
  for (let i=0;i<4 && Object.keys(args).length===1 && args.arguments && typeof args.arguments==='object';i++) args=args.arguments;
  const result = objectFrom(row.output);
  const payload = result.payload && typeof result.payload==='object' ? result.payload : {};
  const countSummary = row.output.match(/\"summary\"\s*:\s*\"(\d+) sources · (\d+) visuals\"/);
  const name = row.title;
  const facts = [];
  const add = (label,value) => { if (typeof value==='string' && value.trim()) facts.push({label,value:brief(value,120)}); };
  add(t('页面'), args.title || args.pageId || row.pageId);
  add(t('搜索内容'), args.query);
  if (args.sourceId) add(t('资料'), String(args.sourceId).split('/').slice(-2).join('/'));
  add(t('设计参考'), args.designSystemId);
  if (Array.isArray(args.slidePlan)) add(t('页面安排'), t(`{p0} 页`, { p0: args.slidePlan.length }));
  if (Array.isArray(args.items)) add(t('制作任务'), t(`{p0} 项`, { p0: args.items.length }));
  if (name==='generate_image') add(t('图片描述'), args.prompt);
  if (name==='write_page' && Array.isArray(args.elements)) add('页面内容', `${args.elements.length} 个元素`);
  if (name==='edit_elements' && Array.isArray(args.elements)) add('所选对象', `${args.elements.length} 个`);
  if (countSummary && !Number.isFinite(payload.sourceFiles)) add('找到资料', `${countSummary[1]} 份资料，${countSummary[2]} 份视觉参考`);
  if (Number.isFinite(payload.sourceFiles)) add('找到资料', `${payload.sourceFiles} 份资料${Number.isFinite(payload.visualFiles) ? `，${payload.visualFiles} 份视觉参考` : ''}`);
  let summary = row.status==='running'
    ? '正在执行，结果返回后会更新。'
    : row.status==='canceled'
      ? row.parentCanceled
        ? '这次调用尚未执行，所在任务已中止。'
        : '这次操作已停止。'
      : row.status==='recovered'
        ? `${failureExplanation(row.output, name).replace(/。$/, '')}；后续重试已成功。`
        : row.status==='failed'
          ? failureExplanation(row.output, name)
          : row.status==='returned'
            ? '已收到结果，尚未确认是否完成。'
            : '这一步已完成。';
  if (row.status==='success') {
    const summaries={inspect_capabilities:'已检查本次任务可以使用的能力。',list_references:'参考资料目录已读取。',read_reference:'已读取这份资料，供后续制作使用。',view_design_reference:'设计参考已打开。',commit_design:'设计与页面安排已保存。',write_todo:'页面制作任务已记录。',open_project:'演示文稿已准备好。',write_page:'页面内容已写入，等待后续检查。',edit_elements:Array.isArray(args.elements) ? `${args.elements.length} 个所选对象已更新，等待后续检查。` : '所选对象已更新，等待后续检查。',render_page:'页面预览已生成。',generate_image:'配图已生成，可用于页面排版。',review_page:'页面检查已返回，结论见下方。',export_deck:'导出操作已完成。'};
    summary = summaries[name] || summary;
    if (name==='review_page') {
      const decision = payload.verdict || payload.status || result.verdict;
      if (['pass','passed'].includes(decision)) summary='本次页面检查通过。';
      else if (['fail','failed','needs-revision'].includes(decision)) summary='页面检查发现需要修改的地方。';
      else summary='已收到页面检查结果。';
    }
    const human = [result.summary, result.detail].find(x=>typeof x==='string' && /[\u4e00-\u9fff]/.test(x) && !/[{}]/.test(x));
    if (human) add('结果',human);
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
