import { t } from "./i18n.js";

const PILL_PHASES = new Set(["complete", "discussion", "edited"]);
const CARD_PHASES = new Set(["paused", "failed", "cancelled", "canceled"]);
const RESOLVE_FAULT_CODES = new Set([
  "provider-auth",
  "provider-quota",
  "provider-token-plan",
  "context-window-too-small",
]);

/** @param {unknown} value */
function text(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** @param {unknown} value */
function normalizeSentence(value) {
  return text(value)
    .trim()
    .replace(/[。！？.!?；;]+$/g, "")
    .trim();
}

const FAULT_RULES = [
  {
    match: /** @param {string} _code @param {string} raw */ (_code, raw) =>
      /free tier can only be used from within OpenCode/i.test(raw),
    message: () =>
      t("当前模型的免费通道只能在其官方客户端内使用。请在输入框下方切换到其他已连接的模型，当前对话会保留。"),
  },
  {
    match: /** @param {string} _code @param {string} raw */ (_code, raw) =>
      /Requested model .* not supported/i.test(raw),
    message: () => t("当前供应商已不支持这个模型。请在输入框下方换一个模型，再发送继续要求。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "operator-stop" || /operator stopped/i.test(raw),
    message: () => t("你已手动停止本轮任务。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "host-interrupted" || /host[_\s-]?interrupted/i.test(raw),
    message: () => t("后台服务意外中断，任务已自动暂停。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "turn-max-tokens" || /turn reached the output limit/i.test(raw),
    message: () => t("模型单轮输出达到长度上限，任务已自动暂停。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "context-window-too-small" || /CONTEXT_WINDOW_TOO_SMALL/i.test(raw),
    message: () => t("当前模型的上下文窗口不足以容纳完整演示文稿生成，请切换到至少 64k 上下文窗口的模型后再继续。"),
  },
  {
    match: /** @param {string} code */ (code) => code === "repeated-invalid-args" || code === "tool-invalid-args-loop",
    message: () => t("模型连续返回无效的工具参数，任务已自动暂停。"),
  },
  {
    match: /** @param {string} code */ (code) => code === "repeated-business-rejection",
    message: () => t("连续多次写入未通过校验，任务已自动暂停。"),
  },
  {
    match: /** @param {string} code */ (code) => code === "planning-no-progress-budget",
    message: () => t("规划阶段长时间未推进，任务已自动暂停。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "production-no-progress-budget" && !/[\u4e00-\u9fff]/.test(raw),
    message: () => t("制作阶段长时间未产生新页面修订，任务已自动暂停。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "provider-token-plan" || /2056|Token Plan 用量上限|请升级 Token Plan/i.test(raw),
    message: () => t("当前模型的套餐额度已用尽。请换模型或充值后再点继续；自动重试无法恢复额度。"),
  },
  {
    match: /** @param {string} code */ (code) => code === "provider-quota",
    message: () => t("模型额度已用尽。请换模型或充值后再继续。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "provider-auth" ||
      /\b(?:401|403)\b|invalid[_\s-]?api[_\s-]?key|unauthorized|forbidden|authentication\s+failed/i.test(raw),
    message: () => t("模型登录失效，请重新登录或更换密钥。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "provider-rate-limit" || /\b429\b|rate[_\s-]?limit|too many requests/i.test(raw),
    message: () => t("模型暂时限流，稍后再继续即可。"),
  },
  {
    match: /** @param {string} _code @param {string} raw */ (_code, raw) => /quota|RESOURCE_EXHAUSTED/i.test(raw),
    message: () => t("模型额度已用尽。请换模型或充值后再继续。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "provider-timeout" ||
      /timeout|timed out|ECONNREFUSED|ECONNRESET|ENOTFOUND|network|fetch failed/i.test(raw),
    message: () => t("模型服务连接超时或网络不可达，请稍后重试或切换模型。"),
  },
  {
    match: /** @param {string} _code @param {string} raw */ (_code, raw) =>
      /context[_\s-]?length|maximum context|too many tokens/i.test(raw),
    message: () => t("上下文内容超出当前模型长度限制，请切换更大上下文的模型或精简指令后继续。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "provider-unavailable" ||
      /\b5(?:0[0234]|2[0-9])\b|internal server error|bad gateway|service unavailable|overloaded/i.test(raw),
    message: () => t("模型服务暂时不可用，请稍后重试或切换模型。"),
  },
  {
    match: /** @param {string} code @param {string} raw */ (code, raw) =>
      code === "provider-bad-request" ||
      /\b(?:400|404)\b|bad request|model[_\s-]?not[_\s-]?found|model .* does not exist/i.test(raw),
    message: () => t("当前模型拒绝了本次请求，请检查模型配置或切换其他模型后重试。"),
  },
];

/** @param {Record<string, any>} [activity] */
export function humanizeGenerationFault(activity = {}) {
  const code = text(activity?.error?.code);
  const raw = text(activity?.error?.detail || activity?.phaseDetail);
  for (const rule of FAULT_RULES) {
    if (rule.match(code, raw)) return rule.message();
  }
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

/**
 * @param {{phase?: string, connectionState?: string, execution?: {blockers?: Array<{code?: string, pageIds?: string[]}>}}} activity
 * @param {{composeBlockers?: unknown[]}} inspection
 */
export function unfinishedGenerationReason(activity, inspection) {
  const rawBlockers = Array.isArray(activity?.execution?.blockers) ? activity.execution.blockers : [];
  const hasConcreteBlocker = rawBlockers.some((row) => row?.code && row.code !== "activity_unknown");
  const suppressUnknown =
    hasConcreteBlocker ||
    (activity?.connectionState !== "disconnected" && ["paused", "failed"].includes(text(activity?.phase)));
  const blockers = suppressUnknown ? rawBlockers.filter((row) => row?.code !== "activity_unknown") : rawBlockers;
  const messages = [];
  const pageCountFor = /** @param {string | undefined} code */ (code) =>
    new Set(blockers.filter((row) => row.code === code).flatMap((row) => row.pageIds || [])).size;
  for (const code of new Set(blockers.map((row) => row.code))) {
    const n = pageCountFor(code);
    const messageByCode = /** @type {Record<string, string>} */ ({
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
    });
    const message = messageByCode[String(code)];
    if (message) messages.push(message);
  }
  if (!messages.length && Array.isArray(inspection?.composeBlockers)) {
    if (inspection.composeBlockers.some((value) => /rendered layout/i.test(text(value)))) {
      messages.push(t("页面截图或排版检查尚未通过"));
    } else if (inspection.composeBlockers.some((value) => /visual review|image content/i.test(text(value)))) {
      messages.push(t("页面截图尚未送达模型，或视觉检查尚未完成"));
    }
  }
  return messages.length ? messages.join(t("；")) : t("模型已结束本轮回复，但尚未完成整稿检查与合稿");
}

/** @param {Record<string, any>} activity @param {number} now */
function activeRateLimitWait(activity, now) {
  const wait = activity?.rateLimitWait || activity?.inspection?.rateLimitWait || activity?.execution?.rateLimitWait;
  if (!wait || typeof wait !== "object") return null;
  const nextRetryAt = Number(wait.nextRetryAt);
  if (!Number.isFinite(nextRetryAt) || nextRetryAt <= now) return null;
  return {
    attempt: Number.isFinite(Number(wait.attempt)) ? Number(wait.attempt) : 0,
    waitMs: Number.isFinite(Number(wait.waitMs)) ? Number(wait.waitMs) : Math.max(0, nextRetryAt - now),
    nextRetryAt,
    code: text(wait.code) || "provider-rate-limit",
  };
}

/** @param {string} effectivePhase @param {number} count @param {string} duration */
function buildPillModel(effectivePhase, count, duration) {
  const title =
    effectivePhase === "complete"
      ? count
        ? t("已完成 · {p0} 页{p1}", { p0: count, p1: duration })
        : t("已完成{p0}", { p0: duration })
      : effectivePhase === "edited"
        ? t("本轮修改已完成，可以继续讨论或调整")
        : t("可以继续提问，也可以让我修改文稿");
  const statusText =
    effectivePhase === "complete" ? t("已完成") : effectivePhase === "edited" ? t("已修改") : t("继续聊聊");
  return {
    variant: "pill",
    tone: effectivePhase === "complete" ? "success" : "info",
    badge: "",
    title,
    summary: "",
    hint: "",
    rawDetail: "",
    recoveryKind: "none",
    rateLimitWait: null,
    statusText,
  };
}

/** @param {string} effectivePhase @param {string} faultCode @param {boolean} isWait @param {boolean} isNonGenerateCard @param {boolean} isCancelled */
function cardTone(effectivePhase, faultCode, isWait, isNonGenerateCard, isCancelled) {
  if (isWait) return "wait";
  if (isNonGenerateCard) return isCancelled ? "info" : effectivePhase === "paused" ? "warning" : "error";
  if (effectivePhase === "failed" || RESOLVE_FAULT_CODES.has(faultCode)) return "error";
  if (effectivePhase === "paused") return "warning";
  return "info";
}

/** @param {string} effectivePhase @param {string} recoveryKind @param {boolean} isWait @param {boolean} isCancelled @param {boolean} isNonGenerateCard */
function cardBadge(effectivePhase, recoveryKind, isWait, isCancelled, isNonGenerateCard) {
  if (isWait) return t("自动重试中");
  if (isNonGenerateCard) return isCancelled ? t("已停止") : effectivePhase === "paused" ? t("已暂停") : t("未完成");
  if (recoveryKind === "resolve") return t("需要处理");
  if (isCancelled) return t("已停止");
  if (effectivePhase === "paused") return t("已暂停");
  return t("未完成");
}

/** @param {{effectivePhase: string, faultCode: string, isWait: boolean, isCancelled: boolean, finishingBlocked: boolean, count: number, isNonGenerateCard: boolean, conversationMode: string}} ctx */
function cardTitle(ctx) {
  if (ctx.isWait) return t("模型暂时限流");
  if (ctx.isNonGenerateCard) {
    if (ctx.conversationMode === "discuss") return ctx.isCancelled ? t("已停止回复") : t("回复未完成");
    return ctx.isCancelled ? t("已停止修改") : t("修改未完成");
  }
  if (ctx.faultCode === "provider-auth") return t("模型登录或密钥失效");
  if (ctx.faultCode === "provider-quota" || ctx.faultCode === "provider-token-plan") return t("模型额度已用尽");
  if (ctx.faultCode === "context-window-too-small") return t("当前模型上下文窗口过小");
  if (ctx.isCancelled) return ctx.count ? t("已停止，保留 {n} 页", { n: ctx.count }) : t("已停止生成");
  if (ctx.finishingBlocked) {
    return ctx.effectivePhase === "failed"
      ? t("已保留 {n} 页，收尾失败", { n: ctx.count })
      : t("已生成 {n} 页，收尾未完成", { n: ctx.count });
  }
  return ctx.effectivePhase === "paused" ? t("生成已暂停") : t("生成未完成");
}

/** @param {{activity: Record<string, any>, inspection: Record<string, any>, faultCode: string, faultReason: string, isWait: boolean, isNonGenerateCard: boolean}} ctx */
function resolveSummaryBase(ctx) {
  if (ctx.isWait) return t("请求触发了上游频率限制，系统正在按退避间隔等待自动续跑。");
  if (ctx.faultCode === "provider-auth") {
    return t("当前供应商拒绝了身份认证，需要重新认证或更换模型后才能继续。");
  }
  if (ctx.faultCode === "provider-token-plan") return t("当前模型的套餐额度已用尽，自动重试无法恢复。");
  if (ctx.faultCode === "provider-quota") return t("当前模型账户额度已用尽，自动重试无法恢复。");
  if (ctx.faultCode === "context-window-too-small") {
    return t("当前模型的上下文窗口不足以容纳完整演示文稿生成，请切换到至少 64k 上下文窗口的模型后再继续。");
  }
  if (ctx.faultReason) return ctx.faultReason;
  if (ctx.isNonGenerateCard) return "";
  return unfinishedGenerationReason(ctx.activity, ctx.inspection);
}

/** @param {{activity: Record<string, any>, inspection: Record<string, any>, faultCode: string, faultReason: string, title: string, isWait: boolean, isCancelled: boolean, finishingBlocked: boolean, missingReferenceCount: number, isNonGenerateCard: boolean}} ctx */
function cardSummary(ctx) {
  const titleNorm = normalizeSentence(ctx.title);
  if (ctx.isCancelled) {
    return ctx.faultReason && normalizeSentence(ctx.faultReason) !== titleNorm ? ctx.faultReason : "";
  }
  const base = resolveSummaryBase(ctx);
  const refNote =
    ctx.finishingBlocked && ctx.missingReferenceCount > 0
      ? t("仍缺 {n} 个参考资料分段未读取", { n: ctx.missingReferenceCount })
      : "";
  const parts = [];
  const baseNorm = normalizeSentence(base);
  const skipGenericRef = Boolean(refNote) && baseNorm === normalizeSentence(t("必需参考资料尚未读完"));
  if (baseNorm && baseNorm !== titleNorm && !skipGenericRef) parts.push(base);
  if (refNote && !parts.some((item) => /\d+\s*个参考资料分段/.test(item))) parts.push(refNote);
  if (parts.length <= 1) return parts[0] || "";
  return `${parts.map((item) => item.replace(/[。；;]+$/g, "")).join(t("；"))}${t("。")}`;
}

/** @param {{tone: string, recoveryKind: string, faultCode: string, isCancelled: boolean, finishingBlocked: boolean, isNonGenerateCard: boolean, conversationMode: string}} ctx */
function cardHint(ctx) {
  if (ctx.tone === "wait") return t("倒计时结束后会自动继续，也可以先在下方切换模型立即继续，或点击停止等待。");
  if (ctx.isNonGenerateCard) {
    return ctx.conversationMode === "discuss"
      ? t("可以重新发送消息，或在下方切换模型后再试。")
      : t("文稿未受影响；可以重新发送修改要求，或在下方切换模型后再试。");
  }
  if (ctx.faultCode === "provider-quota" || ctx.faultCode === "provider-token-plan") {
    return t("请在下方切换到其他已连接的模型，或充值补充额度后再继续。");
  }
  if (ctx.faultCode === "context-window-too-small") {
    return t("请在下方切换到上下文窗口不小于 64k 的模型（推荐 128k 及以上）后再继续。");
  }
  if (ctx.faultCode === "provider-auth" || ctx.recoveryKind === "resolve") {
    return t("可在下方切换到其他可用模型，或在设置中更新密钥或重新登录。");
  }
  if (ctx.isCancelled) return t("你可以直接编辑已有页面，或在下方输入新指令继续协作。");
  if (ctx.finishingBlocked) {
    return t("可以直接在编辑器里修改并导出已有页面，也可以继续完成生成，或在下方补充要求、切换模型后继续。");
  }
  return t("留空按当前计划继续；要纠偏或换模型，先在下方修改。");
}

/** @param {Record<string, any>} activity @param {string} title @param {string} summary */
function cardRawDetail(activity, title, summary) {
  const raw = text(activity?.error?.detail).trim();
  if (!raw) return "";
  const stripped = raw.replace(/^provider-[a-z-]+:\s*/i, "").trim();
  const normRaw = normalizeSentence(stripped);
  if (!normRaw || normRaw === normalizeSentence(title) || normRaw === normalizeSentence(summary)) return "";
  if (normRaw.length >= 8 && normalizeSentence(summary).includes(normRaw)) return "";
  return raw;
}

/** @param {Record<string, any>} activity @param {{pageCount?: number}} options */
function resolveCardCount(activity, options) {
  const inspection = activity?.inspection && typeof activity.inspection === "object" ? activity.inspection : {};
  const pages = Array.isArray(inspection.pages) ? inspection.pages : [];
  const derivedCount = Math.max(Number(activity?.project?.pageCount) || 0, pages.length);
  const count =
    typeof options?.pageCount === "number" && Number.isFinite(options.pageCount) ? options.pageCount : derivedCount;
  const missingReferenceCount = Array.isArray(inspection.missingReferenceChunks)
    ? inspection.missingReferenceChunks.length
    : 0;
  return { inspection, count, missingReferenceCount };
}

/** @param {Record<string, any>} activity */
function resolveFaultContext(activity) {
  const faultCode = text(activity?.error?.code || activity?.execution?.fault?.code);
  const faultSource = activity?.error
    ? activity
    : activity?.execution?.fault
      ? { ...activity, error: activity.execution.fault }
      : null;
  return { faultCode, faultReason: faultSource ? humanizeGenerationFault(faultSource) : "" };
}

/** @param {Record<string, any>} activity @param {string} effectivePhase @param {any} rateLimitWait @param {number} count @param {Record<string, any>} inspection @param {string} faultCode */
function resolveCardFlags(activity, effectivePhase, rateLimitWait, count, inspection, faultCode) {
  const rawRecoveryKind = text(activity?.execution?.recovery?.kind) || (rateLimitWait ? "wait-or-stop" : "none");
  const isWait = Boolean(rateLimitWait) || rawRecoveryKind === "wait-or-stop";
  const isCancelled = effectivePhase === "cancelled" || effectivePhase === "canceled";
  const conversationMode = text(activity?.conversation?.mode);
  const isNonGenerateCard =
    (conversationMode === "discuss" || conversationMode === "edit") && CARD_PHASES.has(effectivePhase) && !isWait;
  const forceResolve = !isNonGenerateCard && !isWait && RESOLVE_FAULT_CODES.has(faultCode);
  const recoveryKind = isNonGenerateCard ? "none" : forceResolve ? "resolve" : rawRecoveryKind;
  const finishingBlocked = !isNonGenerateCard && count > 0 && inspection.composed !== true && !isCancelled && !isWait;
  return { conversationMode, isNonGenerateCard, recoveryKind, isWait, isCancelled, finishingBlocked };
}

/** @param {{status?: string} | null} presentation @param {any} rateLimitWait @param {string} title @param {boolean} isNonGenerateCard @param {boolean} isCancelled @param {string} conversationMode */
function resolveCardStatusText(presentation, rateLimitWait, title, isNonGenerateCard, isCancelled, conversationMode) {
  if (isNonGenerateCard) {
    return isCancelled ? t("已停止") : conversationMode === "discuss" ? t("回复未完成") : t("修改未完成");
  }
  if (presentation && presentation.status) return presentation.status;
  return rateLimitWait ? t("模型暂时限流，等待自动重试") : title;
}

/**
 * Build a unified presentation model for terminal pills, fault cards, and wait cards.
 * @param {Record<string, any>} activity
 * @param {{status?: string} | null} presentation
 * @param {{now?: number, pageCount?: number, duration?: string, phase?: string}} [options]
 */
export function buildTerminalCardModel(activity = {}, presentation = null, options = {}) {
  const opts = options || {};
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const effectivePhase = text(opts.phase || activity.phase);
  const { inspection, count, missingReferenceCount } = resolveCardCount(activity, opts);
  if (PILL_PHASES.has(effectivePhase)) return buildPillModel(effectivePhase, count, text(opts.duration));
  const rateLimitWait = activeRateLimitWait(activity, now);
  if (!CARD_PHASES.has(effectivePhase) && !rateLimitWait) return null;
  const { faultCode, faultReason } = resolveFaultContext(activity);
  const flags = resolveCardFlags(activity, effectivePhase, rateLimitWait, count, inspection, faultCode);
  const { conversationMode, isNonGenerateCard, recoveryKind, isWait, isCancelled, finishingBlocked } = flags;
  const tone = cardTone(effectivePhase, faultCode, isWait, isNonGenerateCard, isCancelled);
  const badge = cardBadge(effectivePhase, recoveryKind, isWait, isCancelled, isNonGenerateCard);
  const title = cardTitle({
    effectivePhase,
    faultCode,
    isWait,
    isCancelled,
    finishingBlocked,
    count,
    isNonGenerateCard,
    conversationMode,
  });
  const phaseActivity = effectivePhase === text(activity.phase) ? activity : { ...activity, phase: effectivePhase };
  const summary = cardSummary({
    activity: phaseActivity,
    inspection,
    faultCode,
    faultReason,
    title,
    isWait,
    isCancelled,
    finishingBlocked,
    missingReferenceCount,
    isNonGenerateCard,
  });
  const hint = cardHint({
    tone,
    recoveryKind,
    faultCode,
    isCancelled,
    finishingBlocked,
    isNonGenerateCard,
    conversationMode,
  });
  const rawDetail = cardRawDetail(activity, title, summary);
  const statusText = resolveCardStatusText(
    presentation,
    rateLimitWait,
    title,
    isNonGenerateCard,
    isCancelled,
    conversationMode,
  );
  return { variant: "card", tone, badge, title, summary, hint, rawDetail, recoveryKind, rateLimitWait, statusText };
}
