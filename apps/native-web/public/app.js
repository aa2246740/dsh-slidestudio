import { t } from "./i18n.js";
import {
  clearWaitingRow,
  createStepPainter,
  paintWaitingRow,
  prefersReducedMotion,
  typewriteInto,
} from "./step-paint.js";
import { renderRailView } from "./rail.js";
import { reviewCacheKey, isAnnotationTarget, annotationPoint, annotationBox, annotationTargetsInBox } from "./comment-targets.js";
import { installTooltips } from "./tooltips.js";
import { handoffToLiveEditor, hubDraftHref, performLaunch, readLaunch } from "./launch-flow.js";
import { LAUNCH_STEPS, coverFailure, revealWorkspace, setCover } from "./workspace-cover.js";
import { appendBriefChip, clipChromeText } from "./brief-chip.js";
import { mountReasonCard } from "./reader-reasoning.js";
import { createGenerationLiveBuffer } from "./generation-live.js";
import { renderChatMarkdown } from "./chat-markdown.js";
import { mountAssistantQuestion } from "./assistant-questions.js";
import { conversationMessageKey } from "./assistant-conversation.js";
import { createConversationScroll, conversationProcessRows } from "./conversation-scroll.js";
import {
  targetFromAssistantIntent,
} from "./work-agent-scope.js";
import {
  generationActivityProgressSignature,
  generationEventsForTask,
  generationResumeCandidate,
  generationResumeInstruction,
  generationStateCanResume,
  generationTerminalPresentation,
  humanizeGenerationFault,
  processStatusLabel,
  projectGenerationProcess,
} from "./generation-process.js";
import {
  buildGenerationTurnRequest,
  currentModelFromState,
  generationComposerMode,
  modelOptionValue,
  parseProviderRoster,
  selectedModelFromRoster,
} from "./generation-composer.js";
import {
  categoricalChartModel,
  chartKind,
  placeScatterLabels,
  scatterChartModel,
  waterfallChartModel,
} from "/runtime/chart-semantics.js";
import {
  CHART_GRID,
  CHART_INK,
  CHART_PALETTE,
  CHART_TEXT_PX,
  alignedSecondaryScale,
  chartLayout,
  chartSwatch,
  formatChartValue,
  measureChartText,
  resolveChartLegend,
  seriesDecimals,
} from "/runtime/chart-layout.js";

import { conversationEvents, settledAssistantActivity, commentIsDraft, acceptedReviewSubmissions } from "./assistant-conversation.js";

installTooltips();

// A deck only has an AI session when it was generated from the Hub (the binding lives in its `_agent/` folder).
const NO_AI_SESSION_MESSAGE = t("这份文稿没有 AI 对话记录（可能是导入或复制来的），所以不能让 AI 继续修改。仍可手动编辑；需要 AI 请回首页新建文稿。");

function nativeApi(path) {
  const rest = String(path || "").replace(/^\/api/, "");
  const root = location.pathname.startsWith("/app/") ? "/app/api" : "/api";
  return `${root}${rest.startsWith("/") ? rest : `/${rest}`}`;
}

function currentProjectPath() {
  return new URLSearchParams(location.search).get("project") || generationActivity?.project?.path || model?.rootDir || "";
}

const $ = (id) => document.getElementById(id);

let toastTimer = 0;
function showToast(message, duration = 3600) {
  const toast = $("app-toast");
  if (!toast) return;
  if (toastTimer) window.clearTimeout(toastTimer);
  toast.textContent = String(message || "");
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
    toast.textContent = "";
    toastTimer = 0;
  }, Math.max(1200, Number(duration) || 3600));
}

let model = null;
let thumbs = [];
let notesTimer = 0;
let pendingNotes = null;
let textCommitState = null;
let tableCommitState = null;
let notesCommitState = null;
let drag = null;
let shapeCatalog = [];
let faIcons = [];
let faUnicode = {};
let timelineOpen = false;
let versions = [];
let previewVersion = null;
let historyReturnToChat = false;
let historyReturnFocus = null;
let previewThumbs = null;
let railView = localStorage.getItem("oss.railView") === "list" ? "list" : "thumbs";
let commentMode = false;
let commentPopoverOpen = false;
let commentPopoverView = "draft";
let commentPopoverAnchor = null;
let commentDraftScope = "page";
// A draft target is separate from editor selection: annotating never moves or
// edits an object, and clicking the text box must not lose the target.
let commentDraftTargetIds = [];
let commentDraftBox = null;
let commentDraftPageKey = "";
let commentHoverTargetId = "";
let commentActiveId = "";
let commentGesture = null;
let commentOverlayFrame = 0;
// Batch submission: page view cards and the cross-page inbox both write into
// this map, so one submit can carry comments from several pages.
const commentSelection = new Map();
const commentQueueRevisions = new Map();
const commentTextDrafts = new Map();
let commentSubmitPending = false;
const acknowledgedCommentTurns = new Map();
const workspaceEditReceipts = new Map();
let commentQueueState = { project: "", loading: false, loaded: false };
let allPageComments = null;
let propertyPanelCollapsed = localStorage.getItem("oss.propertyPanelCollapsed") === "1";
let propertyPanelAutoCollapsedForAgent = false;
let propertyPanelAgentUserOverride = false;
let comments = [];
let commentLoadedKey = "";
let commentLoadState = { key: "", status: "idle", error: "" };
let commentSaveTail = Promise.resolve();
let presentStep = 0;
let lastPresentPage = -1;
let previewModel = null;
let tableCell = { row: 0, col: 0 };
let tableAnchor = { row: 0, col: 0 };
let tableFocusId = null;
let editingCell = null;
let editCellPrev = "";
let shapeGroup = "";
let tlMaxSec = 2;
let editingId = null;
let editingRich = false;
let pendingToolbarRange = null;
let editCommitLock = false;
let editKeyTyped = false;
let editPrevText = "";
let lastCtxSelKey = "";
let marqueeDidSelect = false;
let commandTail = Promise.resolve();
let chartCols = ["类目", "数值"];
let chartFocusRow = -1;
let chartPersistTimer = 0;
let chartDraft = null;
const reportedCommandErrors = new WeakSet();
let lastExportFormat = "pptx";
let railDrag = null;
let railDidDrag = false;
let croppingId = null;
let remorphTimer = 0;
let remorphGen = 0;
let shiftPointerClaimId = "";
// A click whose own gesture already moved a multi-selection belongs to that
// drag; it must not collapse the selection onto the pressed element.
let dragClickClaimId = "";
let generationPollTimer = 0;
let generationActivity = null;
let generationLiveSource = null;
let generationLiveSession = "";
let generationLiveBuffer = null;
let generationLivePaint = 0;
let generationLiveThoughtKey = null;
let generationRenderedRevision = "";
let generationPollFailures = 0;
let aiReviewTurnActive = false;
let aiReviewLiveLabel = "";
let activeCommentReviewControl = null;
let activeWorkspaceReviewControl = null;
let aiReviewBaselineTurn = null;
let generationPanelExpanded = false;
let generationPanelUserToggled = false;
let generationEventsUserToggled = false;
let generationPreviousPhase = "";
let generationEventFollowing = true;
let generationEventScrollBound = false;
let generationScroll;
const generationProcessChoices = new Map();
let generationProcessContext = "";
function rememberProcessChoice(key, open) {
  generationProcessChoices.set(key, open);
  try { sessionStorage.setItem(`slides-chat-process:${generationProcessContext}`, JSON.stringify([...generationProcessChoices])); } catch { /* optional UI state */ }
}
let generationResumePending = false;
let generationResumeVerifiedSessionId = "";
let generationResumeEligibilityRequest = 0;
let generationResumeUncertainSessionId = "";
let generationRoster = null;
let generationStopPending = false;
let lastGenerationState = null;
let pendingAgentAttachments = [];
let agentAttachmentUploadActive = false;
let workAgentSubmitPending = false;
let assistantTurnPending = false;
let contextMenuReturnFocus = null;
let insertPopoverReturnFocus = null;
let internalClipboardClaim = null;
let textLinkDialogState = null;
let textLinkDialogBusy = false;

// Palette/ink come from the shared chart layout contract (pptd-v2).

const SHAPE_GROUP_LABELS = {
  "Basic Shapes": t("基本形状"),
  "Rectangle Variants": t("矩形"),
  "Stars and Bursts": t("星形"),
  "Arrow Shapes": t("箭头"),
  "Arrow Callouts": t("箭头标注"),
  "Callouts": t("标注"),
  "Brackets and Braces": t("括号"),
  "Ribbons": t("丝带"),
  "Scrolls": t("卷轴"),
  "Math Symbols": t("数学"),
  "Chart Shapes": t("图表"),
  "Tab Shapes": t("选项卡"),
  "Action Buttons": t("动作按钮"),
  "Flowchart Shapes": t("流程图"),
};

// One picker, like PowerPoint's ribbon: each choice names the East Asian face
// and the Latin face it is set with. Storage still keeps the two apart.
const FONT_PRESETS = [
  { ea: "微软雅黑", latin: "Arial" },
  { ea: "黑体", latin: "Arial" },
  { ea: "宋体", latin: "Times New Roman" },
  { ea: "楷体", latin: "Times New Roman" },
  { ea: "仿宋", latin: "Times New Roman" },
];
const DEFAULT_FONT_LATIN = "Arial";
const DEFAULT_FONT_EA = "微软雅黑";
const SLIDE_FONT_STACK = 'Arial, "微软雅黑", "Microsoft YaHei", "PingFang SC", sans-serif';

const SHAPE_KINDS = [
  ["rect", t("矩形")],
  ["roundRect", t("圆角")],
  ["ellipse", t("椭圆")],
  ["triangle", t("三角")],
  ["rtTriangle", t("直角三角")],
  ["diamond", t("菱形")],
  ["pentagon", t("五边")],
  ["hexagon", t("六边")],
  ["chevron", t("V形")],
  ["plus", t("十字")],
  ["star5", t("五星")],
  ["heart", t("心形")],
  ["rightArrow", t("右箭头")],
  ["leftArrow", t("左箭头")],
  ["upArrow", t("上箭头")],
  ["downArrow", t("下箭头")],
  ["homePlate", t("五边箭")],
];

const ICON_KINDS = [
  "fas:star",
  "fas:heart",
  "fas:check",
  "fas:xmark",
  "fas:plus",
  "fas:minus",
  "fas:house",
  "fas:user",
  "fas:gear",
  "fas:lightbulb",
  "fas:comment",
  "fas:envelope",
  "fas:camera",
  "fas:file",
  "fas:magnifying-glass",
  "fas:bell",
  "fas:bookmark",
  "fas:flag",
  "fas:bolt",
  "fas:circle",
];

function allowed(id) {
  return Boolean(model?.allowedControlIds?.includes(id));
}

function mediaUrl(src) {
  if (!src) return "";
  // Remote URLs are never rendered straight into the page: an http(s) src
  // must be localized into media/ at import time, not fetched live.
  if (/^https?:/i.test(src)) return "";
  if (/^(data:|blob:)/i.test(src)) return src;
  const params = new URLSearchParams();
  if (previewVersion?.id) params.set("version", previewVersion.id);
  try {
    const cur = typeof currentProjectPath === "function" ? currentProjectPath() : "";
    if (cur) params.set("project", cur);
  } catch {
    // fall through without the project hint
  }
  const q = params.size ? `?${params.toString()}` : "";
  // Per-segment encode: a crafted src cannot break out of the url("…") css.
  const rel = src.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return `/media/${rel}${q}`;
}

function viewModel() {
  return previewModel || model;
}

function selectedIds() {
  const sel = model?.selection;
  if (sel?.kind === "element") return [sel.elementId];
  if (sel?.kind === "multi") return sel.elementIds || [];
  return [];
}

function selectedEl() {
  const id = selectedIds()[0];
  return model?.elements.find((e) => e.id === id) || null;
}

function pageIdFromPath(pagePath) {
  return String(pagePath || "").split("/").pop().replace(/\.page$/i, "");
}

function workAgentTargetFromPlan(plan) {
  return targetFromAssistantIntent(plan, {
    pagePaths: model?.pagePaths || [], pageIndex: model?.pageIndex ?? 0,
    selectedElements: selectedIds().map(id => {
      const element = model?.elements.find(candidate => candidate.id === id);
      return element ? { id, label: elementReadableName(element) } : null;
    }),
  });
}

function paintWorkAgentTarget(text = $("work-brief")?.value || "") {
  const target = $("work-target");
  if (!target || !model) return;
  const attached = selectedCommentEntries().length;
  const running = aiReviewTurnActive || generationInteractionLocked() || assistantTurnPending;
  target.hidden = true;
  if (running && !attached) {
    target.textContent = t("可以补充要求，或停止当前任务");
    target.dataset.scope = "followup"; target.dataset.valid = "true";
    $("work-brief")?.setAttribute("aria-invalid", "false");
    return;
  }
  if (attached) {
    target.textContent = t(`按附带的 {p0} 条批注修改文稿，可在下方补充要求`, { p0: attached });
    target.dataset.scope = "comments";
    target.dataset.valid = "true";
    $("work-brief")?.setAttribute("aria-invalid", "false");
    return;
  }
  // Unsent prose has no authoritative scope. Resolve it once after submission.

}


function slideElNode(id) {
  if (!id) return null;
  return document.querySelector(`#slide .el[data-id="${id}"]`);
}

function applyTextStyleToNode(node, el) {
  if (!node || !el) return;
  const [ha] = el.align || ["left", "top"];
  const liveRich = Boolean(editingRich && editingId && el.id === editingId);
  node.style.color = el.href ? (el.color || "#2563EB") : (el.color || "#111");
  node.style.fontSize = `${el.fontSize || 18}px`;
  if (!liveRich) {
    node.style.fontWeight = el.bold ? "700" : "400";
    node.style.fontStyle = el.italic ? "italic" : "normal";
    node.style.textDecoration = el.underline || el.href ? "underline" : "none";
  }
  node.style.fontFamily = el.fontFamily || SLIDE_FONT_STACK;
  node.style.lineHeight = el.lineHeight != null ? String(el.lineHeight) : "1.2";
  node.style.letterSpacing = el.letterSpacing != null ? `${el.letterSpacing}px` : "";
  node.style.textAlign = ha;
  if (el.backgroundColor) node.style.backgroundColor = el.backgroundColor;
}

function applyRunStyleToSpan(span, run) {
  if (!span || !run) return;
  if (run.fontSize) span.style.fontSize = `${run.fontSize}px`;
  if (run.color) span.style.color = run.color;
  if (run.bold) span.style.fontWeight = "700";
  if (run.italic) span.style.fontStyle = "italic";
  if (run.underline) span.style.textDecoration = "underline";
}

function appendTextRuns(node, runs) {
  for (const run of runs) {
    const span = document.createElement("span");
    const text = String(run.text ?? "");
    span.textContent = text;
    applyRunStyleToSpan(span, run);
    node.append(span);
  }
}

function escapeHtmlText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rgbToHexColor(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hex6 = /^#([0-9a-fA-F]{6})$/.exec(raw);
  if (hex6) return `#${hex6[1].toLowerCase()}`;
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(raw);
  if (hex3) {
    const [r, g, b] = hex3[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(raw);
  if (!m) return raw;
  const hex = (n) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

function styleToCss(style) {
  const parts = [];
  if (style.fontSize != null) parts.push(`font-size:${style.fontSize}px`);
  if (style.color) parts.push(`color:${style.color}`);
  if (style.bold) parts.push("font-weight:700");
  if (style.italic) parts.push("font-style:italic");
  if (style.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

function runStyleKey(style) {
  return JSON.stringify({
    fontSize: style.fontSize ?? null,
    color: style.color ?? null,
    bold: Boolean(style.bold),
    italic: Boolean(style.italic),
    underline: Boolean(style.underline),
  });
}

function isRichBlock(node) {
  return Boolean(node && node.nodeType === 1 && /^(DIV|P|LI|H[1-6])$/.test(node.tagName));
}

function readInlineStyle(el) {
  const out = {};
  if (!el || el.nodeType !== 1) return out;
  const style = el.style;
  const fs = parseFloat(style.fontSize);
  if (fs) out.fontSize = fs;
  if (style.color) out.color = rgbToHexColor(style.color);
  const fw = style.fontWeight;
  if (fw === "bold" || fw === "bolder" || Number(fw) >= 600) out.bold = true;
  if (style.fontStyle === "italic" || style.fontStyle === "oblique") out.italic = true;
  if ((style.textDecorationLine || style.textDecoration || "").includes("underline")) {
    out.underline = true;
  }
  const tag = el.tagName;
  if (tag === "B" || tag === "STRONG") out.bold = true;
  if (tag === "I" || tag === "EM") out.italic = true;
  if (tag === "U") out.underline = true;
  return out;
}

function splitRunsToParas(runs) {
  const paras = [[]];
  for (const run of runs || []) {
    const parts = String(run.text ?? "").split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) paras.push([]);
      if (parts[i].length) paras[paras.length - 1].push({ ...run, text: parts[i] });
    }
  }
  return paras;
}

function fillNodeFromRuns(node, runs) {
  node.replaceChildren();
  for (const para of splitRunsToParas(runs)) {
    const div = document.createElement("div");
    if (!para.length) {
      div.append(document.createElement("br"));
    } else {
      appendTextRuns(div, para);
    }
    node.append(div);
  }
}

function isIgnorableRootWs(node, root) {
  if (node.nodeType !== Node.TEXT_NODE || node.parentNode !== root) return false;
  const t = node.nodeValue || "";
  return Boolean(t) && !t.trim();
}

function isPlaceholderBr(node, root) {
  if (!node || node.tagName !== "BR") return false;
  const parent = node.parentNode;
  if (!parent || parent === root || !isRichBlock(parent)) return false;
  for (const child of parent.childNodes) {
    if (child === node) continue;
    if (child.nodeType === Node.TEXT_NODE && child.nodeValue) return false;
    if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== "BR") return false;
  }
  return true;
}

function serializeEditNode(root) {
  const paras = [[]];
  const pushText = (text, style) => {
    if (!text) return;
    const cur = paras[paras.length - 1];
    const last = cur[cur.length - 1];
    if (last && runStyleKey(last.style) === runStyleKey(style)) last.text += text;
    else cur.push({ text, style: { ...style } });
  };
  const walk = (node, style) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (isIgnorableRootWs(node, root)) return;
      pushText(node.nodeValue || "", style);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === "BR") {
      if (isPlaceholderBr(node, root)) return;
      paras.push([]);
      return;
    }
    const next = { ...style, ...readInlineStyle(node) };
    if (isRichBlock(node)) {
      if (paras[paras.length - 1].length) paras.push([]);
      for (const child of node.childNodes) walk(child, next);
      return;
    }
    for (const child of node.childNodes) walk(child, next);
  };
  for (const child of root.childNodes) walk(child, {});
  while (paras.length > 1 && paras[paras.length - 1].length === 0) paras.pop();
  const joined = paras.map((p) => p.map((r) => r.text).join("")).join("\n");
  const hasStyle = paras.some((p) =>
    p.some((r) => r.style.bold || r.style.italic || r.style.underline || r.style.color || r.style.fontSize),
  );
  if (!hasStyle && !joined.includes("\n")) return escapeHtmlText(joined);
  return paras
    .map((para) => {
      const inner = para
        .map(({ text, style }) => {
          const css = styleToCss(style);
          const escaped = escapeHtmlText(text);
          return css ? `<span style="${css}">${escaped}</span>` : escaped;
        })
        .join("");
      return `<p>${inner}</p>`;
    })
    .join("");
}

function pointToPlainOffset(root, container, offset) {
  let count = 0;
  let found = false;
  let seenContent = false;
  let pendingBreak = false;
  const flushBreak = () => {
    if (!pendingBreak) return;
    count += 1;
    pendingBreak = false;
  };
  const walk = (node) => {
    if (found) return;
    if (node === container && node.nodeType === Node.TEXT_NODE) {
      flushBreak();
      count += offset;
      if (offset) seenContent = true;
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (isIgnorableRootWs(node, root)) return;
      const t = node.nodeValue || "";
      if (!t) return;
      flushBreak();
      count += t.length;
      seenContent = true;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node === container) {
      if (isRichBlock(node) && node !== root && seenContent) pendingBreak = true;
      flushBreak();
      const kids = node.childNodes;
      for (let i = 0; i < offset && i < kids.length; i++) walk(kids[i]);
      found = true;
      return;
    }
    if (node.tagName === "BR") {
      if (isPlaceholderBr(node, root)) return;
      flushBreak();
      count += 1;
      seenContent = true;
      return;
    }
    if (isRichBlock(node) && node !== root) {
      if (seenContent) pendingBreak = true;
      for (const child of node.childNodes) walk(child);
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return count;
}

function plainOffsetToPoint(root, target) {
  let count = 0;
  let result = null;
  let last = { node: root, offset: 0 };
  let seenContent = false;
  let pendingBreak = false;
  const flushBreak = () => {
    if (!pendingBreak) return false;
    if (count >= target) return true;
    count += 1;
    pendingBreak = false;
    return count >= target;
  };
  const walk = (node) => {
    if (result) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (isIgnorableRootWs(node, root)) return;
      const t = node.nodeValue || "";
      if (!t) return;
      if (flushBreak()) {
        result = { node, offset: 0 };
        return;
      }
      if (count + t.length >= target) {
        result = { node, offset: target - count };
        return;
      }
      count += t.length;
      seenContent = true;
      last = { node, offset: t.length };
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === "BR") {
      if (isPlaceholderBr(node, root)) return;
      if (flushBreak()) {
        result = last;
        return;
      }
      if (count >= target) {
        result = last;
        return;
      }
      count += 1;
      seenContent = true;
      last = { node, offset: 0 };
      return;
    }
    if (isRichBlock(node) && node !== root && seenContent) pendingBreak = true;
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return result || last;
}

function editingSelectionOffsets(node) {
  if (!node) return null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const inside =
    node === range.commonAncestorContainer || node.contains(range.commonAncestorContainer);
  if (!inside) return null;
  if (range.collapsed) return null;
  const start = pointToPlainOffset(node, range.startContainer, range.startOffset);
  const end = pointToPlainOffset(node, range.endContainer, range.endOffset);
  if (start === end) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function setSelectionByPlainOffsets(node, start, end) {
  const a = plainOffsetToPoint(node, start);
  const b = plainOffsetToPoint(node, end);
  if (!a || !b) return false;
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    return false;
  }
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return true;
}

function activeEditRange() {
  if (!editingId) return null;
  return editingSelectionOffsets(slideElNode(editingId)) || pendingToolbarRange;
}

function rangeHasStyle(runs, start, end, key) {
  let cursor = 0;
  let saw = false;
  for (const run of runs || []) {
    const rs = cursor;
    const re = cursor + String(run.text || "").length;
    cursor = re;
    const lo = Math.max(start, rs);
    const hi = Math.min(end, re);
    if (lo >= hi) continue;
    saw = true;
    if (!run[key]) return false;
  }
  return saw;
}

function refreshRichEdit(range) {
  if (!editingId) return;
  editingRich = true;
  const el = model?.elements.find((e) => e.id === editingId);
  const node = slideElNode(editingId);
  if (!el || !node) return;
  const runs = Array.isArray(el.runs) && el.runs.length ? el.runs : [{ text: el.text || "" }];
  fillNodeFromRuns(node, runs);
  node.focus();
  if (range) {
    setSelectionByPlainOffsets(node, range.start, range.end);
    pendingToolbarRange = { start: range.start, end: range.end };
  }
  syncRichToolbarState();
}

function textStyleOn(el, key) {
  if (!el) return false;
  const range = activeEditRange();
  if (range) return rangeHasStyle(el.runs, range.start, range.end, key);
  return Boolean(el[key]);
}

function syncRichToolbarState() {
  const el = selectedEl();
  if (!el || el.type !== "text") return;
  const map = [
    ["element.text.toolbar.bold.toggle", "bold"],
    ["element.text.toolbar.italic.toggle", "italic"],
    ["element.text.toolbar.underline.toggle", "underline"],
  ];
  for (const [control, key] of map) {
    document.querySelectorAll(`[data-control="${control}"]`).forEach((b) => {
      b.classList.toggle("on", textStyleOn(el, key));
    });
  }
}

function styleTextFromToolbar(controlId, patch, toggleKey) {
  const range = activeEditRange();
  if (range && editingId) {
    const saved = { start: range.start, end: range.end };
    pendingToolbarRange = saved;
    const apply = async () => {
      const node = slideElNode(editingId);
      const raw = node ? String(node.innerText || "").replace(/\n$/, "") : "";
      if (node && (editKeyTyped || raw !== editPrevText)) {
        editingRich = true;
        await command("setRichText", { html: serializeEditNode(node) });
        editKeyTyped = false;
        editPrevText = raw;
      }
      const el = model?.elements.find((e) => e.id === editingId);
      const finalPatch = toggleKey
        ? { [toggleKey]: rangeHasStyle(el?.runs, saved.start, saved.end, toggleKey) ? null : true }
        : patch;
      await command("setTextRangeStyle", {
        start: saved.start,
        end: saved.end,
        patch: finalPatch,
        controlId,
      });
      refreshRichEdit(saved);
    };
    return apply();
  }
  if (toggleKey === "bold") {
    return command("setBold", { bold: !selectedEl()?.bold }).then(() => syncRichToolbarState());
  }
  return command("setTextStyle", { controlId, patch }).then(() => syncRichToolbarState());
}

function selectNodeText(node) {
  node.focus();
  try {
    document.execCommand("selectAll");
  } catch {
    /* fall through to Range */
  }
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed && node.contains(sel.anchorNode)) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function isEditTypeKey(ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  if (ev.key === "Backspace" || ev.key === "Delete" || ev.key === "Enter") return true;
  return ev.key.length === 1;
}

function placeCaretAtPoint(node, ev) {
  const sel = window.getSelection();
  if (!sel) return;
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(ev.clientX, ev.clientY);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(ev.clientX, ev.clientY);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (range && node.contains(range.startContainer)) {
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
  sel.collapseToEnd();
}

function bindEditingNode(node) {
  node.draggable = false;
  node.setAttribute("draggable", "false");
  node.addEventListener("dragstart", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  node.addEventListener("drop", (ev) => ev.preventDefault());
  node.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || ev.isComposing || ev.keyCode === 229) return;
    if (isEditTypeKey(ev)) editKeyTyped = true;
    const meta = ev.metaKey || ev.ctrlKey;
    if (!meta || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k !== "b" && k !== "i" && k !== "u") return;
    ev.preventDefault();
    ev.stopPropagation();
    const key = k === "b" ? "bold" : k === "i" ? "italic" : "underline";
    styleTextFromToolbar(`element.text.toolbar.${key}.toggle`, { [key]: true }, key);
  });
  node.addEventListener("input", () => {
    if (editKeyTyped || !editingId) return;
    const now = String(node.innerText || "").replace(/\n$/, "");
    if (!now && editPrevText) node.textContent = editPrevText;
  });
  node.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    const sel = window.getSelection();
    const body = String(node.innerText || "").replace(/\n$/, "");
    const allSelected = Boolean(sel && !sel.isCollapsed && body && sel.toString() === body);
    if (allSelected) {
      ev.preventDefault();
      node.focus();
      placeCaretAtPoint(node, ev);
    }
  });
}

function enterTextEdit(id) {
  const el = model?.elements.find((e) => e.id === id);
  const node = slideElNode(id);
  if (!el || el.type !== "text" || !node) return;
  editingId = id;
  editingRich = true;
  pendingToolbarRange = null;
  editKeyTyped = false;
  editPrevText = el.text || "";
  node.querySelectorAll(".handle, .sel-box, .handle-rot-stem").forEach((n) => n.remove());
  const runs = Array.isArray(el.runs) && el.runs.length ? el.runs : [{ text: el.text || "" }];
  fillNodeFromRuns(node, runs);
  node.contentEditable = "true";
  node.style.whiteSpace = "pre-wrap";
  node.classList.add("is-editing");
  bindEditingNode(node);
  selectNodeText(node);
  syncRichToolbarState();
}

function exitTextEdit() {
  if (!editingId) return null;
  const node = slideElNode(editingId);
  const text = node ? String(node.innerText || "").replace(/\n$/, "") : "";
  editingId = null;
  editingRich = false;
  pendingToolbarRange = null;
  if (node) {
    node.contentEditable = "false";
    node.removeAttribute("contenteditable");
    node.classList.remove("is-editing");
  }
  return text;
}

async function commitTextEdit() {
  if (textCommitState && !textCommitState.failed) return textCommitState.promise;
  if (!editingId) return;
  const targetId = editingId;
  const prev = editPrevText;
  const typed = editKeyTyped;
  const rich = editingRich;
  const node = slideElNode(targetId);
  const raw = node ? String(node.innerText || "").replace(/\n$/, "") : "";
  const wiped = !raw && prev && !typed;
  if (wiped && node) {
    const runs = [{ text: prev }];
    fillNodeFromRuns(node, runs);
  }
  const html = node && (rich || editingRich || !wiped)
    ? (wiped ? escapeHtmlText(prev) : serializeEditNode(node))
    : null;
  const text = html == null ? (wiped ? prev : raw) : null;
  // Toolbar controls can blur the editor after they have already persisted
  // their own change. Do not add an empty rich-text transaction in front of
  // Undo when the editable contents were never changed.
  if (!typed && raw === prev) {
    if (editingId === targetId) {
      exitTextEdit();
      editKeyTyped = false;
      editPrevText = "";
      // Keep the rail DOM stable through the pointerdown → click sequence.
      // Replacing its buttons here would swallow the first page-navigation click.
      syncSelectionDom();
      renderChrome();
      positionCtxBar();
      positionChartOverlay();
    }
    return;
  }
  const state = { failed: false, promise: null };
  const operation = (async () => {
    editCommitLock = true;
    if (html != null) await command("setRichText", { html });
    else await command("setText", { text });
    // Keep the editable DOM and its local value until persistence succeeds.
    // command() deliberately renders only chrome while editingId is present.
    if (editingId === targetId) {
      exitTextEdit();
      editKeyTyped = false;
      editPrevText = "";
      render();
    }
  })();
  state.promise = operation;
  textCommitState = state;
  try {
    await operation;
  } catch (error) {
    state.failed = true;
    throw error;
  } finally {
    editCommitLock = false;
    if (!state.failed && textCommitState === state) textCommitState = null;
  }
}

function cancelTextEdit() {
  if (!editingId) return;
  editingId = null;
  editingRich = false;
  pendingToolbarRange = null;
  render();
}

function tableElById(id) {
  return model?.elements.find((e) => e.id === id && e.type === "table") || null;
}

function tableSize(el) {
  const rows = el?.tableRows || [];
  return { rows: rows.length, cols: rows[0]?.length || 0 };
}

function tableTd(id, row, col) {
  const table = document.querySelector(`#slide .el[data-id="${CSS.escape(id)}"] table`);
  return table?.rows?.[row]?.cells?.[col] || null;
}

function clampCell(el, row, col) {
  const { rows, cols } = tableSize(el);
  return {
    row: Math.max(0, Math.min(row, Math.max(0, rows - 1))),
    col: Math.max(0, Math.min(col, Math.max(0, cols - 1))),
  };
}

function paintCellSelection(id) {
  const table = document.querySelector(`#slide .el[data-id="${CSS.escape(id)}"] table`);
  if (!table) return;
  const r1 = Math.min(tableAnchor.row, tableCell.row);
  const r2 = Math.max(tableAnchor.row, tableCell.row);
  const c1 = Math.min(tableAnchor.col, tableCell.col);
  const c2 = Math.max(tableAnchor.col, tableCell.col);
  for (const td of table.querySelectorAll("td")) {
    td.classList.remove("is-cell", "is-cell-range");
  }
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const td = table.rows[r]?.cells[c];
      if (!td) continue;
      td.classList.add(r === tableCell.row && c === tableCell.col ? "is-cell" : "is-cell-range");
    }
  }
}

function enterTableEdit(id, row, col) {
  const el = tableElById(id);
  const td = tableTd(id, row, col);
  if (!el || !td) return;
  if (editingId) {
    void commitTextEdit()
      .then(() => enterTableEdit(id, row, col))
      .catch((error) => showToast(t(`保存文字失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
    return;
  }
  if (editingCell && (editingCell.id !== id || editingCell.row !== row || editingCell.col !== col)) {
    void commitTableEdit()
      .then(() => enterTableEdit(id, row, col))
      .catch((error) => showToast(t(`保存表格失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
    return;
  }
  tableCell = { row, col };
  tableAnchor = { row, col };
  editingCell = { id, row, col };
  editCellPrev = el.tableRows?.[row]?.[col]?.text || "";
  td.contentEditable = "true";
  td.classList.add("is-editing-cell");
  td.focus();
  try {
    document.execCommand("selectAll");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(td);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

async function commitTableEdit() {
  if (tableCommitState && !tableCommitState.failed) return tableCommitState.promise;
  if (!editingCell) return;
  const target = { ...editingCell };
  const { id, row, col } = target;
  const td = tableTd(id, row, col);
  const text = td ? String(td.textContent || "") : editCellPrev;
  const state = { failed: false, promise: null };
  const operation = (async () => {
    await command("setTableCell", { row, col, text });
    if (
      editingCell?.id === target.id &&
      editingCell?.row === target.row &&
      editingCell?.col === target.col
    ) {
      editingCell = null;
      if (td) {
        td.contentEditable = "false";
        td.removeAttribute("contenteditable");
        td.classList.remove("is-editing-cell");
      }
      render();
    }
  })();
  state.promise = operation;
  tableCommitState = state;
  try {
    await operation;
  } catch (error) {
    state.failed = true;
    throw error;
  } finally {
    if (!state.failed && tableCommitState === state) tableCommitState = null;
  }
}

async function flushPendingNotes() {
  if (notesCommitState && !notesCommitState.failed) return notesCommitState.promise;
  clearTimeout(notesTimer);
  notesTimer = 0;
  if (!pendingNotes) return;
  const pending = pendingNotes;
  const state = { failed: false, promise: null };
  const operation = command("setNotes", {
    notes: pending.notes,
    pageIndex: pending.pageIndex,
  }).then(() => {
    if (pendingNotes === pending) pendingNotes = null;
  });
  state.promise = operation;
  notesCommitState = state;
  try {
    await operation;
  } catch (error) {
    state.failed = true;
    throw error;
  } finally {
    if (!state.failed && notesCommitState === state) notesCommitState = null;
  }
}

/** Commit editor-local values before changing context or reading PPTD from disk. */
async function settlePendingEdits() {
  if (editingId) await commitTextEdit();
  if (editingCell) await commitTableEdit();
  while (pendingNotes) await flushPendingNotes();
  while (chartDraft?.dirty) await flushPendingChartDraft();
  // A capture-phase pointer handler may have started a commit immediately
  // before the action's click handler reached this function.
  await commandTail;
}

function pendingLocalCommit() {
  const pending = [textCommitState, tableCommitState, notesCommitState]
    .filter(Boolean)
    .map((state) => state.promise);
  return pending.length ? Promise.all(pending) : null;
}

function cancelTableEdit() {
  if (!editingCell) return;
  const td = tableTd(editingCell.id, editingCell.row, editingCell.col);
  if (td) {
    td.textContent = editCellPrev;
    td.contentEditable = "false";
    td.removeAttribute("contenteditable");
    td.classList.remove("is-editing-cell");
  }
  editingCell = null;
}

async function moveTableCell(dr, dc, extend = false) {
  const id =
    editingCell?.id ||
    tableFocusId ||
    (selectedEl()?.type === "table" ? selectedEl().id : null);
  const el = tableElById(id);
  if (!el) return;
  if (editingCell) await commitTableEdit();
  const next = clampCell(el, tableCell.row + dr, tableCell.col + dc);
  tableCell = next;
  if (!extend) tableAnchor = { ...next };
  paintCellSelection(el.id);
  renderCtxBar();
}

async function tableToolbar(fn) {
  if (editingCell) await commitTableEdit();
  const result = await fn();
  const el = selectedEl();
  if (el?.type === "table") {
    tableCell = clampCell(el, tableCell.row, tableCell.col);
    tableAnchor = clampCell(el, tableAnchor.row, tableAnchor.col);
    tableFocusId = el.id;
    paintCellSelection(el.id);
    renderCtxBar();
  }
  return result;
}

function isCtxChrome(target) {
  return Boolean(target?.closest?.("#ctx-bar, .ctx-pop, #text-link-dialog"));
}

function isSolidHex(value) {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value || "").trim());
}

const VIEWED_PROJECTS_STORE = "oss.viewed.projects";

function noteProjectViewed(p) {
  try {
    if (!p) return;
    const raw = JSON.parse(localStorage.getItem(VIEWED_PROJECTS_STORE) || "[]");
    const seen = new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []);
    seen.add(String(p));
    localStorage.setItem(VIEWED_PROJECTS_STORE, JSON.stringify([...seen].slice(-200)));
  } catch {
    // private mode etc: history filtering just stays off
  }
}

/** Stable per-tab id (sessionStorage survives reload but not duplication). */
function editorTabId() {
  try {
    let id = sessionStorage.getItem("oss:tabId");
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem("oss:tabId", id);
    }
    return id;
  } catch {
    return "default";
  }
}

/** Last disk revision the server confirmed — sent as baseRevision on edits. */
let lastDiskRevision = "";

async function api(path, opts) {
  // Every editor call carries its project so concurrent browsers/tabs keep
  // separate live sessions server-side instead of racing one global project.
  let target = nativeApi(path);
  try {
    const cur = typeof currentProjectPath === "function" ? currentProjectPath() : "";
    if (cur && !/[?&]project=/.test(target)) {
      target += `${target.includes("?") ? "&" : "?"}project=${encodeURIComponent(cur)}`;
    }
    if (!/[?&]tab=/.test(target)) {
      target += `${target.includes("?") ? "&" : "?"}tab=${encodeURIComponent(editorTabId())}`;
    }
  } catch {
    // fall through with the original target
  }
  const res = await fetch(target, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const data = await res.json();
    if (target.includes("/api/open")) {
      try {
        const u = new URL(target, location.origin);
        let fromBody = "";
        const rawBody = opts?.body;
        if (typeof rawBody === "string") {
          try {
            fromBody = JSON.parse(rawBody)?.path || "";
          } catch {
            fromBody = "";
          }
        } else if (rawBody && typeof rawBody === "object") {
          fromBody = rawBody.path || "";
        }
        noteProjectViewed(u.searchParams.get("project") || fromBody);
      } catch {
        // ignore malformed bodies
      }
    }
    if (typeof data?.revision === "string" && data.revision) {
      lastDiskRevision = data.revision;
    }
    if (!res.ok) {
      const error = new Error(data.error || res.statusText);
      error.status = res.status;
      if (data?.code) error.code = data.code;
      if (data?.comment) error.comment = data.comment;
      if (data?.missingElementIds) error.missingElementIds = data.missingElementIds;
      throw error;
    }
    return data;
  }
  if (!res.ok) throw new Error(res.statusText);
  return res;
}

function canvasChartSwatch(el, i) {
  const declaredSeriesCount = Array.isArray(el.chartSeries) ? el.chartSeries.length : 0;
  const dataSeriesCount = Math.max(0, (el.chartData?.cols?.length || 0) - 1);
  const seriesCount = Math.max(declaredSeriesCount, dataSeriesCount);
  return chartSwatch(
    { colors: el.chartColors, series: el.chartSeries, data: el.chartData },
    i,
    seriesCount,
  );
}

function chartSemanticInput(el) {
  return {
    data: el.chartData || { cols: [], rows: [] },
    series:
      Array.isArray(el.chartSeries) && el.chartSeries.length
        ? el.chartSeries
        : [{ type: el.chartType || "bar" }],
  };
}

function chartNumber(value, signed = false) {
  return formatChartValue(value, undefined, { signed });
}

/**
 * Shared painter plumbing: resolve the legend spec, run the same chartLayout
 * the exporter uses, and convert every rect to the element's local frame.
 * `tickLabels`/`categoryLabels` feed the axis reserves.
 */
function chartLayoutFor(el, categorical, opts = {}) {
  const w = el.bounds[2];
  const h = el.bounds[3];
  const legend = resolveChartLegend(el.chartLegend);
  const axis = el.chartAxis || {};
  const scale = opts.scale || categorical?.scale;
  const tickDecimals = scale ? scale.tickDecimals : 0;
  const tickLabels = scale
    ? scale.ticks.map((t) => formatChartValue(t, tickDecimals))
    : ["0"];
  const widestTickLabel = tickLabels.reduce(
    (best, label) => (label.length > best.length ? label : best),
    "",
  );
  const categories = categorical?.categories ?? opts.categories ?? [];
  const widestCategoryLabel = categories.reduce(
    (best, label) => (String(label).length > best.length ? String(label) : best),
    "",
  );
  const secondaryScale = opts.secondaryScale;
  const widestSecondaryTickLabel = secondaryScale
    ? secondaryScale.ticks
        .map((t) => formatChartValue(t, secondaryScale.tickDecimals))
        .reduce((best, label) => (label.length > best.length ? label : best), "")
    : undefined;
  const kind = chartKind(chartSemanticInput(el));
  const legendItems =
    kind === "pie"
      ? categories
      : (categorical?.series ?? []).map((series) => series.name);
  const layout = chartLayout({ w, h }, {
    title: el.chartTitle || opts.title || "",
    legend,
    legendItems,
    widestTickLabel,
    widestCategoryLabel,
    categoryCount: Math.max(1, categories.length),
    hasSecondaryAxis: Boolean(secondaryScale),
    widestSecondaryTickLabel,
    axis: {
      x: axis.x,
      y: axis.y,
      secondaryY: axis.secondaryY,
    },
    reserveBelowLabel:
      kind !== "pie" &&
      kind !== "scatter" &&
      kind !== "waterfall" &&
      categorical?.orientation !== "horizontal" &&
      ((scale?.min ?? 0) < 0 || (secondaryScale?.min ?? 0) < 0),
  });
  return { legend, layout, scale, tickDecimals };
}

function legendSvg(layout, swatch, ink, fontPx = CHART_TEXT_PX.legend, names) {
  if (!layout.legend) return "";
  return layout.legend.items
    .map((item, index) => {
      const label = names?.[index] ?? item.name;
      return `<rect x="${item.swatch.x}" y="${item.swatch.y}" width="${item.swatch.w}" height="${item.swatch.h}" fill="${escapeHtmlText(swatch(index))}"></rect>` +
        `<text x="${item.textAnchor.x}" y="${item.textAnchor.y}" font-size="${fontPx}" fill="${ink}">${escapeHtmlText(label)}</text>`;
    })
    .join("");
}

/** Value-axis grid + tick labels for a shared scale inside `plot`. */
function valueGridSvg(plot, scale, ink, gridColor, opts = {}) {
  const range = Math.max(1e-9, scale.max - scale.min);
  const yFor = (v) => plot.y + plot.h - ((v - scale.min) / range) * plot.h;
  const lines = scale.ticks
    .map((tick) => {
      const y = yFor(tick);
      const label = formatChartValue(tick, scale.tickDecimals);
      const secondary = opts.secondaryScale
        ? `<text x="${plot.x + plot.w + 6}" y="${y + 3}" text-anchor="start" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(
            formatChartValue(
              opts.secondaryScale.min +
                ((tick - scale.min) / range) *
                  (opts.secondaryScale.max - opts.secondaryScale.min),
              opts.secondaryScale.tickDecimals,
            ),
          )}</text>`
        : "";
      return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="${gridColor}" stroke-width="1"/><text x="${plot.x - 6}" y="${y + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(label)}</text>${secondary}`;
    })
    .join("");
  return { svg: lines, yFor };
}

function paintWaterfallSvg(el, w, h, titleSvg, axisSvg, ink, gridColor) {
  const model = waterfallChartModel(chartSemanticInput(el));
  const { layout } = chartLayoutFor(el, null, {
    scale: model.scale,
    categories: model.bars.map((bar) => bar.label),
  });
  const plot = layout.plot;
  const valueMin = model.scale.min;
  const range = Math.max(1e-9, model.scale.max - valueMin);
  const yFor = (value) => plot.y + ((model.scale.max - value) / range) * plot.h;
  const group = plot.w / Math.max(1, model.bars.length);
  const barW = Math.max(8, Math.min(46, group * 0.58));
  const grid = model.scale.ticks
    .map((tick) => {
      const y = yFor(tick);
      return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="${gridColor}" stroke-width="1"/><text x="${plot.x - 6}" y="${y + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(formatChartValue(tick, model.scale.tickDecimals))}</text>`;
    })
    .join("");
  const bars = model.bars
    .map((bar, index) => {
      const centerX = plot.x + group * (index + 0.5);
      const x = centerX - barW / 2;
      const yTop = Math.max(plot.y, yFor(Math.max(bar.start, bar.end)));
      const yBottom = Math.min(plot.y + plot.h, yFor(Math.min(bar.start, bar.end)));
      const height = Math.max(2, yBottom - yTop);
      const color =
        bar.kind === "increase"
          ? "#10B981"
          : bar.kind === "decrease"
            ? "#EF4444"
            : bar.kind === "subtotal"
              ? "#F59E0B"
              : "#2563EB";
      const value = chartNumber(
        bar.value,
        bar.kind === "increase" || bar.kind === "decrease",
      );
      const labelY = Math.max(plot.y + 11, yTop - 4);
      const categoryY = layout.categoryBand
        ? layout.categoryBand.y + CHART_TEXT_PX.category
        : plot.y + plot.h + 14;
      const next = model.bars[index + 1];
      const connector = next
        ? `<line x1="${x + barW}" y1="${yFor(next.kind === "total" ? bar.end : next.start)}" x2="${plot.x + group * (index + 1.5) - barW / 2}" y2="${yFor(next.kind === "total" ? bar.end : next.start)}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3 3"/>`
        : "";
      return `${connector}<rect x="${x}" y="${yTop}" width="${barW}" height="${height}" rx="1" fill="${color}"/><text x="${centerX}" y="${labelY}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(value)}</text><text x="${centerX}" y="${categoryY}" text-anchor="middle" font-size="${CHART_TEXT_PX.category}" fill="${ink}">${escapeHtmlText(bar.label)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" font-family="${SLIDE_FONT_STACK}">${titleSvg}${grid}${bars}${axisSvg}</svg>`;
}

function paintScatterSvg(el, w, h, titleSvg, ink, gridColor) {
  const model = scatterChartModel(chartSemanticInput(el));
  const { layout } = chartLayoutFor(el, null, {
    scale: model.yScale,
    categories: [],
  });
  const plot = layout.plot;
  const xRange = Math.max(1e-9, model.xMax - model.xMin);
  const yRange = Math.max(1e-9, model.yMax - model.yMin);
  const xFor = (value) => plot.x + ((value - model.xMin) / xRange) * plot.w;
  const yFor = (value) => plot.y + ((model.yMax - value) / yRange) * plot.h;
  const xThreshold = model.xMin + xRange * 0.7;
  const yThreshold = model.yMin + yRange * 0.7;
  const thresholdX = xFor(xThreshold);
  const thresholdY = yFor(yThreshold);
  const quadrants = `<rect x="${plot.x}" y="${plot.y}" width="${thresholdX - plot.x}" height="${thresholdY - plot.y}" fill="#FEF3C7" opacity="0.45"/><rect x="${thresholdX}" y="${plot.y}" width="${plot.x + plot.w - thresholdX}" height="${thresholdY - plot.y}" fill="#FEE2E2" opacity="0.7"/><rect x="${plot.x}" y="${thresholdY}" width="${thresholdX - plot.x}" height="${plot.y + plot.h - thresholdY}" fill="#ECFDF5" opacity="0.7"/><rect x="${thresholdX}" y="${thresholdY}" width="${plot.x + plot.w - thresholdX}" height="${plot.y + plot.h - thresholdY}" fill="#FEF3C7" opacity="0.45"/>`;
  const grid =
    model.xScale.ticks
      .map((tick) => {
        const x = xFor(tick);
        return `<line x1="${x}" y1="${plot.y}" x2="${x}" y2="${plot.y + plot.h}" stroke="${gridColor}" stroke-width="1"/><text x="${x}" y="${plot.y + plot.h + 13}" text-anchor="middle" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(formatChartValue(tick, model.xScale.tickDecimals))}</text>`;
      })
      .join("") +
    model.yScale.ticks
      .map((tick) => {
        const y = yFor(tick);
        return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="${gridColor}" stroke-width="1"/><text x="${plot.x - 7}" y="${y + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(formatChartValue(tick, model.yScale.tickDecimals))}</text>`;
      })
      .join("");
  const placements = placeScatterLabels(
    model.points.map((point) => ({
      label: point.label,
      x: xFor(point.x),
      y: yFor(point.y),
    })),
    { left: 2, top: 4, right: w - 2, bottom: h - 3 },
    9,
  );
  const points = placements
    .map(({ label, pointX, pointY, textX, baseline, anchor }) =>
      `<circle cx="${pointX}" cy="${pointY}" r="6" fill="#DC2626" stroke="#FFFFFF" stroke-width="2"/><text x="${textX}" y="${baseline}" text-anchor="${anchor}" font-size="${CHART_TEXT_PX.scatterLabel}" font-weight="600" fill="#0B1F3A" style="paint-order:stroke;stroke:#FFFFFF;stroke-width:3px;stroke-linejoin:round;">${escapeHtmlText(label)}</text>`,
    )
    .join("");
  const axes = `<text x="${plot.x + plot.w / 2}" y="${h - 3}" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(el.chartAxis?.x || model.xName)}</text><text transform="translate(10 ${plot.y + plot.h / 2}) rotate(-90)" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(el.chartAxis?.y || model.yName)}</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" font-family="${SLIDE_FONT_STACK}">${titleSvg}${quadrants}${grid}${points}${axes}</svg>`;
}

function paintComboChartSvg(
  el,
  w,
  h,
  titleSvg,
  categorical,
  swatch,
  ink,
  gridColor,
  showLabels,
) {
  const primarySeries = categorical.series.filter((series) => series.axis !== "secondary");
  const secondarySeries = categorical.series.filter((series) => series.axis === "secondary");
  const primaryScale = categorical.scale;
  const secondaryScale = secondarySeries.length
    ? alignedSecondaryScale(
        secondarySeries.flatMap((series) => series.values),
        primaryScale,
      )
    : undefined;
  const { layout } = chartLayoutFor(el, categorical, {
    secondaryScale,
  });
  const plot = layout.plot;
  const yFor = (value, axis) => {
    const scale = axis === "secondary" ? secondaryScale : primaryScale;
    if (!scale) return plot.y + plot.h;
    const range = Math.max(1e-9, scale.max - scale.min);
    return plot.y + plot.h - ((value - scale.min) / range) * plot.h;
  };
  const zeroY = yFor(0, "primary");
  const grid = primaryScale.ticks
    .map((tick) => {
      const y = yFor(tick, "primary");
      const left = formatChartValue(tick, primaryScale.tickDecimals);
      const right = secondaryScale
        ? formatChartValue(
            secondaryScale.min +
              ((tick - primaryScale.min) /
                Math.max(1e-9, primaryScale.max - primaryScale.min)) *
                (secondaryScale.max - secondaryScale.min),
            secondaryScale.tickDecimals,
          )
        : "";
      return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="${gridColor}" stroke-width="1"/><text x="${plot.x - 6}" y="${y + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(left)}</text>${secondaryScale ? `<text x="${plot.x + plot.w + 6}" y="${y + 3}" text-anchor="start" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(right)}</text>` : ""}`;
    })
    .join("");
  const categories = categorical.categories;
  const xStep = categories.length ? plot.w / categories.length : plot.w;
  const barSeries = categorical.series.filter((series) => series.kind === "bar");
  const barWidth = Math.max(4, Math.min(34, (xStep * 0.62) / Math.max(1, barSeries.length)));
  const bars = barSeries
    .map((series, seriesIndex) =>
      series.values
        .map((value, rowIndex) => {
          const groupWidth = barWidth * barSeries.length;
          const x = plot.x + xStep * (rowIndex + 0.5) - groupWidth / 2 + seriesIndex * barWidth;
          const axisScale = series.axis === "secondary" ? secondaryScale : primaryScale;
          const baseY = axisScale
            ? yFor(Math.max(axisScale.min, 0), series.axis)
            : zeroY;
          const y = yFor(value, series.axis);
          const top = Math.min(y, baseY);
          const height = Math.max(1, Math.abs(baseY - y));
          const color = swatch(categorical.series.indexOf(series));
          const label = showLabels && value !== 0
            ? `<text x="${x + barWidth / 2}" y="${value >= 0 ? Math.max(plot.y + 11, top - 4) : top + height + 11}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(formatChartValue(value))}</text>`
            : "";
          return `<rect x="${x}" y="${top}" width="${Math.max(1, barWidth - 2)}" height="${height}" fill="${color}"/>${label}`;
        })
        .join(""),
    )
    .join("");
  const lines = categorical.series
    .filter((series) => series.kind === "line" || series.kind === "area")
    .map((series) => {
      const color = swatch(categorical.series.indexOf(series));
      const points = series.values.map((value, index) => ({
        x: plot.x + xStep * (index + 0.5),
        y: yFor(value, series.axis),
        value,
      }));
      const pointList = points.map((point) => `${point.x},${point.y}`).join(" ");
      const area =
        series.kind === "area" && points.length
          ? `<polygon points="${pointList} ${points.at(-1).x},${zeroY} ${points[0].x},${zeroY}" fill="${color}33"/>`
          : "";
      const labels = showLabels
        ? points
            .map(
              (point) =>
                `<text x="${point.x}" y="${Math.max(plot.y + 11, point.y - 7)}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(formatChartValue(point.value))}</text>`,
            )
            .join("")
        : "";
      const dots = points
        .map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3" fill="${color}"/>`)
        .join("");
      return `${area}<polyline points="${pointList}" fill="none" stroke="${color}" stroke-width="3"/>${dots}${labels}`;
    })
    .join("");
  const categoryLabels = categories
    .map((category, index) => {
      const y = layout.categoryBand
        ? layout.categoryBand.y + CHART_TEXT_PX.category
        : plot.y + plot.h + 14;
      return `<text x="${plot.x + xStep * (index + 0.5)}" y="${y}" text-anchor="middle" font-size="${CHART_TEXT_PX.category}" fill="${ink}">${escapeHtmlText(category)}</text>`;
    })
    .join("");
  const legend = legendSvg(layout, swatch, ink);
  const axisTitles =
    (layout.axisTitleX
      ? `<text x="${layout.axisTitleX.x + layout.axisTitleX.w / 2}" y="${layout.axisTitleX.y + layout.axisTitleX.h - 3}" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(el.chartAxis?.x || "")}</text>`
      : "") +
    (layout.axisTitleY
      ? `<text transform="translate(${layout.axisTitleY.x + CHART_TEXT_PX.axisTitle - 2} ${layout.axisTitleY.y + layout.axisTitleY.h / 2}) rotate(-90)" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(el.chartAxis?.y || "")}</text>`
      : "") +
    (layout.axisTitleSecondaryY
      ? `<text transform="translate(${layout.axisTitleSecondaryY.x + 4} ${layout.axisTitleSecondaryY.y + layout.axisTitleSecondaryY.h / 2}) rotate(90)" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(el.chartAxis?.secondaryY || "")}</text>`
      : "");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" font-family="${SLIDE_FONT_STACK}">${titleSvg}${grid}${bars}${lines}${categoryLabels}${legend}${axisTitles}</svg>`;
}

/**
 * The colour actually behind an element: its own background, else the topmost
 * opaque element painted under it — a chart dropped onto a dark panel is the
 * common case — else the page background. The native exporter composites the
 * same underlay, so the preview and the exported PPTX agree on chart ink.
 */
function chartBackdropCss(el) {
  const elements = Array.isArray(model?.elements) ? model.elements : [];
  // The painter may be handed a copy of the element, so locate it by id.
  const index = elements.findIndex((candidate) => candidate === el || (el.id && candidate.id === el.id));
  if (index <= 0) return "";
  const [x, y, w, h] = el.bounds || [0, 0, 0, 0];
  let backdrop = "";
  for (let i = 0; i < index; i += 1) {
    const other = elements[i];
    if (!other || other.hidden) continue;
    // Canvas elements expose their paint as a CSS colour (`fillCss`), the same
    // value the shape renderer uses.
    const fill = other.fillCss;
    if (!isSolidHex(fill)) continue;
    const bounds = other.bounds || [0, 0, 0, 0];
    if (bounds[0] <= x && bounds[1] <= y && bounds[0] + bounds[2] >= x + w && bounds[1] + bounds[3] >= y + h) {
      backdrop = fill;
    }
  }
  return backdrop;
}

function paintChartSvg(el) {
  const w = el.bounds[2];
  const h = el.bounds[3];
  const title = escapeHtmlText(el.chartTitle || "");
  const semanticInput = chartSemanticInput(el);
  const type = chartKind(semanticInput);
  // Deck text is LLM/user data — everything interpolated into the SVG string
  // is escaped so a hostile title/label cannot pivot into markup.
  const swatch = (i) => escapeHtmlText(canvasChartSwatch(el, i));
  const chartSurfaceCss = el.chartBackgroundCss || chartBackdropCss(el) || model?.backgroundCss || "";
  const darkSurface = typeof isDarkCss === "function" && isDarkCss(chartSurfaceCss);
  const ink = darkSurface ? CHART_INK.dark : CHART_INK.light;
  const gridColor = darkSurface ? CHART_GRID.dark : CHART_GRID.light;
  const axis = el.chartAxis || {};
  const axisSvg =
    (axis.x
      ? `<text x="${w / 2}" y="${h - 4}" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(axis.x)}</text>`
      : "") +
    (axis.y
      ? `<text transform="translate(10 ${h / 2}) rotate(-90)" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(axis.y)}</text>`
      : "");
  const showLabels = el.chartLabels !== false;
  const focusRow = el.chartFocusRow ?? chartFocusRow;
  const titleSvg = title ? `<text x="12" y="18" font-size="${CHART_TEXT_PX.title}" fill="${ink}">${title}</text>` : "";
  if (type === "waterfall") {
    return paintWaterfallSvg(el, w, h, titleSvg, axisSvg, ink, gridColor);
  }
  if (type === "scatter") {
    return paintScatterSvg(el, w, h, titleSvg, ink, gridColor);
  }
  const categorical = categoricalChartModel(semanticInput);
  const combo =
    new Set(categorical.series.map((series) => series.kind)).size >= 2 &&
    categorical.series.some((series) => series.axis === "secondary");
  if (combo) {
    return paintComboChartSvg(
      el,
      w,
      h,
      titleSvg,
      categorical,
      swatch,
      ink,
      gridColor,
      showLabels,
    );
  }
  const categories = categorical.categories;
  const chartSeries = categorical.series;
  const seriesCount = Math.max(1, chartSeries.length);
  const vals = chartSeries[0]?.values || [];
  const scale = categorical.scale;
  const range = Math.max(1e-9, scale.max - scale.min);
  const { layout } = chartLayoutFor(el, categorical);
  const plot = layout.plot;
  const yFor = (v) => plot.y + plot.h - ((v - scale.min) / range) * plot.h;
  const zeroY = yFor(Math.max(scale.min, Math.min(0, scale.max)));
  const catBandY = layout.categoryBand
    ? layout.categoryBand.y + CHART_TEXT_PX.category
    : plot.y + plot.h + 13;
  const valueDecimals = seriesDecimals(chartSeries.flatMap((s) => s.values));
  const valueText = (v) => formatChartValue(v, valueDecimals || undefined);
  const gridSvg =
    type === "pie"
      ? ""
      : scale.ticks
          .map((tick) => {
            const y = yFor(tick);
            return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="${gridColor}" stroke-width="1"/><text x="${plot.x - 6}" y="${y + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(formatChartValue(tick, scale.tickDecimals))}</text>`;
          })
          .join("");
  const legend = legendSvg(
    layout,
    swatch,
    ink,
    CHART_TEXT_PX.legend,
    type === "pie" ? categories : chartSeries.map((s) => s.name),
  );
  const axisTitlesSvg =
    (layout.axisTitleX
      ? `<text x="${layout.axisTitleX.x + layout.axisTitleX.w / 2}" y="${layout.axisTitleX.y + layout.axisTitleX.h - 3}" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(axis.x || "")}</text>`
      : "") +
    (layout.axisTitleY
      ? `<text transform="translate(${layout.axisTitleY.x + CHART_TEXT_PX.axisTitle - 2} ${layout.axisTitleY.y + layout.axisTitleY.h / 2}) rotate(-90)" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(axis.y || "")}</text>`
      : "");
  if (type === "pie") {
    const sum = vals.reduce((a, b) => a + b, 0);
    const cx = layout.plot.x + layout.plot.w / 2;
    const cy = layout.plot.y + layout.plot.h / 2;
    const r = Math.min(layout.plot.w, layout.plot.h) / 2;
    if (sum <= 0) {
      return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" font-family="${SLIDE_FONT_STACK}">${titleSvg}${legend}${axisSvg}</svg>`;
    }
    let a0 = -Math.PI / 2;
    const parts = [];
    vals.forEach((v, i) => {
      if (v <= 0) return;
      const a1 = a0 + (v / sum) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const d = `M ${cx} ${cy} L ${cx + Math.cos(a0) * r} ${cy + Math.sin(a0) * r} A ${r} ${r} 0 ${large} 1 ${cx + Math.cos(a1) * r} ${cy + Math.sin(a1) * r} Z`;
      parts.push(`<path d="${d}" fill="${swatch(i)}"></path>`);
      if (showLabels) {
        const mid = (a0 + a1) / 2;
        const lx = cx + Math.cos(mid) * r * 0.55;
        const ly = cy + Math.sin(mid) * r * 0.55;
        const pct = Math.round((v / sum) * 100);
        const name = categories[i] ?? "";
        parts.push(`<text x="${lx}" y="${ly}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(name)} ${pct}%</text>`);
      }
      a0 = a1;
    });
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" font-family="${SLIDE_FONT_STACK}">${titleSvg}${parts.join("")}${legend}${axisSvg}</svg>`;
  }
  const iw = plot.w;
  const ih = plot.h;
  if (type === "area" || type === "line") {
    const xStep = iw / Math.max(1, categories.length);
    const center = (i) => plot.x + xStep * i + xStep / 2;
    const paths = chartSeries.map((series, s) => {
      const col = series.values;
      const pts = col.map((v, i) => `${center(i)},${yFor(v)}`).join(" ");
      const color = swatch(s);
      const valueLabs = showLabels
        ? col
            .map((v, i) => {
              const x = center(i);
              const y = yFor(v);
              const above = v >= 0;
              return `<text x="${x}" y="${above ? Math.max(plot.y + 11, y - 6) : y + 14}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(valueText(v))}</text>`;
            })
            .join("")
        : "";
      if (type === "area") {
        const lastX = center(categories.length - 1);
        const base = `${lastX},${zeroY} ${center(0)},${zeroY}`;
        return `<polygon fill="${color}55" stroke="${color}" stroke-width="2" points="${pts} ${base}"></polygon>${valueLabs}`;
      }
      const dots = col
        .map((v, i) => `<circle cx="${center(i)}" cy="${yFor(v)}" r="3" fill="${color}"/>`)
        .join("");
      return `<polyline fill="none" stroke="${color}" stroke-width="3" points="${pts}"></polyline>${dots}${valueLabs}`;
    }).join("");
    const catLabs = categories
      .map((category, i) => `<text x="${center(i)}" y="${catBandY}" text-anchor="middle" font-size="${CHART_TEXT_PX.category}" fill="${ink}">${escapeHtmlText(category)}</text>`)
      .join("");
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" font-family="${SLIDE_FONT_STACK}">${titleSvg}${gridSvg}${paths}${catLabs}${legend}${axisTitlesSvg}</svg>`;
  }
  if (categorical.orientation === "horizontal") {
    const hPlot = {
      x: plot.x + measureChartTextMax(categories, CHART_TEXT_PX.category) + 8,
      y: plot.y,
      w: Math.max(1, plot.x + plot.w - (plot.x + measureChartTextMax(categories, CHART_TEXT_PX.category) + 8)),
      h: plot.h,
    };
    const xFor = (v) => hPlot.x + ((v - scale.min) / range) * hPlot.w;
    const zeroX = xFor(Math.max(scale.min, Math.min(0, scale.max)));
    const grid = scale.ticks
      .map((tick) => {
        const x = xFor(tick);
        return `<line x1="${x}" y1="${hPlot.y}" x2="${x}" y2="${hPlot.y + hPlot.h}" stroke="${gridColor}" stroke-width="1"/><text x="${x}" y="${catBandY}" text-anchor="middle" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(formatChartValue(tick, scale.tickDecimals))}</text>`;
      })
      .join("");
    const groupGap = 7;
    const groupH = categories.length
      ? (hPlot.h - groupGap * Math.max(0, categories.length - 1)) / categories.length
      : hPlot.h;
    const barGap = 2;
    const barH = Math.max(3, (groupH - barGap * (seriesCount - 1)) / seriesCount);
    const bars = categories.map((category, rowIndex) => {
      const groupY = hPlot.y + rowIndex * (groupH + groupGap);
      const categoryLabel = `<text x="${hPlot.x - 7}" y="${groupY + groupH / 2 + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.category}" fill="${ink}">${escapeHtmlText(category)}</text>`;
      const items = chartSeries.map((series, seriesIndex) => {
        const value = series.values[rowIndex] || 0;
        const x0 = Math.min(xFor(value), zeroX);
        const x1 = Math.max(xFor(value), zeroX);
        const width = Math.max(1, x1 - x0);
        const y = groupY + seriesIndex * (barH + barGap);
        const fill = seriesCount === 1 ? swatch(rowIndex) : swatch(seriesIndex);
        const highlight = focusRow === rowIndex ? ` stroke="#2f86f0" stroke-width="2"` : "";
        const labelX = value >= 0 ? x1 + 4 : x0 - 4;
        const valueLabel = showLabels && value !== 0
          ? `<text x="${labelX}" y="${y + barH / 2 + 3}" text-anchor="${value >= 0 ? "start" : "end"}" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(valueText(value))}</text>`
          : "";
        return `<rect x="${x0}" y="${y}" width="${width}" height="${barH}" fill="${fill}"${highlight}></rect>${valueLabel}`;
      }).join("");
      return categoryLabel + items;
    }).join("");
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" font-family="${SLIDE_FONT_STACK}">${titleSvg}${grid}${bars}${legend}${axisTitlesSvg}</svg>`;
  }
  const groupGap = 10;
  const barGap = 2;
  const groupW = categories.length ? (iw - groupGap * (categories.length - 1)) / categories.length : iw;
  const bw = Math.max(3, (groupW - barGap * (seriesCount - 1)) / seriesCount);
  const bars = categories
    .map((category, i) => {
      const gx = plot.x + i * (groupW + groupGap);
      const parts = Array.from({ length: seriesCount }, (_, s) => {
        const v = chartSeries[s]?.values[i] || 0;
        const y = yFor(v);
        const top = Math.min(y, zeroY);
        const height = Math.max(1, Math.abs(zeroY - y));
        const x = gx + s * (bw + barGap);
        const fill = seriesCount === 1 ? swatch(i) : swatch(s);
        const hl = focusRow === i ? ` stroke="#2f86f0" stroke-width="2"` : "";
        // Same place as the exported outEnd label: just above a positive
        // bar, just below a negative one. The shared layout reserves both
        // bands, so the label stays off the fill and the category names.
        const labelY = v >= 0 ? top - 4 : top + height + 11;
        const valLab = showLabels && v !== 0
          ? `<text x="${x + bw / 2}" y="${labelY}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(valueText(v))}</text>`
          : "";
        return `<rect x="${x}" y="${top}" width="${bw}" height="${height}" fill="${fill}"${hl}></rect>${valLab}`;
      });
      const xLab = `<text x="${gx + groupW / 2}" y="${catBandY}" text-anchor="middle" font-size="${CHART_TEXT_PX.category}" fill="${ink}">${escapeHtmlText(category)}</text>`;
      return parts.join("") + xLab;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" font-family="${SLIDE_FONT_STACK}">${titleSvg}${gridSvg}${bars}${legend}${axisTitlesSvg}</svg>`;
}

function measureChartTextMax(labels, fontPx) {
  return labels.reduce(
    (best, label) => Math.max(best, measureChartText(String(label), fontPx)),
    0,
  );
}

function repaintChartNode(el, patch = {}) {
  const id = el?.id;
  const node = id ? slideElNode(id) : document.querySelector("#slide .el.selected");
  if (!node) return;
  const markup = paintChartSvg({ ...el, ...patch });
  const tmp = document.createElement("div");
  tmp.innerHTML = markup;
  const fresh = tmp.querySelector("svg");
  if (!fresh) return;
  const prev = node.querySelector("svg");
  if (prev) prev.replaceWith(fresh);
  else node.insertBefore(fresh, node.firstChild);
}

function iconKey(name) {
  return String(name || "star").replace(/^(fas|far|fab):/, "");
}

function paintIconSvg(el) {
  const fill = escapeHtmlText(el.fillCss || "#000000");
  const name = iconKey(el.iconName);
  const d = {
    star: "M12 2l2.9 6.6L22 9.3l-5 4.7 1.4 7L12 17.8 5.6 21l1.4-7-5-4.7 7.1-.7z",
    heart: "M12 21s-6.7-4.4-9.3-8.2C.7 10 1.2 6.6 4 5.3 6.2 4.3 8.4 5 12 8.2c3.6-3.2 5.8-3.9 8-2.9 2.8 1.3 3.3 4.7 1.3 7.5C18.7 16.6 12 21 12 21z",
    check: "M9.2 16.6L4.8 12.2l1.4-1.4 3 3 8.6-8.6 1.4 1.4z",
    xmark: "M6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z",
    plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
    minus: "M5 11h14v2H5z",
    house: "M12 3l9 8h-2v9h-6v-6H11v6H5v-9H3z",
    user: "M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z",
    gear: "M10 2h4l.6 2.4 2.2.9 2.1-1.4 2.8 2.8-1.4 2.1.9 2.2L23 10v4l-2.4.6-.9 2.2 1.4 2.1-2.8 2.8-2.1-1.4-2.2.9L14 23h-4l-.6-2.4-2.2-.9-2.1 1.4L2.3 18l1.4-2.1-.9-2.2L1 14v-4l2.4-.6.9-2.2L2.9 5.1 5.7 2.3l2.1 1.4 2.2-.9zm2 7a3 3 0 110 6 3 3 0 010-6z",
    lightbulb: "M9 21h6v-1H9zm3-19a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z",
    comment: "M4 4h16v12H7l-3 3z",
    envelope: "M3 6h18v12H3zm0 0l9 7 9-7",
    camera: "M9 6l1.5-2h3L15 6h4v12H5V6zm7 6a4 4 0 11-8 0 4 4 0 018 0z",
    file: "M6 3h8l4 4v14H6z",
    "magnifying-glass": "M10 4a6 6 0 014.9 9.6L20 18.7 18.7 20l-5.1-5.1A6 6 0 1110 4zm0 2a4 4 0 100 8 4 4 0 000-8z",
    bell: "M12 3a6 6 0 016 6v5l2 2H4l2-2V9a6 6 0 016-6zm-2 16h4a2 2 0 01-4 0z",
    bookmark: "M7 3h10v18l-5-3-5 3z",
    flag: "M5 3h1v18H5zm2 0h12l-3 4 3 4H7z",
    bolt: "M13 2L4 14h7l-1 8 10-14h-7z",
    circle: "M12 3a9 9 0 110 18 9 9 0 010-18z",
  };
  const path = d[name] || d.star;
  return `<svg viewBox="0 0 24 24" width="100%" height="100%"><path fill="${fill}" d="${path}"/></svg>`;
}

function paintShapeSvg(el) {
  return typeof shapePaintMarkup === "function" ? shapePaintMarkup(el) : null;
}

function replaceShapeSvg(node, el) {
  if (!node) return;
  const markup = paintShapeSvg(el);
  if (!markup) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = markup;
  const fresh = wrap.firstElementChild;
  if (!fresh) return;
  const svg = node.querySelector("svg.shape-paint, svg");
  if (svg) svg.replaceWith(fresh);
  else node.insertBefore(fresh, node.firstChild);
}

function liveShapeFill(el, css) {
  const node = slideElNode(el.id);
  if (!node) return;
  const svg = node.querySelector("svg.shape-paint, svg");
  const chip = document.querySelector("#pop-fill .ctx-chip");
  if (chip) chip.style.background = isSolidHex(css) ? css : (el.fillCss || css);
  if (!svg) {
    node.style.background = css;
    return;
  }
  svg.querySelector("#oss-live-fill")?.remove();
  if (isSolidHex(css)) {
    for (const p of svg.querySelectorAll("path")) {
      if (p.getAttribute("fill") !== "none") p.setAttribute("fill", css);
    }
    return;
  }
  const m = /linear-gradient\((\d+)deg,\s*([^)]+)\)/i.exec(String(css));
  if (!m) return;
  const angle = Number(m[1]);
  const rad = ((angle - 90) * Math.PI) / 180;
  const x1 = 50 - Math.cos(rad) * 50;
  const y1 = 50 - Math.sin(rad) * 50;
  const x2 = 50 + Math.cos(rad) * 50;
  const y2 = 50 + Math.sin(rad) * 50;
  const ns = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(ns, "defs");
  defs.id = "oss-live-fill";
  const lg = document.createElementNS(ns, "linearGradient");
  lg.id = "oss-live-grad";
  lg.setAttribute("gradientUnits", "userSpaceOnUse");
  lg.setAttribute("x1", String(x1));
  lg.setAttribute("y1", String(y1));
  lg.setAttribute("x2", String(x2));
  lg.setAttribute("y2", String(y2));
  for (const part of m[2].split(",")) {
    const bits = part.trim().split(/\s+/);
    const stop = document.createElementNS(ns, "stop");
    stop.setAttribute("offset", bits[1] || "0%");
    stop.setAttribute("stop-color", bits[0] || "#111");
    lg.append(stop);
  }
  defs.append(lg);
  svg.insertBefore(defs, svg.firstChild);
  for (const p of svg.querySelectorAll("path")) {
    if (p.getAttribute("fill") !== "none") p.setAttribute("fill", "url(#oss-live-grad)");
  }
}

function liveShapeBorder(el, border) {
  const node = slideElNode(el.id);
  const svg = node?.querySelector("svg.shape-paint, svg");
  if (!svg) {
    if (node && border?.width) {
      node.style.border = `${border.width}px ${border.style || "solid"} ${border.color || "#111"}`;
    }
    return;
  }
  const sw = Number(border?.width) || 0;
  const color = sw > 0 ? (border?.color || "#111") : "none";
  for (const p of svg.querySelectorAll("path")) {
    if (p.getAttribute("fill") === "none") {
      p.setAttribute("stroke", border?.color || "#111");
      p.setAttribute("stroke-width", String(sw || 1.5));
    } else {
      p.setAttribute("stroke", color);
      p.setAttribute("stroke-width", String(color === "none" ? 0 : sw));
    }
  }
}

async function remorphShapeLive(el, adj) {
  const gen = ++remorphGen;
  try {
    const q = new URLSearchParams({ name: el.shapeName || "rect" });
    if (adj?.length) q.set("adj", adj.join(","));
    const data = await api(`/api/shape-geometry?${q}`);
    if (gen !== remorphGen) return;
    const node = slideElNode(el.id);
    if (!node) return;
    replaceShapeSvg(node, { ...el, adjustments: adj, pathD: data.pathD, pathStroke: data.pathStroke });
    if (Array.isArray(data.handles)) {
      data.handles.forEach((h, i) => {
        const d = node.querySelector(`[data-handle="adj:${i}"]`);
        if (!d) return;
        d.style.left = `${h.x}%`;
        d.style.top = `${h.y}%`;
      });
    }
  } catch {
    /* live preview only */
  }
}

function scheduleRemorph(el, adj) {
  clearTimeout(remorphTimer);
  remorphTimer = setTimeout(() => remorphShapeLive(el, adj), 32);
}

function enterCropMode(id) {
  croppingId = id;
  render();
}

function exitCropMode() {
  if (!croppingId) return;
  croppingId = null;
  render();
  showToast(t("裁切修改已应用，可使用撤销恢复。"), 5000);
}

function applyCropShapeMask(node, el) {
  if (el.cropShape?.shapeName === "ellipse") node.style.borderRadius = "50%";
  if (el.cropShape?.shapeName === "roundRect") node.style.borderRadius = "18px";
  if (el.cropShape?.shapeName === "diamond") node.style.clipPath = "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)";
  if (el.cropShape?.shapeName === "hexagon") {
    node.style.clipPath = "polygon(25% 6%, 75% 6%, 100% 50%, 75% 94%, 25% 94%, 0 50%)";
  }
}

function applyImageCropDisplay(node, el) {
  const crop = el.crop || {};
  const l = crop.left || 0;
  const t = crop.top || 0;
  const r = crop.right || 0;
  const b = crop.bottom || 0;
  node.style.backgroundSize =
    el.fit === "contain" ? "contain" : el.fit === "fill" ? "100% 100%" : "cover";
  node.style.backgroundPosition = "center";
  if (l || t || r || b) {
    const zw = 1 / Math.max(0.08, 1 - l - r);
    const zh = 1 / Math.max(0.08, 1 - t - b);
    node.style.backgroundSize = `${zw * 100}% ${zh * 100}%`;
    node.style.backgroundPosition = `${(l / Math.max(0.01, l + r)) * 100}% ${(t / Math.max(0.01, t + b)) * 100}%`;
  }
  applyCropShapeMask(node, el);
}

function paintCropChromeStyles(node, c) {
  if (!node) return;
  const l = c.left || 0;
  const t = c.top || 0;
  const r = c.right || 0;
  const b = c.bottom || 0;
  const frame = node.querySelector(".crop-frame");
  if (frame) {
    frame.style.left = `${l * 100}%`;
    frame.style.top = `${t * 100}%`;
    frame.style.right = `${r * 100}%`;
    frame.style.bottom = `${b * 100}%`;
  }
  const tDim = node.querySelector(".crop-dim-t");
  if (tDim) tDim.style.height = `${t * 100}%`;
  const bDim = node.querySelector(".crop-dim-b");
  if (bDim) bDim.style.height = `${b * 100}%`;
  const lDim = node.querySelector(".crop-dim-l");
  if (lDim) {
    lDim.style.width = `${l * 100}%`;
    lDim.style.top = `${t * 100}%`;
    lDim.style.bottom = `${b * 100}%`;
  }
  const rDim = node.querySelector(".crop-dim-r");
  if (rDim) {
    rDim.style.width = `${r * 100}%`;
    rDim.style.top = `${t * 100}%`;
    rDim.style.bottom = `${b * 100}%`;
  }
}

function paintFaIcon(el) {
  const fill = escapeHtmlText(el.fillCss || "#000000");
  const raw = String(el.iconName || "fas:star");
  const [prefix, name] = raw.includes(":") ? raw.split(":") : ["fas", raw];
  const uni = faUnicode[name];
  if (!uni) return paintIconSvg(el);
  const family = prefix === "fab" ? "Font Awesome 6 Brands" : "Font Awesome 6 Free";
  const weight = prefix === "fas" ? 900 : 400;
  // uni comes from the bundled fa-unicode map; fill/family are escaped above.
  return `<span class="fa-icon" style="font-family:'${family}';font-weight:${weight};color:${fill};font-size:80%">&#x${escapeHtmlText(uni)};</span>`;
}

function linePathFromPoints(points, curve, w, h) {
  const pts = String(points || "")
    .trim()
    .split(/\s+/)
    .map((p) => p.split(",").map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite));
  if (pts.length < 2) return `M 0 ${h / 2} L ${w} ${h / 2}`;
  const [x0, y0] = pts[0];
  if (curve === "smooth" && pts.length >= 3) {
    if (pts.length === 3) return `M ${x0} ${y0} Q ${pts[1][0]} ${pts[1][1]} ${pts[2][0]} ${pts[2][1]}`;
    return `M ${x0} ${y0} C ${pts[1][0]} ${pts[1][1]} ${pts[2][0]} ${pts[2][1]} ${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}`;
  }
  return pts.map((p, i) => `${i ? "L" : "M"} ${p[0]} ${p[1]}`).join(" ");
}

function attachSelBox(node) {
  const box = document.createElement("div");
  box.className = "sel-box";
  node.append(box);
}

function attachHandles(node, el) {
  attachSelBox(node);
  const stem = document.createElement("i");
  stem.className = "handle-rot-stem";
  node.append(stem);
  const spots = [
    ["nw", 0, 0],
    ["n", 50, 0],
    ["ne", 100, 0],
    ["e", 100, 50],
    ["se", 100, 100],
    ["s", 50, 100],
    ["sw", 0, 100],
    ["w", 0, 50],
  ];
  for (const [dir, l, t] of spots) {
    const h = document.createElement("i");
    h.className = `handle handle-${dir}`;
    h.dataset.handle = dir;
    h.style.left = `${l}%`;
    h.style.top = `${t}%`;
    h.addEventListener("pointerdown", (ev) => startDrag(ev, el, dir));
    node.append(h);
  }
  const rot = document.createElement("i");
  rot.className = "handle handle-rot";
  rot.dataset.handle = "rot";
  rot.title = t("旋转");
  rot.innerHTML =
    '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M12.5 8a4.5 4.5 0 11-1.3-3.1" fill="none" stroke="#6b7280" stroke-width="1.6" stroke-linecap="round"/><path d="M11.2 2.8v2.6h2.6" fill="none" stroke="#6b7280" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  rot.addEventListener("pointerdown", (ev) => startDrag(ev, el, "rot"));
  node.append(rot);
}

function attachAdjHandles(node, el) {
  (el.adjustHandles || []).forEach((h, i) => {
    const d = document.createElement("i");
    d.className = "handle handle-adj";
    d.dataset.handle = `adj:${i}`;
    d.style.left = `${h.x}%`;
    d.style.top = `${h.y}%`;
    d.title = t("形状调整点");
    d.addEventListener("pointerdown", (ev) => startDrag(ev, el, `adj:${i}`));
    node.append(d);
  });
}

function animClass(effect) {
  const e = String(effect || "fade-in");
  if (e.includes("fly")) return "anim-play-fly";
  if (e.includes("zoom")) return "anim-play-zoom";
  if (e.includes("wipe")) return "anim-play-wipe";
  if (e.includes("float")) return "anim-play-float";
  return "anim-play-fade";
}

function paintSlide(target, m, opts = {}) {
  const interactive = opts.interactive !== false;
  const [sw, sh] = m.size;
  const groups = animationGroups(m.animations);
  const step = typeof opts.presentStep === "number" ? opts.presentStep : null;
  target.style.width = `${sw}px`;
  target.style.height = `${sh}px`;
  if (m.backgroundImage) {
    target.style.backgroundImage = `url("${mediaUrl(m.backgroundImage)}")`;
    target.style.backgroundColor = m.backgroundCss || "#111";
  } else {
    target.style.backgroundImage = "none";
    target.style.background = m.backgroundCss || "#fff";
  }
  target.innerHTML = "";
  if (m.generationPlaceholder) {
    target.classList.add("is-generation-placeholder");
    target.classList.remove("is-dark");
    const placeholder = document.createElement("div");
    placeholder.className = "generation-canvas-placeholder";
    const heading = document.createElement("strong");
    heading.textContent = generationActivity?.conversation?.mode === "discuss" ? t("先把想法聊清楚") : t("正在准备首张页面");
    const detail = document.createElement("span");
    detail.textContent = generationActivity?.conversation?.mode === "discuss" ? t("在左侧讨论主题、结构和风格。准备好了，就说“开始生成”。") : t("页面写入并完成检查后，会直接出现在这里。");
    placeholder.append(heading, detail);
    target.append(placeholder);
    return;
  }
  target.classList.remove("is-generation-placeholder");
  target.classList.toggle("is-dark", typeof isDarkCss === "function" && isDarkCss(m.backgroundCss));
  const ids = new Set(
    commentMode && interactive ? [] : m === model
      ? selectedIds()
      : m.selection?.kind === "element"
        ? [m.selection.elementId]
        : [],
  );
  for (const el of m.elements) {
    const [x, y, w, h] = el.bounds;
    const node = document.createElement("div");
    node.className = `el ${el.type}${ids.has(el.id) ? " selected" : ""}`;
    node.dataset.id = el.id;
    if (el.layoutRole) node.dataset.layoutRole = el.layoutRole;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;
    node.style.padding = "0";
    node.style.boxSizing = "border-box";
    node.style.opacity = String(el.opacity ?? 1);
    const flips = [];
    if (el.flipH) flips.push("scaleX(-1)");
    if (el.flipV) flips.push("scaleY(-1)");
    if (el.rotation) flips.push(`rotate(${el.rotation}deg)`);
    if (flips.length) node.style.transform = flips.join(" ");
    if (el.hidden) node.classList.add("is-hidden");
    if (el.locked) node.classList.add("is-locked");
    if (el.shadow) {
      const sh = el.shadow;
      node.style.boxShadow = `${sh.offsetX || 0}px ${sh.offsetY || 4}px ${sh.blur || 12}px ${sh.color || "rgba(0,0,0,.25)"}`;
    }
    if (step != null) {
      const gi = groups.findIndex((g) => g.some((a) => a.elementId === el.id));
      if (gi >= 0 && gi >= step) {
        node.classList.add("anim-hidden");
      } else if (gi >= 0 && gi === step - 1 && opts.playLast) {
        const hit = groups[gi].find((a) => a.elementId === el.id);
        node.classList.add(animClass(hit?.effect));
      }
    }
    if (el.type === "text") {
      const [ha, va] = el.align || ["left", "top"];
      applyTextStyleToNode(node, el);
      if (el.href) {
        node.dataset.href = el.href;
        node.title = el.href;
        node.classList.add("is-link");
      }
      if (el.wrap === false) node.style.whiteSpace = "nowrap";
      if (va === "middle" || va === "bottom") {
        node.style.display = "flex";
        node.style.flexDirection = "column";
        node.style.justifyContent = va === "bottom" ? "flex-end" : "center";
        node.style.alignItems =
          ha === "center" ? "center" : ha === "right" ? "flex-end" : "flex-start";
      }
      const runs = Array.isArray(el.runs) && el.runs.length ? el.runs : null;
      if (el.list) {
        const list = document.createElement(el.list === "number" ? "ol" : "ul");
        list.className = `text-list text-list-${el.list}`;
        const lines = String(el.text || "").split(/\n/);
        for (const line of lines) {
          const li = document.createElement("li");
          li.textContent = line;
          list.append(li);
        }
        node.append(list);
      } else if (runs) {
        appendTextRuns(node, runs);
      } else node.textContent = String(el.text || "");
    } else if (el.type === "shape") {
      const svg = paintShapeSvg(el);
      if (svg) {
        node.style.background = "transparent";
        node.innerHTML = svg;
      } else {
        node.style.background = el.fillCss || "transparent";
        if (el.shapeName === "ellipse") node.style.borderRadius = "50%";
        if (el.shapeName === "roundRect") node.style.borderRadius = "12px";
        if (el.border?.width) {
          node.style.border = `${el.border.width}px ${el.border.style || "solid"} ${el.border.color || "#111"}`;
        }
      }
    } else if (el.type === "image" && el.src) {
      const crop = el.crop || {};
      const l = crop.left || 0;
      const t = crop.top || 0;
      const r = crop.right || 0;
      const b = crop.bottom || 0;
      const cropping = interactive && croppingId === el.id;
      node.style.backgroundImage = `url("${mediaUrl(el.src)}")`;
      node.style.backgroundRepeat = "no-repeat";
      if (cropping) {
        node.classList.add("is-cropping");
        node.style.backgroundSize = "100% 100%";
        node.style.backgroundPosition = "0 0";
        const dim = (cls, style) => {
          const d = document.createElement("div");
          d.className = `crop-dim ${cls}`;
          Object.assign(d.style, style);
          node.append(d);
        };
        dim("crop-dim-t", { left: "0", top: "0", right: "0", height: `${t * 100}%` });
        dim("crop-dim-b", { left: "0", bottom: "0", right: "0", height: `${b * 100}%` });
        dim("crop-dim-l", { left: "0", top: `${t * 100}%`, width: `${l * 100}%`, bottom: `${b * 100}%` });
        dim("crop-dim-r", { right: "0", top: `${t * 100}%`, width: `${r * 100}%`, bottom: `${b * 100}%` });
        const frame = document.createElement("div");
        frame.className = "crop-frame";
        frame.style.left = `${l * 100}%`;
        frame.style.top = `${t * 100}%`;
        frame.style.right = `${r * 100}%`;
        frame.style.bottom = `${b * 100}%`;
        for (const [dir, left, top] of [
          ["nw", "0%", "0%"],
          ["n", "50%", "0%"],
          ["ne", "100%", "0%"],
          ["e", "100%", "50%"],
          ["se", "100%", "100%"],
          ["s", "50%", "100%"],
          ["sw", "0%", "100%"],
          ["w", "0%", "50%"],
        ]) {
          const h = document.createElement("i");
          h.className = `handle handle-crop handle-${dir}`;
          h.dataset.crop = dir;
          h.style.left = left;
          h.style.top = top;
          h.addEventListener("pointerdown", (ev) => startCropDrag(ev, el, dir));
          frame.append(h);
        }
        node.append(frame);
      } else {
        applyImageCropDisplay(node, el);
      }
    } else if (el.type === "table" && el.tableRows) {
      const table = document.createElement("table");
      table.className = "el-table";
      el.tableRows.forEach((row, ri) => {
        const tr = document.createElement("tr");
        row.forEach((cell, ci) => {
          const td = document.createElement("td");
          td.textContent = cell.text || "";
          if (cell.bold) td.style.fontWeight = "700";
          if (cell.color) td.style.color = cell.color;
          if (cell.fill) td.style.background = cell.fill;
          if (cell.rowSpan) td.rowSpan = cell.rowSpan;
          if (cell.colSpan) td.colSpan = cell.colSpan;
          if (cell.align?.[0]) td.style.textAlign = cell.align[0];
          if (ri === 0) td.classList.add("is-header");
          if (interactive) {
            const inRange = () => {
              const r1 = Math.min(tableAnchor.row, tableCell.row);
              const r2 = Math.max(tableAnchor.row, tableCell.row);
              const c1 = Math.min(tableAnchor.col, tableCell.col);
              const c2 = Math.max(tableAnchor.col, tableCell.col);
              return ri >= r1 && ri <= r2 && ci >= c1 && ci <= c2;
            };
            if (ids.has(el.id) && tableCell.row === ri && tableCell.col === ci) td.classList.add("is-cell");
            else if (ids.has(el.id) && inRange()) td.classList.add("is-cell-range");
            td.addEventListener("click", (ev) => {
              ev.stopPropagation();
              if (editingCell) {
                void commitTableEdit().catch((error) =>
                  showToast(t(`保存表格失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
              }
              tableFocusId = el.id;
              tableCell = { row: ri, col: ci };
              if (!ev.shiftKey) tableAnchor = { row: ri, col: ci };
              const mark = () => {
                paintCellSelection(el.id);
                renderCtxBar();
              };
              if (!selectedIds().includes(el.id)) {
                command("select", { elementId: el.id }).then(mark);
                return;
              }
              mark();
            });
            td.addEventListener("dblclick", (ev) => {
              ev.stopPropagation();
              tableFocusId = el.id;
              tableCell = { row: ri, col: ci };
              tableAnchor = { row: ri, col: ci };
              const edit = () => enterTableEdit(el.id, ri, ci);
              if (!selectedIds().includes(el.id)) {
                command("select", { elementId: el.id }).then(edit);
                return;
              }
              edit();
            });
          }
          tr.append(td);
        });
        table.append(tr);
      });
      node.append(table);
    } else if (el.type === "chart") {
      node.style.background = el.chartBackgroundCss || "transparent";
      node.innerHTML = paintChartSvg(el);
    } else if (el.type === "line") {
      const color = escapeHtmlText(el.border?.color || "#111");
      const width = el.border?.width || 3;
      const style = el.border?.style || "solid";
      const dash = style === "dash" ? "12 8" : style === "dot" ? "2 6" : "";
      const [start, end] = el.lineArrow || [null, null];
      const id = `ln${el.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
      const d = linePathFromPoints(el.linePoints, el.lineCurve, w, h);
      const join = el.lineCurve === "sharp" ? "miter" : "round";
      const marker = (kind, side) => {
        if (!kind) return "";
        return `<marker id="${id}-${side}" viewBox="0 0 10 10" refX="${side === "start" ? 1 : 9}" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="${kind === "diamond" ? "M5 1 L9 5 L5 9 L1 5 Z" : kind === "oval" ? "M5 1 A4 4 0 1 1 4.9 1 Z" : kind === "stealth" ? "M1 1 L9 5 L1 9 L3 5 Z" : "M0 0 L10 5 L0 10 Z"}" fill="${color}"/></marker>`;
      };
      const pts = String(el.linePoints || "")
        .trim()
        .split(/\s+/)
        .map((p) => p.split(",").map(Number));
      const handles =
        interactive && ids.has(el.id)
          ? pts
              .map((p, i) =>
                Number.isFinite(p[0])
                  ? `<circle class="bez" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="6" fill="#fff" stroke="#3b82f6" stroke-width="2" />`
                  : "",
              )
              .join("")
          : "";
      const edgeLabel = el.lineLabel
        ? `<text class="line-label" x="${w / 2}" y="${Math.max(12, h / 2 - 8)}" text-anchor="middle" font-size="10" font-style="italic" fill="${color}">${escapeHtmlText(el.lineLabel)}</text>`
        : "";
      node.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%"><defs>${marker(start, "start")}${marker(end, "end")}</defs><path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="${join}" ${dash ? `stroke-dasharray="${dash}"` : ""} ${start ? `marker-start="url(#${id}-start)"` : ""} ${end ? `marker-end="url(#${id}-end)"` : ""} />${edgeLabel}${handles}</svg>`;
    } else if (el.type === "icon") {
      node.innerHTML = paintFaIcon(el);
    } else {
      node.textContent = el.type;
    }
    if (interactive) {
      node.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (editingId === el.id) return;
        if (dragClickClaimId === el.id) {
          // Topmost element of a just-finished group move: the selection is the
          // result of that drag, so a lone re-select here would steal the group.
          dragClickClaimId = "";
          return;
        }
        if (ev.shiftKey) {
          // Pointer-down must preselect an unselected item before a possible
          // drag. The subsequent click belongs to that same gesture and must
          // not toggle the item off again after the async select completes.
          if (shiftPointerClaimId === el.id) {
            shiftPointerClaimId = "";
            return;
          }
          const next = new Set(selectedIds());
          if (next.has(el.id)) next.delete(el.id);
          else next.add(el.id);
          command("select", { elementIds: [...next] });
        } else {
          const cur = selectedIds();
          if (cur.length === 1 && cur[0] === el.id) return;
          command("select", { elementId: el.id });
        }
      });
      node.addEventListener("pointerdown", (ev) => {
        // A new pointer gesture supersedes any drag-only claim left by the
        // previous gesture. Otherwise keep the claim until its own click.
        shiftPointerClaimId = "";
        dragClickClaimId = "";
        if (ev.target.classList?.contains("handle")) return;
        if (editingId === el.id) return;
        const fromCell = Boolean(ev.target.closest?.("td"));
        if (fromCell && (editingCell || ev.target.closest("td")?.isContentEditable)) return;
        if (editingCell) {
          void commitTableEdit().catch((error) =>
            showToast(t(`保存表格失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
        }
        if (el.locked) return;
        if (!selectedIds().includes(el.id)) {
          if (ev.shiftKey) {
            // The select command repaints the element before click. Keep the
            // claim outside the node closure so the repainted node can consume
            // it and avoid a second toggle.
            shiftPointerClaimId = el.id;
            const next = new Set(selectedIds());
            next.add(el.id);
            command("select", { elementIds: [...next] });
          } else {
            command("select", { elementId: el.id });
          }
        }
        // Cells eat the whole table box. Click stays a cell select; drag past
        // the threshold moves the table (official-style grab-to-move).
        startDrag(ev, el, "move", { threshold: fromCell ? 8 : 0 });
      });
      node.addEventListener("dblclick", (ev) => {
        if (el.type !== "text") return;
        ev.stopPropagation();
        ev.preventDefault();
        enterTextEdit(el.id);
      });
      node.addEventListener("blur", () => {
        if (editingId !== el.id) return;
        setTimeout(() => {
          if (editingId !== el.id) return;
          const active = document.activeElement;
          if (isCtxChrome(active) || node.contains(active)) return;
          void commitTextEdit().catch((error) =>
            showToast(t(`保存文字失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
        }, 0);
      });
      if (ids.has(el.id)) {
        if (croppingId === el.id) attachSelBox(node);
        else if (ids.size === 1 && !el.locked) attachHandles(node, el);
        else attachSelBox(node);
      }
      if (ids.has(el.id) && ids.size === 1 && el.adjustHandles?.length && croppingId !== el.id) {
        attachAdjHandles(node, el);
      }
    }
    target.append(node);
  }
  if (interactive) {
    const guides = document.createElement("div");
    guides.id = target.id === "slide" ? "guide-layer" : "";
    guides.className = "guide-layer";
    target.append(guides);
  }
}

function slideScale() {
  const slide = $("slide");
  const t = slide.style.transform || "";
  const m = /scale\(([^)]+)\)/.exec(t);
  return m ? Number(m[1]) : 1;
}

function startCropDrag(ev, el, dir) {
  ev.preventDefault();
  ev.stopPropagation();
  drag = {
    mode: `crop:${dir}`,
    id: el.id,
    startX: ev.clientX,
    startY: ev.clientY,
    bounds: [...el.bounds],
    crop: { ...(el.crop || {}) },
  };
  ev.target.setPointerCapture?.(ev.pointerId);
  window.addEventListener("pointermove", onDrag);
  window.addEventListener("pointerup", endDrag, { once: true });
}

function startDrag(ev, el, mode, opts = {}) {
  if (editingId === el.id) return;
  if (mode !== "move") ev.preventDefault();
  ev.stopPropagation();
  // A multi-selection moves as one group: snapshot the other selected elements
  // so the live preview and the released command share one delta.
  const group =
    mode === "move"
      ? selectedIds()
          .filter((id) => id !== el.id)
          .map((id) => {
            const bounds = model?.elements?.find((candidate) => candidate.id === id)?.bounds;
            return bounds ? { id, bounds: [...bounds] } : null;
          })
          .filter(Boolean)
      : [];
  drag = {
    mode,
    id: el.id,
    startX: ev.clientX,
    startY: ev.clientY,
    bounds: [...el.bounds],
    rotation: el.rotation || 0,
    handle: mode.startsWith("adj:") ? (el.adjustHandles || [])[Number(mode.slice(4))] : null,
    adjustments: el.adjustments ? [...el.adjustments] : [],
    threshold: Number(opts.threshold) || 0,
    moved: false,
    group,
  };
  ev.target.setPointerCapture?.(ev.pointerId);
  window.addEventListener("pointermove", onDrag);
  window.addEventListener("pointerup", endDrag, { once: true });
}

function onDrag(ev) {
  if (!drag) return;
  if (drag.mode === "move" && drag.threshold && !drag.moved) {
    if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < drag.threshold) return;
    drag.moved = true;
  }
  const scale = slideScale();
  const dx = (ev.clientX - drag.startX) / scale;
  const dy = (ev.clientY - drag.startY) / scale;
  let [x, y, w, h] = drag.bounds;
  if (drag.mode === "move") {
    x += dx;
    y += dy;
  } else if (drag.mode === "rot") {
    const deg = drag.rotation + dx;
    const node = slideElNode(drag.id);
    if (node) node.style.transform = `rotate(${deg}deg)`;
    drag.nextRotation = deg;
    return;
  } else if (String(drag.mode).startsWith("crop:")) {
    const dir = String(drag.mode).slice(5);
    const [, , w, h] = drag.bounds;
    const ox = (ev.clientX - drag.startX) / scale / Math.max(1, w);
    const oy = (ev.clientY - drag.startY) / scale / Math.max(1, h);
    const clamp = (n) => Math.max(0, Math.min(0.45, n));
    const c = { ...(drag.crop || {}) };
    if (dir.includes("w")) c.left = clamp((drag.crop.left || 0) + ox);
    if (dir.includes("e")) c.right = clamp((drag.crop.right || 0) - ox);
    if (dir.includes("n")) c.top = clamp((drag.crop.top || 0) + oy);
    if (dir.includes("s")) c.bottom = clamp((drag.crop.bottom || 0) - oy);
    drag.nextCrop = c;
    const node = slideElNode(drag.id);
    if (node) paintCropChromeStyles(node, c);
    return;
  } else if (String(drag.mode).startsWith("adj:") && drag.handle) {
    const node = slideElNode(drag.id);
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const lx = (ev.clientX - rect.left) / Math.max(1, rect.width);
    const ly = (ev.clientY - rect.top) / Math.max(1, rect.height);
    const next = [...(drag.adjustments || [])];
    const h = drag.handle;
    const clamp = (n, lo, hi) => {
      let v = n;
      if (typeof lo === "number") v = Math.max(lo, v);
      if (typeof hi === "number") v = Math.min(hi, v);
      return v;
    };
    if (h.kind === "polar" && h.adjIndexAng != null) {
      let ang = (Math.atan2(ly - 0.5, lx - 0.5) * 180) / Math.PI;
      if (ang < 0) ang += 360;
      next[h.adjIndexAng] = clamp(ang * 60000, h.minAng, h.maxAng);
    } else {
      if (h.adjIndexX != null) next[h.adjIndexX] = clamp(lx * 100000, h.minX, h.maxX);
      if (h.adjIndexY != null) next[h.adjIndexY] = clamp(ly * 100000, h.minY, h.maxY);
    }
    drag.nextAdj = next;
    const diamond = node.querySelector(`[data-handle="${drag.mode}"]`);
    if (diamond) {
      diamond.style.left = `${lx * 100}%`;
      diamond.style.top = `${ly * 100}%`;
    }
    const liveEl = model?.elements?.find((e) => e.id === drag.id);
    if (liveEl) remorphShapeLive(liveEl, next);
    return;
  } else {
    if (drag.mode.includes("e")) w = Math.max(20, w + dx);
    if (drag.mode.includes("s")) h = Math.max(16, h + dy);
    if (drag.mode.includes("w")) {
      w = Math.max(20, w - dx);
      x += dx;
    }
    if (drag.mode.includes("n")) {
      h = Math.max(16, h - dy);
      y += dy;
    }
  }
  if (typeof computeSnapGuides === "function" && (drag.mode === "move" || /[nesw]/.test(drag.mode))) {
    const [pw, ph] = model?.size || [960, 540];
    // Group members travel with the pointer, so they must not act as snap
    // targets — otherwise the guides would chase a sibling moving in lockstep.
    const moving = new Set([drag.id, ...(drag.group || []).map((member) => member.id)]);
    const others = (model?.elements || [])
      .filter((e) => !moving.has(e.id) && !e.hidden && !e.locked)
      .map((e) => e.bounds);
    const hit = computeSnapGuides([x, y, w, h], others, 6, [pw, ph]);
    if (drag.mode === "move") {
      [x, y] = hit.snap;
    }
    paintGuides([
      { axis: "x", pos: pw / 2, kind: "center" },
      { axis: "y", pos: ph / 2, kind: "center" },
      ...hit.guides,
    ]);
  }
  drag.next = [x, y, w, h];
  const node = slideElNode(drag.id);
  if (node) {
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;
  }
  if (drag.mode === "move" && drag.group?.length) {
    const gdx = x - drag.bounds[0];
    const gdy = y - drag.bounds[1];
    for (const member of drag.group) {
      const memberNode = slideElNode(member.id);
      if (!memberNode) continue;
      memberNode.style.left = `${member.bounds[0] + gdx}px`;
      memberNode.style.top = `${member.bounds[1] + gdy}px`;
    }
  }
}

function paintGuides(guides) {
  const layer = $("guide-layer");
  if (!layer) return;
  layer.innerHTML = "";
  const seen = new Set();
  for (const g of guides || []) {
    const key = `${g.axis}:${Math.round(Number(g.pos))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = document.createElement("i");
    line.className = `guide-line guide guide-${g.axis}${g.kind === "center" ? " is-center" : ""}`;
    if (g.axis === "x") line.style.left = `${g.pos}px`;
    else line.style.top = `${g.pos}px`;
    layer.append(line);
  }
}

function endDrag() {
  window.removeEventListener("pointermove", onDrag);
  paintGuides([]);
  if (!drag) return;
  const cur = drag;
  drag = null;
  if (cur.mode === "move" && cur.threshold && !cur.moved) return;
  if (cur.mode === "rot" && typeof cur.nextRotation === "number") {
    command("setRotation", { degrees: Math.round(cur.nextRotation) });
    return;
  }
  if (cur.nextAdj) {
    command("setAdjustments", { adjustments: cur.nextAdj });
    return;
  }
  if (cur.nextCrop) {
    command("setImageCrop", { crop: cur.nextCrop });
    return;
  }
  if (cur.next) {
    const groupMoved =
      cur.mode === "move" &&
      cur.group?.length > 0 &&
      (Math.abs(cur.next[0] - cur.bounds[0]) > 0.5 || Math.abs(cur.next[1] - cur.bounds[1]) > 0.5);
    if (groupMoved) dragClickClaimId = cur.id;
    // elementId names the dragged anchor so a same-size sibling can never be
    // mistaken for it while the Host applies the group delta.
    command("setBounds", { bounds: cur.next, elementId: cur.id });
  }
}

function applyStageScale(scale) {
  const slide = $("slide");
  if (!slide || !model) return;
  const [sw, sh] = viewModel().size;
  slide.style.transformOrigin = "top left";
  slide.style.transform = `scale(${scale})`;
  const card = slide.parentElement;
  if (card) {
    card.style.width = `${Math.round(sw * scale)}px`;
    card.style.height = `${Math.round(sh * scale)}px`;
  }
  const label = $("zoom-label");
  if (label) label.textContent = `${Math.round(scale * 100)}%`;
}

function computeFitScale() {
  if (!model) return 1;
  const vp = $("viewport");
  if (!vp) return 1;
  const [sw, sh] = viewModel().size;
  const style = window.getComputedStyle(vp);
  const px = (value) => Number.parseFloat(value) || 0;
  const horizontalPadding = px(style.paddingLeft) + px(style.paddingRight);
  const verticalPadding = px(style.paddingTop) + px(style.paddingBottom);
  const availW = Math.max(96, vp.clientWidth - horizontalPadding);
  const availH = Math.max(54, vp.clientHeight - verticalPadding);
  if (availW < 32 || availH < 32) return 1;
  const fit = Math.min(availW / sw, availH / sh);
  const user = Math.min(2, Math.max(0.25, (model.zoomPercent || 100) / 100));
  return Math.max(0.12, fit * user);
}

function fitStage() {
  if (!model) return;
  const vp = $("viewport");
  const slide = $("slide");
  if (!vp || !slide) return;
  applyStageScale(computeFitScale());
  applyStageScale(computeFitScale());
}

function syncRailVisibility() {
  const rail = $("rail");
  if (!rail || !model) return;
  rail.hidden = !model.pageRailOpen;
  const railToggle = $("btn-rail");
  railToggle?.classList.toggle("active", Boolean(model.pageRailOpen));
  if (railToggle) {
    const label = model.pageRailOpen ? t("收起") : t("展开");
    railToggle.dataset.tip = label;
    railToggle.setAttribute("aria-label", label);
  }
  const previewToggle = $("btn-rail-view");
  previewToggle?.classList.toggle("active", railView === "thumbs");
  previewToggle?.setAttribute("aria-pressed", String(railView === "thumbs"));
}

function renderRail() {
  const rail = $("rail");
  if (!rail) return;
  const vm = viewModel();
  syncRailVisibility();
  rail.classList.toggle("is-thumbs", railView === "thumbs");
  rail.classList.toggle("is-list", railView !== "thumbs");
  const railStyle = window.getComputedStyle(rail);
  const railWidth = Math.max(
    1,
    rail.clientWidth -
      (Number.parseFloat(railStyle.paddingLeft) || 0) -
      (Number.parseFloat(railStyle.paddingRight) || 0),
  );
  const gutterSpace = railView === "thumbs" ? Number.parseFloat(railStyle.getPropertyValue("--thumbnail-gutter") || "32") : 0;
  const thumbFrameWidth = Math.max(1, railWidth - gutterSpace);

  const pages = previewVersion
    ? (previewThumbs || vm.pageModels || [])
    : (vm.pageModels || thumbs);

  renderRailView({
    rail,
    pages,
    activeIndex: vm.pageIndex,
    railView,
    thumbFrameWidth,
    paintSlide,
    callbacks: {
      onPointerDown: (ev, b) => {
        if (ev.button !== 0 || previewVersion || !allowed("chrome.pages.reorder")) return;
        railDidDrag = false;
        const pageIdx = Number(b.dataset.pageIndex);
        railDrag = {
          fromIndex: pageIdx,
          startX: ev.clientX,
          startY: ev.clientY,
          active: false,
          thumb: b,
        };
      },
      onClick: (ev, b) => {
        if (railDidDrag) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        const pageIdx = Number(b.dataset.pageIndex);
        if (previewVersion) {
          const currentVm = viewModel();
          const pList = previewThumbs || currentVm.pageModels || [];
          const targetModel = pList.find((p) => p.pageIndex === pageIdx) || pList[pageIdx];
          if (targetModel) {
            previewModel = targetModel;
            render();
          }
          return;
        }
        command("goToPage", { index: pageIdx });
      },
      onContextMenu: (ev, b) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (previewVersion) return;
        const pageIdx = Number(b.dataset.pageIndex);
        const currentVm = viewModel();
        const menu = $("ctx-menu");
        contextMenuReturnFocus = b;
        menu.style.left = `${ev.clientX}px`;
        menu.style.top = `${ev.clientY}px`;
        menu.innerHTML = "";
        setTimeout(() => {
          menu.hidden = false;
          const rect = menu.getBoundingClientRect();
          const gutter = 8;
          menu.style.left = `${Math.max(gutter, Math.min(ev.clientX, window.innerWidth - rect.width - gutter))}px`;
          menu.style.top = `${Math.max(gutter, Math.min(ev.clientY, window.innerHeight - rect.height - gutter))}px`;
          menu.querySelector("button:not(:disabled)")?.focus();
        }, 0);
        const items = [
          [t("上移"), allowed("chrome.pages.reorder") && pageIdx > 0, () =>
            command("reorderPage", { fromIndex: pageIdx, toIndex: pageIdx - 1 })],
          [t("下移"), allowed("chrome.pages.reorder") && pageIdx < currentVm.pageCount - 1, () =>
            command("reorderPage", { fromIndex: pageIdx, toIndex: pageIdx + 1 })],
          [t("复制"), allowed("chrome.pages.duplicate"), () => command("duplicatePage", { index: pageIdx })],
          [t("删除"), allowed("chrome.pages.delete") && currentVm.pageCount > 1, () =>
            command("deletePage", { index: pageIdx })],
        ];
        for (const [label, ok, fn] of items) {
          const x = document.createElement("button");
          x.type = "button";
          x.textContent = label;
          x.disabled = !ok;
          x.addEventListener("click", () => {
            hideMenus();
            fn();
          });
          menu.append(x);
        }
      },
    },
    createAddButton: () => {
      const add = document.createElement("button");
      add.type = "button";
      add.id = "btn-rail-add";
      add.className = "rail-add";
      add.innerHTML = t(`<span class="plus">+</span>新建页面`);
      add.disabled = Boolean(previewVersion) || !allowed("chrome.pages.add");
      add.addEventListener("click", () => command("addPage"));
      return add;
    },
  });
  const add = $("btn-rail-add");
  if (add) add.disabled = Boolean(previewVersion) || !allowed("chrome.pages.add");
}

function railThumbs() {
  return [...($("rail")?.querySelectorAll(".thumb") || [])];
}

function railInsertIndex(clientY) {
  const thumbs = railThumbs();
  let idx = thumbs.length;
  for (let i = 0; i < thumbs.length; i++) {
    const r = thumbs[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) {
      idx = i;
      break;
    }
  }
  return idx;
}

function placeRailInsertLine(insertAt) {
  const rail = $("rail");
  if (!rail) return;
  let line = $("rail-insert-line");
  if (!line) {
    line = document.createElement("div");
    line.id = "rail-insert-line";
    line.className = "rail-insert-line";
    rail.append(line);
  }
  const thumbs = railThumbs();
  if (!thumbs.length) return;
  const rr = rail.getBoundingClientRect();
  let y;
  if (insertAt <= 0) {
    y = thumbs[0].getBoundingClientRect().top - rr.top + rail.scrollTop;
  } else if (insertAt >= thumbs.length) {
    const last = thumbs[thumbs.length - 1].getBoundingClientRect();
    y = last.bottom - rr.top + rail.scrollTop;
  } else {
    const prev = thumbs[insertAt - 1].getBoundingClientRect();
    const next = thumbs[insertAt].getBoundingClientRect();
    y = (prev.bottom + next.top) / 2 - rr.top + rail.scrollTop;
  }
  line.style.top = `${y}px`;
  line.hidden = false;
}

function hideRailInsertLine() {
  const line = $("rail-insert-line");
  if (line) line.hidden = true;
  for (const t of railThumbs()) t.classList.remove("is-dragging");
}

function btn(label, control, fn, extra = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ctx-btn ${extra}`;
  b.textContent = label;
  b.disabled = !allowed(control);
  b.setAttribute("data-control", control);
  b.addEventListener("click", fn);
  return b;
}

function stateBtn(label, accessibleLabel, control, fn, pressed) {
  const button = btn(label, control, fn, pressed ? "on" : "");
  button.setAttribute("aria-label", accessibleLabel);
  button.setAttribute("aria-pressed", String(Boolean(pressed)));
  button.setAttribute("data-tip", accessibleLabel);
  return button;
}

function validateTextLink(raw) {
  const href = String(raw || "").trim();
  if (!href) return { error: t("请输入链接地址，或选择“移除链接”。") };
  try {
    const protocol = new URL(href, window.location.href).protocol.toLowerCase();
    if (["http:", "https:", "mailto:", "tel:"].includes(protocol)) return { href };
  } catch {
    // The shared error below covers malformed and unsupported values alike.
  }
  return { error: t("链接仅支持 http、https、mailto、tel 或站内相对地址。") };
}

function setTextLinkDialogError(message = "") {
  const error = $("text-link-error");
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

function setTextLinkDialogBusy(busy) {
  textLinkDialogBusy = busy;
  for (const id of ["text-link-input", "text-link-save", "text-link-remove", "text-link-cancel"]) {
    const control = $(id);
    if (control) control.disabled = busy || (id === "text-link-remove" && !textLinkDialogState?.currentHref);
  }
}

function restoreTextLinkDialogFocus(state) {
  if (!state) return;
  const node = slideElNode(state.elementId);
  if (state.editingId && state.editingId === editingId && node) {
    node.focus();
    if (state.range) {
      setSelectionByPlainOffsets(node, state.range.start, state.range.end);
      pendingToolbarRange = { ...state.range };
    }
    return;
  }
  if (state.returnFocus?.isConnected) state.returnFocus.focus();
  else if (node) {
    node.tabIndex = -1;
    node.focus();
  }
}

function openTextLinkDialog(trigger = document.activeElement) {
  const el = selectedEl();
  const dialog = $("text-link-dialog");
  const input = $("text-link-input");
  if (!el || el.type !== "text" || !dialog || !input) return;
  const range = editingId === el.id ? activeEditRange() : null;
  if (range) pendingToolbarRange = { ...range };
  const currentHref = String(el.href || "").trim();
  textLinkDialogState = {
    elementId: el.id,
    editingId: editingId === el.id ? editingId : null,
    range: range ? { ...range } : null,
    returnFocus: trigger instanceof HTMLElement && trigger !== document.body ? trigger : null,
    currentHref,
  };
  $("text-link-scope").textContent = range
    ? t("作用于整个文本框；关闭后会恢复当前文字选区。")
    : t("作用于整个文本框。");
  input.value = currentHref;
  setTextLinkDialogError();
  const open = $("text-link-open");
  if (open) {
    const safe = currentHref ? validateTextLink(currentHref) : null;
    open.hidden = !safe?.href;
    if (safe?.href) open.setAttribute("href", safe.href);
    else open.removeAttribute("href");
  }
  setTextLinkDialogBusy(false);
  if (!dialog.open) dialog.showModal();
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
}

async function applyTextLinkFromDialog(href) {
  const state = textLinkDialogState;
  const dialog = $("text-link-dialog");
  if (!state || !dialog || textLinkDialogBusy) return;
  if (selectedEl()?.id !== state.elementId) {
    setTextLinkDialogError(t("所选文本已变化，请取消后重新选择。"));
    return;
  }
  setTextLinkDialogError();
  setTextLinkDialogBusy(true);
  try {
    if (state.editingId && state.editingId === editingId) {
      const node = slideElNode(editingId);
      if (node) await command("setRichText", { html: serializeEditNode(node) });
    }
    await command("setTextStyle", {
      controlId: "element.text.toolbar.link.set",
      patch: { href },
    });
    dialog.close(href ? "saved" : "removed");
  } catch (error) {
    setTextLinkDialogError(t(`保存失败：{p0}。草稿仍保留，可重试。`, { p0: error instanceof Error ? error.message : String(error) }));
  } finally {
    if (dialog.open) setTextLinkDialogBusy(false);
  }
}

function toggleKeyboardHelp(force) {
  let panel = $("kbd-help");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "kbd-help";
    panel.className = "kbd-help";
    panel.innerHTML = t(`<header>快捷键</header>
      <ul>
        <li><kbd>⌘Z</kbd> 撤销 · <kbd>⇧⌘Z</kbd> 重做</li>
        <li><kbd>⌘B</kbd> 粗体 · <kbd>⌘I</kbd> 斜体 · <kbd>⌘U</kbd> 下划线</li>
        <li><kbd>⇧⌘L</kbd> 项目符号 · <kbd>⌘K</kbd> 超链接</li>
        <li><kbd>⌘C</kbd> 复制 · <kbd>⌘X</kbd> 剪切 · <kbd>⌘V</kbd> 粘贴对象（本编辑会话内）</li>
        <li><kbd>⌘D</kbd> 复制副本 · <kbd>⌘G</kbd> 编组 · <kbd>⌫</kbd> 删除</li>
        <li><kbd>Tab</kbd> 下一元素 / 表格下一格 · <kbd>⇧Tab</kbd> 上一格</li>
        <li>表格 <kbd>Enter</kbd> 编辑 · <kbd>F2</kbd> 编辑 · 方向键换格</li>
        <li><kbd>Esc</kbd> 取消选区 · <kbd>?</kbd> 本面板</li>
        <li>方向键微调（非表格），⇧ 加速</li>
      </ul>`);
    panel.hidden = true;
    document.body.append(panel);
  }
  panel.hidden = force == null ? !panel.hidden : !force;
}

const ICO = {
  comment: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 6h14v10H8l-3 3z"/></svg>',
  chart: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 19V9M11 19V5M17 19v-7"/></svg>',
  text: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6h12M12 6v12"/></svg>',
  // Reuse the bundled Font Awesome list-ol glyph. The former hand-drawn mark
  // read like an alignment control rather than a numbered-list command.
  nums: '<span class="fa-icon ctx-fa-list-ol" aria-hidden="true">&#xf0cb;</span>',
  list: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01"/></svg>',
  layers: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4l8 4-8 4-8-4 8-4z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4"/></svg>',
  crop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3v15h15M3 6h15v15"/></svg>',
  border: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="5" width="14" height="14" rx="2" stroke-dasharray="3 2"/></svg>',
  alignH: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12h16M8 7h8M8 17h8"/></svg>',
  alignV: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v16M7 8v8M17 8v8"/></svg>',
  opacity: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3s6 6.4 6 11a6 6 0 11-12 0c0-4.6 6-11 6-11z"/><path d="M12 8v11a5 5 0 005-5c0-2.2-2.4-5.6-5-8.8" fill="currentColor" opacity=".22"/></svg>',
  image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.4"/><path d="M4 16l5-5 3 3 2-2 6 6"/></svg>',
  icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3.8l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/></svg>',
  more: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/></svg>',
  link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 007.1 0l2-2a5 5 0 00-7.1-7.1l-1.2 1.2"/><path d="M14 11a5 5 0 00-7.1 0l-2 2a5 5 0 007.1 7.1l1.2-1.2"/></svg>',
  table: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5" width="16" height="14" rx="1"/><path d="M4 10h16M4 15h16M10 5v14"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14"/></svg>',
  smartart: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="8" width="6" height="8" rx="1"/><rect x="15" y="8" width="6" height="8" rx="1"/><path d="M9 12h6"/></svg>',
  palette: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4a8 8 0 108 8c0-1.7-1.3-2.4-2.6-2.4H16a2.4 2.4 0 010-4.8 3 3 0 01.6-3.2A8 8 0 0012 4z"/><circle cx="8" cy="10" r="1" fill="currentColor"/><circle cx="9.5" cy="14.5" r="1" fill="currentColor"/><circle cx="13.5" cy="15.2" r="1" fill="currentColor"/></svg>',
  axis: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5v14h14"/><path d="M8 15l3-5 3 3 4-6"/></svg>',
};

function iconBtn(title, svg, fn, control = "", extra = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ctx-icon ${extra}`.trim();
  b.title = title;
  if (title) {
    b.setAttribute("data-tip", title);
    b.setAttribute("aria-label", title);
  }
  b.innerHTML = svg;
  const visibleLabel = document.createElement("span");
  visibleLabel.className = "ctx-visible-label";
  visibleLabel.textContent = title;
  b.append(visibleLabel);
  if (control) {
    b.setAttribute("data-control", control);
    b.disabled = !allowed(control);
  }
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    fn(ev);
  });
  return b;
}

function chartToggleBtn(label, svg, fn, control, pressed) {
  const action = `${pressed ? t("隐藏") : t("显示")}${label}`;
  const b = iconBtn(label, svg, fn, control, "ctx-labeled-toggle");
  b.title = action;
  b.setAttribute("data-tip", action);
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-pressed", String(Boolean(pressed)));
  b.classList.toggle("on", Boolean(pressed));
  return b;
}

function ctxSep() {
  const s = document.createElement("span");
  s.className = "ctx-sep";
  return s;
}

function propertySection(key, title, description = "") {
  const section = document.createElement("section");
  section.className = "property-section";
  section.dataset.inspectorSection = key;
  const header = document.createElement("header");
  header.className = "property-section-head";
  const heading = document.createElement("h3");
  heading.textContent = title;
  header.append(heading);
  if (description) {
    const copy = document.createElement("p");
    copy.textContent = description;
    header.append(copy);
  }
  const body = document.createElement("div");
  body.className = "property-section-body";
  section.append(header, body);
  return { section, body };
}

function appendPropertySection(bar, key, title, nodes, description = "", extra = "") {
  const list = Array.from(nodes || []).filter(Boolean);
  if (!list.length) return null;
  const { section, body } = propertySection(key, title, description);
  if (extra) section.classList.add(extra);
  body.append(...list);
  bar.append(section);
  return section;
}

function appendPropertyDisclosure(bar, key, title, nodes, description = "", defaultOpen = false) {
  const list = Array.from(nodes || []).filter(Boolean);
  if (!list.length) return null;
  const details = document.createElement("details");
  details.className = "property-section property-disclosure";
  details.dataset.inspectorSection = key;
  const saved = sessionStorage.getItem(`oss.inspectorSection.${key}`);
  details.open = saved == null ? defaultOpen : saved === "1";
  const summary = document.createElement("summary");
  const heading = document.createElement("span");
  heading.textContent = title;
  summary.append(heading);
  if (description) {
    const copy = document.createElement("small");
    copy.textContent = description;
    summary.append(copy);
  }
  const body = document.createElement("div");
  body.className = "property-section-body";
  body.append(...list);
  details.append(summary, body);
  details.addEventListener("toggle", () => {
    sessionStorage.setItem(`oss.inspectorSection.${key}`, details.open ? "1" : "0");
  });
  bar.append(details);
  return details;
}

function wrapPropertyChildren(bar, startIndex, key, title, description = "") {
  const nodes = Array.from(bar.children).slice(startIndex);
  return appendPropertySection(bar, key, title, nodes, description);
}

function propertyInput(labelText, input, hint = "") {
  const label = document.createElement("label");
  label.className = "property-direct-field";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  label.append(caption, input);
  if (hint) {
    const help = document.createElement("small");
    help.textContent = hint;
    label.append(help);
  }
  return label;
}

function propertyNumber(label, value, control, onChange, options = {}) {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "ctx-input";
  input.value = String(value ?? 0);
  if (options.id) input.id = options.id;
  if (options.field) input.dataset.propertyField = options.field;
  input.setAttribute("data-control", control);
  input.setAttribute("aria-label", label);
  input.disabled = !allowed(control);
  if (options.min != null) input.min = String(options.min);
  if (options.max != null) input.max = String(options.max);
  if (options.step != null) input.step = String(options.step);
  const field = propertyInput(label, input, options.hint || "");
  const error = document.createElement("small");
  error.className = "property-field-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  field.append(error);
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    error.hidden = true;
  });
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    const next = Number(raw);
    const belowMin = options.min != null && next < Number(options.min);
    const aboveMax = options.max != null && next > Number(options.max);
    if (!raw || !Number.isFinite(next) || belowMin || aboveMax) {
      input.setAttribute("aria-invalid", "true");
      error.textContent = options.error || t(`{p0}`, { p0: label });
      error.hidden = false;
      return;
    }
    onChange(next);
  });
  return field;
}

function propertySwitch(labelText, description, checked, control, onChange) {
  const label = document.createElement("label");
  label.className = "property-switch-row";
  const copy = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = labelText;
  const help = document.createElement("small");
  help.textContent = description;
  copy.append(strong, help);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.role = "switch";
  input.checked = Boolean(checked);
  input.setAttribute("data-control", control);
  input.setAttribute("aria-label", labelText);
  input.disabled = !allowed(control);
  input.addEventListener("change", () => onChange(input.checked));
  label.append(copy, input);
  return label;
}

function propertyActionGrid(...nodes) {
  const row = document.createElement("div");
  row.className = "property-action-grid";
  row.append(...nodes.filter(Boolean));
  return row;
}

function propertyStateNote(text, tone = "") {
  const note = document.createElement("p");
  note.className = `property-state-note ${tone}`.trim();
  note.textContent = text;
  return note;
}

function ctxPop(id, title, svg, control, fill) {
  const wrap = document.createElement("div");
  wrap.className = "ctx-popwrap";
  wrap.id = id;
  const b = iconBtn(title, svg, () => {
    const open = wrap.classList.contains("open");
    closeCtxPops();
    if (!open) {
      wrap.classList.add("open");
      b.setAttribute("aria-expanded", "true");
    }
    positionCtxPops();
  }, control);
  b.classList.add("has-caret");
  const pop = document.createElement("div");
  pop.className = "ctx-pop";
  pop.id = `${id}-panel`;
  pop.setAttribute("aria-label", title);
  fill(pop);
  pop.setAttribute("role", pop.querySelector("input, select, textarea") ? "dialog" : "menu");
  if (pop.getAttribute("role") === "menu") {
    pop.querySelectorAll(":scope > button").forEach((item) => item.setAttribute("role", "menuitem"));
  }
  b.setAttribute("aria-haspopup", pop.getAttribute("role"));
  b.setAttribute("aria-controls", pop.id);
  b.setAttribute("aria-expanded", "false");
  wrap.append(b, pop);
  return wrap;
}

function closeCtxPops({ restoreFocus = false } = {}) {
  document.querySelectorAll(".ctx-popwrap.open").forEach((n) => {
    n.classList.remove("open");
    const trigger = n.querySelector(":scope > .ctx-icon");
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger?.focus();
  });
}

function fillSwatch(color, title, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ctx-swatch";
  b.title = title;
  b.style.background = color;
  b.addEventListener("click", fn);
  return b;
}

function positionCtxBar() {
  const bar = $("ctx-bar");
  if (!bar || bar.hidden) return;
  bar.classList.remove("is-dark");
  bar.style.removeProperty("top");
  bar.style.removeProperty("left");
  bar.style.removeProperty("transform");
}

function positionCtxPops() {
  document.querySelectorAll("#property-panel .ctx-pop").forEach((pop) => pop.classList.remove("is-up"));
}

function positionChartOverlay() {
  const box = $("chart-overlay");
  if (!box || box.hidden) return;
  const el = selectedEl();
  const wrap = document.querySelector(".stage-wrap");
  const node = el ? document.querySelector(`#slide .el[data-id="${el.id}"]`) : null;
  if (!wrap || !node) return;
  const nr = node.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  box.style.top = `${Math.max(8, nr.top - wr.top + 8)}px`;
  box.style.left = `${Math.max(16, nr.left - wr.left + 12)}px`;
  box.style.transform = "none";
}

function appendCommonOps(pop, el) {
  const selected = selectedIds()
    .map((id) => model?.elements?.find((candidate) => candidate.id === id))
    .filter(Boolean);
  const anyLocked = selected.some((candidate) => candidate.locked);
  const anyHidden = selected.some((candidate) => candidate.hidden);
  const rows = [
    [t("上移一层"), "element.arrange.forward", () => command("arrange", { dir: "forward" })],
    [t("下移一层"), "element.arrange.backward", () => command("arrange", { dir: "backward" })],
    [t("置于顶层"), "element.arrange.forward", () => command("arrange", { dir: "front" })],
    [t("置于底层"), "element.arrange.backward", () => command("arrange", { dir: "back" })],
    [t("编组"), "element.group.set", () => command("group")],
    [t("解组"), "element.ungroup.set", () => command("ungroup")],
    [anyLocked ? t("解锁") : t("锁定"), "element.lock.toggle", () => command("setLocked", { locked: !anyLocked })],
    [anyHidden ? t("显示") : t("隐藏"), "element.visibility.toggle", () => command("setHidden", { hidden: !anyHidden })],
    [t("复制"), "element.duplicate", () => command("duplicateSelected")],
    [t("删除"), "element.delete", () => command("deleteSelected")],
  ];
  for (const [lab, control, fn] of rows) {
    const button = btn(lab, control, () => { closeCtxPops(); fn(); }, anyLocked && lab === t("解锁") ? "on" : "");
    if (anyLocked && [t("上移一层"), t("下移一层"), t("置于顶层"), t("置于底层"), t("编组"), t("解组"), t("删除")].includes(lab)) {
      button.disabled = true;
      button.title = t("所选对象中有锁定对象，请先解锁");
    }
    pop.append(button);
  }
}

function disableForLockedSelection(control, anyLocked) {
  if (!anyLocked) return control;
  const controls = control.matches?.("button, input, select, textarea")
    ? [control]
    : Array.from(control.querySelectorAll("button, input, select, textarea"));
  controls.forEach((item) => {
    item.disabled = true;
    item.title = t("所选对象中有锁定对象，请先解锁");
  });
  return control;
}

const ELEMENT_TYPE_LABELS = {
  text: t("文字"),
  shape: t("形状"),
  image: t("图片"),
  table: t("表格"),
  chart: t("图表"),
  line: t("线条"),
  icon: t("图标"),
};

function elementReadableName(el) {
  if (!el) return t("对象");
  if (el.smartArt) {
    const layout = String(el.smartArt.layout || el.shapeName || "").trim();
    return layout ? `SmartArt · ${layout}` : "SmartArt";
  }
  const type = ELEMENT_TYPE_LABELS[el.type] || t("对象");
  const text = String(el.text || el.chartTitle || "").replace(/\s+/g, " ").trim().slice(0, 28);
  if (text) return `${type}“${text}”`;
  const subtype = String(el.shapeName || el.iconName || "").trim();
  const shapeNames = { rect: t("矩形"), roundRect: t("圆角矩形"), ellipse: t("椭圆"), line: t("线条") };
  return shapeNames[subtype] || (subtype ? `${type} · ${subtype}` : type);
}

function updatePropertyPanel(ids = selectedIds(), el = selectedEl()) {
  const panel = $("property-panel");
  const title = $("property-title");
  const empty = $("property-empty");
  const toggle = $("property-toggle");
  if (!panel) return;
  const hasContext = Boolean(el);
  const autoEmpty = !hasContext;
  const chatOpen = Boolean($("work-chat") && !$("work-chat").hidden);
  propertyPanelAutoCollapsedForAgent = Boolean(
    hasContext &&
    chatOpen &&
    !propertyPanelCollapsed &&
    !propertyPanelAgentUserOverride &&
    window.innerWidth > 900 &&
    window.innerWidth <= 1440
  );
  const collapsed = (propertyPanelCollapsed || propertyPanelAutoCollapsedForAgent) && hasContext;
  panel.hidden = commentMode || Boolean(model?.presenting) || (chatOpen && !hasContext);
  panel.dataset.inspectorType = el?.smartArt ? "smartart" : el?.type || "none";
  panel.dataset.selectionState = ids.length > 1 ? "multi" : el ? "single" : "empty";
  panel.classList.toggle("is-empty", autoEmpty);
  panel.classList.toggle("is-collapsed", collapsed);
  panel.toggleAttribute("data-agent-auto-collapsed", propertyPanelAutoCollapsedForAgent && hasContext);
  if (title) {
    const selected = ids.map((id) => model?.elements?.find((candidate) => candidate.id === id)).filter(Boolean);
    const multiState = `${selected.some((candidate) => candidate.hidden) ? t(" · 含隐藏对象") : ""}${selected.some((candidate) => candidate.locked) ? t(" · 含锁定对象") : ""}`;
    title.textContent = ids.length > 1
        ? t(`{p0} 个对象{p1}`, { p0: ids.length, p1: multiState })
        : el
          ? `${elementReadableName(el)}${el.hidden ? t(" · 已隐藏") : ""}${el.locked ? t(" · 已锁定") : ""}`
          : t("未选择对象");
  }
  if (empty) empty.hidden = hasContext || propertyPanelCollapsed;
  if (toggle) {
    toggle.hidden = autoEmpty;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", collapsed ? t("展开属性面板") : t("收起属性面板"));
    toggle.textContent = collapsed ? "‹" : "›";
  }
}

function decoratePropertyInputs(root) {
  for (const input of root.querySelectorAll("input, select")) {
    if (input.closest("label")) continue;
    const text = input.getAttribute("aria-label") || input.title;
    if (!text) continue;
    const label = document.createElement("label");
    label.className = "property-input-row";
    const caption = document.createElement("span");
    caption.textContent = text;
    input.before(label);
    label.append(caption, input);
  }
}

function renderCtxBar() {
  const bar = $("ctx-bar");
  if (model?.presenting) {
    bar.hidden = true;
    return;
  }
  const ids = selectedIds();
  const el = selectedEl();
  const openId = bar.querySelector(".ctx-popwrap.open")?.id || "";
  const ae = document.activeElement;
  const focusInBar = ae && bar.contains(ae);
  const focusId = focusInBar && ae.id ? ae.id : "";
  const focusControl = focusInBar && !ae.id ? ae.getAttribute("data-control") || "" : "";
  const restoreCtxUi = () => {
    if (openId) {
      const wrap = document.getElementById(openId);
      if (wrap && bar.contains(wrap)) {
        wrap.classList.add("open");
        wrap.querySelector(":scope > .ctx-icon")?.setAttribute("aria-expanded", "true");
      }
    }
    const again = focusId
      ? document.getElementById(focusId)
      : focusControl
        ? bar.querySelector(`[data-control="${focusControl}"]`)
        : null;
    if (!again) return;
    again.focus();
    if (again.tagName === "INPUT" && (again.type === "number" || again.type === "text")) {
      again.select();
    }
  };
  const selKey = ids.join("\0");
  const finish = () => {
    decoratePropertyInputs(bar);
    updatePropertyPanel(ids, el);
    positionCtxBar();
    restoreCtxUi();
    if (bar.hidden) {
      lastCtxSelKey = "";
      return;
    }
    if (selKey && selKey !== lastCtxSelKey) {
      bar.classList.remove("ctx-switch");
      void bar.offsetWidth;
      bar.classList.add("ctx-switch");
    }
    lastCtxSelKey = selKey;
  };
  bar.innerHTML = "";
  if (!el) {
    bar.hidden = true;
    lastCtxSelKey = "";
    updatePropertyPanel(ids, el);
    return;
  }
  bar.hidden = false;
  const typeStart = bar.children.length;
  if (el.smartArt) {
    bar.append(
      iconBtn(t("加节点"), ICO.plus, () => command("smartArtNode", { op: "add" }), "element.smartart.node.add"),
      iconBtn(t("删节点"), ICO.minus, () => command("smartArtNode", { op: "delete" }), "element.smartart.node.delete"),
      ctxPop("pop-sa-layout", t("SmartArt 布局"), ICO.smartart, "element.smartart.layout.set", (pop) => {
        for (const [lab, layout] of [[t("流程"), "process"], [t("循环"), "cycle"], [t("层级"), "hierarchy"]]) {
          pop.append(btn(lab, "element.smartart.layout.set", () => {
            closeCtxPops();
            command("setSmartArtLayout", { layout });
          }, el.smartArt.layout === layout ? "on" : ""));
        }
      }),
    );
  }

  if (ids.length > 1) {
    const selectedElements = ids.map((id) => model?.elements?.find((candidate) => candidate.id === id)).filter(Boolean);
    const anyLocked = ids.some((id) => model?.elements?.find((candidate) => candidate.id === id)?.locked);
    const anyHidden = ids.some((id) => model?.elements?.find((candidate) => candidate.id === id)?.hidden);
    const selectedGroupIds = [...new Set(selectedElements.map((candidate) => candidate.groupId).filter(Boolean))];
    const canUngroup = selectedElements.length === ids.length && selectedGroupIds.length === 1 && selectedElements.every((candidate) => candidate.groupId === selectedGroupIds[0]);
    const arrangeNodes = [];
    if (anyLocked) arrangeNodes.push(propertyStateNote(t("选区包含锁定对象。请先解锁，再调整位置、层级或编组。"), "warning"));
    const align = ctxPop("pop-align", t("对象对齐"), ICO.alignH, "element.arrange.align.set", (pop) => {
      pop.append(propertyStateNote(t("参照：已选对象范围")));
      for (const [label, edge] of [[t("左齐"), "left"], [t("水平居中"), "center"], [t("右齐"), "right"], [t("上齐"), "top"], [t("垂直居中"), "middle"], [t("下齐"), "bottom"]]) {
        pop.append(btn(label, "element.arrange.align.set", () => command("align", { edge })));
      }
    });
    align.dataset.alignScope = "selection";
    arrangeNodes.push(disableForLockedSelection(align, anyLocked));
    if (ids.length >= 3) {
      arrangeNodes.push(disableForLockedSelection(propertyActionGrid(
        btn(t("水平分布"), "element.arrange.distribute.set", () => command("distribute", { axis: "h" })),
        btn(t("垂直分布"), "element.arrange.distribute.set", () => command("distribute", { axis: "v" })),
      ), anyLocked));
    }
    const layers = propertyActionGrid(
      btn(t("置于顶层"), "element.arrange.forward", () => command("arrange", { dir: "front" })),
      btn(t("上移一层"), "element.arrange.forward", () => command("arrange", { dir: "forward" })),
      btn(t("下移一层"), "element.arrange.backward", () => command("arrange", { dir: "backward" })),
      btn(t("置于底层"), "element.arrange.backward", () => command("arrange", { dir: "back" })),
    );
    const layerBlock = document.createElement("div");
    layerBlock.className = "property-segment-block";
    const layerTitle = document.createElement("span");
    layerTitle.className = "property-control-label";
    layerTitle.textContent = t("图层");
    layerBlock.append(layerTitle, layers);
    arrangeNodes.push(disableForLockedSelection(layerBlock, anyLocked));
    const multiUngroup = btn(t("解组"), "element.ungroup.set", () => command("ungroup"));
    if (!canUngroup) {
      multiUngroup.disabled = true;
      multiUngroup.title = t("当前选区不是同一个有效编组");
    }
    arrangeNodes.push(propertyActionGrid(
      disableForLockedSelection(btn(t("编组"), "element.group.set", () => command("group")), anyLocked),
      disableForLockedSelection(multiUngroup, anyLocked),
      btn(anyLocked ? t("解锁选区") : t("锁定选区"), "element.lock.toggle", () => command("setLocked", { locked: !anyLocked }), anyLocked ? "on" : ""),
      btn(anyHidden ? t("显示选区") : t("隐藏选区"), "element.visibility.toggle", () => command("setHidden", { hidden: !anyHidden }), anyHidden ? "on" : ""),
    ));
    if (!canUngroup) arrangeNodes.push(propertyStateNote(t("解组仅适用于同一个完整编组。")));
    appendPropertyDisclosure(bar, "position-arrange", t("位置与排列"), arrangeNodes, t("对象对齐参照已选范围"), true);
    const duplicate = btn(t("复制副本"), "element.duplicate", () => command("duplicateSelected"));
    const remove = btn(t("删除选区"), "element.delete", () => command("deleteSelected"), "danger");
    if (anyLocked) remove.disabled = true;
    appendPropertySection(bar, "actions", t("常用动作"), [propertyActionGrid(duplicate, remove)], "", "property-fixed-actions");
    finish();
    return;
  }

  if (el.type === "chart") {
    const pie = String(el.chartType || "").toLowerCase() === "pie";
    const seriesNames = pie
      ? (el.chartData?.rows || []).map((row, index) => String(row?.[0] || t(`类别{p0}`, { p0: index + 1 })))
      : (el.chartData?.cols || []).slice(1);
    const seriesCount = Math.max(1, seriesNames.length);
    bar.append(
      iconBtn(t("编辑数据"), ICO.chart, () => openChartOverlay(el), "element.chart.data.set"),
      ctxPop("pop-chart-type", t("图表类型"), ICO.chart, "element.chart.type.set", (pop) => {
        const cur = el.chartType || "bar";
        for (const [lab, type] of [[t("柱状"), "bar"], [t("折线"), "line"], [t("面积"), "area"], [t("饼图"), "pie"]]) {
          pop.append(btn(lab, "element.chart.type.set", () => command("setChartType", { type }), cur === type ? "on" : ""));
        }
      }),
      ctxPop("pop-chart-color", t("系列色"), ICO.palette, "element.chart.series.color.set", (pop) => {
        for (let i = 0; i < seriesCount; i++) {
          const row = document.createElement("label");
          row.className = "chart-color-row";
          const name = document.createElement("span");
          name.textContent = seriesNames[i] || `S${i + 1}`;
          const input = document.createElement("input");
          input.type = "color";
          input.className = "ctx-color";
          input.id = `ctx-chart-color-${i}`;
          input.setAttribute("data-control", "element.chart.series.color.set");
          input.setAttribute("aria-label", t(`{p0}`, { p0: seriesNames[i] || `系列 ${i + 1}` }));
          input.disabled = !allowed("element.chart.series.color.set");
          const raw = el.chartColors?.[i];
          input.value = raw && /^#[0-9a-fA-F]{6}/.test(raw) ? raw.slice(0, 7) : CHART_PALETTE[i % CHART_PALETTE.length];
          input.addEventListener("input", () => {
            const colors = Array.from({ length: seriesCount }, (_, k) =>
              k === i ? input.value : canvasChartSwatch(el, k),
            );
            repaintChartNode(el, { chartColors: colors });
          });
          input.addEventListener("change", () => command("setChartSeriesFill", { index: i, color: input.value }));
          row.append(name, input);
          pop.append(row);
        }
      }),
      ctxPop("pop-chart-axis", t("坐标轴"), ICO.axis, "element.chart.axis.set", (pop) => {
        const mk = (id, lab, key) => {
          const wrap = document.createElement("label");
          wrap.className = "chart-axis-row";
          const cap = document.createElement("span");
          cap.textContent = lab;
          const input = document.createElement("input");
          input.type = "text";
          input.id = id;
          input.className = "ctx-input";
          input.setAttribute("data-control", "element.chart.axis.set");
          input.setAttribute("aria-label", lab);
          input.disabled = !allowed("element.chart.axis.set");
          input.value = el.chartAxis?.[key] || "";
          input.addEventListener("change", () => {
            const axis = {
              x: $("ctx-chart-axis-x")?.value ?? el.chartAxis?.x ?? "",
              y: $("ctx-chart-axis-y")?.value ?? el.chartAxis?.y ?? "",
              secondaryY:
                $("ctx-chart-axis-secondary-y")?.value ??
                el.chartAxis?.secondaryY ??
                "",
            };
            axis[key] = input.value;
            command("setChartAxis", { axis });
          });
          wrap.append(cap, input);
          return wrap;
        };
        pop.append(
          mk("ctx-chart-axis-x", t("X 轴"), "x"),
          mk("ctx-chart-axis-y", t("Y 轴"), "y"),
          mk("ctx-chart-axis-secondary-y", t("次 Y 轴"), "secondaryY"),
        );
      }),
      ctxPop("pop-chart-title", t("标题"), ICO.text, "element.chart.title.set", (pop) => {
        const titleIn = document.createElement("input");
        titleIn.type = "text";
        titleIn.className = "ctx-input";
        titleIn.placeholder = t("图表标题");
        titleIn.setAttribute("aria-label", t("图表标题"));
        titleIn.setAttribute("data-control", "element.chart.title.set");
        titleIn.disabled = !allowed("element.chart.title.set");
        titleIn.value = el.chartTitle || "";
        titleIn.addEventListener("change", () => command("setChartTitle", { title: titleIn.value }));
        pop.append(titleIn);
      }),
      chartToggleBtn(
        t("数据标签"),
        ICO.nums,
        () => command("setChartLabels", { labels: el.chartLabels === false }),
        "element.chart.labels.set",
        el.chartLabels !== false,
      ),
      chartToggleBtn(
        t("图例"),
        ICO.list,
        () =>
          command("setChartLegend", {
            legend: !resolveChartLegend(el.chartLegend).show,
          }),
        "element.chart.legend.set",
        resolveChartLegend(el.chartLegend).show,
      ),
    );
  }

  if (el.type === "text") {
    const fontPicker = () => {
      const select = document.createElement("select");
      select.className = "ctx-input";
      select.setAttribute("aria-label", t("字体"));
      select.setAttribute("data-control", "element.text.toolbar.fontfamily.set");
      select.disabled = !allowed("element.text.toolbar.fontfamily.set");
      const cur = {
        ea: String(el.fontEastAsian || DEFAULT_FONT_EA),
        latin: String(el.fontLatin || DEFAULT_FONT_LATIN),
      };
      const keyOf = (pair) => `${pair.ea}|${pair.latin}`;
      const listed = FONT_PRESETS.some((preset) => keyOf(preset) === keyOf(cur));
      if (!listed) {
        // A pair an Agent or an older deck wrote: name it instead of hiding it.
        const unlisted = document.createElement("option");
        unlisted.value = keyOf(cur);
        unlisted.textContent = t(`{p0} + {p1}（当前字体）`, { p0: cur.ea, p1: cur.latin });
        unlisted.selected = true;
        select.append(unlisted);
      }
      for (const preset of FONT_PRESETS) {
        const option = document.createElement("option");
        option.value = keyOf(preset);
        option.textContent = preset.ea;
        option.style.fontFamily = `${preset.latin}, "${preset.ea}"`;
        if (keyOf(preset) === keyOf(cur)) option.selected = true;
        select.append(option);
      }
      select.addEventListener("change", () => {
        const [ea, latin] = select.value.split("|");
        command("setTextStyle", {
          controlId: "element.text.toolbar.fontfamily.set",
          patch: { fontFamily: { latin, ea } },
        });
      });
      return propertyInput(t("字体"), select);
    };
    const size = document.createElement("input");
    size.type = "number";
    size.id = "ctx-fontsize";
    size.className = "ctx-input";
    size.value = String(el.fontSize || 18);
    size.min = "1";
    size.setAttribute("aria-label", t("字号"));
    size.setAttribute("data-control", "element.text.toolbar.fontsize.set");
    size.disabled = !allowed("element.text.toolbar.fontsize.set");
    const sizeField = propertyInput(t("字号"), size);
    const sizeError = document.createElement("small");
    sizeError.className = "property-field-error";
    sizeError.setAttribute("role", "alert");
    sizeError.hidden = true;
    sizeField.append(sizeError);
    size.addEventListener("input", () => {
      size.removeAttribute("aria-invalid");
      sizeError.hidden = true;
    });
    size.addEventListener("change", () => {
      const next = Number(size.value);
      if (!size.value.trim() || !Number.isFinite(next) || next <= 0) {
        size.setAttribute("aria-invalid", "true");
        sizeError.textContent = t("字号必须是大于 0 的数值。");
        sizeError.hidden = false;
        return;
      }
      size.removeAttribute("aria-invalid");
      styleTextFromToolbar("element.text.toolbar.fontsize.set", { fontSize: next });
    });
    const styles = document.createElement("div");
    styles.className = "ctx-style-row property-text-styles";
    styles.setAttribute("aria-label", t("常用字形"));
    styles.append(
      stateBtn("B", t("粗体"), "element.text.toolbar.bold.toggle", () =>
        styleTextFromToolbar("element.text.toolbar.bold.toggle", { bold: !el.bold }, "bold"), textStyleOn(el, "bold")),
      stateBtn("I", t("斜体"), "element.text.toolbar.italic.toggle", () =>
        styleTextFromToolbar("element.text.toolbar.italic.toggle", { italic: !el.italic }, "italic"), textStyleOn(el, "italic")),
      stateBtn("U", t("下划线"), "element.text.toolbar.underline.toggle", () =>
        styleTextFromToolbar("element.text.toolbar.underline.toggle", { underline: !el.underline }, "underline"), textStyleOn(el, "underline")),
    );
    const typeRow = document.createElement("div");
    typeRow.className = "property-type-row";
    typeRow.append(sizeField, styles);
    bar.append(
      fontPicker(),
      typeRow,
    );
    const color = document.createElement("input");
    color.type = "color";
    color.id = "ctx-text-color";
    color.className = "ctx-color";
    color.title = t("文字颜色");
    color.value = el.color || "#111111";
    color.setAttribute("data-control", "element.text.toolbar.color.set");
    color.addEventListener("focus", () => {
      pendingToolbarRange = editingSelectionOffsets(slideElNode(el.id)) || pendingToolbarRange;
    });
    color.addEventListener("input", () => {
      if (activeEditRange()) return;
      const node = slideElNode(el.id);
      if (node) node.style.color = color.value;
    });
    color.addEventListener("change", () =>
      styleTextFromToolbar("element.text.toolbar.color.set", { color: color.value }),
    );
    bar.append(propertyInput(t("文字颜色"), color));
    const textAlign = document.createElement("div");
    textAlign.id = "pop-align-t";
    textAlign.className = "property-segment-block";
    const textAlignTitle = document.createElement("span");
    textAlignTitle.className = "property-control-label";
    textAlignTitle.textContent = t("文本对齐");
    const textAlignHorizontal = propertyActionGrid();
    textAlignHorizontal.classList.add("property-segments", "four");
    for (const align of ["left", "center", "right", "justify"]) {
      const text = { left: t("左"), center: t("中"), right: t("右"), justify: t("两端") }[align];
      textAlignHorizontal.append(stateBtn(text, t(`文字水平{p0}`, { p0: { left: t("左对齐"), center: t("居中对齐"), right: t("右对齐"), justify: t("两端对齐") }[align] }), "element.text.toolbar.align.set", () =>
        command("setTextStyle", {
          controlId: "element.text.toolbar.align.set",
          patch: { align: [align, el.align?.[1] || "top"] },
        }), (el.align?.[0] || "left") === align));
    }
    const textAlignVertical = propertyActionGrid();
    textAlignVertical.classList.add("property-segments");
    for (const [label, vertical] of [[t("顶部"), "top"], [t("居中"), "middle"], [t("底部"), "bottom"]]) {
      textAlignVertical.append(stateBtn(label, t(`文字垂直{p0}对齐`, { p0: label }), "element.text.toolbar.align.set", () =>
        command("setTextStyle", {
          controlId: "element.text.toolbar.align.set",
          patch: { align: [el.align?.[0] || "left", vertical] },
        }), (el.align?.[1] || "top") === vertical));
    }
    textAlign.append(textAlignTitle, textAlignHorizontal, textAlignVertical);
    bar.append(textAlign);
    const listRow = document.createElement("div");
    listRow.className = "property-segment-block";
    const listTitle = document.createElement("span");
    listTitle.className = "property-control-label";
    listTitle.textContent = t("列表");
    const listChoices = propertyActionGrid(
      stateBtn(t("无"), t("无列表"), "element.text.toolbar.list.set", () =>
        command("setTextStyle", { controlId: "element.text.toolbar.list.set", patch: { list: null } }), !el.list),
      stateBtn(t("项目符号"), t("项目符号列表"), "element.text.toolbar.list.set", () =>
        command("setTextStyle", { controlId: "element.text.toolbar.list.set", patch: { list: "bullet" } }), el.list === "bullet"),
      stateBtn(t("编号"), t("编号列表"), "element.text.toolbar.list.set", () =>
        command("setTextStyle", { controlId: "element.text.toolbar.list.set", patch: { list: "number" } }), el.list === "number"),
    );
    listChoices.classList.add("property-segments");
    listRow.append(listTitle, listChoices);
    bar.append(listRow);
    bar.append(propertyActionGrid(
      iconBtn(t("编辑链接"), ICO.link, (event) => openTextLinkDialog(event.currentTarget),
        "element.text.toolbar.link.set", el.href ? "on" : ""),
      ctxPop("pop-type-advanced", t("高级排版"), ICO.text, "element.text.toolbar.lineheight.set", (pop) => {
        const lineHeight = document.createElement("select");
        lineHeight.className = "ctx-input";
        lineHeight.setAttribute("aria-label", t("行距"));
        lineHeight.setAttribute("data-control", "element.text.toolbar.lineheight.set");
        lineHeight.disabled = !allowed("element.text.toolbar.lineheight.set");
        for (const value of [1, 1.2, 1.5, 1.8, 2]) {
          const option = document.createElement("option");
          option.value = String(value);
          option.textContent = String(value);
          if (Number(el.lineHeight || 1.2) === value) option.selected = true;
          lineHeight.append(option);
        }
        lineHeight.addEventListener("change", () => command("setTextStyle", {
          controlId: "element.text.toolbar.lineheight.set",
          patch: { lineHeight: Number(lineHeight.value) },
        }));
        const letterSpacing = document.createElement("input");
        letterSpacing.type = "number";
        letterSpacing.className = "ctx-input";
        letterSpacing.value = String(el.letterSpacing ?? 0);
        letterSpacing.setAttribute("aria-label", t("字距"));
        letterSpacing.setAttribute("data-control", "element.text.toolbar.letterspacing.set");
        letterSpacing.disabled = !allowed("element.text.toolbar.letterspacing.set");
        letterSpacing.addEventListener("change", () => command("setTextStyle", {
          controlId: "element.text.toolbar.letterspacing.set",
          patch: { letterSpacing: Number(letterSpacing.value) },
        }));
        const highlight = document.createElement("input");
        highlight.type = "color";
        const currentHighlight = isSolidHex(el.backgroundColor) ? String(el.backgroundColor) : "";
        highlight.value = currentHighlight || "#fff59d";
        highlight.setAttribute("aria-label", t("文字高亮色"));
        highlight.setAttribute("data-control", "element.text.toolbar.highlight.set");
        highlight.disabled = !allowed("element.text.toolbar.highlight.set");
        highlight.addEventListener("change", () => command("setTextStyle", {
          controlId: "element.text.toolbar.highlight.set",
          patch: { backgroundColor: highlight.value },
        }));
        const clearHighlight = btn(t("清除高亮"), "element.text.toolbar.highlight.set", () => command("setTextStyle", {
          controlId: "element.text.toolbar.highlight.set",
          patch: { backgroundColor: null },
        }));
        clearHighlight.disabled = clearHighlight.disabled || !currentHighlight;
        pop.append(
          propertyInput(t("行距"), lineHeight),
          propertyInput(t("字距"), letterSpacing),
          propertyInput(currentHighlight ? t("当前高亮") : t("高亮色"), highlight),
          clearHighlight,
        );
      }),
    ));
    const textNodes = Array.from(bar.children).slice(typeStart);
    appendPropertySection(bar, "text", t("文字"), textNodes, t("常用文字格式直接调整"));
    appendPropertySection(bar, "textbox", t("文本框"), [
      propertySwitch(
        t("框内自动换行"),
        t("按文本框宽度换行，不自动增高或缩小字号。"),
        el.wrap !== false,
        "element.text.toolbar.wrap.set",
        (checked) => command("setTextStyle", {
          controlId: "element.text.toolbar.wrap.set",
          patch: { wrap: checked },
        }),
      ),
    ]);
  }
  if (el.type === "shape") {
    bar.append(ctxPop("pop-adj", t("调整 / 形状"), ICO.crop, "element.shape.adjust.set", (pop) => {
      const kind = document.createElement("select");
      kind.className = "ctx-input";
      kind.title = t("形状");
      kind.setAttribute("aria-label", t("形状类型"));
      kind.setAttribute("data-control", "element.shape.kind.set");
      kind.disabled = !allowed("element.shape.kind.set");
      const catalog = shapeCatalog.length ? shapeCatalog : SHAPE_KINDS.map(([id, title]) => ({ name: id, title }));
      for (const s of catalog) {
        const o = document.createElement("option");
        o.value = s.name;
        o.textContent = s.title || s.name;
        if (el.shapeName === s.name) o.selected = true;
        kind.append(o);
      }
      kind.addEventListener("change", () => command("setShape", { shapeName: kind.value }));
      pop.append(kind);
      const info = shapeCatalog.find((s) => s.name === el.shapeName);
      if (info?.defaults?.length) {
        info.defaults.forEach((def, i) => {
          const sl = document.createElement("input");
          sl.type = "range";
          const handle = (el.adjustHandles || [])[i];
          sl.min = String(typeof handle?.minX === "number" ? handle.minX : 0);
          sl.max = String(typeof handle?.maxX === "number" && handle.maxX > 0 ? handle.maxX : 100000);
          sl.value = String(el.adjustments?.[i] ?? def);
          sl.title = `adj${i}`;
          sl.setAttribute("data-control", "element.shape.adjust.set");
          sl.setAttribute("aria-label", t(`形状调整 {p0}`, { p0: i + 1 }));
          sl.disabled = !allowed("element.shape.adjust.set");
          sl.dataset.adj = String(i);
          sl.addEventListener("input", () => {
            const next = [...(el.adjustments || info.defaults)];
            next[i] = Number(sl.value);
            scheduleRemorph(el, next);
          });
          sl.addEventListener("change", () => {
            const next = [...(el.adjustments || info.defaults)];
            next[i] = Number(sl.value);
            command("setAdjustments", { adjustments: next });
          });
          pop.append(sl);
        });
      }
    }));
    bar.append(ctxPop("pop-fill", t("填充"), `<span class="ctx-chip" style="background:${el.fillCss || "#2563EB"}"></span>`, "element.shape.fill.set", (pop) => {
      const fill = document.createElement("input");
      fill.type = "color";
      fill.id = "ctx-fill-color";
      fill.setAttribute("aria-label", t("形状填充色"));
      fill.setAttribute("data-control", "element.shape.fill.set");
      fill.disabled = !allowed("element.shape.fill.set");
      fill.value = isSolidHex(el.fillCss) ? el.fillCss : "#2563EB";
      fill.addEventListener("input", () => liveShapeFill(el, fill.value));
      fill.addEventListener("change", () => command("setFill", { color: fill.value }));
      const g1 = document.createElement("input");
      g1.type = "color";
      g1.title = t("渐变起");
      g1.setAttribute("aria-label", t("形状渐变起始色"));
      g1.setAttribute("data-control", "element.shape.fill.set");
      g1.disabled = !allowed("element.shape.fill.set");
      g1.value = "#111111";
      const g2 = document.createElement("input");
      g2.type = "color";
      g2.title = t("渐变止");
      g2.setAttribute("aria-label", t("形状渐变结束色"));
      g2.setAttribute("data-control", "element.shape.fill.set");
      g2.disabled = !allowed("element.shape.fill.set");
      g2.value = "#2563EB";
      const previewGrad = () =>
        liveShapeFill(el, `linear-gradient(90deg, ${g1.value} 0%, ${g2.value} 100%)`);
      const applyGrad = () =>
        command("setFill", {
          fill: {
            type: "gradient",
            gradientType: "linear",
            angle: 0,
            stops: [
              { position: 0, color: g1.value },
              { position: 1, color: g2.value },
            ],
          },
        });
      g1.addEventListener("input", previewGrad);
      g2.addEventListener("input", previewGrad);
      g1.addEventListener("change", applyGrad);
      g2.addEventListener("change", applyGrad);
      const swatches = document.createElement("div");
      swatches.className = "ctx-swatches";
      for (const c of Object.values(model?.themeColors || { primary: "#2563EB", text: "#111111" })) {
        const hex = String(c).slice(0, 7);
        if (!/^#/.test(hex)) continue;
        swatches.append(fillSwatch(hex, hex, () => command("setFill", { color: hex })));
      }
      pop.append(swatches, fill, g1, g2, btn(t("渐变"), "element.shape.fill.set", applyGrad));
    }));
    bar.append(ctxPop("pop-border", t("描边"), ICO.border, "element.shape.border.set", (pop) => {
      const border = document.createElement("input");
      border.type = "color";
      border.title = t("描边");
      border.setAttribute("aria-label", t("形状描边色"));
      border.setAttribute("data-control", "element.shape.border.set");
      border.disabled = !allowed("element.shape.border.set");
      border.value = el.border?.color || "#111111";
      border.addEventListener("input", () =>
        liveShapeBorder(el, { color: border.value, width: el.border?.width || 2, style: el.border?.style || "solid" }),
      );
      border.addEventListener("change", () =>
        command("setBorder", { border: { color: border.value, width: el.border?.width || 2, style: el.border?.style || "solid" } }),
      );
      const bw = document.createElement("input");
      bw.type = "number";
      bw.className = "ctx-input";
      bw.title = t("描边宽度");
      bw.setAttribute("aria-label", t("形状描边宽度"));
      bw.setAttribute("data-control", "element.shape.border.set");
      bw.disabled = !allowed("element.shape.border.set");
      bw.value = String(el.border?.width || 0);
      bw.addEventListener("input", () =>
        liveShapeBorder(el, { width: Number(bw.value), color: el.border?.color || "#111111", style: el.border?.style || "solid" }),
      );
      bw.addEventListener("change", () =>
        command("setBorder", { border: { width: Number(bw.value), color: el.border?.color || "#111111", style: el.border?.style || "solid" } }),
      );
      pop.append(
        btn(t("无边框"), "element.shape.border.set", () => command("setBorder", { border: { width: 0, color: el.border?.color || "#111111", style: "solid" } })),
        border,
        bw,
      );
    }));
  }
  if (el.type === "icon") {
    bar.append(ctxPop("pop-icon", t("图标"), ICO.icon, "element.icon.name.set", (pop) => {
      const fill = document.createElement("input");
      fill.type = "color";
      fill.value = isSolidHex(el.fillCss) ? el.fillCss : "#F59E0B";
      fill.setAttribute("data-control", "element.icon.color.set");
      fill.setAttribute("aria-label", t("图标颜色"));
      fill.disabled = !allowed("element.icon.color.set");
      fill.addEventListener("change", () => command("setFill", { color: fill.value, icon: true }));
      const icon = document.createElement("select");
      icon.className = "ctx-input";
      icon.setAttribute("data-control", "element.icon.name.set");
      icon.setAttribute("aria-label", t("图标名称"));
      icon.disabled = !allowed("element.icon.name.set");
      const currentIconName = el.iconName || "fas:star";
      const iconNames = ICON_KINDS.includes(currentIconName)
        ? ICON_KINDS
        : [currentIconName, ...ICON_KINDS];
      for (const name of iconNames) {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = iconKey(name);
        if (currentIconName === name || iconKey(currentIconName) === iconKey(name)) o.selected = true;
        icon.append(o);
      }
      icon.addEventListener("change", () => command("setIconName", { iconName: icon.value }));
      pop.append(fill, icon);
    }));
  }
  if (el.type === "image") {
    const replace = btn(t("替换图片"), "element.image.replace", () => pickImageFile((src) => command("setImageSrc", { src })));
    let cropAction;
    if (croppingId === el.id) {
      cropAction = btn(t("退出裁切"), "element.image.crop.set", () => exitCropMode());
      cropAction.id = "crop-done";
    } else {
      cropAction = btn(t("开始裁切"), "element.image.crop.set", () => enterCropMode(el.id));
      cropAction.id = "crop-start";
    }
    const primaryActions = propertyActionGrid(replace, cropAction);
    bar.append(primaryActions);
    if (croppingId === el.id) {
      const reset = btn(t("重置裁切"), "element.image.crop.set", () =>
        command("setImageCrop", { crop: { left: 0, top: 0, right: 0, bottom: 0 } }));
      reset.id = "crop-reset";
      bar.append(propertyStateNote(t("裁切修改会即时应用；退出后仍可用撤销恢复。")), reset);
    }
    const fit = document.createElement("select");
    fit.className = "ctx-input";
    fit.setAttribute("data-control", "element.image.fit.set");
    fit.setAttribute("aria-label", t("图片填充方式"));
    fit.disabled = !allowed("element.image.fit.set");
    for (const [mode, label] of [["cover", t("裁切铺满")], ["contain", t("完整显示")], ["fill", t("拉伸填满")]]) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = label;
      if ((el.fit || "cover") === mode) option.selected = true;
      fit.append(option);
    }
    fit.addEventListener("change", () => command("setImageFit", { mode: fit.value }));
    bar.append(propertyInput(t("填充方式"), fit));
    bar.append(ctxPop("pop-crop", t("遮罩形状"), ICO.crop, "element.image.mask.set", (pop) => {
      for (const [mask, label] of [["", t("矩形")], ["ellipse", t("椭圆")], ["roundRect", t("圆角矩形")], ["diamond", t("菱形")], ["hexagon", t("六边形")]]) {
        pop.append(btn(label, "element.image.mask.set", () =>
          command("setImageCropShape", { cropShape: mask ? { shapeName: mask } : null })));
      }
    }));
    bar.append(ctxPop("pop-image", t("Agent 重建图片"), ICO.image, "element.image.rebuild", (pop) => {
      const rebuild = document.createElement("form");
      rebuild.id = "image-rebuild-form";
      rebuild.className = "image-rebuild-form";
      rebuild.setAttribute("data-inspector-form", "image-rebuild");
      const rebuildTitle = document.createElement("strong");
      rebuildTitle.textContent = t("Agent 重建图片");
      const rebuildHelp = document.createElement("small");
      rebuildHelp.textContent = model?.llmConfigured
        ? t("可写希望保留或改变的内容；当前模型会读取原图。")
        : t("当前未配置多模态模型，将按输入文字生成可编辑节点。");
      const prompt = document.createElement("textarea");
      prompt.id = "image-rebuild-prompt";
      prompt.rows = 3;
      prompt.placeholder = model?.llmConfigured ? t("例如：保留构图，改成蓝白插画风") : t("例如：市场、产品、交付");
      prompt.setAttribute("aria-label", t("图片重建要求"));
      const status = document.createElement("p");
      status.className = "image-rebuild-status";
      status.setAttribute("role", "status");
      status.hidden = true;
      const submit = btn(t("开始重建"), "element.image.rebuild", () => {});
      submit.type = "submit";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.id = "image-rebuild-cancel";
      cancel.className = "ctx-btn";
      cancel.textContent = t("取消重建");
      cancel.addEventListener("click", () => {
        prompt.value = "";
        status.hidden = true;
        closeCtxPops({ restoreFocus: true });
      });
      rebuild.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        status.hidden = false;
        status.classList.remove("is-error");
        status.textContent = t("正在重建…");
        try {
          await command("rebuildImage", { prompt: prompt.value.trim() });
          status.textContent = t("已提交重建。");
        } catch (error) {
          status.classList.add("is-error");
          status.textContent = t(`重建失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) });
          prompt.focus();
        } finally {
          submit.disabled = !allowed("element.image.rebuild");
        }
      });
      rebuild.append(rebuildTitle, rebuildHelp, prompt, status, propertyActionGrid(cancel, submit));
      pop.append(rebuild);
    }));
  }
  if (el.type === "line") {
    bar.append(ctxPop("pop-line", t("线条"), ICO.border, "element.line.arrow.set", (pop) => {
      const lab = document.createElement("input");
      lab.type = "text";
      lab.className = "ctx-input";
      lab.title = t("连接线标签");
      lab.placeholder = t("如 拉动 / 传导");
      lab.value = el.lineLabel || "";
      lab.setAttribute("data-control", "element.line.label.set");
      lab.setAttribute("aria-label", t("连接线标签"));
      lab.disabled = !allowed("element.line.label.set");
      lab.addEventListener("change", () => command("setLineLabel", { label: lab.value.trim() || null }));
      pop.append(lab);
      const color = document.createElement("input");
      color.type = "color";
      color.setAttribute("data-control", "element.shape.border.set");
      color.setAttribute("aria-label", t("线条颜色"));
      color.disabled = !allowed("element.shape.border.set");
      color.value = el.border?.color || "#111111";
      color.addEventListener("change", () =>
        command("setBorder", { border: { color: color.value, width: el.border?.width || 3, style: el.border?.style || "solid" } }),
      );
      const bw = document.createElement("input");
      bw.type = "number";
      bw.className = "ctx-input";
      bw.setAttribute("data-control", "element.shape.border.set");
      bw.setAttribute("aria-label", t("线条宽度"));
      bw.disabled = !allowed("element.shape.border.set");
      bw.value = String(el.border?.width || 3);
      bw.addEventListener("change", () =>
        command("setBorder", { border: { width: Number(bw.value), color: el.border?.color || "#111111", style: el.border?.style || "solid" } }),
      );
      pop.append(color, bw);
      for (const [style, label] of [["solid", t("实线")], ["dash", t("虚线")], ["dot", t("点线")]]) {
        const styleButton = btn(label, "element.shape.border.set", () =>
          command("setBorder", { border: { style, width: el.border?.width || 3, color: el.border?.color || "#111111" } }));
        styleButton.dataset.value = style;
        pop.append(styleButton);
      }
      const arrows = [[null, t("无")], ["arrow", t("三角")], ["stealth", t("燕尾")], ["diamond", t("菱")], ["oval", t("圆")]];
      const start = document.createElement("select");
      start.className = "ctx-input";
      start.setAttribute("data-control", "element.line.arrow.set");
      start.setAttribute("aria-label", t("线条起点样式"));
      start.disabled = !allowed("element.line.arrow.set");
      for (const [v, lab] of arrows) {
        const o = document.createElement("option");
        o.value = v || "";
        o.textContent = t(`起 {p0}`, { p0: lab });
        if ((el.lineArrow?.[0] || "") === (v || "")) o.selected = true;
        start.append(o);
      }
      const end = document.createElement("select");
      end.className = "ctx-input";
      end.setAttribute("data-control", "element.line.arrow.set");
      end.setAttribute("aria-label", t("线条终点样式"));
      end.disabled = !allowed("element.line.arrow.set");
      for (const [v, lab] of arrows) {
        const o = document.createElement("option");
        o.value = v || "";
        o.textContent = t(`终 {p0}`, { p0: lab });
        if ((el.lineArrow?.[1] || "") === (v || "")) o.selected = true;
        end.append(o);
      }
      const applyArrow = () => command("setLineArrow", { arrow: [start.value || null, end.value || null] });
      start.addEventListener("change", applyArrow);
      end.addEventListener("change", applyArrow);
      pop.append(start, end);
      for (const [curve, label] of [["sharp", t("折角")], ["round", t("圆角")], ["smooth", t("平滑")]]) {
        const curveButton = btn(label, "element.line.curve.set", () => command("setLineCurve", { curve }));
        curveButton.dataset.value = curve;
        pop.append(curveButton);
      }
    }));
  }
  if (el.type === "table") {
    bar.append(ctxPop("pop-table", t("表格"), ICO.table, "element.table.row.add", (pop) => {
      const fill = document.createElement("input");
      fill.type = "color";
      fill.id = "ctx-table-fill";
      fill.className = "ctx-color";
      fill.title = t("单元格底色");
      fill.setAttribute("aria-label", t("单元格底色"));
      fill.setAttribute("data-control", "element.table.cell.fill.set");
      fill.disabled = !allowed("element.table.cell.fill.set");
      fill.value = el.tableRows?.[tableCell.row]?.[tableCell.col]?.fill || "#FEF3C7";
      fill.addEventListener("input", () => {
        const td = tableTd(el.id, tableCell.row, tableCell.col);
        if (td) td.style.background = fill.value;
      });
      fill.addEventListener("change", () =>
        tableToolbar(() =>
          command("tableFill", { row: tableCell.row, col: tableCell.col, color: fill.value }),
        ),
      );
      const addRow = btn(t("+行"), "element.table.row.add", () =>
        tableToolbar(() => command("tableRow", { op: "add", row: tableCell.row })));
      const deleteRow = btn(t("-行"), "element.table.row.delete", () =>
        tableToolbar(() => command("tableRow", { op: "delete", row: tableCell.row })));
      const addColumn = btn(t("+列"), "element.table.col.add", () =>
        tableToolbar(() => command("tableCol", { op: "add", col: tableCell.col })));
      const deleteColumn = btn(t("-列"), "element.table.col.delete", () =>
        tableToolbar(() => command("tableCol", { op: "delete", col: tableCell.col })));
      const { rows: tableRowCount, cols: tableColumnCount } = tableSize(el);
      if (tableRowCount <= 1) {
        deleteRow.disabled = true;
        deleteRow.title = t("表格至少保留一行");
        deleteRow.setAttribute("aria-label", t("删除行（表格至少保留一行）"));
      }
      if (tableColumnCount <= 1) {
        deleteColumn.disabled = true;
        deleteColumn.title = t("表格至少保留一列");
        deleteColumn.setAttribute("aria-label", t("删除列（表格至少保留一列）"));
      }
      const mergeCells = btn(t("合并"), "element.table.merge", async () => {
        try {
          await tableToolbar(() =>
            command("tableMerge", {
              r1: tableAnchor.row,
              c1: tableAnchor.col,
              r2: tableCell.row,
              c2: tableCell.col,
            }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          showToast(/partially overlaps merged cell/i.test(message)
            ? t("无法合并：所选范围与已有合并单元格部分重叠，请重新选择完整区域。")
            : t(`无法合并单元格：{p0}`, { p0: message }));
        }
      });
      if (tableAnchor.row === tableCell.row && tableAnchor.col === tableCell.col) {
        mergeCells.disabled = true;
        mergeCells.title = t("请先选择两个或更多单元格");
        mergeCells.setAttribute("aria-label", t("合并单元格（请先选择两个或更多单元格）"));
      }
      pop.append(
        addRow,
        deleteRow,
        addColumn,
        deleteColumn,
        mergeCells,
        fill,
        btn(t("左齐"), "element.table.cell.align.set", () =>
          tableToolbar(() =>
            command("setTableAlign", { row: tableCell.row, col: tableCell.col, align: ["left", "middle"] }))),
        btn(t("居中"), "element.table.cell.align.set", () =>
          tableToolbar(() =>
            command("setTableAlign", { row: tableCell.row, col: tableCell.col, align: ["center", "middle"] }))),
        btn(t("右齐"), "element.table.cell.align.set", () =>
          tableToolbar(() =>
            command("setTableAlign", { row: tableCell.row, col: tableCell.col, align: ["right", "middle"] }))),
      );
    }));
  }
  if (el.type !== "text") {
    const labels = {
      chart: ["chart", t("图表"), t("数据、类型与呈现")],
      shape: el.smartArt ? ["smartart", t("SmartArt 与形状"), t("结构、形状、填充与描边")] : ["shape", t("形状"), t("形状、填充与描边")],
      image: ["image", t("图片"), t("来源、填充、裁切与遮罩")],
      line: ["line", t("线条"), t("标签、样式、箭头与曲线")],
      icon: ["icon", t("图标"), t("图标与颜色")],
      table: ["table", t("表格"), t("当前单元格与表格结构")],
    };
    const [key, title, description] = labels[el.type] || ["object", t("对象"), t("对象属性")];
    wrapPropertyChildren(bar, typeStart, key, title, description);
  }

  const anyLocked = Boolean(el.locked);
  const bounds = Array.isArray(el.bounds) ? el.bounds : [0, 0, 0, 0];
  const positionGrid = document.createElement("div");
  positionGrid.className = "property-number-grid";
  // Each field names only the number it changed. The array is built when that command runs,
  // from the bounds the previous command already saved, so a repaint in between cannot
  // put an older X, Y, width, or height back.
  for (const [label, index] of [["X", 0], ["Y", 1], [t("宽"), 2], [t("高"), 3]]) {
    positionGrid.append(propertyNumber(label, Math.round(bounds[index] || 0), "element.bounds.set", (value) => {
      command("setBounds", { boundsIndex: index, boundsValue: value });
    }, {
      id: `ctx-bounds-${index}`,
      field: ["x", "y", "width", "height"][index],
      ...(index >= 2 ? { min: 1, error: t(`{p0}`, { p0: label }) } : {}),
    }));
  }
  const transformRow = propertyActionGrid(
    btn(t("水平翻转"), "element.arrange.flip.set", () => command("flip", { axis: "h" })),
    btn(t("垂直翻转"), "element.arrange.flip.set", () => command("flip", { axis: "v" })),
  );
  const objectAlign = ctxPop("pop-align-el", t("对象对齐"), ICO.alignH, "element.arrange.align.set", (pop) => {
    pop.append(propertyStateNote(t("参照：当前页面")));
    for (const [label, edge] of [[t("左齐"), "left"], [t("水平居中"), "center"], [t("右齐"), "right"], [t("上齐"), "top"], [t("垂直居中"), "middle"], [t("下齐"), "bottom"]]) {
      pop.append(btn(label, "element.arrange.align.set", () => command("align", { edge })));
    }
  });
  objectAlign.dataset.alignScope = "page";
  const layerGrid = propertyActionGrid(
    btn(t("置于顶层"), "element.arrange.forward", () => command("arrange", { dir: "front" })),
    btn(t("上移一层"), "element.arrange.forward", () => command("arrange", { dir: "forward" })),
    btn(t("下移一层"), "element.arrange.backward", () => command("arrange", { dir: "backward" })),
    btn(t("置于底层"), "element.arrange.backward", () => command("arrange", { dir: "back" })),
  );
  layerGrid.id = "pop-layers";
  const layerBlock = document.createElement("div");
  layerBlock.className = "property-segment-block";
  const layerTitle = document.createElement("span");
  layerTitle.className = "property-control-label";
  layerTitle.textContent = t("图层");
  layerBlock.append(layerTitle, layerGrid);
  const stateButtons = [];
  if (el.groupId) stateButtons.push(btn(t("解组"), "element.ungroup.set", () => command("ungroup")));
  stateButtons.push(
    btn(el.locked ? t("解锁") : t("锁定"), "element.lock.toggle", () => command("setLocked", { locked: !el.locked }), el.locked ? "on" : ""),
    btn(el.hidden ? t("显示") : t("隐藏"), "element.visibility.toggle", () => command("setHidden", { hidden: !el.hidden }), el.hidden ? "on" : ""),
  );
  const arrangeState = propertyActionGrid(...stateButtons);
  const stateBlock = document.createElement("div");
  stateBlock.className = "property-segment-block";
  const stateTitle = document.createElement("span");
  stateTitle.className = "property-control-label";
  stateTitle.textContent = t("对象状态");
  stateBlock.append(stateTitle, arrangeState);
  const rotationField = propertyNumber(t("旋转"), Math.round(el.rotation || 0), "element.rotate.set", (value) => command("setRotation", { degrees: value }), { id: "ctx-rotation", field: "rotation", step: 1 });
  const arrangeNodes = [positionGrid, rotationField, transformRow, objectAlign, layerBlock, stateBlock];
  if (anyLocked) {
    arrangeNodes.unshift(propertyStateNote(t("对象已锁定。解锁后可调整位置、尺寸、层级和编组。"), "warning"));
    [positionGrid, rotationField, transformRow, objectAlign, layerBlock].forEach((node) => disableForLockedSelection(node, true));
    arrangeState.querySelectorAll('[data-control="element.ungroup.set"]').forEach((control) => {
      control.disabled = true;
      control.title = t("对象已锁定，请先解锁");
    });
  }
  appendPropertyDisclosure(bar, "position-arrange", t("位置与排列"), arrangeNodes, t("对象对齐参照当前页面"), false);

  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = "0";
  opacity.max = "100";
  opacity.value = String(Math.round((el.opacity ?? 1) * 100));
  opacity.setAttribute("data-control", "element.opacity.set");
  opacity.setAttribute("aria-label", t("不透明度"));
  opacity.disabled = !allowed("element.opacity.set");
  const opacityValue = document.createElement("output");
  opacityValue.textContent = `${opacity.value}%`;
  opacityValue.htmlFor = "";
  opacity.addEventListener("input", () => { opacityValue.textContent = `${opacity.value}%`; });
  opacity.addEventListener("change", () => command("setOpacity", { opacity: Number(opacity.value) / 100 }));
  const opacityField = document.createElement("label");
  opacityField.className = "property-opacity-direct";
  opacityField.append(document.createTextNode(t("不透明度")), opacity, opacityValue);
  appendPropertyDisclosure(bar, "appearance", t("外观"), [
    opacityField,
    propertySwitch(t("阴影"), t("为当前对象添加柔和投影。"), Boolean(el.shadow), "element.shadow.set", (checked) => command("setShadow", {
      shadow: checked ? { blur: 14, color: "#00000040", offsetX: 0, offsetY: 6 } : null,
    })),
  ], t("透明度与阴影"), false);

  const duplicate = btn(t("复制副本"), "element.duplicate", () => command("duplicateSelected"));
  const remove = btn(t("删除"), "element.delete", () => command("deleteSelected"), "danger");
  if (anyLocked) remove.disabled = true;
  appendPropertySection(bar, "actions", t("常用动作"), [propertyActionGrid(duplicate, remove)], "", "property-fixed-actions");
  finish();
}

function renderChrome() {
  const vm = viewModel();
  const historyPreview = Boolean(previewVersion);
  $("doc-title").textContent = vm.title || t("未命名演示文稿");
  const chatTitle = $("chat-title");
  if (chatTitle) chatTitle.textContent = vm.title || "DSH SlideStudio";
  $("page-count").textContent = vm.pageCount ? `${vm.pageIndex + 1} / ${vm.pageCount}` : t("准备中");
  $("btn-rail").classList.toggle("active", model.pageRailOpen);
  const meta = $("rail-meta");
  if (meta) meta.hidden = false;
  $("notes-panel").hidden = !model.notesOpen;
  document.querySelector(".app")?.classList.toggle("is-notes", Boolean(model.notesOpen));
  const notesLink = $("btn-notes-link");
  if (notesLink) notesLink.textContent = model.notesOpen ? t("隐藏演讲者备注") : t("显示演讲者备注");
  const notesText = $("notes-text");
  notesText.readOnly = historyPreview;
  notesText.setAttribute("aria-readonly", String(historyPreview));
  notesText.style.resize = historyPreview ? "none" : "";
  notesText.style.cursor = historyPreview ? "default" : "";
  notesText.style.background = historyPreview ? "#f6f7f9" : "";
  const notesLabel = notesText.closest("label")?.firstChild;
  if (notesLabel?.nodeType === Node.TEXT_NODE) {
    notesLabel.textContent = historyPreview ? t("演讲者备注 · 历史版本只读\n") : t("演讲者备注\n");
  }
  if (historyPreview || document.activeElement !== notesText) {
    notesText.value = vm.notes || "";
  }
  for (const id of ["btn-rail-view", "btn-mode-edit"]) {
    const control = $(id);
    if (control) control.disabled = historyPreview;
  }
  $("present").hidden = !model.presenting;
  document.querySelector(".app")?.classList.toggle("is-comment", commentMode);
  document.querySelector(".app")?.classList.toggle("is-presenting", Boolean(model.presenting));
  document.body.classList.toggle("is-presenting", Boolean(model.presenting));
  if (model.presenting) {
    const chartBox = $("chart-overlay");
    if (chartBox) chartBox.hidden = true;
    const commentLayer = $("comment-layer");
    if (commentLayer) commentLayer.hidden = true;
  }
  for (const btnEl of document.querySelectorAll("[data-control]")) {
    // Composer and question-card controls manage their own disabled state
    // (pending sends, unanswered questions); the session gate must not stomp it.
    if (btnEl.closest("#work-form, .assistant-question-card")) continue;
    const id = btnEl.getAttribute("data-control");
    if (!id) continue;
    // The assistant is useful before the first slide exists. Its visibility
    // toggle must not depend on the empty canvas's editing permissions.
    if (id === "chrome.workspace.toggle") {
      btnEl.disabled = false;
      continue;
    }
    let off = !allowed(id);
    if (historyPreview && ![
      "chrome.history.versions.open",
      "chrome.history.versions.preview",
      "chrome.history.versions.restore",
    ].includes(id)) off = true;
    if (id === "chrome.history.undo") off = off || !model.canUndo || Boolean(previewVersion);
    if (id === "chrome.history.redo") off = off || !model.canRedo || Boolean(previewVersion);
    btnEl.disabled = off;
  }
  $("btn-comments")?.setAttribute("aria-expanded", String(commentMode && commentPopoverOpen));
  $("btn-sparkles")?.setAttribute("aria-expanded", String(!$("work-chat")?.hidden));
  if (model.presenting) {
    if (lastPresentPage !== model.pageIndex) {
      presentStep = 0;
      lastPresentPage = model.pageIndex;
    }
    paintSlide($("present-slide"), model, {
      interactive: false,
      presentStep,
      playLast: true,
    });
    const [sw, sh] = model.size;
    const scale = Math.min(window.innerWidth / sw, window.innerHeight / sh) * 0.92;
    $("present-slide").style.width = `${sw}px`;
    $("present-slide").style.height = `${sh}px`;
    $("present-slide").style.transform = `scale(${scale})`;
  } else {
    lastPresentPage = -1;
    presentStep = 0;
  }
  renderCtxBar();
  renderTimeline();
  renderComments();
}

let lastPage = -1;

function syncSelectionDom() {
  const slide = $("slide");
  if (!slide) return;
  const ids = new Set(commentMode ? [] : selectedIds());
  for (const node of slide.querySelectorAll(".el")) {
    const id = node.dataset.id;
    const on = ids.has(id);
    node.classList.toggle("selected", on);
    node.querySelectorAll(".handle, .handle-rot-stem, .sel-box").forEach((n) => n.remove());
    if (commentMode) node.querySelectorAll(".bez").forEach((n) => n.remove());
    if (!on || previewVersion) continue;
    const el = model.elements.find((e) => e.id === id);
    if (!el) continue;
    if (croppingId === el.id) attachSelBox(node);
    else if (ids.size === 1 && !el.locked) attachHandles(node, el);
    else attachSelBox(node);
    if (ids.size === 1 && el.adjustHandles?.length && croppingId !== el.id) attachAdjHandles(node, el);
  }
}

function render() {
  if (!model) return;
  paintWorkAgentTarget();
  syncRailVisibility();
  if (selectedEl()?.type === "table") tableFocusId = selectedEl().id;
  else if (!editingCell && selectedEl()) tableFocusId = null;
  if (editingId) {
    const el = model.elements.find((e) => e.id === editingId);
    const node = slideElNode(editingId);
    if (el && node) applyTextStyleToNode(node, el);
    renderChrome();
    positionCtxBar();
    positionChartOverlay();
    return;
  }
  if (editingCell) {
    renderChrome();
    positionCtxBar();
    positionChartOverlay();
    return;
  }
  const vm = viewModel();
  document.querySelector(".app")?.classList.toggle("is-history", Boolean(previewVersion));
  document.querySelector(".app")?.classList.toggle("is-cropping", Boolean(croppingId));
  const slide = $("slide");
  const pageChanged = lastPage !== -1 && lastPage !== model.pageIndex;
  if (pageChanged) {
    slide.classList.remove("page-in");
    void slide.offsetWidth;
    slide.classList.add("page-in");
  }
  paintSlide(slide, vm, { interactive: !previewVersion && !generationInteractionLocked() });
  lastPage = model.pageIndex;
  renderRail();
  renderChrome();
  fitStage();
  positionCtxBar();
  positionChartOverlay();
}

/** In-flight select command — awaited by flows that must observe the pick. */
let pendingSelectCommand = null;

function command(cmd, payload = {}) {
  const attempt = runCommand(cmd, payload);
  if (cmd === "select") {
    const tracked = attempt.catch(() => {});
    pendingSelectCommand = tracked;
    void tracked.finally(() => {
      if (pendingSelectCommand === tracked) pendingSelectCommand = null;
    });
  }
  void attempt.catch((error) => {
    if (error && (typeof error === "object" || typeof error === "function")) {
      reportedCommandErrors.add(error);
    }
    showToast(t(`操作失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) }));
  });
  return attempt;
}

window.addEventListener("unhandledrejection", (event) => {
  if (event.reason && (typeof event.reason === "object" || typeof event.reason === "function") && reportedCommandErrors.has(event.reason)) {
    // command() has already surfaced this failure. Async DOM handlers may
    // rethrow the same promise rejection after awaiting it; suppress only that
    // duplicate browser-level report while preserving rejection for callers
    // that await it to roll back their local UI.
    event.preventDefault();
  }
});

async function runCommand(cmd, payload = {}) {
  if (previewVersion) return;
  const settleBefore = new Set([
    "goToPage",
    "addPage",
    "deletePage",
    "duplicatePage",
    "reorderPage",
    "present",
    "notes",
    "insert",
    "select",
    "undo",
    "redo",
  ]);
  if (settleBefore.has(cmd)) {
    // Keep the boundary action from overtaking a failed local save. The
    // shared command wrapper reports the error, and awaiting callers still
    // receive the rejection so they can retain or roll back their local UI.
    await settlePendingEdits();
  }
  const liveSafe = new Set(["goToPage", "pageRail", "present", "select", "tabSelect", "zoom"]);
  const localCommit = new Set(["setRichText", "setText", "setTableCell", "setNotes"]);
  const localCommitBarrier = localCommit.has(cmd) ? null : pendingLocalCommit();
  if (aiReviewTurnActive && !liveSafe.has(cmd)) {
    showToast(t("Agent 正在修改当前页；已保护修改前版本，完成或回滚后会自动解锁。"));
    return;
  }
  if (generationInteractionLocked() && !liveSafe.has(cmd)) {
    showToast(t("AI 正在写入文稿；实时预览期间先不要同时修改。生成完成后会自动解锁。"));
    return;
  }
  const run = async () => {
    // Pointer capture can start a save before the click handler queues its
    // selection/navigation command. Do not let the later command overtake a
    // failed local save. The four save commands themselves must not await
    // their own tracked promise.
    if (localCommitBarrier) await localCommitBarrier;
    let requestPayload = payload;
    if (cmd === "setBounds" && payload.boundsIndex != null) {
      const el = selectedEl();
      const base = Array.isArray(el?.bounds) ? el.bounds : [0, 0, 0, 0];
      const next = [...base];
      next[payload.boundsIndex] = payload.boundsValue;
      requestPayload = { bounds: next };
    }
    const data = await api("/api/command", {
      method: "POST",
      body: JSON.stringify({ cmd, baseRevision: lastDiskRevision || undefined, ...requestPayload }),
    }).catch(async (e) => {
      if (e?.status === 409) {
        // Another writer (agent run or another tab) moved the deck; pull the
        // fresh model so this tab shows what its next command would edit.
        try {
          const fresh = await api("/api/model");
          if (fresh?.model) {
            model = fresh.model;
            if (fresh.thumbs) thumbs = fresh.thumbs;
            render();
          }
        } catch { /* refresh is best-effort */ }
      }
      throw e;
    });
    model = data.model;
    if (data.thumbs) thumbs = data.thumbs;
    const selectedTarget = payload.elementId
      ? [payload.elementId]
      : Array.isArray(payload.elementIds) ? payload.elementIds : [];
    const leavesChartOverlay = [
      "goToPage",
      "addPage",
      "deletePage",
      "duplicatePage",
      "reorderPage",
      "present",
      "insert",
      "undo",
      "redo",
    ].includes(cmd) || (cmd === "select" && (selectedTarget.length !== 1 || selectedTarget[0] !== chartDraft?.elementId));
    if (leavesChartOverlay) dismissSavedChartOverlay();
    if (cmd === "select" && !editingId) {
      const keepCrop = croppingId && selectedIds().includes(croppingId);
      if (croppingId && !keepCrop) {
        croppingId = null;
        render();
        return data;
      }
      syncRailVisibility();
      syncSelectionDom();
      renderChrome();
      paintWorkAgentTarget();
      positionCtxBar();
      positionChartOverlay();
      return data;
    }
    render();
    return data;
  };
  const next = commandTail.then(run, run);
  commandTail = next.catch(() => {});
  return next;
}

function decodeExportReport(header) {
  if (!header) return null;
  try {
    const parsed = JSON.parse(header);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* base64url */
  }
  try {
    const pad = header.replace(/-/g, "+").replace(/_/g, "/");
    const padded = pad + "=".repeat((4 - (pad.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function formatExportSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function resetExportStatus() {
  const prog = $("export-progress");
  const result = $("export-result");
  const err = $("export-error");
  if (prog) prog.hidden = true;
  if (result) {
    result.hidden = true;
    result.innerHTML = "";
  }
  if (err) err.hidden = true;
}

function showExportProgress(format) {
  const prog = $("export-progress");
  const result = $("export-result");
  const err = $("export-error");
  if (result) result.hidden = true;
  if (err) err.hidden = true;
  if (prog) {
    prog.hidden = false;
    const text = $("export-progress-text");
    if (text) text.textContent = format === "png" ? t("正在导出 PNG…") : format === "pdf" ? t("正在导出 PDF…") : t("正在导出 PPTX…");
  }
}

function showExportResult(info) {
  const prog = $("export-progress");
  const result = $("export-result");
  const err = $("export-error");
  if (prog) prog.hidden = true;
  if (err) err.hidden = true;
  if (!result) return;
  result.hidden = false;
  const deg = Number(info.degradations) || 0;
  const embedded = Array.isArray(info.embeddedFonts) ? info.embeddedFonts : [];
  const skipped = Array.isArray(info.skippedFonts) ? info.skippedFonts : [];
  const embeddedNames = embedded
    .map((f) => escapeHtmlText(f.typeface))
    .filter(Boolean)
    .join("、");
  // "not in fonts.css" means the face is not one we ship; slides now use only
  // faces Office/WPS already install, so that is the normal case, not a fault.
  const builtin = skipped.filter((f) => f.reason === "not in fonts.css");
  const problems = skipped.filter((f) => f.reason !== "not in fonts.css");
  const skipReason = (reason) =>
    /^license/.test(reason)
      ? t("字体授权不允许嵌入")
      : /CFF2/.test(reason)
        ? t("字体格式暂不支持嵌入")
        : reason;
  const builtinNames = builtin
    .map((f) => escapeHtmlText(f.typeface))
    .filter(Boolean)
    .join("、");
  const problemNames = problems
    .map((f) =>
      escapeHtmlText(f.reason ? `${f.typeface}（${skipReason(f.reason)}）` : f.typeface),
    )
    .filter(Boolean)
    .join("、");
  result.innerHTML = `<strong class="export-file">${escapeHtmlText(info.filename)}</strong>
    <span>${t("{p0} 页 · {p1}", { p0: info.pages, p1: info.size })}</span>
    ${deg > 0 ? `<small class="export-deg">${t("{p0} 处存在导出差异", { p0: deg })}</small>` : ""}
    ${embedded.length ? `<small class="export-fonts">${t("已嵌入字体：{p0}", { p0: embeddedNames })}</small>` : ""}
    ${builtin.length ? `<small class="export-fonts">${t("Office / WPS 自带，无需嵌入：{p0}", { p0: builtinNames })}</small>` : ""}
    ${problems.length ? `<small class="export-fonts export-fonts-skipped">${t("未能嵌入：{p0}", { p0: problemNames })}</small>` : ""}`;
}

function showExportError(message) {
  const prog = $("export-progress");
  const result = $("export-result");
  const err = $("export-error");
  if (prog) prog.hidden = true;
  if (result) result.hidden = true;
  if (!err) return;
  err.hidden = false;
  const t = $("export-error-text");
  if (t) t.textContent = message;
}

async function downloadExport(format) {
  lastExportFormat = format;
  showExportProgress(format);
  try {
    const res = await fetch(nativeApi("/api/export"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format,
        project: currentProjectPath(),
        tabId: editorTabId(),
        embedFonts: Boolean($("export-embed-fonts")?.checked),
      }),
    });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const report = decodeExportReport(res.headers.get("X-Export-Report"));
    const blob = await res.blob();
    const disp = res.headers.get("Content-Disposition") || "";
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disp);
    const plain = /filename="?([^";]+)"?/i.exec(disp);
    const ext = format === "png" ? "png" : format === "pdf" ? "pdf" : "pptx";
    const fallback = `${(model?.title || "deck").replace(/[^\w\u4e00-\u9fff-]+/g, "_").replace(/^_+|_+$/g, "") || "deck"}.${ext}`;
    const filename = decodeURIComponent(star?.[1] || plain?.[1] || fallback);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    // Chrome reads the blob after click returns. Revoking here makes the
    // download shelf report "无法读取导出文件" even though the PPTX is intact.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const bytes = report?.bytes ?? blob.size;
    const pages = report?.slideCount ?? model?.pageCount ?? 1;
    showExportResult({
      filename,
      pages,
      size: formatExportSize(bytes),
      degradations: report?.degradations ?? 0,
      embeddedFonts: report?.embeddedFonts ?? [],
      skippedFonts: report?.skippedFonts ?? [],
    });
  } catch (e) {
    showExportError(e instanceof Error ? e.message : String(e));
  }
}

async function readableImageDataUrl(file) {
  if (!String(file?.type || "").startsWith("image/")) {
    throw new Error(t("请选择可读取的图片文件"));
  }
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error(t("图片文件读取失败")));
    reader.readAsDataURL(file);
  });
  await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve();
      else reject(new Error(t("图片尺寸无效")));
    };
    image.onerror = () => reject(new Error(t("图片已损坏或格式不受支持")));
    image.src = data;
  });
  return data;
}

function pickImageFile(cb) {
  const input = $("image-file");
  input.value = "";
  input.onchange = async () => {
    const file = input.files?.[0];
    input.onchange = null;
    if (!file) return;
    try {
      const data = await readableImageDataUrl(file);
      const up = await api("/api/media", {
        method: "POST",
        body: JSON.stringify({ name: file.name, data }),
      });
      await cb(up.src);
    } catch (error) {
      showToast(t(`图片无法使用：{p0}`, { p0: error instanceof Error ? error.message : String(error) }), 6000);
    }
  };
  input.click();
}

function agentAttachmentStorageKey() {
  const project = new URLSearchParams(location.search).get("project") || "default";
  return `oss.editor.agent-attachments:${project}`;
}

function persistPendingAgentAttachments() {
  try {
    localStorage.setItem(agentAttachmentStorageKey(), JSON.stringify(pendingAgentAttachments));
  } catch {
    // The visible chips remain authoritative for this tab when storage is unavailable.
  }
}

function renderPendingAgentAttachments() {
  const box = $("agent-attachments");
  if (!box) return;
  box.replaceChildren();
  box.hidden = pendingAgentAttachments.length === 0;
  for (const attachment of pendingAgentAttachments) {
    const chip = document.createElement("span");
    chip.className = "agent-attachment-chip";
    chip.dataset.attachmentId = attachment.id;
    const label = document.createElement("span");
    label.textContent = attachment.consumed
      ? t(`{p0}`, { p0: attachment.name })
      : `${attachment.name} · ${formatExportSize(attachment.bytes)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = t(`移除 {p0}`, { p0: attachment.name });
    remove.setAttribute("aria-label", t(`移除附件 {p0}`, { p0: attachment.name }));
    remove.textContent = "×";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        const response = await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
        pendingAgentAttachments = pendingAgentAttachments.filter((entry) => entry.id !== attachment.id);
        persistPendingAgentAttachments();
        renderPendingAgentAttachments();
      } catch (error) {
        remove.disabled = false;
        showToast(t(`移除附件失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) }), 5000);
      }
    });
    chip.append(label, remove);
    box.append(chip);
  }
}

function setPendingAgentAttachmentsBusy(busy) {
  const box = $("agent-attachments");
  box?.setAttribute("aria-busy", String(Boolean(busy)));
  if ($("composer-plus")) $("composer-plus").disabled = Boolean(busy) || agentAttachmentUploadActive;
  if ($("agent-attachment-file")) $("agent-attachment-file").disabled = Boolean(busy);
  box?.querySelectorAll("button").forEach((button) => {
    button.disabled = Boolean(busy);
  });
}

async function uploadAgentAttachment(file) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error(t(`无法读取 {p0}`, { p0: file.name })));
    reader.readAsDataURL(file);
  });
  return api("/api/attachments", {
    method: "POST",
    body: JSON.stringify({ name: file.name, data }),
  });
}

async function restorePendingAgentAttachments() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(agentAttachmentStorageKey()) || "[]");
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved) || !saved.length) {
    pendingAgentAttachments = [];
    renderPendingAgentAttachments();
    return;
  }
  const restored = [];
  for (const item of saved.slice(0, 6)) {
    const id = String(item?.id || "");
    if (!id) continue;
    try {
      const rec = await api(`/api/attachments/${encodeURIComponent(id)}`);
      if (rec.parsed && typeof rec.text === "string") {
        restored.push({ id: rec.id, name: rec.name, bytes: rec.bytes, consumed: Boolean(item.consumed) });
      }
    } catch {
      // Attachment sidecar state may have been restarted; stale chips are dropped.
    }
  }
  pendingAgentAttachments = restored;
  persistPendingAgentAttachments();
  renderPendingAgentAttachments();
}

async function consumePendingAgentAttachments(attachments) {
  const cleanup = await Promise.all(attachments.map(async (attachment) => {
    try {
      const response = await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: "DELETE" });
      return { id: attachment.id, removed: response.ok || response.status === 404 };
    } catch {
      return { id: attachment.id, removed: false };
    }
  }));
  const removed = new Set(cleanup.filter((entry) => entry.removed).map((entry) => entry.id));
  const cleanupFailed = new Set(cleanup.filter((entry) => !entry.removed).map((entry) => entry.id));
  pendingAgentAttachments = pendingAgentAttachments
    .filter((attachment) => !removed.has(attachment.id))
    .map((attachment) => cleanupFailed.has(attachment.id) ? { ...attachment, consumed: true } : attachment);
  persistPendingAgentAttachments();
  renderPendingAgentAttachments();
  if (cleanupFailed.size) showToast(t("Agent 已收到附件，但有附件清理失败；可用 × 重试清理。"), 6000);
}

function positionInsertPopover(popover, trigger) {
  if (!popover || !trigger || popover.hidden) return;
  const anchor = trigger.getBoundingClientRect();
  const rect = popover.getBoundingClientRect();
  const gutter = 8;
  const left = Math.max(gutter, Math.min(anchor.left, window.innerWidth - rect.width - gutter));
  let top = anchor.bottom + 6;
  if (top + rect.height > window.innerHeight - gutter) top = Math.max(gutter, anchor.top - rect.height - 6);
  popover.style.position = "fixed";
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.bottom = "auto";
  popover.style.transform = "none";
}

function closeInsertPopovers(except = "") {
  closeCtxPops();
  for (const id of ["shape-palette", "table-size"]) {
    if (id === except) continue;
    const node = $(id);
    if (node) node.hidden = true;
  }
  document.querySelectorAll('[aria-controls="shape-palette"], [aria-controls="table-size"]').forEach((trigger) => {
    if (trigger.getAttribute("aria-controls") !== except) trigger.setAttribute("aria-expanded", "false");
  });
}

function hideMenus() {
  closeInsertPopovers();
  $("ctx-menu").hidden = true;
  const vm = $("version-menu");
  if (vm) vm.hidden = true;
  $("btn-versions")?.setAttribute("aria-expanded", "false");
}

$("text-link-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("text-link-input");
  const checked = validateTextLink(input?.value);
  if (!checked.href) {
    setTextLinkDialogError(checked.error);
    input?.focus();
    return;
  }
  void applyTextLinkFromDialog(checked.href);
});
$("text-link-input")?.addEventListener("input", () => setTextLinkDialogError());
$("text-link-cancel")?.addEventListener("click", () => $("text-link-dialog")?.close("cancel"));
$("text-link-remove")?.addEventListener("click", () => void applyTextLinkFromDialog(null));
$("text-link-dialog")?.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (!textLinkDialogBusy) $("text-link-dialog")?.close("cancel");
});
$("text-link-dialog")?.addEventListener("close", () => {
  const state = textLinkDialogState;
  textLinkDialogState = null;
  textLinkDialogBusy = false;
  queueMicrotask(() => restoreTextLinkDialogFocus(state));
});

$("btn-export").addEventListener("click", async () => {
  try {
    await settlePendingEdits();
    resetExportStatus();
    selectExportFormat(lastExportFormat || "pptx");
    $("export-dialog").showModal();
  } catch (e) {
    showToast(t(`保存当前编辑失败：{p0}`, { p0: e instanceof Error ? e.message : String(e) }));
  }
});
$("btn-sparkles")?.addEventListener("click", () => {
  const chat = $("work-chat");
  if (chat && !chat.hidden) {
    hideWorkChat();
    return;
  }
  showWorkChat();
});
$("chat-close")?.addEventListener("click", () => hideWorkChat());
$("composer-plus")?.addEventListener("click", () => $("agent-attachment-file")?.click());
$("agent-attachment-file")?.addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const files = [...(input.files || [])];
  input.value = "";
  if (!files.length) return;
  if (pendingAgentAttachments.length + files.length > 6) {
    showToast(t("每次最多发送 6 个附件。"), 5000);
    return;
  }
  agentAttachmentUploadActive = true;
  setPendingAgentAttachmentsBusy(false);
  try {
    for (const file of files) {
      const uploaded = await uploadAgentAttachment(file);
      if (!uploaded.parsed) {
        await fetch(`/api/attachments/${encodeURIComponent(uploaded.id)}`, { method: "DELETE" }).catch(() => undefined);
        throw new Error(uploaded.note || t(`{p0}`, { p0: file.name }));
      }
      pendingAgentAttachments.push(uploaded);
    }
    persistPendingAgentAttachments();
    renderPendingAgentAttachments();
  } catch (error) {
    showToast(t(`附件上传失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) }), 6000);
  } finally {
    agentAttachmentUploadActive = false;
    persistPendingAgentAttachments();
    renderPendingAgentAttachments();
    setPendingAgentAttachmentsBusy(false);
  }
});

function versionUiLabel(version) {
  const id = String(version?.id || "");
  return /^v[1-9]\d*$/i.test(id) ? id.toUpperCase() : String(version?.label || id || t("版本"));
}

async function refreshVersions() {
  const data = await api("/api/versions");
  versions = data.versions || [];
  const currentVersionId = String(data.currentVersionId || "");
  const latestStored = versions[versions.length - 1];
  const currentIsStored = Boolean(latestStored && latestStored.id === currentVersionId);
  const currentNumber = Math.max(1, versions.length + (currentIsStored ? 0 : 1));
  const btn = $("btn-versions");
  if (btn) {
    const previewLabel = versionUiLabel(previewVersion);
    btn.textContent = previewVersion ? `${previewLabel} ▾` : `V${currentNumber} ▾`;
  }
  const list = $("versions-list");
  if (!list) return;
  list.innerHTML = "";

  const appendCover = (row, page0) => {
    const cover = document.createElement("div");
    cover.className = "version-cover";
    if (page0?.size) {
      const mini = document.createElement("div");
      mini.className = "thumb-mini";
      paintSlide(mini, page0, { interactive: false });
      const [sw] = page0.size;
      mini.style.transform = `scale(${56 / sw})`;
      cover.append(mini);
    }
    row.append(cover);
  };

  if (!currentIsStored) {
    const current = document.createElement("button");
    current.type = "button";
    current.className = "version-row is-current";
    current.setAttribute("role", "menuitem");
    current.dataset.control = "chrome.history.versions.open";
    appendCover(current, thumbs?.[0]);
    const meta = document.createElement("div");
    meta.innerHTML = t(`<strong>V{p0} · 当前稿</strong><br><small>正在编辑</small> <span class="version-tag is-current">最新</span>`, { p0: currentNumber });
    current.append(meta);
    current.addEventListener("click", () => {
      exitHistoryPreview();
      $("version-menu").hidden = true;
    });
    list.append(current);
  }

  const items = [...versions].reverse();
  for (const v of items) {
    const latest = currentIsStored && v.id === currentVersionId;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "version-row";
    row.setAttribute("role", "menuitem");
    row.dataset.versionId = String(v.id || "");
    if (latest) row.classList.add("is-current");
    if (previewVersion?.id === v.id) row.classList.add("is-active");
    const when = v.createdAt ? relTime(v.createdAt) : t("刚刚");
    const note = String(v.note || "");
    const isOriginal = v.id === "v1" || note === "baseline:original";
    const isAgent = /^(?:ai-review|agent-chat|refine):/.test(note);
    const label = versionUiLabel(v);
    const context = String(v.label || "").replace(/\bv(\d+)\b/gi, "V$1");
    const hasContext = context && context !== label;
    const tag = latest ? t("最新") : isOriginal ? t("原始版本") : isAgent ? t("Agent 修改前") : hasContext ? context : t("手动快照");
    appendCover(row, v.thumbs?.[0]);
    const meta = document.createElement("div");
    const title = latest
      ? t(`{p0}`, { p0: label })
      : isOriginal
        ? t(`{p0}`, { p0: label })
        : label;
    meta.innerHTML = `<strong>${escapeHtmlText(title)}</strong><br><small>${escapeHtmlText(when)}${latest && hasContext ? ` · ${escapeHtmlText(context)}` : ""}</small> <span class="version-tag${isAgent ? " is-agent" : ""}${latest ? " is-current" : ""}">${escapeHtmlText(tag)}</span>`;
    if (v.note) row.title = v.note;
    row.append(meta);
    row.dataset.control = latest
      ? "chrome.history.versions.open"
      : "chrome.history.versions.preview";
    row.addEventListener("click", async () => {
      if (latest) {
        exitHistoryPreview();
        $("version-menu").hidden = true;
        return;
      }
      try {
        await enterHistoryPreview(v);
      } catch (error) {
        showToast(t(`打开版本失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) }));
      }
    });
    list.append(row);
  }
}

async function enterHistoryPreview(v) {
  await settlePendingEdits();
  const data = await api(`/api/versions/${encodeURIComponent(v.id)}`);
  if (!previewVersion) {
    historyReturnToChat = !$("work-chat")?.hidden;
    historyReturnFocus = document.activeElement;
  }
  previewVersion = data.version || v;
  previewModel = data.model;
  previewThumbs = data.thumbs || data.model?.pageModels || null;
  $("version-menu").hidden = true;
  hideWorkChat({ restoreFocus: false });
  $("chart-overlay").hidden = true;
  document.querySelector(".pin-card")?.remove();
  const original = previewVersion.id === "v1" || previewVersion.note === "baseline:original";
  const label = versionUiLabel(previewVersion);
  $("history-readonly").textContent = t(`只读 · {p0}{p1}`, { p0: label, p1: original ? " 原始版本" : "" });
  $("history-restore").textContent = t(`↺ 恢复 {p0}`, { p0: label });
  $("history-restore").disabled = false;
  await refreshVersions();
  render();
  // Expose the history bar only after the canvas and chrome have switched to
  // read-only preview state. Callers can now use its visibility as the
  // completion signal for the whole transition.
  $("history-bar").hidden = false;
}

function exitHistoryPreview() {
  previewVersion = null;
  previewModel = null;
  previewThumbs = null;
  $("history-bar").hidden = true;
  $("notes-text").value = model?.notes || "";
  render();
  if (historyReturnToChat) showWorkChat({ focusComposer: false });
  if (historyReturnFocus?.isConnected) historyReturnFocus.focus({ preventScroll: true });
  historyReturnToChat = false; historyReturnFocus = null;
  refreshVersions();
}

$("btn-versions").addEventListener("click", async (ev) => {
  ev.stopPropagation();
  try {
    await settlePendingEdits();
    await refreshVersions();
    $("version-menu").hidden = !$("version-menu").hidden;
    $("btn-versions").setAttribute("aria-expanded", String(!$("version-menu").hidden));
    if (!$("version-menu").hidden && ev.detail === 0) queueMicrotask(() => $("version-menu").querySelector("button:not(:disabled)")?.focus());
  } catch (e) {
    showToast(t(`保存当前编辑失败：{p0}`, { p0: e instanceof Error ? e.message : String(e) }));
  }
});
$("version-save").addEventListener("click", async (ev) => {
  ev.stopPropagation();
  try {
    await settlePendingEdits();
    await api("/api/versions", { method: "POST", body: JSON.stringify({}) });
    await refreshVersions();
  } catch (e) {
    showToast(t(`保存版本失败：{p0}`, { p0: e instanceof Error ? e.message : String(e) }));
  }
});
$("history-restore").addEventListener("click", async () => {
  const restore = $("history-restore");
  if (!previewVersion || restore.disabled) return;
  const versionId = previewVersion.id;
  restore.disabled = true;
  try {
    const data = await api("/api/versions/restore", {
      method: "POST",
      body: JSON.stringify({ id: versionId }),
    });
    model = data.model;
    if (data.thumbs) thumbs = data.thumbs;
    versions = data.versions || versions;
    exitHistoryPreview();
  } catch (error) {
    // Keep the immutable preview and its restore target in place so a
    // transient persistence error can be retried without losing context.
    restore.disabled = false;
    showToast(t(`恢复版本失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) }), 6000);
  }
});
$("history-back").addEventListener("click", () => exitHistoryPreview());
function selectExportFormat(format) {
  lastExportFormat = format;
  $("export-pptx")?.classList.toggle("on", format === "pptx");
  $("export-pdf")?.classList.toggle("on", format === "pdf");
  $("export-png")?.classList.toggle("on", format === "png");
  const fontLabel = $("export-font-label");
  if (fontLabel) fontLabel.hidden = format !== "pptx";
  const scope = $("export-scope");
  if (scope) {
    const pages = Number(model?.pageCount || model?.pageModels?.length || 1);
    scope.textContent = format === "png"
      ? t(`当前第 {p0} 页 · PNG 图片`, { p0: (model?.pageIndex ?? 0) + 1 })
      : format === "pdf"
        ? t(`全部 {p0} 页 · PDF 图片版（所看即所得）`, { p0: pages })
        : t(`全部 {p0} 页 · 可编辑 PPTX`, { p0: pages });
  }
}
$("export-pptx").addEventListener("click", () => {
  selectExportFormat("pptx");
});
$("export-pdf").addEventListener("click", () => {
  selectExportFormat("pdf");
});
$("export-png").addEventListener("click", () => {
  selectExportFormat("png");
});
let exportDownloadBusy = false;
const runExportDownload = async () => {
  if (exportDownloadBusy) return;
  exportDownloadBusy = true;
  const btn = $("export-download");
  if (btn) btn.disabled = true;
  try {
    await settlePendingEdits();
    await downloadExport(lastExportFormat || "pptx");
  } catch (e) {
    showExportError(e instanceof Error ? e.message : String(e));
  } finally {
    exportDownloadBusy = false;
    if (btn) btn.disabled = false;
  }
};
$("export-download")?.addEventListener("click", () => void runExportDownload());
$("export-retry")?.addEventListener("click", () => void runExportDownload());
const exportDialogEl = $("export-dialog");
if (exportDialogEl) {
  // Close is wired three ways: native method="dialog" submit, this explicit
  // click, and backdrop clicks (target === the dialog itself). If a capture
  // listener ever eats the submit, the explicit close still fires.
  exportDialogEl.querySelector('menu button[value="cancel"]')?.addEventListener("click", () => {
    if (exportDialogEl.open) exportDialogEl.close("cancel");
  });
  exportDialogEl.addEventListener("click", (ev) => {
    if (ev.target === exportDialogEl) exportDialogEl.close("cancel");
  });
}
function applyFitZoom() {
  hideMenus();
  command("zoom", { percent: 100 }).then(() => fitStage());
}
$("zoom-label").addEventListener("click", applyFitZoom);
for (const btnEl of document.querySelectorAll(".insert-btn[data-insert]")) {
  btnEl.addEventListener("click", (ev) => {
    const kind = btnEl.getAttribute("data-insert");
    if (!kind) return;
    if (kind === "image") {
      hideMenus();
      pickImageFile((src) =>
        command("insert", { kind: "image", src, aspect: "source" }).then(() => fitStage()),
      );
      return;
    }
    if (kind === "table") {
      ev.stopPropagation();
      const ts = $("table-size");
      const open = Boolean(ts?.hidden);
      closeInsertPopovers(open ? "table-size" : "");
      if (ts) {
        ts.hidden = !open;
        btnEl.setAttribute("aria-haspopup", "dialog");
        btnEl.setAttribute("aria-controls", "table-size");
        btnEl.setAttribute("aria-expanded", String(open));
        if (open) {
          insertPopoverReturnFocus = btnEl;
          positionInsertPopover(ts, btnEl);
          if (ev.detail === 0) queueMicrotask(() => ts.querySelector("button:not(:disabled)")?.focus());
        }
      }
      return;
    }
    if (kind === "shape") {
      ev.stopPropagation();
      const pal = $("shape-palette");
      const open = Boolean(pal.hidden) || document.querySelector('#lib-tabs [data-lib="shape"]')?.classList.contains("on") === false;
      closeInsertPopovers(open ? "shape-palette" : "");
      pal.hidden = !open;
      btnEl.setAttribute("aria-haspopup", "dialog");
      btnEl.setAttribute("aria-controls", "shape-palette");
      btnEl.setAttribute("aria-expanded", String(open));
      if (open) {
        insertPopoverReturnFocus = btnEl;
        setLibTab("shape");
        positionInsertPopover(pal, btnEl);
        if (ev.detail === 0) queueMicrotask(() => pal.querySelector("button:not(:disabled)")?.focus());
      }
      return;
    }
    if (kind === "line") {
      ev.stopPropagation();
      const pal = $("shape-palette");
      closeInsertPopovers("shape-palette");
      pal.hidden = false;
      btnEl.setAttribute("aria-haspopup", "dialog");
      btnEl.setAttribute("aria-controls", "shape-palette");
      btnEl.setAttribute("aria-expanded", "true");
      insertPopoverReturnFocus = btnEl;
      setLibTab("line");
      positionInsertPopover(pal, btnEl);
      return;
    }
    hideMenus();
    command("insert", { kind }).then(() => {
      if (kind === "text") {
        const id = selectedIds()[0];
        if (id) enterTextEdit(id);
      }
    });
  });
}
function presentAdvance(dir) {
  if (!model?.presenting) return;
  const groups = animationGroups(model.animations);
  if (dir > 0) {
    if (presentStep < groups.length) {
      presentStep += 1;
      renderChrome();
      return;
    }
    if (model.pageIndex + 1 < model.pageCount) {
      presentStep = 0;
      command("goToPage", { index: model.pageIndex + 1 });
      return;
    }
    return;
  }
  if (presentStep > 0) {
    presentStep -= 1;
    renderChrome();
    return;
  }
  if (model.pageIndex > 0) {
    command("goToPage", { index: model.pageIndex - 1 }).then(() => {
      presentStep = animationGroups(model.animations).length;
      renderChrome();
    });
  }
}

$("btn-play").addEventListener("click", () => {
  presentStep = 0;
  command("present", { on: !model?.presenting });
});
function fullscreenAdapter() {
  const root = document.documentElement;
  if (
    typeof root?.requestFullscreen === "function" &&
    typeof document.exitFullscreen === "function" &&
    document.fullscreenEnabled !== false
  ) {
    return {
      element: () => document.fullscreenElement,
      enter: () => root.requestFullscreen(),
      exit: () => document.exitFullscreen(),
    };
  }
  if (
    typeof root?.webkitRequestFullscreen === "function" &&
    typeof document.webkitExitFullscreen === "function" &&
    document.webkitFullscreenEnabled !== false
  ) {
    return {
      element: () => document.webkitFullscreenElement,
      enter: () => root.webkitRequestFullscreen(),
      exit: () => document.webkitExitFullscreen(),
    };
  }
  return null;
}

let fullscreenPending = false;
function updateFullscreenButton() {
  const button = $("btn-fs");
  if (!button) return;
  const adapter = fullscreenAdapter();
  const active = Boolean(adapter?.element());
  button.disabled = fullscreenPending || !adapter;
  const label = !adapter
    ? t("当前浏览器不支持全屏")
    : active
      ? t("退出全屏")
      : t("全屏");
  button.dataset.tip = label;
  button.removeAttribute("title");
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(active));
}

$("btn-fs").addEventListener("click", async () => {
  const adapter = fullscreenAdapter();
  if (!adapter || fullscreenPending) {
    updateFullscreenButton();
    return;
  }
  fullscreenPending = true;
  updateFullscreenButton();
  try {
    if (adapter.element()) await adapter.exit();
    else await adapter.enter();
  } catch (error) {
    showToast(t(`无法切换全屏：{p0}`, { p0: error instanceof Error ? error.message : String(error) }));
  } finally {
    fullscreenPending = false;
    updateFullscreenButton();
  }
});
document.addEventListener("fullscreenchange", updateFullscreenButton);
document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
updateFullscreenButton();
$("btn-rail").addEventListener("click", () => {
  if (!model) return;
  const open = !model.pageRailOpen;
  model.pageRailOpen = open;
  syncRailVisibility();
  command("pageRail", { open });
});
$("btn-undo").addEventListener("click", () => command("undo"));
$("btn-redo").addEventListener("click", () => command("redo"));
$("btn-zoom-in").addEventListener("click", () => {
  hideMenus();
  command("zoom", { direction: "in" });
});
$("btn-zoom-out").addEventListener("click", () => {
  hideMenus();
  command("zoom", { direction: "out" });
});
$("btn-notes-icon")?.addEventListener("click", () => command("notes", { open: !model.notesOpen }));
$("btn-rail-view")?.addEventListener("click", () => {
  railView = railView === "thumbs" ? "list" : "thumbs";
  localStorage.setItem("oss.railView", railView);
  renderRail();
});
$("present").addEventListener("click", (ev) => {
  if (ev.target.closest(".present-slide") || ev.target === $("present") || ev.target.closest(".present-hint")) {
    presentAdvance(1);
  }
});
$("notes-text").addEventListener("input", () => {
  if (previewVersion) {
    $("notes-text").value = viewModel()?.notes || "";
    return;
  }
  clearTimeout(notesTimer);
  pendingNotes = {
    pageIndex: model?.pageIndex ?? 0,
    notes: $("notes-text").value,
  };
  notesTimer = setTimeout(() => {
    flushPendingNotes().catch((e) => {
      showToast(t(`保存演讲者备注失败：{p0}`, { p0: e instanceof Error ? e.message : String(e) }));
    });
  }, 300);
});
document.addEventListener("selectionchange", () => {
  if (!editingId) return;
  const r = editingSelectionOffsets(slideElNode(editingId));
  if (r) pendingToolbarRange = r;
  syncRichToolbarState();
});
document.addEventListener(
  "pointerdown",
  (ev) => {
    const target = ev.target;
    if (editingId) {
      if (slideElNode(editingId)?.contains(target)) return;
      if (isCtxChrome(target)) {
        pendingToolbarRange = editingSelectionOffsets(slideElNode(editingId)) || pendingToolbarRange;
        return;
      }
      void commitTextEdit().catch((error) =>
        showToast(t(`保存文字失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
    }
    if (editingCell && !target.closest?.("td[contenteditable=true]") && !isCtxChrome(target)) {
      void commitTableEdit().catch((error) =>
        showToast(t(`保存表格失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
    }
  },
  true,
);
// Empty page area clears the selection. The grey field around the page and
// the card that frames it are the same empty area; only the page itself used
// to listen, so a click beside the page left the selection in place.
function clearSelectionFromBlank(ev) {
  if (marqueeDidSelect) {
    marqueeDidSelect = false;
    return;
  }
  if (editingId) {
    void commitTextEdit().catch((error) =>
      showToast(t(`保存文字失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
    return;
  }
  if (editingCell) {
    void commitTableEdit().catch((error) =>
      showToast(t(`保存表格失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
    return;
  }
  command("select", {});
}

$("slide").addEventListener("click", (ev) => {
  if (ev.target !== $("slide")) return;
  clearSelectionFromBlank(ev);
});
$("viewport")?.addEventListener("click", (ev) => {
  if (ev.target.closest("#slide")) return;
  if (ev.target.closest("button, a, input, textarea, select, [role='dialog']")) return;
  clearSelectionFromBlank(ev);
});
$("slide").addEventListener("pointerdown", (ev) => {
  if (ev.target !== $("slide")) return;
  if (ev.button != null && ev.button !== 0) return;
  if (editingId || editCommitLock) {
    if (editingId) {
      void commitTextEdit().catch((error) =>
        showToast(t(`保存文字失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
    }
    return;
  }
  if (editingCell) {
    void commitTableEdit().catch((error) =>
      showToast(t(`保存表格失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
    return;
  }
  const scale = slideScale();
  const rect = $("slide").getBoundingClientRect();
  const x0 = (ev.clientX - rect.left) / scale;
  const y0 = (ev.clientY - rect.top) / scale;
  const box = document.createElement("div");
  box.className = "marquee";
  $("slide").append(box);
  let moved = false;
  const move = (e) => {
    const dist = Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY);
    if (dist <= 4 && !moved) return;
    moved = true;
    const x1 = (e.clientX - rect.left) / scale;
    const y1 = (e.clientY - rect.top) / scale;
    const l = Math.min(x0, x1);
    const t = Math.min(y0, y1);
    box.style.left = `${l}px`;
    box.style.top = `${t}px`;
    box.style.width = `${Math.abs(x1 - x0)}px`;
    box.style.height = `${Math.abs(y1 - y0)}px`;
    box.dataset.box = JSON.stringify([l, t, Math.abs(x1 - x0), Math.abs(y1 - y0)]);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    const raw = box.dataset.box;
    box.remove();
    if (!moved || !raw) return;
    const [l, t, w, h] = JSON.parse(raw);
    const hits = (model.elements || [])
      .filter((el) => {
        if (el.locked || el.hidden) return false;
        const [x, y, ew, eh] = el.bounds;
        return x < l + w && x + ew > l && y < t + h && y + eh > t;
      })
      .map((el) => el.id);
    marqueeDidSelect = true;
    if (hits.length) command("select", { elementIds: hits });
    else command("select", {});
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
});

function commentTargetAtPoint(x, y) {
  const slide = $("slide");
  const size = slideSize();
  for (const node of document.elementsFromPoint(x, y)) {
    const target = node.closest?.(".el[data-id]");
    if (!target || !slide?.contains(target)) continue;
    const element = model?.elements?.find((item) => item.id === target.dataset.id);
    if (isAnnotationTarget(element, size)) return element.id;
  }
  return "";
}

function commentTargetsInRegion(box) {
  const slideRect = $("slide").getBoundingClientRect();
  const size = slideSize();
  // DOM bounds include rotation. Convert them back to slide units so the same
  // rule works at every zoom level and when the canvas is scrolled.
  const candidates = (model?.elements || []).filter((element) => isAnnotationTarget(element, size)).map((element) => {
    const rect = slideElNode(element.id)?.getBoundingClientRect();
    if (!rect) return element;
    const left = (rect.left - slideRect.left) * size[0] / slideRect.width;
    const top = (rect.top - slideRect.top) * size[1] / slideRect.height;
    return { ...element, bounds: [left, top, rect.width * size[0] / slideRect.width, rect.height * size[1] / slideRect.height] };
  });
  return annotationTargetsInBox(candidates, box, size);
}

function clearCommentDraftTarget() {
  commentGesture?.cancel();
  commentDraftTargetIds = [];
  commentDraftBox = null;
  commentHoverTargetId = "";
}

function syncCommentDraftPage() {
  const key = reviewCacheKey(model?.rootDir || currentProjectPath(), currentReviewPagePath());
  if (key === commentDraftPageKey) return;
  clearCommentDraftTarget();
  commentDraftPageKey = key;
  commentActiveId = "";
  hideCommentPopover();
}

function beginCommentTargetGesture(ev) {
  if (commentGesture) return;
  hideCommentPopover();
  const slide = $("slide");
  const pageKey = commentDraftPageKey;
  const start = annotationPoint(ev.clientX, ev.clientY, slide.getBoundingClientRect(), slideSize());
  const beforeIds = commentDraftTargetIds.slice();
  const beforeBox = commentDraftBox;
  const beforeScope = commentDraftScope;
  const hit = commentTargetAtPoint(ev.clientX, ev.clientY);
  let moved = false;
  let finished = false;
  commentHoverTargetId = "";
  commentActiveId = "";
  const stop = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", escape, true);
    commentGesture = null;
    if (slide.hasPointerCapture?.(ev.pointerId)) slide.releasePointerCapture(ev.pointerId);
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    stop();
    commentDraftTargetIds = beforeIds;
    commentDraftBox = beforeBox;
    commentDraftScope = beforeScope;
    syncCommentDraftUi();
  };
  const escape = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  };
  const move = (event) => {
    if (event.pointerId !== ev.pointerId) return;
    if (Math.hypot(event.clientX - ev.clientX, event.clientY - ev.clientY) < 4 && !moved) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    moved = true;
    commentDraftScope = "draw";
    const end = annotationPoint(event.clientX, event.clientY, slide.getBoundingClientRect(), slideSize());
    commentDraftBox = annotationBox(start, end);
    commentDraftTargetIds = commentTargetsInRegion(commentDraftBox);
    syncCommentDraftUi();
  };
  const up = (event) => {
    if (event.pointerId !== ev.pointerId || finished) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finished = true;
    stop();
    if (!commentMode || pageKey !== commentDraftPageKey) return;
    if (moved) {
      // The drag box is only a gesture. Once released, the actual objects are
      // the review scope; keep their individual outlines for confirmation.
      commentDraftBox = null;
      commentDraftScope = "elements";
      if (event.shiftKey || ev.shiftKey) {
        commentDraftTargetIds = [...new Set([...beforeIds, ...commentDraftTargetIds])];
      }
      if (!commentDraftTargetIds.length) {
        showToast(t("框内没有选中对象，请重新圈选。"));
      }
    } else if (hit) {
      commentDraftScope = "elements";
      commentDraftBox = null;
      const ids = new Set(event.shiftKey || ev.shiftKey ? beforeIds : []);
      if ((event.shiftKey || ev.shiftKey) && ids.has(hit)) ids.delete(hit);
      else ids.add(hit);
      commentDraftTargetIds = [...ids];
    } else {
      commentDraftScope = "page";
      commentDraftTargetIds = [];
      commentDraftBox = null;
    }
    syncCommentDraftUi();
    if (commentDraftTargetIds.length || commentDraftScope === "page") {
      showCommentPopover("draft", { point: { x: event.clientX, y: event.clientY }, focus: true });
    }
  };
  commentGesture = { cancel };
  slide.setPointerCapture?.(ev.pointerId);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", escape, true);
}

// Capture before editor drag/resize handlers: annotation gestures only choose
// targets. Their final click must not leak through and move/clear editor selection.
$("viewport")?.addEventListener("pointerdown", (ev) => {
  if (!commentMode || !$("slide")?.contains(ev.target) || ev.button !== 0) return;
  if (previewVersion || model?.presenting || generationInteractionLocked() || aiReviewTurnActive) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  syncCommentDraftPage();
  beginCommentTargetGesture(ev);
}, true);
for (const type of ["click", "dblclick"]) {
  $("viewport")?.addEventListener(type, (ev) => {
    if (!commentMode || !$("slide")?.contains(ev.target)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
}
$("viewport")?.addEventListener("pointermove", (ev) => {
  if (!commentMode || commentGesture) return;
  const id = commentTargetAtPoint(ev.clientX, ev.clientY);
  if (id === commentHoverTargetId) return;
  commentHoverTargetId = id;
  renderCommentDraftHighlight();
});
$("viewport")?.addEventListener("pointerleave", () => {
  commentHoverTargetId = "";
  renderCommentDraftHighlight();
});

function menuItem(label, shortcut, fn, control) {
  const b = document.createElement("button");
  b.type = "button";
  if (control) {
    b.setAttribute("data-control", control);
    b.disabled = !allowed(control);
  }
  b.innerHTML = `<span>${label}</span>${shortcut ? `<kbd>${shortcut}</kbd>` : ""}`;
  b.addEventListener("click", () => {
    hideMenus();
    fn();
  });
  return b;
}

function menuSep() {
  const s = document.createElement("div");
  s.className = "ctx-menu-sep";
  return s;
}

$("slide").addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  const menu = $("ctx-menu");
  contextMenuReturnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : $("slide");
  menu.style.left = `${ev.clientX}px`;
  menu.style.top = `${ev.clientY}px`;
  menu.innerHTML = "";
  setTimeout(() => {
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const gutter = 8;
    menu.style.left = `${Math.max(gutter, Math.min(ev.clientX, window.innerWidth - rect.width - gutter))}px`;
    menu.style.top = `${Math.max(gutter, Math.min(ev.clientY, window.innerHeight - rect.height - gutter))}px`;
    menu.querySelector("button:not(:disabled)")?.focus();
  }, 0);
  const el = selectedEl();
  if (!el) {
    menu.append(
      menuItem(t("粘贴"), "⌘V", pasteCanvasClipboardFromMenu, "element.duplicate"),
    );
    return;
  }
  menu.append(
    menuItem(t("剪切"), "⌘X", () => copyCanvasSelectionFromMenu({ cut: true }), "element.delete"),
    menuItem(t("复制"), "⌘C", copyCanvasSelectionFromMenu, "element.duplicate"),
    menuItem(t("粘贴"), "⌘V", pasteCanvasClipboardFromMenu, "element.duplicate"),
    menuItem(t("复制副本"), "⌘D", () => command("duplicateSelected"), "element.duplicate"),
    menuSep(),
    menuItem(t("置于顶层"), "", () => command("arrange", { dir: "front" }), "element.arrange.forward"),
    menuItem(t("上移一层"), "", () => command("arrange", { dir: "forward" }), "element.arrange.forward"),
    menuItem(t("下移一层"), "", () => command("arrange", { dir: "backward" }), "element.arrange.backward"),
    menuItem(t("置于底层"), "", () => command("arrange", { dir: "back" }), "element.arrange.backward"),
    menuSep(),
    menuItem(t("编组"), "⌘G", () => command("group"), "element.group.set"),
    menuItem(t("解组"), "", () => command("ungroup"), "element.ungroup.set"),
    menuItem(el.locked ? t("解锁") : t("锁定"), "", () => command("setLocked", { locked: !el.locked }), "element.lock.toggle"),
    menuItem(t("删除"), "⌫", () => command("deleteSelected"), "element.delete"),
  );
});

function renderShapeGrid(filter = "") {
  const grid = $("shape-grid");
  if (!grid) return;
  const q = filter.trim().toLowerCase();
  const catalog = shapeCatalog.length ? shapeCatalog : SHAPE_KINDS.map(([name, title]) => ({ name, title, group: "Basic Shapes" }));
  const groups = [...new Set(catalog.map((s) => s.group).filter(Boolean))];
  const cats = $("shape-cats");
  if (cats) {
    cats.innerHTML = "";
    const all = document.createElement("button");
    all.type = "button";
    all.className = `shape-cat${!shapeGroup ? " on" : ""}`;
    all.textContent = t("全部");
    all.addEventListener("click", (ev) => {
      ev.stopPropagation();
      shapeGroup = "";
      renderShapeGrid($("shape-search")?.value || "");
    });
    cats.append(all);
    for (const g of groups) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `shape-cat${shapeGroup === g ? " on" : ""}`;
      b.textContent = SHAPE_GROUP_LABELS[g] || g;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        shapeGroup = g;
        renderShapeGrid($("shape-search")?.value || "");
      });
      cats.append(b);
    }
  }
  const list = catalog.filter((s) => {
    if (shapeGroup && s.group && s.group !== shapeGroup) return false;
    return !q || s.name.toLowerCase().includes(q) || (s.title || "").toLowerCase().includes(q) || (s.group || "").toLowerCase().includes(q);
  });
  const count = $("shape-count");
  if (count) count.textContent = String(list.length);
  grid.innerHTML = "";
  for (const s of list.slice(0, 177)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "shape-cell";
    b.title = s.title || s.name;
    b.setAttribute("data-control", "insert.shape");
    b.disabled = !allowed("insert.shape");
    const d = s.pathD || "";
    const st = s.pathStroke || "";
    b.innerHTML =
      (d || st
        ? `<svg viewBox="0 0 100 100" width="28" height="28">${
            d ? `<path d="${d}" fill="currentColor"/>` : ""
          }${
            st
              ? `<path d="${st}" fill="none" stroke="currentColor" stroke-width="4"/>`
              : ""
          }</svg>`
        : s.title || s.name) + `<small>${s.title || s.name}</small>`;
    b.addEventListener("click", () => {
      hideMenus();
      command("insert", { kind: "shape", shapeName: s.name });
    });
    grid.append(b);
  }
}

let iconStyle = "fas";
let iconCat = "";
const ICON_CATS = [
  [t("全部"), ""],
  [t("常用"), "star heart check house user gear bell plus minus"],
  [t("箭头"), "arrow chevron caret"],
  [t("文件"), "file folder image camera"],
  [t("商务"), "chart briefcase building"],
];

function pickIcon(name) {
  const sel = selectedEl();
  if (sel?.type === "icon") command("setIconName", { iconName: name });
  hideMenus();
}

function renderIconChrome() {
  const cats = $("icon-cats");
  if (cats && !cats.dataset.ready) {
    cats.dataset.ready = "1";
    for (const [lab, key] of ICON_CATS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = lab;
      b.dataset.cat = key;
      if (key === iconCat) b.classList.add("on");
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        iconCat = key;
        for (const x of cats.querySelectorAll("button")) x.classList.toggle("on", x === b);
        renderIconGrid($("icon-search")?.value || "");
      });
      cats.append(b);
    }
  }
  $("icon-styles")?.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.getAttribute("data-style") === iconStyle);
  });
}

function renderIconGrid(filter = "") {
  renderIconChrome();
  const grid = $("icon-grid");
  if (!grid) return;
  const q = filter.trim().toLowerCase();
  const list = (faIcons.length ? faIcons : ICON_KINDS.map((n) => ({ defaultName: n, name: iconKey(n), search: [n] }))).filter(
    (s) => {
      const prefix = String(s.defaultName || s.name || "").split(":")[0];
      const styles = Array.isArray(s.styles) ? s.styles : [prefix];
      if (iconStyle && !styles.includes(iconStyle) && (s.defaultName || "").includes(":")) return false;
      if (iconCat && !(s.search || [s.name]).some((t) => iconCat.split(" ").some((k) => String(t).includes(k)))) {
        return false;
      }
      return !q || s.search?.some((t) => t.includes(q)) || s.name.includes(q);
    },
  );
  grid.innerHTML = "";
  for (const s of list.slice(0, 96)) {
    const b = document.createElement("button");
    b.type = "button";
    const iconControl = "element.icon.name.set";
    b.setAttribute("data-control", iconControl);
    b.disabled = !allowed(iconControl);
    const uni = faUnicode[s.name];
    const fam = iconStyle === "fab" ? "Font Awesome 6 Brands" : "Font Awesome 6 Free";
    const weight = iconStyle === "fas" ? 900 : 400;
    b.innerHTML = uni
      ? `<span style="font-family:'${fam}';font-weight:${weight}">&#x${uni};</span>`
      : s.name;
    b.title = `${iconStyle}:${s.name}`;
    b.setAttribute("aria-label", b.title);
    b.addEventListener("click", () => {
      pickIcon(`${iconStyle}:${s.name}`);
    });
    grid.append(b);
  }
}

function setLibTab(tab) {
  for (const b of document.querySelectorAll("#lib-tabs [data-lib]")) {
    b.classList.toggle("on", b.getAttribute("data-lib") === tab);
  }
  const shape = $("lib-shape");
  const line = $("lib-line");
  if (shape) shape.hidden = tab !== "shape";
  if (line) line.hidden = tab !== "line";
  if (tab === "line") fillLinePresets();
}

function fillLinePresets() {
  const host = $("line-presets");
  if (!host || host.dataset.ready) return;
  host.dataset.ready = "1";
  const presets = [
    { label: t("直线"), arrow: [null, null] },
    { label: t("箭头"), arrow: [null, "arrow"] },
    { label: t("双箭头"), arrow: ["arrow", "arrow"] },
  ];
  for (const p of presets) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.setAttribute("data-control", "insert.line");
    b.disabled = !allowed("insert.line");
    b.addEventListener("click", async () => {
      hideMenus();
      await command("insert", { kind: "line" });
      await command("setLineArrow", { arrow: p.arrow });
    });
    host.append(b);
  }
}

function fillTableSize() {
  const grid = $("table-size-grid");
  if (!grid || grid.dataset.ready) return;
  grid.dataset.ready = "1";
  const label = $("table-size-label");
  const max = 6;
  const paint = (hr, hc) => {
    grid.querySelectorAll(".table-size-cell").forEach((c) => {
      const r = Number(c.dataset.r);
      const col = Number(c.dataset.c);
      c.classList.toggle("on", r <= hr && col <= hc);
    });
    if (label) label.textContent = `${hr} × ${hc}`;
  };
  for (let r = 1; r <= max; r += 1) {
    for (let c = 1; c <= max; c += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "table-size-cell";
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.title = `${r} × ${c}`;
      cell.setAttribute("data-control", "insert.table");
      cell.disabled = !allowed("insert.table");
      cell.addEventListener("pointerenter", () => paint(r, c));
      cell.addEventListener("click", () => {
        hideMenus();
        void command("insert", { kind: "table", rows: r, columns: c });
      });
      grid.append(cell);
    }
  }
  paint(2, 2);
}

function fillPalettes() {
  renderShapeGrid();
  fillLinePresets();
  fillTableSize();
  $("shape-search")?.addEventListener("input", (e) => renderShapeGrid(e.target.value));
  $("lib-tabs")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-lib]");
    if (!btn) return;
    ev.stopPropagation();
    setLibTab(btn.getAttribute("data-lib"));
  });
}

let tlTime = 0;
let tlPlaying = false;
let tlTimer = 0;

function renderTimeline() {
  const panel = $("timeline");
  if (!panel) return;
  panel.hidden = !timelineOpen;
  document.querySelector(".app")?.classList.toggle("is-timeline", timelineOpen);
  $("btn-timeline")?.classList.toggle("active", timelineOpen);
  $("btn-anim-pill")?.classList.toggle("on", timelineOpen);
  const tracks = $("tl-tracks");
  if (!tracks || !model) return;
  const raw = model.animations || [];
  const anims = typeof staggerDelays === "function" ? staggerDelays(raw) : raw;
  const maxMs = Math.max(2000, ...anims.map((a, i) => (a.delayMs || i * 400) + (a.durationMs || 400)));
  tlMaxSec = maxMs / 1000;
  tracks.innerHTML = "";
  const effectLabel = {
    "fade-in": t("淡入"),
    "fly-in": t("飞入"),
    appear: t("出现"),
    "zoom-in": t("放大"),
    "wipe-in": t("擦除"),
    "float-in": t("浮入"),
  };
  for (const [i, a] of raw.entries()) {
    const row = document.createElement("div");
    row.className = "tl-track";
    const timed = anims[i] || a;
    const start = timed.delayMs || i * 400;
    const dur = timed.durationMs || 400;
    const label = document.createElement("div");
    label.className = "tl-track-label";
    label.textContent = `${effectLabel[a.effect] || a.effect || t("淡入")} · ${a.elementId}`;
    const wrap = document.createElement("div");
    wrap.className = "tl-bar-wrap";
    const bar = document.createElement("div");
    bar.className = "tl-bar";
    bar.style.left = `${(start / maxMs) * 100}%`;
    bar.style.width = `${(dur / maxMs) * 100}%`;
    wrap.append(bar);
    const chips = document.createElement("div");
    chips.className = "tl-chips";
    for (const [v, lab] of [
      ["onClick", t("单击时")],
      ["withPrevious", t("同时")],
      ["afterPrevious", t("之后")],
    ]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `tl-chip${(a.trigger || "onClick") === v ? " on" : ""}`;
      chip.textContent = lab;
      chip.addEventListener("click", () => {
        const next = raw.map((x, j) => (j === i ? { ...x, trigger: v } : x));
        command("setAnimations", { animations: next });
      });
      chips.append(chip);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.addEventListener("click", () => {
      command("setAnimations", { animations: raw.filter((_, j) => j !== i) });
    });
    row.append(label, wrap, chips, del);
    tracks.append(row);
  }
  const stagger = $("tl-stagger");
  if (stagger) {
    const groups = animationGroups(raw);
    stagger.hidden = !groups.some((g) => g.length > 1);
    stagger.innerHTML = "";
    groups.forEach((g, gi) => {
      if (g.length < 2) return;
      const chip = document.createElement("i");
      chip.textContent = t(`组 {p0} · {p1} 项 stagger 70ms`, { p0: gi + 1, p1: g.length });
      stagger.append(chip);
    });
  }
  const head = $("tl-playhead");
  if (head) head.style.left = `${Math.min(100, (tlTime / tlMaxSec) * 100)}%`;
  const clock = $("tl-time");
  if (clock) clock.textContent = `${tlTime.toFixed(1)}s`;
  if (timelineOpen && !model.presenting && !previewVersion) {
    const revealed = new Set();
    for (const [i, a] of anims.entries()) {
      const start = (a.delayMs || i * 400) / 1000;
      if (tlTime + 0.001 >= start) revealed.add(a.elementId);
    }
    const animated = new Set(anims.map((a) => a.elementId));
    $("slide")?.querySelectorAll(".el").forEach((node) => {
      const id = node.getAttribute("data-id");
      if (!id || !animated.has(id)) return;
      node.classList.toggle("anim-hidden", !revealed.has(id));
    });
  }
}

document.addEventListener(
  "pointerdown",
  (ev) => {
    const menu = $("ctx-menu");
    if (!menu || menu.hidden) return;
    if (menu.contains(ev.target)) return;
    hideMenus();
  },
  true,
);
$("viewport")?.addEventListener("scroll", hideMenus, { passive: true });
$("viewport")?.addEventListener("wheel", hideMenus, { passive: true });
document.addEventListener("click", (ev) => {
  const insertTrigger = ev.target.closest?.("[data-insert]");
  if (!ev.target.closest("#ctx-menu")) $("ctx-menu").hidden = true;
  if (
    !ev.target.closest("#shape-palette") &&
    insertTrigger?.getAttribute("data-insert") !== "shape" &&
    insertTrigger?.getAttribute("data-insert") !== "line"
  ) {
    $("shape-palette").hidden = true;
  }
  if (!ev.target.closest("#table-size") && insertTrigger?.getAttribute("data-insert") !== "table") {
    const ts = $("table-size");
    if (ts) ts.hidden = true;
  }
  if (!ev.target.closest(".version-wrap")) {
    const vm = $("version-menu");
    if (vm) vm.hidden = true;
    $("btn-versions")?.setAttribute("aria-expanded", "false");
  }
});

function commentKey() {
  // Never truncate project identity: many generated decks share the first 60
  // characters of their path. The old key could import another deck's comments.
  return reviewCacheKey(model?.rootDir || currentProjectPath(), currentReviewPagePath());
}

function currentReviewPagePath() {
  return model?.pagePaths?.[model?.pageIndex ?? 0] || `page-${String((model?.pageIndex ?? 0) + 1).padStart(2, "0")}`;
}

function loadComments({ force = false } = {}) {
  const key = commentKey();
  if (!force && commentLoadedKey === key && ["loading", "ready", "cached", "error"].includes(commentLoadState.status)) return;
  commentLoadedKey = key;
  let legacyComments = [];
  try {
    const local = JSON.parse(localStorage.getItem(key) || "[]");
    legacyComments = Array.isArray(local) ? local : [];
  } catch {
    legacyComments = [];
  }
  comments = [];
  commentLoadState = { key, status: "loading", error: "" };
  const pagePath = currentReviewPagePath();
  void fetch(`${nativeApi("/api/reviews")}?pagePath=${encodeURIComponent(pagePath)}&project=${encodeURIComponent(currentProjectPath())}`)
    .then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(data?.comments)) throw new Error(data?.error || t("无法读取项目批注"));
      return data;
    })
    .then((data) => {
      if (commentLoadedKey !== key) return;
      // A successful server read is authoritative, including an empty page.
      // Do not migrate the ambiguous old truncated cache into a different deck.
      comments = data.comments;
      syncCommentQueuePage(pagePath, comments);
      commentLoadState = { key, status: "ready", error: "" };
      localStorage.setItem(key, JSON.stringify(comments));
      renderComments();
    })
    .catch((error) => {
      if (commentLoadedKey !== key) return;
      comments = legacyComments;
      commentLoadState = {
        key,
        status: legacyComments.length ? "cached" : "error",
        error: error instanceof Error ? error.message : t("无法读取项目批注"),
      };
      renderComments();
    });
}

async function reloadCommentsFromServer() {
  // Refresh the pending context after a turn or navigation.
  allPageComments = null;
  commentQueueState.loaded = false;
  const key = commentKey();
  const pagePath = currentReviewPagePath();
  const response = await fetch(`${nativeApi("/api/reviews")}?pagePath=${encodeURIComponent(pagePath)}&project=${encodeURIComponent(currentProjectPath())}`);
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.comments)) throw new Error(data?.error || t("无法刷新批注状态"));
  if (key !== commentKey()) return;
  commentLoadedKey = key;
  comments = data.comments;
  syncCommentQueuePage(pagePath, comments);
  commentLoadState = { key, status: "ready", error: "" };
  localStorage.setItem(key, JSON.stringify(comments));
  renderComments();
}

/** Re-point a comment whose targets were regenerated away. */
async function rebindComment(comment, scope) {
  if (!comment?.id) return;
  if (scope.kind === "elements" && !scope.elementIds.length) return;
  try {
    if (scope.kind === "page") delete comment.elementId;
    await saveComments(comment, { throwOnError: true, deferLocal: true, rebindScope: scope });
    await reloadCommentsFromServer().catch(() => undefined);
    renderComments();
    showToast(scope.kind === "page" ? t("已改为整页批注，现在可以交给 AI 了。") : t("已绑到所选对象，现在可以交给 AI 了。"));
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 6000);
    renderComments();
  }
}

function saveComments(changedComment, { throwOnError = false, deferLocal = false, rebindScope = null } = {}) {
  const now = new Date().toISOString();
  for (const comment of comments) {
    comment.id ||= globalThis.crypto?.randomUUID?.() || `review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    comment.author ||= t("我");
    comment.createdAt ||= now;
    comment.updatedAt = now;
    comment.aiStatus ||= "idle";
  }
  if (!deferLocal) localStorage.setItem(commentKey(), JSON.stringify(comments));
  const pagePath = currentReviewPagePath();
  const changedId = changedComment?.id;
  const records = changedId ? comments.filter((comment) => comment.id === changedId) : comments.slice();
  const attempt = commentSaveTail.then(async () => {
    for (const comment of records) {
      if (!comment.scope) {
        const legacyId = String(comment.elementId || "").trim();
        comment.scope = legacyId
          ? { kind: "elements", elementIds: [legacyId] }
          : { kind: "page", elementIds: [] };
      }
      const outgoing = { ...comment };
      delete outgoing._resolvePending;
      if (rebindScope) outgoing.scope = rebindScope;
      // Scope is immutable after creation. Omitting it on ordinary updates
      // prevents a later selection change from silently retargeting a thread —
      // unless this call is an explicit re-bind.
      if (!rebindScope && Number.isInteger(comment.revision) && comment.revision >= 1) delete outgoing.scope;
      const sendPatch = (payload) => fetch(nativeApi("/api/reviews"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: currentProjectPath(),
          pagePath,
          comment: payload,
          // An explicit re-bind is the one case where a scope may change.
          ...(rebindScope ? { rebind: true } : {}),
        }),
      });
      let response = await sendPatch(outgoing);
      let result = await response.json().catch(() => null);
      if (response.status === 400 && result?.code === "REVIEW_SCOPE_REQUIRED" && !outgoing.scope) {
        // This browser still holds the comment but the project store no longer has
        // its thread, so the server asks for an explicit scope. Re-send with the
        // scope we already resolved locally instead of failing the save.
        response = await sendPatch({ ...outgoing, scope: comment.scope });
        result = await response.json().catch(() => null);
      }
      if (response.status === 409 && result?.comment) {
        const index = comments.findIndex((entry) => entry.id === result.comment.id);
        if (index >= 0) Object.assign(comments[index], result.comment);
        localStorage.setItem(commentKey(), JSON.stringify(comments));
        renderComments();
        const error = new Error(result.code === "REVIEW_SCOPE_IMMUTABLE"
          ? t("批注范围已锁定；如需改范围，请新建批注。")
          : t("批注已被其他窗口更新，已载入最新版本。"));
        error.code = result.code || "REVIEW_COMMENT_CONFLICT";
        throw error;
      }
      if (!response.ok || !result?.comment) {
        const missing = Array.isArray(result?.missingElementIds) ? `：${result.missingElementIds.join("、")}` : "";
        const error = new Error(result?.code === "REVIEW_TARGET_MISSING"
          ? t(`批注对象已不存在{p0}，请重新选择对象后新建批注。`, { p0: missing })
          : result?.error || t("批注保存失败"));
        error.code = result?.code || "REVIEW_SAVE_FAILED";
        throw error;
      }
      const index = comments.findIndex((entry) => entry.id === result.comment.id);
      if (index >= 0) Object.assign(comments[index], result.comment);
      syncCommentQueuePage(pagePath, comments);
      localStorage.setItem(commentKey(), JSON.stringify(comments));
    }
  });
  const settled = attempt.catch((error) => {
    // A 409 has already replaced the local stale thread with the server copy,
    // so retrying the same edit cannot silently overwrite a collaborator.
    showToast(error?.message || t("批注暂未保存到项目，请稍后重试。"));
  });
  commentSaveTail = settled;
  return throwOnError ? attempt : settled;
}

function slideSize() {
  const size = model?.size;
  if (Array.isArray(size) && size.length >= 2) return [Number(size[0]) || 1920, Number(size[1]) || 1080];
  return [1920, 1080];
}

function commentElementIds(comment) {
  const scope = comment?.scope;
  // A stored scope is authoritative. Without this, a comment re-bound to the whole
  // page kept pointing at the element id it was born with, and stayed "invalid".
  if (scope && scope.kind === "page") return [];
  const ids = scope && scope.kind === "elements" && Array.isArray(scope.elementIds)
    ? scope.elementIds
    : comment?.elementId
      ? [comment.elementId]
      : [];
  return [...new Set(ids.filter((id) => typeof id === "string" && id.trim()))];
}

function missingCommentElementIds(comment) {
  const present = new Set((model?.elements || []).map((element) => element.id));
  return commentElementIds(comment).filter((id) => !present.has(id));
}

function commentPinPoint(c, vp) {
  const [sw, sh] = slideSize();
  let px = vp.left + c.x * vp.width;
  let py = vp.top + c.y * vp.height;
  const elementIds = commentElementIds(c);
  let orphan = missingCommentElementIds(c).length > 0;
  if (!elementIds.length) return avoidInsertPill(px, py, orphan);
  const anchorId = elementIds.find((id) => model?.elements?.some((element) => element.id === id));
  const el = model?.elements?.find((e) => e.id === anchorId);
  if (!el || !Array.isArray(el.bounds)) {
    return avoidInsertPill(px, py, true);
  }
  if (c.scope?.kind === "elements") {
    const node = slideElNode(el.id);
    const bounds = node?.getBoundingClientRect();
    if (bounds) {
      const visible = $("viewport")?.getBoundingClientRect();
      const radius = 12;
      let anchorX = bounds.right + 8;
      let anchorY = bounds.top;
      if (visible) {
        if (anchorX > visible.right - radius) anchorX = bounds.left - 8;
        anchorX = Math.max(visible.left + radius, Math.min(visible.right - radius, anchorX));
        anchorY = Math.max(visible.top + radius, Math.min(visible.bottom - radius, anchorY));
      }
      return avoidInsertPill(anchorX, anchorY, orphan);
    }
  }
  if (c.ox == null || c.oy == null) {
    c.ox = c.x * sw - el.bounds[0];
    c.oy = c.y * sh - el.bounds[1];
  }
  px = vp.left + ((el.bounds[0] + Number(c.ox)) / sw) * vp.width;
  py = vp.top + ((el.bounds[1] + Number(c.oy)) / sh) * vp.height;
  return avoidInsertPill(px, py, orphan);
}

function avoidInsertPill(px, py, orphan) {
  // The insert row was renamed from .insert-pill to #insert-toolbar; querying the
  // old class silently disabled this overlap avoidance for comment pins.
  const pill = document.querySelector("#insert-toolbar");
  if (!pill || pill.hidden) return { px, py, orphan };
  const r = pill.getBoundingClientRect();
  const pad = 16;
  if (px >= r.left - pad && px <= r.right + pad && py >= r.top - pad && py <= r.bottom + pad) {
    return { px, py: r.top - 18, orphan };
  }
  return { px, py, orphan };
}

function renderComments() {
  if (model) void ensureCommentQueue();
  renderCommentBatchChip();
  const layer = $("comment-layer");
  const panel = $("comment-panel");
  if (!layer) return;
  if (model?.presenting || previewVersion) {
    layer.hidden = true;
    if (panel) panel.hidden = true;
    return;
  }
  layer.hidden = !commentMode;
  layer.innerHTML = "";
  if (!commentMode || !model) {
    if (panel) panel.hidden = true;
    return;
  }
  if (panel) panel.hidden = !commentPopoverOpen;
  syncCommentDraftPage();
  loadComments();
  renderCommentPanel();
  const vp = $("slide")?.getBoundingClientRect();
  if (!vp) return;
  let migrated = false;
  comments.forEach((c, i) => {
    if (!isPendingComment(c)) return;
    const ordinal = selectedCommentEntries().findIndex(entry => entry.pagePath === currentReviewPagePath() && entry.comment.id === c.id) + 1 || i + 1;
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "pin";
    pin.textContent = String(ordinal);
    const beforeOx = c.ox;
    const beforeOy = c.oy;
    const { px, py, orphan } = commentPinPoint(c, vp);
    if (c.elementId && (beforeOx == null || beforeOy == null) && c.ox != null && c.oy != null) migrated = true;
    if (orphan) pin.classList.add("pin-orphan");
    if (c.elementId) pin.dataset.elementId = c.elementId;
    pin.dataset.commentId = c.id || "";
    pin.style.left = `${px}px`;
    pin.style.top = `${py}px`;
    // The popover carries the note; a second hover tooltip would cover its controls.
    pin.setAttribute("aria-label", t(`批注 {p0}{p1}{p2}`, { p0: ordinal, p1: orphan ? "，目标已失效" : "", p2: c.text ? `：${c.text}` : "" }));
    pin.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void openPinCard(c);
    });
    layer.append(pin);
    const targetIds = commentElementIds(c);
    // A missing element is NOT a page comment. Never paint a whole-slide outline
    // as a fallback: it falsely tells the user that the note targets the page.
    const boxes = targetIds.length
      ? targetIds.map((elementId) => ({ elementId, rect: slideElNode(elementId)?.getBoundingClientRect() }))
      : c.scope?.kind === "page" ? [{ elementId: "", rect: vp }] : [];
    for (const { elementId, rect } of boxes) {
      if (!rect || !rect.width || !rect.height) continue;
      const mark = document.createElement("div");
      mark.className = `comment-anchor${elementId ? "" : " is-page"}`;
      mark.dataset.commentId = c.id || "";
      mark.dataset.elementId = elementId;
      positionCommentBox(mark, rect);
      mark.setAttribute("aria-hidden", "true");
      layer.append(mark);
    }
    pin.addEventListener("mouseenter", () => syncCommentAnchorHighlight(c.id));
    pin.addEventListener("mouseleave", () => syncCommentAnchorHighlight());
    pin.addEventListener("focus", () => syncCommentAnchorHighlight(c.id));
    pin.addEventListener("blur", () => syncCommentAnchorHighlight());
  });
  if (migrated) saveComments();
  syncCommentAnchorHighlight();
  renderCommentDraftHighlight();
  scheduleCommentOverlayPositions();
}

function positionCommentBox(node, rect) {
  Object.assign(node.style, {
    left: `${rect.left}px`, top: `${rect.top}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
  });
}

function renderCommentDraftHighlight() {
  const layer = $("comment-layer");
  $("comment-draft-layer")?.remove();
  if (!layer || !commentMode || previewVersion || model?.presenting) return;
  const draftLayer = document.createElement("div");
  draftLayer.id = "comment-draft-layer";
  draftLayer.setAttribute("aria-hidden", "true");
  const draw = (rect, className, id = "") => {
    if (!rect?.width || !rect?.height) return;
    const outline = document.createElement("div");
    outline.className = className;
    if (id) outline.dataset.commentDraftTarget = id;
    positionCommentBox(outline, rect);
    draftLayer.append(outline);
  };
  const slideRect = $("slide")?.getBoundingClientRect();
  const viewportRect = $("viewport")?.getBoundingClientRect();
  if (!slideRect) return;
  if (viewportRect) draftLayer.style.clipPath = `inset(${Math.max(0, viewportRect.top)}px ${Math.max(0, innerWidth - viewportRect.right)}px ${Math.max(0, innerHeight - viewportRect.bottom)}px ${Math.max(0, viewportRect.left)}px)`;
  if (commentDraftScope === "page") {
    draw(slideRect, "comment-draft-page");
  } else {
    if (commentDraftScope === "draw" && commentDraftBox) {
      const [x, y, w, h] = commentDraftBox;
      const [sw, sh] = slideSize();
      draw({ left: slideRect.left + x * slideRect.width / sw, top: slideRect.top + y * slideRect.height / sh,
        width: w * slideRect.width / sw, height: h * slideRect.height / sh }, "comment-draft-region");
    }
    for (const [index, id] of commentDraftTargetIds.entries()) {
      draw(slideElNode(id)?.getBoundingClientRect(), "comment-draft-target", id);
      const outline = draftLayer.lastElementChild;
      if (outline?.dataset.commentDraftTarget === id && !commentGesture) {
        outline.dataset.ordinal = String(index + 1);
      }
    }
    if (commentHoverTargetId && !commentDraftTargetIds.includes(commentHoverTargetId)) {
      draw(slideElNode(commentHoverTargetId)?.getBoundingClientRect(), "comment-hover-target");
    }
  }
  layer.append(draftLayer);
}

function scheduleCommentOverlayPositions() {
  if (commentOverlayFrame) return;
  commentOverlayFrame = requestAnimationFrame(() => {
    commentOverlayFrame = 0;
    if (!commentMode) return;
    const layer = $("comment-layer");
    const slideRect = $("slide")?.getBoundingClientRect();
    if (!layer || !slideRect) return;
    for (const mark of layer.querySelectorAll(".comment-anchor")) {
      const rect = mark.dataset.elementId
        ? slideElNode(mark.dataset.elementId)?.getBoundingClientRect() : slideRect;
      if (rect) positionCommentBox(mark, rect);
      else mark.remove();
    }
    for (const pin of layer.querySelectorAll(".pin")) {
      const comment = comments.find((item) => item.id === pin.dataset.commentId);
      if (!comment) continue;
      const { px, py } = commentPinPoint(comment, slideRect);
      pin.style.left = `${px}px`;
      pin.style.top = `${py}px`;
    }
    renderCommentDraftHighlight();
    positionCommentPopover();
  });
}
$("viewport")?.addEventListener("scroll", scheduleCommentOverlayPositions, { passive: true });
window.addEventListener("resize", scheduleCommentOverlayPositions, { passive: true });
if (typeof ResizeObserver !== "undefined") {
  const observer = new ResizeObserver(scheduleCommentOverlayPositions);
  if ($("slide")) observer.observe($("slide"));
  if ($("viewport")) observer.observe($("viewport"));
  if ($("comment-panel")) observer.observe($("comment-panel"));
}

/** Hover intensifies the active card's anchor without forgetting an opened note. */
function syncCommentAnchorHighlight(activeId = commentActiveId) {
  const layer = $("comment-layer");
  if (!layer) return;
  for (const node of layer.querySelectorAll(".comment-anchor")) {
    node.classList.toggle("is-active", Boolean(activeId) && node.dataset.commentId === activeId);
  }
  for (const node of layer.querySelectorAll(".pin")) {
    node.classList.toggle("is-anchor-active", Boolean(activeId) && node.dataset.commentId === activeId);
  }
}

function commentScopeLabel(comment) {
  const scope = comment?.scope;
  if (scope?.kind === "elements") {
    const ids = Array.isArray(scope.elementIds) ? scope.elementIds : [];
    const elements = ids.map((id) => model?.elements?.find((element) => element.id === id)).filter(Boolean);
    return ids.length > 1
      ? t(`{p0} 个对象{p1}`, { p0: ids.length, p1: elements.length ? ` · ${elements.slice(0, 2).map(elementReadableName).join("、")}${elements.length > 2 ? "…" : ""}` : "" })
      : elements[0]
        ? elementReadableName(elements[0])
        : t("所选对象");
  }
  return t("整页");
}

function makeCommentCard(c) {
  const card = document.createElement("article");
  card.className = "comment-card";
  card.dataset.commentId = c.id;
  const disabled = c.aiStatus === "running" || Boolean(c._resolvePending);
  const entry = { pagePath: currentReviewPagePath(), comment: c };
  const key = commentSelectionKey(entry.pagePath, c.id);
  card.innerHTML = t(`<p class="comment-note-target"></p><textarea aria-label="修改意见" placeholder="描述你希望如何修改…" {p0}></textarea><p class="comment-note-status" role="status" hidden></p><footer class="comment-actions"><button type="button" class="comment-remove" data-act="remove" data-control="chrome.comments.select" aria-label="移除这条批注" {p1}>{p2}</button><span class="comment-shortcut">⌘ / Ctrl + Enter</span><button type="button" class="comment-commit" data-act="save" {p3}>更新</button></footer>`, { p0: disabled ? "disabled" : "", p1: disabled ? "disabled" : "", p2: commentTrashIcon(), p3: disabled ? "disabled" : "" });
  card.querySelector('.comment-note-target').textContent = t(`第 {p0} 页 · {p1}`, { p0: (model?.pageIndex ?? 0) + 1, p1: commentScopeLabel(c) });
  const editor = card.querySelector('textarea');
  editor.value = commentTextDrafts.get(key) ?? c.text ?? '';
  editor.addEventListener('input', () => { commentTextDrafts.set(key, editor.value); renderCommentBatchChip(); });
  editor.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); card.querySelector('[data-act=save]').click(); }
  });
  const status = card.querySelector('.comment-note-status');
  const missing = missingCommentElementIds(c).length;
  const message = missing ? t("原对象已变化，请在画布上重新标记。") : c.aiStatus === 'running' ? t("AI 正在修改…") : c.aiStatus === 'failed' ? t("修改未完成，可以在对话中重新发送。") : '';
  status.hidden = !message; status.textContent = message;
  card.querySelector('[data-act=save]').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      await saveCommentTextDraft(entry);
      commentSelection.set(key, entry);
      hideCommentPopover(); renderComments();
    } catch (error) { showToast(error.message || t("批注更新失败")); }
    finally { button.disabled = false; }
  });
  card.querySelector('[data-act=remove]').addEventListener('click', () => void removeCommentAttachment(entry));
  return card;
}

function commentTrashIcon() {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg>';
}

function commentPagePathForCurrentView() {
  return model?.pagePaths?.[model?.pageIndex ?? 0] || "";
}

function commentSelectionKey(pagePath, id) {
  return `${pagePath}\u0000${id}`;
}

function isPendingComment(comment) {
  return commentIsDraft(comment, generationActivity);
}

function syncCommentQueuePage(pagePath, records) {
  for (const comment of records) {
    if (!comment.id) continue;
    const key = commentSelectionKey(pagePath, comment.id);
    const revision = comment.revision || 0;
    if ((commentQueueRevisions.get(key) || 0) > revision) continue;
    commentQueueRevisions.set(key, revision);
    // A structurally deleted page orphans its threads: keep the record but
    // never offer it as a submittable edit target.
    if (comment.pageGone || !isPendingComment(comment)) commentSelection.delete(key);
    else commentSelection.set(key, { pagePath, comment });
  }
}

async function ensureCommentQueue() {
  const project = currentProjectPath();
  if (!project) return;
  if (commentQueueState.project !== project) {
    commentQueueState = { project, loading: false, loaded: false };
    commentSelection.clear(); commentQueueRevisions.clear(); commentTextDrafts.clear(); allPageComments = null;
  }
  if (commentQueueState.loaded || commentQueueState.loading) return;
  const state = commentQueueState;
  state.loading = true;
  try {
    const data = await api(`/api/reviews?all=1&project=${encodeURIComponent(project)}`);
    if (state !== commentQueueState) return;
    allPageComments = data;
    for (const [pagePath, records] of Object.entries(data.pages || {})) syncCommentQueuePage(pagePath, records);
    state.loaded = true;
    renderCommentBatchChip();
  } catch { state.loaded = true; showToast(t("暂时无法读取批注，请刷新后重试。")); }
  finally { state.loading = false; }
}

function selectedCommentEntries() {
  return [...commentSelection.values()].filter(entry => isPendingComment(entry.comment));
}

async function openCommentAttachment(entry) {
  try {
    const index = model?.pagePaths?.indexOf(entry.pagePath) ?? -1;
    if (index < 0) return showToast(t("找不到这条批注的页面。"));
    if (index !== model.pageIndex) await command('goToPage', { index });
    await reloadCommentsFromServer();
    const comment = comments.find(item => item.id === entry.comment.id);
    if (comment && isPendingComment(comment)) await openPinCard(comment);
  } catch { showToast(t("暂时无法打开批注，请稍后再试。")); }
}

// The review API replaces a record; preserve metadata on text/remove updates.
function commentPatch(comment, patch) {
  const record = { ...comment, ...patch };
  delete record._resolvePending;
  delete record.scope;
  return record;
}

function applyCommentUpdate(entry, updated) {
  Object.assign(entry.comment, updated);
  const lists = [allPageComments?.pages?.[entry.pagePath]];
  if (entry.pagePath === currentReviewPagePath()) lists.push(comments);
  for (const list of lists) {
    const current = list?.find(comment => comment.id === updated.id);
    if (current) Object.assign(current, updated);
  }
  syncCommentQueuePage(entry.pagePath, [entry.comment]);
}

async function removeCommentAttachment(entry) {
  const c = entry.comment;
  if (c._resolvePending || c.aiStatus === 'running' || aiReviewTurnActive) return;
  const key = commentSelectionKey(entry.pagePath, c.id);
  c._resolvePending = true;
  renderCommentBatchChip();
  try {
    await commentSaveTail;
    const result = await api('/api/reviews', { method: 'PATCH', body: JSON.stringify({project: currentProjectPath(), pagePath: entry.pagePath, comment: commentPatch(c, {resolved: true})}) });
    applyCommentUpdate(entry, result.comment);
    commentTextDrafts.delete(key);
    if (commentActiveId === c.id) hideCommentPopover();
    renderComments();
    showToast(t("已移除批注"), 7000);
    const undo = document.createElement('button');
    undo.type = 'button'; undo.className = 'comment-undo'; undo.textContent = t("撤销");
    undo.dataset.control = 'chrome.comments.select';
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        const restored = await api('/api/reviews', { method: 'PATCH', body: JSON.stringify({project: currentProjectPath(), pagePath: entry.pagePath, comment: commentPatch(c, {resolved: false})}) });
        applyCommentUpdate(entry, restored.comment);
        renderComments(); showToast(t("批注已恢复"));
      } catch (error) { showToast(error.message || t("恢复失败")); }
    });
    $('app-toast')?.append(undo);
  } catch (error) { showToast(error.message || t("移除失败，批注仍保留")); }
  finally { delete c._resolvePending; renderCommentBatchChip(); }
}

function renderCommentBatchChip() {
  const group = $('work-comment-batch');
  if (!group) return;
  const entries = selectedCommentEntries();
  group.hidden = entries.length === 0;
  $('work-comment-batch-label').textContent = t(`{p0} 条批注`, { p0: entries.length });
  const list = $('work-comment-items');
  const signature = JSON.stringify(entries.map(({pagePath,comment:c})=>[pagePath,c.id,c.revision,commentTextDrafts.get(commentSelectionKey(pagePath,c.id))??c.text,c.aiStatus,Boolean(c._resolvePending)]));
  if (list && list.dataset.signature !== signature) {
    list.dataset.signature = signature; list.replaceChildren();
    entries.forEach((entry,index) => {
      const c = entry.comment;
      const item = document.createElement('div'); item.className = 'comment-attachment'; item.dataset.commentId = c.id;
      const open = document.createElement('button'); open.type='button'; open.className='comment-attachment-open'; open.dataset.control='chrome.comments.list';
      const pageIndex = model?.pagePaths?.indexOf(entry.pagePath) ?? -1;
      const preview = String(commentTextDrafts.get(commentSelectionKey(entry.pagePath,c.id)) ?? c.text ?? '').trim();
      open.innerHTML='<span class="comment-attachment-number"></span><span class="comment-attachment-copy"><small></small><span></span></span>';
      open.querySelector('.comment-attachment-number').textContent=String(index+1);
      open.querySelector('small').textContent=pageIndex>=0 ? t(`第 {p0} 页`, { p0: pageIndex+1 }) : t("批注");
      open.querySelector('.comment-attachment-copy > span').textContent=preview;
      open.setAttribute('aria-label',t(`编辑批注 {p0}：{p1}`, { p0: index+1, p1: preview }));
      open.addEventListener('click',()=>void openCommentAttachment(entry));
      const remove=document.createElement('button'); remove.type='button'; remove.className='comment-attachment-remove'; remove.textContent='×'; remove.dataset.control='chrome.comments.select';
      remove.setAttribute('aria-label',t(`移除批注 {p0}`, { p0: index+1 })); remove.disabled=c.aiStatus==='running'||Boolean(c._resolvePending);
      remove.addEventListener('click',()=>void removeCommentAttachment(entry));
      item.append(open,remove); list.append(item);
    });
  }
  const send=document.querySelector('#work-form .composer-send');
  if (send && !generationInteractionLocked() && !aiReviewTurnActive) {
    const label=entries.length ? t(`发送 {p0} 条批注`, { p0: entries.length }) : t("发送消息");
    send.title=label; send.setAttribute('aria-label',label);
  }
  paintWorkAgentTarget();
}

function saveCommentTextDraft(entry) {
  const attempt = commentSaveTail.then(async () => {
    const key = commentSelectionKey(entry.pagePath, entry.comment.id);
    if (!commentTextDrafts.has(key)) return;
    const text = commentTextDrafts.get(key).trim();
    if (!text) throw new Error(t("批注内容不能为空，请补全后再发送。"));
    const result = await api("/api/reviews", {
      method: "PATCH",
      body: JSON.stringify({ project: currentProjectPath(), pagePath: entry.pagePath,
        comment: commentPatch(entry.comment, { text, aiSubmissionId: undefined, aiStatus: "idle", aiError: undefined }) }),
    });
    if (!result?.comment) throw new Error(t("批注没有保存成功，请稍后重试。"));
    applyCommentUpdate(entry, result.comment);
    if (commentTextDrafts.get(key)?.trim() === text) commentTextDrafts.delete(key);
  });
  commentSaveTail = attempt.catch(() => {});
  return attempt;
}

function mergeAcknowledgedCommentTurns(activity) {
  const messages = (activity.conversation?.messages || []).filter(message => !message.localPending);
  const submissions = activity.reviewSubmissions || [];
  for (const ack of acknowledgedCommentTurns.values()) {
    if (ack.project !== currentProjectPath()) continue;
    if (!messages.some(message => message.id === ack.message.id)) messages.push(ack.message);
    if (!submissions.some(submission => submission.id === ack.submission.id)) submissions.push(ack.submission);
  }
  for (const receipt of [...workspaceEditReceipts.values()]) {
    const accepted = receipt.message.localPending && messages.find(message => message.clientRequestId === receipt.clientRequestId);
    if (accepted) acceptAssistantSend(receipt, accepted);
    if (receipt.project === currentProjectPath() && receipt.message && !messages.some(message => message.id === receipt.message.id)) messages.push(receipt.message);
  }
  activity.conversation = { ...(activity.conversation || {}), messages };
  activity.reviewSubmissions = submissions;
  return activity;
}

function acknowledgeCommentTurn(message, submission, entries, draftToClear) {
  if (!message?.id || !submission?.id) throw new Error(t("未收到批注发送回执，请刷新后确认状态。"));
  acknowledgedCommentTurns.set(submission.id, { project: currentProjectPath(), message, submission });
  generationActivity = mergeAcknowledgedCommentTurns(generationActivity || {});
  for (const entry of entries) {
    const locked = submission.items.find(item => item.commentId === entry.comment.id && item.pagePath === entry.pagePath);
    applyCommentUpdate(entry, { ...entry.comment, aiStatus: "running", aiSubmissionId: submission.id,
      revision: Math.max(entry.comment.revision || 0, (locked?.commentRevision || 0) + 1) });
    commentSelection.delete(commentSelectionKey(entry.pagePath, entry.comment.id));
  }
  // Acknowledgement owns only the submitted draft, never text typed afterwards.
  const input = $("work-brief");
  if (draftToClear !== undefined && input?.value === draftToClear) input.value = "";
  hideCommentPopover();
  renderComments();
  paintEditorGeneration(generationActivity);
}

async function retryCommentSubmission(submission) {
  if (commentSubmitPending || generationInteractionLocked() || aiReviewTurnActive) return;
  try {
    const data = await api("/api/reviews?all=1&project=" + encodeURIComponent(currentProjectPath()));
    const entries = submission.items.map(item => {
      const comment = data.pages?.[item.pagePath]?.find(c => c.id === item.commentId);
      if (!comment || comment.resolved || comment.aiStatus === "applied" ||
          comment.text !== item.text || comment.aiSubmissionId !== submission.id) {
        throw new Error(t("这条批注已有变化，请在画布上重新标记后发送。"));
      }
      return { pagePath: item.pagePath, comment };
    });
    await submitCommentBatch(entries, { retryBrief: submission.brief || "" });
  } catch (error) { showToast(error.message || t("暂时无法重试，请稍后再试。")); }
}

/** New requests leave through the composer; failed messages own their retry. */
async function submitCommentBatch(entries = selectedCommentEntries(), { retryBrief } = {}) {
  if (!entries.length) return false;
  if (commentSubmitPending || generationInteractionLocked() || aiReviewTurnActive) return true;
  commentSubmitPending = true;
  const draft = retryBrief === undefined ? ($("work-brief")?.value || "") : undefined;
  const brief = retryBrief ?? draft.trim();
  try {
    await settlePendingEdits();
    if (retryBrief === undefined) for (const entry of entries) await saveCommentTextDraft(entry);
    if (entries.some((entry) => !String(entry.comment.text || "").trim())) {
      throw new Error(t("有批注内容为空，请先补全再发送。"));
    }
    await startCommentBatchReview(entries.map((entry) => ({ ...entry.comment, pagePath: entry.pagePath })), {
      brief, onAccepted: (message, submission) => acknowledgeCommentTurn(message, submission, entries, draft),
    });
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 8000);
  } finally {
    commentSubmitPending = false;
    renderComments();
    paintEditorGeneration(generationActivity);
  }
  return true;
}

function syncCommentAddButton() {
  const button = $("comment-add");
  if (!button || button.dataset.busy === "1") return;
  const hasText = Boolean($("comment-draft")?.value.trim());
  const present = new Set((model?.elements || []).map((element) => element.id));
  const hasTarget = commentDraftScope === "page" || (commentDraftTargetIds.length > 0
    && commentDraftTargetIds.every((id) => present.has(id)));
  button.disabled = !hasText || !hasTarget || Boolean(previewVersion) || aiReviewTurnActive || generationInteractionLocked();
}

function syncCommentDraftUi() {
  const ids = commentDraftTargetIds;
  const app = document.querySelector('.app');
  if (app) app.dataset.commentTool = commentMode ? 'elements' : '';
  $('comment-panel').dataset.targetIds = JSON.stringify(ids);
  const hint = $('comment-mode-hint');
  if (hint) {
    hint.hidden = !commentMode || Boolean(previewVersion) || Boolean(model?.presenting) || generationInteractionLocked() || aiReviewTurnActive;
    hint.textContent = commentGesture && commentDraftBox
      ? t(`已圈选 {p0} 个对象 · 松手写意见`, { p0: ids.length })
      : t("单击标注 · 拖动框选 · Shift 增减 · Esc 退出");
  }
  const targets = ids.map(id=>model?.elements?.find(el=>el.id===id)).filter(Boolean);
  const label = commentDraftScope === 'page' ? t("整页")
    : targets.length ? t(`已选 {p0} 个对象`, { p0: targets.length }) : t("未选择对象，请在画布上选择");
  $('comment-target').textContent = t(`第 {p0} 页 · {p1}`, { p0: (model?.pageIndex ?? 0)+1, p1: label });
  const list = $('comment-targets');
  const key = JSON.stringify(targets.map(target => [target.id, elementReadableName(target)]));
  list.hidden = targets.length === 0;
  if (list.dataset.targets !== key) {
    list.dataset.targets = key;
    list.replaceChildren(...targets.map((target, index) => {
      const row = document.createElement('li');
      row.className = 'comment-target-item';
      row.dataset.targetId = target.id;
      const name = elementReadableName(target);
      const number = document.createElement('span');
      number.className = 'comment-target-number'; number.textContent = String(index + 1);
      number.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'comment-target-name'; label.textContent = name; label.title = name;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'comment-target-remove'; remove.textContent = '×';
      remove.dataset.commentControl = 'chrome.comments.targets';
      remove.setAttribute('aria-label', t(`取消选择{p0}`, { p0: name }));
      remove.addEventListener('click', () => {
        commentDraftTargetIds = commentDraftTargetIds.filter(id => id !== target.id);
        commentDraftBox = null; commentDraftScope = 'elements';
        syncCommentDraftUi(); positionCommentPopover();
        const buttons = list.querySelectorAll('button');
        (buttons[Math.min(index, buttons.length - 1)] || $('comment-draft'))?.focus({ preventScroll: true });
      });
      row.append(number, label, remove);
      return row;
    }));
  }
  renderCommentDraftHighlight(); syncCommentAddButton();
}

function hideCommentPopover() {
  commentPopoverOpen = false;
  $("btn-comments")?.setAttribute("aria-expanded", "false");
  $("btn-comments")?.setAttribute("aria-label", commentMode ? t("退出批注") : t("添加批注"));
  if ($("comment-panel")) $("comment-panel").hidden = true;
}

function positionCommentPopover() {
  const panel = $("comment-panel");
  if (!panel || panel.hidden || !commentPopoverOpen) return;
  const visual = window.visualViewport;
  const left = visual?.offsetLeft || 0, top = visual?.offsetTop || 0;
  const width = visual?.width || window.innerWidth, height = visual?.height || window.innerHeight;
  const margin = 12, gap = 14;
  panel.style.maxHeight = `${Math.max(120, height - margin * 2)}px`;
  const slide = $("slide")?.getBoundingClientRect();
  let x, y;
  if (commentPopoverAnchor?.kind === "pin" && slide) {
    const comment = comments.find((item) => item.id === commentPopoverAnchor.id);
    if (comment) { const point = commentPinPoint(comment, slide); x = point.px; y = point.py; }
  } else if (commentPopoverAnchor?.kind === "slide" && slide) {
    x = slide.left + commentPopoverAnchor.x * slide.width;
    y = slide.top + commentPopoverAnchor.y * slide.height;
  } else if (commentPopoverAnchor?.kind === "element") {
    const rect = slideElNode(commentPopoverAnchor.id)?.getBoundingClientRect();
    if (rect) { x = rect.right; y = rect.top; }
  }
  if (!Number.isFinite(x)) {
    const button = $("btn-comments")?.getBoundingClientRect();
    x = button?.right ?? width / 2; y = button?.bottom ?? 100;
  }
  const box = panel.getBoundingClientRect();
  const viewport = $('viewport')?.getBoundingClientRect();
  // Keep a canvas popover out of the chat column whenever the canvas can fit it.
  const minX = viewport && viewport.width >= box.width + margin * 2
    ? Math.max(left + margin, viewport.left + margin) : left + margin;
  const maxX = left + width - box.width - margin;
  const minY = top + margin, maxY = top + height - box.height - margin;
  const targetIds = commentPopoverView === 'draft' ? commentDraftTargetIds
    : commentElementIds(comments.find(item => item.id === commentActiveId) || {});
  const targets = targetIds.map(id => slideElNode(id)?.getBoundingClientRect()).filter(Boolean);
  const positions = [[x + gap, y + gap], [x - box.width - gap, y + gap],
    [x + gap, y - box.height - gap], [x - box.width - gap, y - box.height - gap]];
  if (targets.length) {
    const above = Math.min(...targets.map(rect => rect.top)) - box.height - gap;
    const below = Math.max(...targets.map(rect => rect.bottom)) + gap;
    for (const px of [x + gap, x - box.width - gap]) positions.push([px, above], [px, below]);
  }
  const candidates = positions.map(([px, py]) => {
    px = Math.max(minX, Math.min(px, maxX)); py = Math.max(minY, Math.min(py, maxY));
    const overlap = targets.reduce((area, rect) => area
      + Math.max(0, Math.min(px + box.width, rect.right) - Math.max(px, rect.left))
      * Math.max(0, Math.min(py + box.height, rect.bottom) - Math.max(py, rect.top)), 0);
    const coversPoint = x > px && x < px + box.width && y > py && y < py + box.height;
    return {px, py, score: overlap * 1000 + (coversPoint ? 1e7 : 0) + Math.hypot(px - x, py - y)};
  }).sort((a, b) => a.score - b.score);
  panel.style.left = `${candidates[0].px}px`;
  panel.style.top = `${candidates[0].py}px`;
}

function showCommentPopover(view, { point, anchor, focus = false } = {}) {
  commentPopoverView = view;
  commentPopoverOpen = true;
  $("btn-comments")?.setAttribute("aria-expanded", "true");
  $("btn-comments")?.setAttribute("aria-label", t("退出批注"));
  if (point) {
    const rect = $("slide").getBoundingClientRect();
    commentPopoverAnchor = { kind: "slide", x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height };
  } else if (anchor) commentPopoverAnchor = anchor;
  $("comment-panel").hidden = false;
  renderCommentPanel();
  positionCommentPopover();
  if (focus) {
    const target = view === "draft" ? $("comment-draft")
      : view === "note" ? $("comment-list")?.querySelector("textarea") : null;
    target?.focus({ preventScroll: true });
  }
}

window.visualViewport?.addEventListener("resize", positionCommentPopover, { passive: true });
window.visualViewport?.addEventListener("scroll", positionCommentPopover, { passive: true });
document.addEventListener("pointerdown", (event) => {
  if (!commentPopoverOpen || event.target.closest?.("#comment-panel, #btn-comments, #comment-layer .pin") || $("slide")?.contains(event.target)) return;
  hideCommentPopover();
}, true);

function renderCommentPanel(activeId = "") {
  const list = $("comment-list");
  syncCommentDraftUi();
  renderCommentBatchChip();
  const panel = $("comment-panel");
  panel.dataset.view = commentPopoverView;
  $("comment-popover-title").textContent = commentPopoverView === "draft" ? t("添加批注") : t("编辑批注");
  requestAnimationFrame(positionCommentPopover);
  if (commentPopoverView === "draft") return;
  const open = comments.filter(c => c.id === commentActiveId && isPendingComment(c));
  if (!list) return;
  list.replaceChildren();
  const loadStatus = commentLoadState.key === commentKey() ? commentLoadState.status : "loading";
  if (["loading", "error", "cached"].includes(loadStatus)) {
    const status = document.createElement("div");
    status.className = `comment-list-status is-${loadStatus}`;
    status.setAttribute("role", loadStatus === "loading" ? "status" : "alert");
    const message = document.createElement("p");
    message.textContent = loadStatus === "loading"
      ? t("正在读取项目批注…")
      : loadStatus === "cached"
        ? t("暂时无法连接项目，以下为本机缓存，可能不是最新状态。")
        : t(`批注读取失败：{p0}`, { p0: commentLoadState.error || t("请稍后重试") });
    status.append(message);
    if (loadStatus !== "loading") {
      const retry = btn(t("重试"), "chrome.comments.retry", () => {
        loadComments({ force: true });
        renderCommentPanel();
      });
      retry.classList.add("comment-retry");
      status.append(retry);
    }
    list.append(status);
    if (loadStatus !== "cached") return;
  }
  if (!open.length) {
    const empty = document.createElement("p");
    empty.className = "comment-list-empty";
    empty.textContent = t("这条批注已移除。");
    list.append(empty);
    return;
  }
  for (const comment of open) {
    const card = makeCommentCard(comment);
    card.classList.toggle("is-active", Boolean(activeId && comment.id === activeId));
    list.append(card);
  }
  if (activeId) list.querySelector(`[data-comment-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest" });
  syncCommentAnchorHighlight(activeId);
  syncCommentAddButton();
}

async function openPinCard(c) {
  await setCommentMode(true, { preserveScope: true });
  commentActiveId = c.id || "";
  const elementIds = commentElementIds(c);
  const missingElementIds = missingCommentElementIds(c);
  if (missingElementIds.length) {
    showToast(t(`批注绑定对象已失效：{p0}。请重新选择对象并新建批注。`, { p0: missingElementIds.join("、") }));
  } else if (elementIds.length) {
    commentDraftScope = "elements";
    commentDraftTargetIds = elementIds;
  }
  showCommentPopover("note", { anchor: { kind: "pin", id: c.id }, focus: true });
}

async function setCommentMode(on, { preserveScope = false, focus = false } = {}) {
  if (on && !commentMode && commentLoadState.key !== commentKey()) commentLoadedKey = "";
  if (on && !preserveScope && commentDraftScope === "page") commentDraftScope = "elements";
  if (!on) { commentActiveId = ""; hideCommentPopover(); }
  // A pointerdown select can still be in flight; wait for it so the selection
  // the user just made is visible before we snapshot it as the draft target.
  if (on && pendingSelectCommand) {
    try { await pendingSelectCommand; } catch { /* selection failure leaves an empty draft target */ }
  }
  clearCommentDraftTarget();
  commentMode = on;
  syncCommentDraftPage();
  if (on && commentDraftScope !== "page" && !commentDraftTargetIds.length) {
    // A selection the user made before opening the panel is the obvious target.
    commentDraftTargetIds = selectedIds().filter((id) => model?.elements?.some((element) => element.id === id));
  }
  document.querySelector(".app")?.classList.toggle("is-comment", on);
  const button = $("btn-comments");
  button?.classList.toggle("on", on);
  button?.setAttribute("aria-expanded", String(on && commentPopoverOpen));
  button?.setAttribute("aria-pressed", String(on));
  button?.setAttribute("aria-label", on ? t("退出批注") : t("添加批注"));
  const panel = $("comment-panel");
  if (panel) panel.hidden = !on || !commentPopoverOpen;
  // Transfer the prior selection to the annotation draft, then release editing
  // selection. Hide handles immediately while the queued select command settles.
  syncSelectionDom();
  syncCommentDraftUi();
  updatePropertyPanel();
  renderComments();
  if (on) await command("select", {});
  if (on && commentMode && focus) {
    if (commentDraftTargetIds.length) showCommentPopover("draft", { anchor: {kind:'element',id:commentDraftTargetIds[0]}, focus:true });

  }
  if (!on && focus) button?.focus();
}

function persistChartRows(rows, cols = chartCols) {
  return command("setChartData", {
    data: {
      cols: cols.slice(),
      rows: rows.map((r) => [
        String(r[0] ?? ""),
        ...r.slice(1, cols.length).map((c) => Number(c)),
      ]),
    },
  });
}

function markChartDraftDirty() {
  if (!chartDraft) return;
  chartDraft.dirty = true;
  chartDraft.revision += 1;
}

function setChartDraftStatus(message = "") {
  const status = chartDraft?.status || $("chart-data-status");
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
}

async function flushPendingChartDraft() {
  const draft = chartDraft;
  if (!draft?.dirty) return;
  if (draft.commitPromise) return draft.commitPromise;
  clearTimeout(chartPersistTimer);
  chartPersistTimer = 0;
  const invalid = draft.table?.querySelector("input.is-invalid");
  if (invalid) {
    const count = draft.table.querySelectorAll("input.is-invalid").length;
    const error = new Error(t(`{p0}`, { p0: count }));
    setChartDraftStatus(error.message);
    invalid.focus();
    throw error;
  }
  if (selectedIds()[0] !== draft.elementId) {
    const error = new Error(t("图表目标已经改变，未覆盖原图表；请返回后重试。"));
    setChartDraftStatus(error.message);
    throw error;
  }
  const revision = draft.revision;
  const rows = draft.rows.map((row) => row.slice());
  const cols = chartCols.slice();
  const operation = persistChartRows(rows, cols).then(() => {
    if (chartDraft === draft && draft.revision === revision) {
      draft.dirty = false;
      setChartDraftStatus();
    }
  });
  draft.commitPromise = operation;
  try {
    await operation;
  } catch (error) {
    if (chartDraft === draft) {
      draft.dirty = true;
      setChartDraftStatus(t(`保存失败：{p0}。草稿仍保留，可重试。`, { p0: error instanceof Error ? error.message : String(error) }));
    }
    throw error;
  } finally {
    if (chartDraft === draft && draft.commitPromise === operation) draft.commitPromise = null;
  }
}

async function closeChartOverlay({ restoreFocus = true } = {}) {
  const box = $("chart-overlay");
  if (!box || box.hidden) return true;
  try {
    while (chartDraft?.dirty) await flushPendingChartDraft();
  } catch {
    box.hidden = false;
    return false;
  }
  const targetId = chartDraft?.elementId;
  box.hidden = true;
  chartFocusRow = -1;
  chartDraft = null;
  clearTimeout(chartPersistTimer);
  chartPersistTimer = 0;
  if (restoreFocus && targetId) slideElNode(targetId)?.focus?.();
  return true;
}

function dismissSavedChartOverlay() {
  if (chartDraft?.dirty || chartDraft?.commitPromise) return false;
  const box = $("chart-overlay");
  if (box) box.hidden = true;
  chartFocusRow = -1;
  chartDraft = null;
  clearTimeout(chartPersistTimer);
  chartPersistTimer = 0;
  return true;
}

function liveChartFromRows(el, rows, focus = chartFocusRow) {
  const cur = selectedEl() || el;
  if (!cur || cur.type !== "chart") return;
  const nextRows = rows.map((r) => [r[0], ...r.slice(1, chartCols.length).map((c) => Number(c) || 0)]);
  repaintChartNode(cur, {
    chartData: { cols: chartCols.slice(), rows: nextRows },
    chartFocusRow: focus,
  });
}

function parseTablePaste(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(/\t|,/).map((c) => c.trim()))
    .filter((row) => row.some((c) => c !== ""));
}

function openChartOverlay(el) {
  const box = $("chart-overlay");
  const table = $("chart-grid");
  if (!box || !table) return;
  chartCols = el.chartData?.cols?.length ? el.chartData.cols.slice() : [t("类目"), t("数值")];
  const rows = el.chartData?.rows?.length
    ? el.chartData.rows.map((r) => Array.from({ length: chartCols.length }, (_, i) => r[i] ?? (i ? 0 : "")))
    : [["2024", 1], ["2025", 2]];
  const status = $("chart-data-status");
  chartDraft = {
    elementId: el.id,
    rows,
    table,
    status,
    dirty: false,
    revision: 0,
    commitPromise: null,
  };
  const showStatus = (message = "") => {
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
  };
  const syncInvalidStatus = () => {
    const count = table.querySelectorAll("input.is-invalid").length;
    showStatus(count ? t(`{p0}`, { p0: count }) : "");
  };
  const setNumericValidity = (input, valid) => {
    input.classList.toggle("is-invalid", !valid);
    if (valid) {
      input.removeAttribute("title");
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    } else {
      input.title = t("需要数字");
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", "chart-data-status");
    }
    syncInvalidStatus();
  };
  showStatus();
  const schedulePersist = () => {
    markChartDraftDirty();
    clearTimeout(chartPersistTimer);
    chartPersistTimer = setTimeout(() => {
      void flushPendingChartDraft().catch(() => {});
    }, 300);
  };
  const flushDirtyDraft = () => {
    clearTimeout(chartPersistTimer);
    chartPersistTimer = 0;
    const draft = chartDraft;
    void (async () => {
      while (chartDraft === draft && draft?.dirty) await flushPendingChartDraft();
    })().catch(() => {});
  };
  const flushPersist = () => {
    markChartDraftDirty();
    flushDirtyDraft();
  };
  const delBtn = (title, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chart-del";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.textContent = "×";
    b.setAttribute("data-control", "element.chart.data.set");
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    });
    return b;
  };
  const paint = () => {
    table.innerHTML = "";
    const head = document.createElement("tr");
    const corner = document.createElement("th");
    corner.className = "chart-grid-corner";
    corner.setAttribute("aria-label", t("行号"));
    head.append(corner);
    const catTh = document.createElement("th");
    catTh.className = "chart-th-cat";
    catTh.scope = "col";
    const catIn = document.createElement("input");
    catIn.value = chartCols[0] || "category";
    catIn.setAttribute("aria-label", t("类目列名称"));
    catIn.setAttribute("data-control", "element.chart.data.set");
    catIn.addEventListener("change", () => {
      chartCols[0] = catIn.value || t("类目");
      flushPersist();
    });
    catTh.append(catIn);
    head.append(catTh);
    const seriesCount = Math.max(0, chartCols.length - 1);
    for (let j = 1; j < chartCols.length; j++) {
      const s1 = document.createElement("th");
      s1.className = `s1 s${j}`;
      s1.scope = "col";
      const sw = document.createElement("i");
      sw.className = "s1-swatch";
      sw.style.background = canvasChartSwatch(el, j - 1);
      const nameIn = document.createElement("input");
      nameIn.value = chartCols[j] ?? `S${j}`;
      nameIn.setAttribute("aria-label", t(`系列 {p0} 名称`, { p0: j }));
      nameIn.setAttribute("data-control", "element.chart.data.set");
      nameIn.addEventListener("change", () => {
        chartCols[j] = nameIn.value || `S${j}`;
        flushPersist();
      });
      s1.append(sw, nameIn);
      if (seriesCount > 1) {
        s1.append(delBtn(t("删除列"), () => {
          chartCols.splice(j, 1);
          for (const row of rows) row.splice(j, 1);
          flushPersist();
          paint();
        }));
      }
      head.append(s1);
    }
    table.append(head);
    rows.forEach((row, i) => {
      const tr = document.createElement("tr");
      const n = document.createElement("th");
      n.className = "chart-row-h";
      n.scope = "row";
      const idx = document.createElement("span");
      idx.textContent = String(i + 1);
      n.append(idx, delBtn(t("删除行"), () => {
        rows.splice(i, 1);
        if (chartFocusRow === i) chartFocusRow = -1;
        else if (chartFocusRow > i) chartFocusRow -= 1;
        flushPersist();
        paint();
        liveChartFromRows(el, rows);
      }));
      tr.append(n);
      row.forEach((cell, j) => {
        const td = document.createElement("td");
        const input = document.createElement("input");
        input.value = String(cell ?? "");
        input.setAttribute(
          "aria-label",
          j === 0 ? t(`第 {p0} 行类目`, { p0: i + 1 }) : t(`第 {p0} 行{p1}数值`, { p0: i + 1, p1: chartCols[j] || `系列 ${j}` }),
        );
        input.setAttribute("data-control", "element.chart.data.set");
        input.addEventListener("focus", () => {
          chartFocusRow = i;
          for (const r of table.querySelectorAll("tr")) r.classList.remove("is-edit");
          for (const th of table.querySelectorAll("th.s1")) th.classList.remove("is-edit");
          tr.classList.add("is-edit");
          if (j >= 1) head.querySelector(`th.s${j}`)?.classList.add("is-edit");
          liveChartFromRows(el, rows, i);
        });
        input.addEventListener("input", () => {
          if (j === 0) {
            rows[i][j] = input.value;
            liveChartFromRows(el, rows, i);
            schedulePersist();
            return;
          }
          const raw = input.value.trim();
          if (raw === "") {
            rows[i][j] = 0;
            setNumericValidity(input, true);
            liveChartFromRows(el, rows, i);
            schedulePersist();
            return;
          }
          const n = Number(raw);
          if (Number.isFinite(n)) {
            rows[i][j] = n;
            setNumericValidity(input, true);
            liveChartFromRows(el, rows, i);
            schedulePersist();
          } else {
            setNumericValidity(input, false);
            markChartDraftDirty();
          }
        });
        input.addEventListener("change", () => {
          if (j === 0) {
            const next = input.value;
            if (rows[i][j] !== next) {
              rows[i][j] = next;
              markChartDraftDirty();
            }
            flushDirtyDraft();
            return;
          }
          const raw = input.value.trim();
          if (raw === "") {
            if (rows[i][j] !== 0) {
              rows[i][j] = 0;
              markChartDraftDirty();
            }
            setNumericValidity(input, true);
            flushDirtyDraft();
            return;
          }
          const n = Number(raw);
          if (Number.isFinite(n)) {
            if (rows[i][j] !== n) {
              rows[i][j] = n;
              markChartDraftDirty();
            }
            setNumericValidity(input, true);
            flushDirtyDraft();
          } else {
            setNumericValidity(input, false);
            markChartDraftDirty();
          }
        });
        td.append(input);
        tr.append(td);
      });
      table.append(tr);
    });
    const tail = document.createElement("tr");
    tail.className = "add-row";
    const tn = document.createElement("th");
    tn.textContent = "";
    tail.append(tn);
    const tcell = document.createElement("td");
    tcell.colSpan = Math.max(1, chartCols.length);
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ctx-btn";
    addBtn.setAttribute("data-control", "element.chart.data.set");
    addBtn.textContent = t("+ 行");
    addBtn.addEventListener("click", () => {
      rows.push(Array.from({ length: chartCols.length }, (_, i) => (i === 0 ? "" : 0)));
      flushPersist();
      paint();
    });
    tcell.append(addBtn);
    const seriesBtn = document.createElement("button");
    seriesBtn.type = "button";
    seriesBtn.className = "ctx-btn";
    seriesBtn.setAttribute("data-control", "element.chart.data.set");
    seriesBtn.textContent = t("+ 列");
    seriesBtn.addEventListener("click", () => {
      chartCols = [...chartCols, `S${chartCols.length}`];
      for (const row of rows) row.push(0);
      flushPersist();
      paint();
    });
    tcell.append(seriesBtn);
    tail.append(tcell);
    table.append(tail);
  };
  paint();
  box.hidden = false;
  box.onpaste = (ev) => {
    const text = ev.clipboardData?.getData("text");
    if (!text || !text.includes("\n") && !text.includes("\t")) return;
    ev.preventDefault();
    const parsed = parseTablePaste(text);
    if (!parsed.length) return;
    const first = parsed[0];
    const looksHeader = /category|类目|s1|s2|数值/i.test(String(first?.[0] || ""));
    let body = parsed;
    if (looksHeader) {
      const nextCols = [first[0] || t("类目"), ...first.slice(1).map((c, i) => c || `S${i + 1}`)];
      if (nextCols.length >= 2) chartCols = nextCols;
      body = parsed.slice(1);
    }
    if (!body.length) return;
    const invalid = [];
    for (let r = 0; r < body.length; r++) {
      for (let c = 1; c < chartCols.length; c++) {
        const raw = String(body[r]?.[c] ?? "").trim();
        if (raw && !Number.isFinite(Number(raw))) invalid.push(`${r + 1}:${c + 1}`);
      }
    }
    if (invalid.length) {
      showStatus(t(`粘贴未应用：{p0} 个数值单元格不是数字。`, { p0: invalid.length }));
      return;
    }
    rows.length = 0;
    for (const row of body) {
      const padded = Array.from({ length: chartCols.length }, (_, i) => (i === 0 ? row[0] ?? "" : Number(row[i]) || 0));
      rows.push(padded);
    }
    flushPersist();
    paint();
  };
  positionChartOverlay();
}

$("chart-overlay-close")?.addEventListener("click", () => {
  void closeChartOverlay();
});


$("property-toggle")?.addEventListener("click", () => {
  if ($("work-chat") && !$("work-chat").hidden) propertyPanelAgentUserOverride = true;
  if (propertyPanelAutoCollapsedForAgent) {
    propertyPanelAutoCollapsedForAgent = false;
    propertyPanelCollapsed = false;
  } else {
    propertyPanelCollapsed = !propertyPanelCollapsed;
  }
  localStorage.setItem("oss.propertyPanelCollapsed", propertyPanelCollapsed ? "1" : "0");
  closeCtxPops();
  updatePropertyPanel();
});
$("btn-comments")?.addEventListener("click", () => void setCommentMode(!commentMode, { focus: true }));
$("comment-panel-close")?.addEventListener("click", () => { hideCommentPopover(); $("btn-comments")?.focus(); });
$("comment-add")?.addEventListener("click", async () => {
  const addButton = $("comment-add");
  const draft = $("comment-draft");
  const text = draft?.value.trim() || "";
  if (!text) {
    showToast(t("请先填写修改意见。"));
    draft?.focus();
    return;
  }
  const present = new Set((model?.elements || []).map((element) => element.id));
  const ids = commentDraftTargetIds.filter((id) => present.has(id));
  if (commentDraftScope !== "page" && ids.length === 0) {
    showToast(commentDraftScope === "draw"
      ? t("请先在画布上圈选要修改的内容。")
      : t("请先点击画布上的内容。"));
    return;
  }
  const [sw, sh] = slideSize();
  const first = commentDraftScope !== "page" && ids.length
    ? model?.elements?.find((element) => element.id === ids[0])
    : null;
  const centerX = first?.bounds ? (first.bounds[0] + first.bounds[2] / 2) / sw : 0.5;
  const centerY = first?.bounds ? (first.bounds[1] + first.bounds[3] / 2) / sh : 0.5;
  const rec = {
    x: Math.max(0, Math.min(1, centerX)),
    y: Math.max(0, Math.min(1, centerY)),
    elementId: commentDraftScope !== "page" ? ids[0] : undefined,
    scope: ids.length && commentDraftScope !== "page"
      ? { kind: "elements", elementIds: ids.slice() }
      : { kind: "page", elementIds: [] },
    text,
    resolved: false,
  };
  if (first?.bounds) {
    rec.ox = first.bounds[2] / 2;
    rec.oy = first.bounds[3] / 2;
  }
  comments.push(rec);
  if (addButton) {
    addButton.dataset.busy = "1";
    addButton.disabled = true;
    addButton.textContent = t("正在保存…");
  }
  try {
    await saveComments(rec, { throwOnError: true });
    draft.value = "";
    commentActiveId = rec.id || "";
    clearCommentDraftTarget();
    syncCommentQueuePage(currentReviewPagePath(), comments);
    hideCommentPopover();
    showWorkChat({ focusComposer: false });
    // Adding finishes the annotation: leave the mode so no hover outline or
    // gesture hint lingers. The comment waits above the chat input; 批注 or
    // its "open" link re-enters the mode with its pin.
    await setCommentMode(false);
    renderComments();
  } catch {
    const index = comments.indexOf(rec);
    if (index >= 0 && !rec.revision) comments.splice(index, 1);
    renderComments();
  } finally {
    if (addButton) {
      delete addButton.dataset.busy;
      addButton.textContent = t("添加批注");
    }
    syncCommentAddButton();
  }
});
$("comment-draft")?.addEventListener("input", syncCommentAddButton);
$("comment-draft")?.addEventListener("keydown", event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); $('comment-add')?.click(); }
});
$("slide")?.addEventListener("pointerdown", (ev) => {
  const box = $("chart-overlay");
  if (!box || box.hidden) return;
  if (ev.target.closest("#chart-overlay") || ev.target.closest("#ctx-bar")) return;
  void closeChartOverlay({ restoreFocus: false });
});

const q = new URLSearchParams(location.search);
const genBrief = q.get("generate");
const genDesign = q.get("design") || "consulting/pine-green-strategy";
const genCategory = q.get("category") || "analysis-decision";
if (genBrief != null && genBrief !== "") {
  showWorkChat({ focusComposer: false });
}

async function runGenerateFlow(brief, design, category, opts = {}) {
  const thread = $("work-thread");
  if (!thread) return;
  let turn = opts.turn;
  if (!turn) {
    appendBriefChip(thread, brief);
    turn = document.createElement("div");
    turn.className = "agent-turn";
    turn.innerHTML = `<div class="kimi-avatar" aria-hidden="true"><i></i><i></i></div>
      <div><div class="tool-card"></div><div class="agent-complete"></div></div>`;
    thread.append(turn);
  }
  document.querySelector(".stage-wrap")?.classList.add("is-generating");
  const card = turn.querySelector(".tool-card");
  const complete = turn.querySelector(".agent-complete");
  if (opts.turn) card?.replaceChildren();
  if (complete) complete.innerHTML = "";
  const paintStep = createStepPainter(card);
  const runtimeRows = new Map();
  let nextRuntimeRow = 1000;
  const paintRuntime = (event) => {
    if (!event?.id) return;
    if (!runtimeRows.has(event.id)) runtimeRows.set(event.id, nextRuntimeRow++);
    paintStep(
      {
        tool: event.tool || event.kind,
        label: event.label,
        status: event.status,
        summary: event.summary || "",
      },
      runtimeRows.get(event.id),
    );
  };
  let activeResumePath = opts.resumePath;
  try {
    const res = await fetch(nativeApi("/api/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brief,
        design,
        category,
        stream: true,
        streamPaceMs: prefersReducedMotion() ? 0 : 16,
        resumePath: activeResumePath,
      }),
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 410) {
        throw new Error(t("请从创建 Hub 生成。产品路径是 DSH /slides/sessions，不再调用 createPiBrain。"));
      }
      throw new Error(body.error || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let doneData = null;
    const handle = (ev) => {
      if (ev.type === "run" && typeof ev.path === "string" && ev.path) {
        activeResumePath = ev.path;
        localStorage.setItem(
          "oss.generate.resume",
          JSON.stringify({ path: activeResumePath, brief }),
        );
      }
      if (ev.type === "waiting") paintWaitingRow(card, ev);
      if (ev.type === "runtime" && ev.event) paintRuntime(ev.event);
      if (ev.type === "step") {
        clearWaitingRow(card);
        paintStep(ev.step, ev.index);
      }
      if (ev.type === "done") doneData = ev;
      if (ev.type === "error") throw new Error(ev.error);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        handle(ev);
      }
    }
    const tail = buf.trim();
    if (tail) {
      try {
        handle(JSON.parse(tail));
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
    if (!doneData) throw new Error(t("生成未返回结果"));
    if (doneData.paused || doneData.composeSource === "paused") {
      document.querySelector(".stage-wrap")?.classList.remove("is-generating");
      card.querySelectorAll(".is-running").forEach((r) => r.classList.remove("is-running"));
      card.querySelectorAll(".running-dot").forEach((d) => d.remove());
      const say = document.createElement("p");
      say.className = "agent-say";
      say.textContent = doneData.pauseMessage || t("模型这次没跑完。可以马上重试，或稍后继续。");
      complete.append(say);
      const actions = document.createElement("div");
      actions.className = "pause-actions";
      actions.innerHTML = t(`<button type="button" class="pause-btn pause-btn-primary" data-retry>马上重试</button>
        <button type="button" class="pause-btn" data-later>稍后继续</button>`);
      complete.append(actions);
      actions.querySelector("[data-retry]")?.addEventListener("click", () => {
        runGenerateFlow(brief, design, category, {
          resumePath: doneData.path || activeResumePath,
          turn,
        });
      });
      actions.querySelector("[data-later]")?.addEventListener("click", () => {
        localStorage.setItem(
          "oss.generate.resume",
          JSON.stringify({ path: doneData.path || activeResumePath, brief }),
        );
      });
      return;
    }
    if (doneData.ok === false) {
      const src = doneData.composeSource ? ` · ${doneData.composeSource}` : "";
      throw new Error(t(`生成未完成{p0}`, { p0: src }));
    }
    document.querySelector(".stage-wrap")?.classList.remove("is-generating");
    localStorage.removeItem("oss.generate.resume");
    const data = await api("/api/model");
    model = data.model;
    thumbs = data.thumbs || thumbs;
    render();
    await refreshVersions();
    const sayEl = document.createElement("p");
    sayEl.className = "agent-say";
    complete.append(sayEl);
    await typewriteInto(
      sayEl,
      t(`已生成 {p0} 页 · {p1}`, { p0: model.pageCount, p1: model.title || "未命名" }),
      prefersReducedMotion() ? 0 : 16,
    );
    const cardEl = document.createElement("div");
    cardEl.className = "refine-card";
    cardEl.innerHTML = t(`<span>已生成 {p0} 页 · {p1}</span><button type="button" class="btn" disabled>V1</button>`, { p0: model.pageCount, p1: model.title || "未命名" });
    complete.append(cardEl);
  } catch (e) {
    document.querySelector(".stage-wrap")?.classList.remove("is-generating");
    card.querySelectorAll(".is-running").forEach((r) => r.classList.remove("is-running"));
    card.querySelectorAll(".running-dot").forEach((d) => d.remove());
    const note = document.createElement("div");
    note.className = "bubble";
    note.textContent = e.message;
    turn.querySelector(".agent-complete")?.append(note);
    if (activeResumePath) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "pause-btn pause-btn-primary";
      retry.textContent = t("从已保存进度继续");
      retry.addEventListener("click", () => {
        runGenerateFlow(brief, design, category, { resumePath: activeResumePath, turn });
      });
      turn.querySelector(".agent-complete")?.append(retry);
    }
  }
}

fillPalettes();
function toggleTimeline() {
  timelineOpen = !timelineOpen;
  renderTimeline();
}
$("btn-timeline")?.addEventListener("click", toggleTimeline);
$("btn-anim-pill")?.addEventListener("click", toggleTimeline);
$("btn-notes-link")?.addEventListener("click", () => command("notes", { open: !model.notesOpen }));
$("btn-notes-close")?.addEventListener("click", () => command("notes", { open: false }));
$("tl-close")?.addEventListener("click", () => {
  timelineOpen = false;
  renderTimeline();
});
$("tl-add")?.addEventListener("click", () => {
  const el = selectedEl();
  if (!el) return;
  const next = [...(model.animations || []), {
    elementId: el.id,
    effect: $("tl-effect")?.value || "fade-in",
    trigger: $("tl-trigger")?.value || "onClick",
    durationMs: 400,
    delayMs: (model.animations || []).length * 400,
  }];
  command("setAnimations", { animations: next });
});
$("tl-ruler")?.addEventListener("pointerdown", (ev) => {
  const rect = ev.currentTarget.getBoundingClientRect();
  const max = tlMaxSec || 2;
  tlTime = Math.max(0, Math.min(max, ((ev.clientX - rect.left) / rect.width) * max));
  renderTimeline();
});
$("tl-play")?.addEventListener("click", () => {
  tlPlaying = !tlPlaying;
  $("tl-play").textContent = tlPlaying ? "❚❚" : "▶";
  clearInterval(tlTimer);
  if (!tlPlaying) return;
  tlTimer = setInterval(() => {
    tlTime += 0.1;
    if (tlTime > (tlMaxSec || 2) + 0.2) {
      tlTime = 0;
      tlPlaying = false;
      $("tl-play").textContent = "▶";
      clearInterval(tlTimer);
    }
    renderTimeline();
  }, 100);
});

$("slide").addEventListener("pointerdown", (ev) => {
  const t = ev.target;
  if (!(t instanceof SVGCircleElement) || !t.classList.contains("bez")) return;
  ev.stopPropagation();
  const i = Number(t.getAttribute("data-i"));
  const el = selectedEl();
  if (!el || el.type !== "line") return;
  const scale = slideScale();
  const rect = $("slide").getBoundingClientRect();
  const pts = String(el.linePoints || "")
    .trim()
    .split(/\s+/)
    .map((p) => p.split(",").map(Number));
  const move = (e) => {
    pts[i] = [(e.clientX - rect.left) / scale - el.bounds[0], (e.clientY - rect.top) / scale - el.bounds[1]];
    t.setAttribute("cx", String(pts[i][0]));
    t.setAttribute("cy", String(pts[i][1]));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    command("setLinePoints", { points: pts.map((p) => p.join(",")).join(" ") });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
});

Promise.all([
  fetch(nativeApi("/api/catalog/shapes")).then((r) => r.json()).catch(() => ({ shapes: [] })),
  fetch("./vendor/fa-icons.json").then((r) => r.json()).catch(() => []),
  fetch("./vendor/fa-unicode.json").then((r) => r.json()).catch(() => ({})),
]).then(([shapes, icons, uni]) => {
  shapeCatalog = shapes.shapes || [];
  faIcons = Array.isArray(icons) ? icons : [];
  faUnicode = uni || {};
  fillPalettes();
  if (model) render();
});

const INTERNAL_CLIPBOARD_TYPE = "application/x-open-slidestudio-elements";
const INTERNAL_CLIPBOARD_HTML_ATTR = "data-open-slidestudio-clipboard";

function nativeClipboardTarget(target = document.activeElement) {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    Boolean(target?.isContentEditable || target?.closest?.('[contenteditable="true"]'));
}

function clipboardPlainText(data) {
  const plain = data?.getData("text/plain") || "";
  if (plain) return plain;
  const html = data?.getData("text/html") || "";
  if (!html) return "";
  return new DOMParser().parseFromString(html, "text/html").body.textContent || "";
}

function clipboardHtml(payload) {
  const node = document.createElement("span");
  node.setAttribute(INTERNAL_CLIPBOARD_HTML_ATTR, payload.token);
  node.textContent = payload.plain;
  return node.outerHTML;
}

function clipboardTokenFromHtml(html) {
  if (!html) return "";
  return new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector(`[${INTERNAL_CLIPBOARD_HTML_ATTR}]`)
    ?.getAttribute(INTERNAL_CLIPBOARD_HTML_ATTR) || "";
}

function newCanvasClipboardPayload() {
  const token = globalThis.crypto?.randomUUID?.() || `clipboard-${Date.now()}`;
  const elementIds = selectedIds();
  return { token, elementIds, plain: t(`DSH SlideStudio 对象（{p0} 个）`, { p0: elementIds.length }) };
}

function sameElementIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function commitCanvasClipboard(payload, { cut = false } = {}) {
  if (!sameElementIds(payload.elementIds, selectedIds())) {
    if (internalClipboardClaim?.token === payload.token) internalClipboardClaim = null;
    showToast(t("所选对象已变化，请重新复制。"), 5000);
    return;
  }
  internalClipboardClaim = payload;
  try {
    await command("copySelected");
    if (cut) await command("deleteSelected");
  } catch (error) {
    if (internalClipboardClaim?.token === payload.token) internalClipboardClaim = null;
    showToast(t(`{p0}对象失败：{p1}`, { p0: cut ? "剪切" : "复制", p1: error instanceof Error ? error.message : String(error) }));
  }
}

function copyCanvasSelection(event, { cut = false } = {}) {
  if (nativeClipboardTarget(event.target) || nativeClipboardTarget() || !selectedIds().length || previewVersion) return;
  const data = event.clipboardData;
  if (!data) return;
  event.preventDefault();
  const payload = newCanvasClipboardPayload();
  try {
    data.setData(INTERNAL_CLIPBOARD_TYPE, payload.token);
    data.setData("text/plain", payload.plain);
    data.setData("text/html", clipboardHtml(payload));
  } catch {
    showToast(t("当前浏览器无法写入对象剪贴板。"), 5000);
    return;
  }
  void commitCanvasClipboard(payload, { cut });
}

async function copyCanvasSelectionFromMenu({ cut = false } = {}) {
  if (!selectedIds().length || previewVersion) return;
  if (!navigator.clipboard?.write || typeof ClipboardItem !== "function") {
    showToast(t(`当前浏览器不支持右键{p0}对象，请使用 {p1}。`, { p0: cut ? "剪切" : "复制", p1: cut ? "⌘X" : "⌘C" }), 5000);
    return;
  }
  const payload = newCanvasClipboardPayload();
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/plain": new Blob([payload.plain], { type: "text/plain" }),
      "text/html": new Blob([clipboardHtml(payload)], { type: "text/html" }),
    })]);
  } catch {
    showToast(t(`浏览器未允许右键{p0}对象，请使用 {p1}。`, { p0: cut ? "剪切" : "复制", p1: cut ? "⌘X" : "⌘C" }), 5000);
    return;
  }
  await commandTail.catch(() => {});
  await commitCanvasClipboard(payload, { cut });
}

function applyCanvasClipboard({ token = "", plain = "" } = {}) {
  const internal = Boolean(internalClipboardClaim && token === internalClipboardClaim.token);
  if (internal) {
    void command("pasteClipboard").catch((error) =>
      showToast(t(`粘贴对象失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
    return;
  }
  internalClipboardClaim = null;
  if (token) {
    showToast(t("对象剪贴板来自其他标签页或已失效，请在当前编辑器重新复制。"), 5000);
    return;
  }
  if (!plain.trim()) {
    showToast(t("当前画布只能粘贴已复制的对象或纯文本。"), 5000);
    return;
  }
  void command("insert", { kind: "text", text: plain }).catch((error) =>
    showToast(t(`粘贴文本失败：{p0}`, { p0: error instanceof Error ? error.message : String(error) })));
}

async function clipboardItemText(item, type) {
  if (!item?.types?.includes(type)) return "";
  return (await item.getType(type)).text();
}

async function pasteCanvasClipboardFromMenu() {
  if (!navigator.clipboard?.read) {
    showToast(t("当前浏览器不支持右键读取剪贴板，请使用 ⌘V。"), 5000);
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    let token = "";
    let plain = "";
    let html = "";
    for (const item of items) {
      token ||= await clipboardItemText(item, INTERNAL_CLIPBOARD_TYPE);
      plain ||= await clipboardItemText(item, "text/plain");
      html ||= await clipboardItemText(item, "text/html");
    }
    token ||= clipboardTokenFromHtml(html);
    if (!plain && html) plain = new DOMParser().parseFromString(html, "text/html").body.textContent || "";
    applyCanvasClipboard({ token, plain });
  } catch {
    showToast(t("浏览器未允许右键读取剪贴板，请使用 ⌘V。"), 5000);
  }
}

window.addEventListener("copy", (event) => copyCanvasSelection(event));
window.addEventListener("cut", (event) => copyCanvasSelection(event, { cut: true }));
window.addEventListener("paste", (event) => {
  if (nativeClipboardTarget(event.target) || nativeClipboardTarget()) return;
  const data = event.clipboardData;
  if (!data) return;
  event.preventDefault();
  const plain = clipboardPlainText(data);
  const token = data.getData(INTERNAL_CLIPBOARD_TYPE) || clipboardTokenFromHtml(data.getData("text/html"));
  applyCanvasClipboard({ token, plain });
});

window.addEventListener("keydown", (ev) => {
  if (ev.defaultPrevented) return;
  // Pick the last open dialog: querySelector returns DOM order, and a modal
  // shown later stacks above one opened before it. Escape must reach the top.
  const openDialogs = document.querySelectorAll("dialog[open]");
  const openDialog = openDialogs[openDialogs.length - 1];
  if (openDialog) {
    ev.stopPropagation();
    if (ev.key === "Escape") {
      ev.preventDefault();
      if (openDialog.id === "text-link-dialog" && textLinkDialogBusy) return;
      const cancelEvent = new Event("cancel", { cancelable: true });
      if (openDialog.dispatchEvent(cancelEvent) && openDialog.open) openDialog.close("cancel");
    }
    return;
  }
  if (ev.isComposing || ev.keyCode === 229) return;
  if (model?.presenting) {
    if (ev.key === "Escape") command("present", { on: false });
    if (ev.key === "ArrowRight" || ev.key === " " || ev.key === "Enter" || ev.key === "PageDown") {
      ev.preventDefault();
      presentAdvance(1);
    }
    if (ev.key === "ArrowLeft" || ev.key === "PageUp") {
      ev.preventDefault();
      presentAdvance(-1);
    }
    return;
  }
  const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || ev.target.isContentEditable;
  // Inputs outside the canvas own their keys, including ?, Tab and formatting.
  if (typing && ev.key !== "Escape" && !$("slide")?.contains(ev.target)) return;
  const contextMenu = $("ctx-menu");
  if (
    (ev.key === "ArrowDown" || ev.key === "ArrowUp") &&
    contextMenu &&
    !contextMenu.hidden &&
    contextMenu.contains(ev.target)
  ) {
    ev.preventDefault();
    const items = [...contextMenu.querySelectorAll("button:not(:disabled)")];
    const current = items.indexOf(document.activeElement);
    const delta = ev.key === "ArrowDown" ? 1 : -1;
    const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : (current + delta + items.length) % items.length;
    items[next]?.focus();
    return;
  }
  if (ev.key === "Escape") {
    const openCtx = document.querySelector(".ctx-popwrap.open");
    if (openCtx) {
      ev.preventDefault();
      closeCtxPops({ restoreFocus: true });
      return;
    }
    const openInsertPopover = ["table-size", "shape-palette"]
      .map((id) => $(id))
      .find((node) => node && !node.hidden);
    if (openInsertPopover) {
      ev.preventDefault();
      openInsertPopover.hidden = true;
      insertPopoverReturnFocus?.setAttribute?.("aria-expanded", "false");
      insertPopoverReturnFocus?.focus?.();
      insertPopoverReturnFocus = null;
      return;
    }
    const menu = $("ctx-menu");
    if (menu && !menu.hidden) {
      ev.preventDefault();
      hideMenus();
      contextMenuReturnFocus?.focus?.();
      contextMenuReturnFocus = null;
      return;
    }
    const versionMenu = $("version-menu");
    if (versionMenu && !versionMenu.hidden) {
      ev.preventDefault();
      versionMenu.hidden = true;
      $("btn-versions")?.setAttribute("aria-expanded", "false");
      $("btn-versions")?.focus();
      return;
    }
    if (commentMode) {
      ev.preventDefault();
      setCommentMode(false, { focus: true });
      return;
    }
    if (editingId) {
      ev.preventDefault();
      cancelTextEdit();
      return;
    }
    if (editingCell) {
      ev.preventDefault();
      cancelTableEdit();
      return;
    }
    if (croppingId) {
      ev.preventDefault();
      exitCropMode();
      return;
    }
    const help = $("kbd-help");
    if (help && !help.hidden) {
      help.hidden = true;
      return;
    }
    const chat = $("work-chat");
    if (chat && !chat.hidden) {
      ev.preventDefault();
      hideWorkChat();
      return;
    }
    command("select", {});
    return;
  }
  // In annotation mode, Tab navigates the panel; editing shortcuts must not
  // recreate a canvas selection behind the comment targets.
  if (commentMode) return;
  if (ev.key === "Tab" && (editingCell || selectedEl()?.type === "table" || (tableFocusId && !selectedEl()))) {
    ev.preventDefault();
    moveTableCell(0, ev.shiftKey ? -1 : 1);
    return;
  }
  if (ev.key === "Tab" && !typing) {
    ev.preventDefault();
    command("tabSelect", { dir: ev.shiftKey ? -1 : 1 });
    return;
  }
  if (ev.key === "Enter" && !ev.metaKey && !ev.ctrlKey && (editingCell || (!typing && selectedEl()?.type === "table"))) {
    ev.preventDefault();
    if (editingCell) moveTableCell(ev.shiftKey ? -1 : 1, 0);
    else enterTableEdit(selectedEl().id, tableCell.row, tableCell.col);
    return;
  }
  if (ev.key === "F2" && !typing && selectedEl()?.type === "table") {
    ev.preventDefault();
    enterTableEdit(selectedEl().id, tableCell.row, tableCell.col);
    return;
  }
  if (ev.key === "?" || (ev.shiftKey && ev.key === "/")) {
    ev.preventDefault();
    toggleKeyboardHelp();
    return;
  }
  const meta = ev.metaKey || ev.ctrlKey;
  if (meta && !ev.altKey && (editingId || selectedEl()?.type === "text")) {
    const k = ev.key.toLowerCase();
    if (k === "b" || k === "i" || k === "u") {
      ev.preventDefault();
      const key = k === "b" ? "bold" : k === "i" ? "italic" : "underline";
      styleTextFromToolbar(`element.text.toolbar.${key}.toggle`, { [key]: true }, key);
      return;
    }
  }
  if (typing) return;
  if ((ev.key === "Delete" || ev.key === "Backspace") && selectedEl()) {
    ev.preventDefault();
    command("deleteSelected");
  }
  if (meta && ev.key.toLowerCase() === "d" && selectedEl()) {
    ev.preventDefault();
    command("duplicateSelected");
  }
  if (meta && ev.key.toLowerCase() === "g" && selectedIds().length > 1) {
    ev.preventDefault();
    command("group");
  }
  if (meta && ev.shiftKey && ev.key.toLowerCase() === "g") {
    ev.preventDefault();
    command("ungroup");
  }
  if (meta && ev.shiftKey && ev.key.toLowerCase() === "l" && selectedEl()?.type === "text") {
    ev.preventDefault();
    const cur = selectedEl().list;
    command("setTextStyle", {
      controlId: "element.text.toolbar.list.set",
      patch: { list: cur === "bullet" ? null : "bullet" },
    });
  }
  if (meta && ev.key.toLowerCase() === "k" && selectedEl()?.type === "text") {
    ev.preventDefault();
    openTextLinkDialog(document.activeElement);
  }
  if (meta && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    command(ev.shiftKey ? "redo" : "undo");
  }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key) && selectedEl()?.type === "table") {
    ev.preventDefault();
    const dr = ev.key === "ArrowUp" ? -1 : ev.key === "ArrowDown" ? 1 : 0;
    const dc = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
    moveTableCell(dr, dc, ev.shiftKey);
    return;
  }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key) && selectedEl()) {
    ev.preventDefault();
    const step = ev.shiftKey ? 10 : 1;
    const [x, y, w, h] = selectedEl().bounds;
    const nx = x + (ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0);
    const ny = y + (ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0);
    command("setBounds", { bounds: [nx, ny, w, h] });
  }
});
window.addEventListener("pointermove", (ev) => {
  if (!railDrag) return;
  const dist = Math.hypot(ev.clientX - railDrag.startX, ev.clientY - railDrag.startY);
  if (!railDrag.active && dist < 6) return;
  railDrag.active = true;
  railDidDrag = true;
  railDrag.thumb?.classList.add("is-dragging");
  const insertAt = railInsertIndex(ev.clientY);
  railDrag.insertAt = insertAt;
  placeRailInsertLine(insertAt);
});
window.addEventListener("pointerup", (ev) => {
  if (!railDrag) return;
  const cur = railDrag;
  railDrag = null;
  hideRailInsertLine();
  if (!cur.active) return;
  const insertAt = cur.insertAt ?? railInsertIndex(ev.clientY);
  let toIndex = insertAt > cur.fromIndex ? insertAt - 1 : insertAt;
  if (toIndex === cur.fromIndex || toIndex < 0) return;
  command("reorderPage", { fromIndex: cur.fromIndex, toIndex });
});
window.addEventListener("pointercancel", () => {
  if (!railDrag) return;
  railDrag = null;
  railDidDrag = false;
  hideRailInsertLine();
});
window.addEventListener("resize", fitStage);
window.visualViewport?.addEventListener("resize", fitStage);
window.addEventListener("resize", () => {
  const anchors = [
    ["table-size", '[data-insert="table"]'],
    ["shape-palette", '[data-insert="shape"]'],
  ];
  for (const [popoverId, triggerRef] of anchors) {
    const popover = $(popoverId);
    const trigger = triggerRef.startsWith?.("[") ? document.querySelector(triggerRef) : $(triggerRef);
    if (popover && !popover.hidden) positionInsertPopover(popover, trigger);
  }
});
if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => fitStage());
  const vp = $("viewport");
  if (vp) ro.observe(vp);
  const rail = $('rail');
  let railContentWidth = -1;
  const railSizer = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width;
    if (width === railContentWidth) return;
    railContentWidth = width;
    if (model && width > 0) requestAnimationFrame(renderRail);
  });
  if (rail) railSizer.observe(rail);
}

function paintReasonRow(card, label, block) {
  if (!card || !block) return;
  const row = document.createElement("div");
  row.className = "tool-row is-expandable is-open";
  row.innerHTML = `<div class="tool-main"><b>✎</b><span>${escapeHtmlText(label)}</span>${
    block.summary ? `<small>${escapeHtmlText(block.summary)}</small>` : ""
  }<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 6l6 6-6 6"/></svg></div><pre class="tool-detail">${escapeHtmlText(block.detail || "")}</pre>`;
  row.addEventListener("click", () => row.classList.toggle("is-open"));
  card.append(row);
}

function paintPersistedReason() {
  const thread = $("work-thread");
  if (!thread || thread.dataset.reasonPainted === "1") return;
  const reason = model?.reason;
  if (!reason?.think && !reason?.plan && !(reason?.tools && reason.tools.length)) return;
  thread.dataset.reasonPainted = "1";
  thread.replaceChildren();
  if (reason.brief) {
    appendBriefChip(thread, reason.brief);
  }
  const turn = document.createElement("div");
  turn.className = "agent-turn";
  turn.innerHTML = `<div class="kimi-avatar" aria-hidden="true"><i></i><i></i></div><div><div class="tool-card"></div></div>`;
  thread.append(turn);
  const card = turn.querySelector(".tool-card");
  if (reason.tools && reason.tools.length) {
    for (const t of reason.tools) {
      paintReasonRow(card, t.label || t.tool, t);
    }
  } else {
    paintReasonRow(card, t("思考"), reason.think);
    paintReasonRow(card, t("计划"), reason.plan);
  }
}

function generationIsActive(activity = generationActivity) {
  return Boolean(activity?.sessionId) && ["awaiting-project", "planning", "generating", "reviewing", "discussing"].includes(activity?.phase);
}

const GENERATION_TERMINAL_PHASES = new Set(["complete", "paused", "failed", "cancelled", "canceled", "discussion", "edited"]);

function generationIsAuthoritativelyTerminal(activity, expectedSessionId = liveGenerationSessionId()) {
  return Boolean(
    expectedSessionId &&
    activity?.sessionId === expectedSessionId &&
    GENERATION_TERMINAL_PHASES.has(activity?.phase),
  );
}

function liveGenerationRoute() {
  return new URLSearchParams(location.search).get("live") === "1";
}

function liveGenerationSessionId() {
  return new URLSearchParams(location.search).get("session") || generationActivity?.sessionId || "";
}

function generationActivityUrl(sessionIdOverride = "") {
  const route = new URLSearchParams(location.search);
  const query = new URLSearchParams();
  const project = route.get("project");
  const sessionId = sessionIdOverride || route.get("session");
  if (project) query.set("project", project);
  if (sessionId) query.set("sessionId", sessionId);
  const suffix = query.toString();
  return `/api/generation-activity${suffix ? `?${suffix}` : ""}`;
}

function generationInteractionLocked(activity = generationActivity) {
  const sessionId = liveGenerationSessionId();
  return Boolean(sessionId) && activity?.conversation?.mode !== "discuss"
    && (generationIsActive(activity) || (liveGenerationRoute() && !generationIsAuthoritativelyTerminal(activity, sessionId)));
}

function captureAiReviewEventBaseline(activity = generationActivity) {
  const turns = (activity?.events || [])
    .map((event) => event?.turn)
    .filter(Number.isFinite);
  aiReviewBaselineTurn = turns.length ? Math.max(...turns) : -Infinity;
}

function setAiReviewTurnActive(active) {
  const wasActive = aiReviewTurnActive;
  aiReviewTurnActive = Boolean(active);
  if (aiReviewTurnActive && !wasActive) {
    captureAiReviewEventBaseline();
  } else if (!aiReviewTurnActive) {
    aiReviewBaselineTurn = null;
  }
  if (aiReviewTurnActive) {
    generationPanelExpanded = true;
    generationPanelUserToggled = false;
  }
  paintEditorGeneration(generationActivity);
  if ($("work-brief")) $("work-brief").disabled = false;
  const sendButton = document.querySelector("#work-form .composer-send");
  if (sendButton) sendButton.disabled = false;
  if ($("notes-text")) $("notes-text").disabled = aiReviewTurnActive;
}

function setNodeText(node, value) {
  const next = String(value || "");
  if (!node || node.textContent === next) return;
  const selection = document.getSelection?.();
  if (selection && !selection.isCollapsed && (
    (selection.anchorNode && node.contains(selection.anchorNode)) ||
    (selection.focusNode && node.contains(selection.focusNode))
  )) return;
  node.textContent = next;
}

function processTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function mountThinkLabel(host, text, shimmer) {
  if (!host) return;
  let root = host.querySelector(":scope > .think");
  if (!root) {
    host.textContent = "";
    root = document.createElement("span");
    root.className = "think";
    const sizer = document.createElement("span");
    sizer.className = "think-sizer";
    const current = document.createElement("span");
    current.className = "think-text";
    current.dataset.readerStatusCopy = "current";
    root.append(sizer, current);
    host.append(root);
  }
  const motion = shimmer && !prefersReducedMotion();
  root.dataset.active = motion ? "true" : "false";
  const sizer = root.querySelector(".think-sizer");
  const current = root.querySelector('.think-text[data-reader-status-copy="current"]');
  const previous = current.textContent || "";
  sizer.textContent = text;
  if (motion && previous && previous !== text) {
    const outgoing = current.cloneNode(true);
    outgoing.dataset.readerStatusCopy = "outgoing";
    outgoing.classList.add("is-exit");
    current.classList.add("is-enter-start");
    current.textContent = text;
    current.dataset.text = text;
    root.insertBefore(outgoing, current);
    root.dataset.readerStatusPhase = "start";
    requestAnimationFrame(() => {
      current.classList.remove("is-enter-start");
      root.dataset.readerStatusPhase = "running";
      window.setTimeout(() => {
        outgoing.remove();
        if (root.dataset.readerStatusPhase === "running") root.dataset.readerStatusPhase = "idle";
      }, 200);
    });
    return;
  }
  current.textContent = text;
  current.dataset.text = text;
}

function paintThinkStatus(label, live) {
  const host = $("generation-think-status");
  if (!host) return;
  if (!live) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  mountThinkLabel(host, label || t("正在思考"), true);
}

function createGenerationProcessHead(tagName = "header") {
  const head = document.createElement(tagName);
  head.className = "generation-process-head";
  const marker = document.createElement("i");
  marker.setAttribute("aria-hidden", "true");
  const title = document.createElement("strong");
  title.dataset.processTitle = "";
  const meta = document.createElement("span");
  meta.dataset.processMeta = "";
  const status = document.createElement("small");
  status.dataset.processStatus = "";
  head.append(marker, title, meta, status);
  return head;
}

function createGenerationTruncation(text) {
  const clipped = document.createElement("p");
  clipped.className = "generation-process-truncated";
  clipped.dataset.processTruncated = "";
  clipped.textContent = text;
  return clipped;
}

function createGenerationTechnicalDetails() {
  const details = document.createElement("details");
  details.className = "generation-technical-details";
  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.textContent = t("技术详情");
  const technicalName = document.createElement("code");
  technicalName.dataset.processTechnicalName = "";
  summary.append(label, technicalName);
  const body = document.createElement("div");
  body.className = "generation-tool-body";
  for (const [slot, title] of [["input", t("工具输入")], ["output", t("工具结果")]]) {
    const section = document.createElement("section");
    section.dataset.processSlot = slot;
    const heading = document.createElement("b");
    heading.textContent = title;
    const raw = document.createElement("pre");
    raw.dataset.processRaw = slot;
    section.append(heading, raw);
    body.append(section);
  }
  body.append(createGenerationTruncation(t("详情已截断")));
  details.append(summary, body);
  return details;
}

function createGenerationProcessNode(row) {
  const item = document.createElement("li");
  item.dataset.processKey = row.key;
  item.dataset.processKind = row.kind;
  if (row.kind === "process-head") {
    item.className = "reader-process-head";
    const button = document.createElement("button");
    button.type = "button"; button.className = "reader-process-toggle";
    const label = document.createElement("span"); label.className = "reader-process-summary";
    const count = document.createElement("span"); count.className = "reader-process-count";
    button.append(label, count);
    button.addEventListener("click", () => {
      generationScroll.beforeUpdate();
      rememberProcessChoice(row.groupKey, button.getAttribute("aria-expanded") !== "true");
      paintEditorGeneration(generationActivity);
    });
    item.append(button);
  } else if (row.kind === "question") {
    item.__question = mountAssistantQuestion(item, row.question, async (action, answer) => {
      const response = await fetch(`/slides/sessions/${encodeURIComponent(liveGenerationSessionId())}/questions/${encodeURIComponent(row.question.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, answer }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || t("回答未送达，请重试。"));
      void pollGenerationActivity();
    });
  } else if (row.kind === "tool") {
    const card = document.createElement("article");
    card.className = "generation-tool-card";
    const line = document.createElement("p");
    line.className = "native-tool-row";
    const verb = document.createElement("span");
    verb.className = "tool-verb";
    verb.dataset.processTitle = "";
    const sep = document.createElement("span");
    sep.className = "row-separator";
    sep.setAttribute("aria-hidden", "true");
    const target = document.createElement("span");
    target.className = "native-tool-summary";
    target.dataset.toolTarget = "";
    const state = document.createElement("small");
    state.dataset.processStatus = "";
    state.hidden = true;
    line.append(verb, sep, target, state);
    const summary = document.createElement("p");
    summary.dataset.processSummary = "";
    summary.hidden = true;
    const facts = document.createElement("dl");
    facts.className = "generation-process-facts";
    facts.dataset.processFacts = "";
    card.append(line, summary, facts, createGenerationTechnicalDetails());
    item.append(card);
  } else if (row.kind === "user") {
    const card = document.createElement("article");
    card.className = "generation-user-card";
    const detail = document.createElement("p");
    detail.dataset.processDetail = "";
    const receipt = document.createElement("div");
    receipt.className = "generation-user-receipt";
    receipt.hidden = true;
    const status = document.createElement("span");
    status.dataset.reviewStatus = "";
    status.setAttribute("role", "status");
    const retry = document.createElement("button");
    retry.type = "button"; retry.textContent = t("重试");
    retry.dataset.control = "chrome.comments.resend";
    retry.addEventListener("click", () => void retryCommentSubmission(item.__reviewSubmission));
    receipt.append(status, retry);
    card.append(detail, receipt);
    item.append(card);
  } else if (row.kind === "status") {
    const card = document.createElement("p");
    card.className = "generation-turn-end";
    card.dataset.processTitle = "";
    const detail = document.createElement("p");
    detail.className = "generation-turn-end-detail";
    detail.dataset.processDetail = "";
    detail.hidden = true;
    item.append(card, detail);
  } else if (row.kind === "thought" || row.kind === "reasoning") {
    const controller = mountReasonCard({ host: item });
    controller.setDetail(row.detail || "", row.status === "running", row.stepLabel);
    controller.root.append(createGenerationTruncation(t("内容较长，展示前8192字符")));
    item.__reason = controller;
  } else {
    const card = document.createElement("article");
    card.className = row.kind === "message" ? "generation-message-card" : "generation-note-card";
    const detail = document.createElement("div");
    detail.dataset.processDetail = "";
    card.append(createGenerationProcessHead(), detail, createGenerationTruncation(t("内容较长，展示前8192字符")));
    item.append(card);
  }
  return item;
}

function reconcileGenerationFacts(container, facts) {
  const source = Array.isArray(facts)
    ? facts.filter((fact) => fact && (fact.label != null || fact.value != null)).slice(0, 6)
    : [];
  const existing = new Map([...container.children].map((node) => [node.dataset.processFactKey, node]));
  const keep = new Set();
  source.forEach((fact, index) => {
    const key = `${String(fact.label || t("信息"))}:${index}`;
    let pair = existing.get(key);
    if (!pair) {
      pair = document.createElement("div");
      pair.dataset.processFactKey = key;
      pair.append(document.createElement("dt"), document.createElement("dd"));
    }
    keep.add(key);
    setNodeText(pair.querySelector("dt"), fact.label || t("信息"));
    setNodeText(pair.querySelector("dd"), fact.value);
    const current = container.children[index];
    if (current !== pair) container.insertBefore(pair, current || null);
  });
  for (const child of [...container.children]) {
    if (!keep.has(child.dataset.processFactKey)) child.remove();
  }
  container.hidden = source.length === 0;
}

/** Targets the Host invents for a call ("todo", "deck") say nothing to a reader. */
const SYNTHETIC_TOOL_TARGETS = new Set(["capabilities", "references", "todo", "deck", "export"]);
function readableToolTarget(row) {
  const target = String(row.target || "");
  const repeat = / ×\d+$/.exec(target)?.[0] || "";
  const base = repeat ? target.slice(0, -repeat.length) : target;
  if (!base || SYNTHETIC_TOOL_TARGETS.has(base) || base === row.technicalName) return repeat.trim();
  return target;
}

function generationToolSummary(row) {
  if (row.summary) return row.summary;
  if (row.status === "running") return t("正在执行，请稍候。");
  if (row.status === "failed") return t("这一步没有完成。");
  if (row.status === "canceled") return t("这一步已取消。");
  if (row.status === "success") return t("这一步已经完成。");
  return t("已收到这一步的执行结果。");
}

function updateGenerationProcessNode(item, row) {
  item.dataset.processGroup = row.processGroup || "";
  item.hidden = Boolean(row.processHidden);
  if (row.kind === "process-head") {
    item.querySelector("button").setAttribute("aria-expanded", String(row.open));
    item.querySelector("button").setAttribute("aria-label", t(`过程：{p0}`, { p0: row.summary || t(`{p0} 个步骤`, { p0: row.count }) }));
    setNodeText(item.querySelector(".reader-process-summary"), row.summary || t("思考与过程"));
    setNodeText(item.querySelector(".reader-process-count"), "");
    return;
  }
  if (row.kind === "question") {
    item.className = "generation-process-entry is-question";
    item.__question.update(row.question);
    return;
  }
  const reasoning = row.kind === "thought" || row.kind === "reasoning";
  const inProcess = reasoning || row.kind === "tool" || row.inProcess;
  item.className = `generation-process-entry is-${row.kind} is-${row.status}${inProcess ? " is-process" : ""}`;
  item.dataset.processStatus = row.status;
  const meta = [processTime(row.at), row.pageId].filter(Boolean).join(" · ");
  const isRunning = row.status === "running";
  let title = row.kind === "tool"
    ? row.displayTitle || row.title || t("执行扩展操作")
    : reasoning
      ? t("思考")
      : row.displayTitle || row.title || (row.kind === "message" ? t("助手回复") : t("过程说明"));
  const titleNode = item.querySelector("[data-process-title]");
  if (reasoning) setNodeText(titleNode, t("思考"));
  else setNodeText(titleNode, title);
  const stepNode = item.querySelector("[data-process-step]");
  if (stepNode) setNodeText(stepNode, row.stepLabel || "");
  setNodeText(item.querySelector("[data-process-meta]"), meta);
  setNodeText(item.querySelector("[data-process-status]"), processStatusLabel(row.status));
  if (reasoning) {
    const openNow = Boolean(isRunning || row.key === generationLiveThoughtKey || (row.processOpen && !generationEventFollowing));
    item.__reason?.setOpen(openNow);
    item.__reason?.setDetail(row.detail || "", isRunning, row.stepLabel);
    const truncated = item.querySelector("[data-process-truncated]");
    if (truncated) truncated.hidden = !row.truncated;
    return;
  }
  if (row.kind === "user") {
    setNodeText(item.querySelector("[data-process-detail]"), row.detail);
    const submission = row.reviewSubmission;
    item.__reviewSubmission = submission;
    const receipt = item.querySelector(".generation-user-receipt");
    receipt.hidden = !submission;
    if (submission) {
      receipt.dataset.state = submission.status;
      const status = submission.status === "running" ? t("已发送 · 正在修改")
        : submission.status === "applied" ? t("已完成")
        : submission.status === "cancelled" ? t("已停止")
        : t("未完成 · ") + humanizeGenerationFault({ error: { detail: submission.error || t("请重试") } });
      setNodeText(receipt.querySelector("[data-review-status]"), status);
      const retry = receipt.querySelector("button");
      retry.hidden = !submission.retryable;
      retry.disabled = commentSubmitPending || aiReviewTurnActive || generationInteractionLocked();
    }
    return;
  }
  if (row.kind === "status") {
    item.querySelector(".generation-turn-end")?.classList.toggle("is-info", row.status !== "success");
    setNodeText(item.querySelector("[data-process-title]"), row.displayTitle || row.title);
    const detail = item.querySelector("[data-process-detail]");
    setNodeText(detail, row.detail || "");
    if (detail) detail.hidden = !row.detail;
    return;
  }
  if (row.kind === "tool") {
    const target = readableToolTarget(row);
    setNodeText(item.querySelector("[data-process-title]"), row.displayTitle || row.title || t("执行扩展操作"));
    setNodeText(item.querySelector("[data-tool-target]"), target);
    const separator = item.querySelector(".row-separator");
    if (separator) separator.hidden = !target;
    const summary = item.querySelector("[data-process-summary]");
    setNodeText(summary, generationToolSummary(row));
    if (summary) summary.hidden = true;
    reconcileGenerationFacts(item.querySelector("[data-process-facts]"), row.facts);
    const technical = item.querySelector(".generation-technical-details");
    const technicalName = row.technicalName || row.title || "";
    setNodeText(technical.querySelector("[data-process-technical-name]"), technicalName);
    const input = item.querySelector('[data-process-slot="input"]');
    const output = item.querySelector('[data-process-slot="output"]');
    input.hidden = !row.input;
    output.hidden = !row.output;
    setNodeText(input.querySelector('[data-process-raw="input"]'), row.input);
    setNodeText(output.querySelector('[data-process-raw="output"]'), row.output);
    const truncated = item.querySelector("[data-process-truncated]");
    if (truncated) truncated.hidden = !row.truncated;
    technical.hidden = true;
  } else {
    const detail = item.querySelector("[data-process-detail]");
    if (detail) {
      // A repaint must never hide a node the user is selecting inside: hiding it
      // unrenders the content and the browser drops the selection.
      const active = document.getSelection();
      const held = Boolean(active && !active.isCollapsed && detail.contains(active.anchorNode));
      if (row.detail || !held) detail.hidden = !row.detail;
    }
    const text = row.detail || "";
    const selection = document.getSelection();
    const selected = selection && !selection.isCollapsed && detail?.contains(selection.anchorNode);
    if (!selected && detail && item.__paintedText !== text) {
      if (row.kind === "message" && text) {
        detail.classList.add("md-body");
        detail.innerHTML = renderChatMarkdown(text);
      } else {
        setNodeText(detail, text);
      }
      item.__paintedText = text;
    }
    if (text) item.dataset.streamed = "1";
    const truncated = item.querySelector("[data-process-truncated]");
    if (truncated) truncated.hidden = !row.truncated;
    if (reasoning) {
      const details = item.querySelector(".generation-reasoning-card");
      const live = generationInteractionLocked() || generationIsActive();
      if (details && details.dataset.userToggled !== "true") {
        const next = Boolean(isRunning || live);
        // Closing a <details> unrenders its content, which would destroy a
        // selection (and the reading position) the user is holding inside it, so
        // a card under active selection is never auto-collapsed.
        const active = document.getSelection();
        const held = Boolean(active && !active.isCollapsed && details.contains(active.anchorNode));
        // Skip redundant writes: re-assigning `open` churns the content box and
        // can drop a selection the user is holding inside the card.
        if (details.open !== next && (next || !held)) details.open = next;
      }
      const viewport = item.querySelector(".reason-viewport");
      if (viewport) {
        const overflowing = viewport.scrollHeight > viewport.clientHeight + 8;
        details?.setAttribute("data-overflow", overflowing ? "true" : "false");
        viewport.dataset.edges = overflowing ? "bottom" : "";
        if (isRunning) viewport.scrollTop = viewport.scrollHeight;
      }
    }
  }
}

function updateGenerationLatestButton() {
  const list = $("editor-generation-event-list");
  const button = $("editor-generation-latest");
  if (!list || !button) return;
  button.hidden = generationEventFollowing || list.scrollHeight <= list.clientHeight + 2;
}

function bindGenerationProcessScroll() {
  if (generationEventScrollBound) return;
  const list = $("editor-generation-event-list");
  const button = $("editor-generation-latest");
  if (!list || !button) return;
  generationEventScrollBound = true;
  generationScroll = createConversationScroll(list, following => {
    generationEventFollowing = following;
    updateGenerationLatestButton();
  });
  button.addEventListener("click", () => generationScroll.toLatest());
}

/**
 * A DOM move is a remove plus an insert, and removing a node that holds the
 * selection's anchor collapses the selection — so a repaint that reorders rows
 * would silently destroy what the user selected. Capture the range before the
 * reorder and put it back afterwards.
 */
function captureSelectionInside(root) {
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (!anchor || !focus || !root.contains(anchor)) return null;
  return { anchor, anchorOffset: selection.anchorOffset, focus, focusOffset: selection.focusOffset };
}

function restoreSelectionInside(snapshot) {
  if (!snapshot) return;
  const { anchor, anchorOffset, focus, focusOffset } = snapshot;
  if (!anchor.isConnected || !focus.isConnected) return;
  const selection = document.getSelection?.();
  if (!selection) return;
  try {
    selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
  } catch {
    // A node detached by the same repaint cannot be restored; leave the selection alone.
  }
}

// Recovery belongs to the same reply, not a second completion panel.
function paintWorkspaceEditReceipts(rows) {
  const list = $("editor-generation-event-list");
  const receipts = new Map();
  for (const artifact of generationActivity?.assistantArtifacts || []) {
    const message = generationActivity?.conversation?.messages?.find(item => item.id === artifact.messageId);
    if (message) receipts.set(message.id, { ...artifact, project: currentProjectPath(), message });
  }
  for (const local of workspaceEditReceipts.values()) {
    if (local.project === currentProjectPath()) receipts.set(local.message.id, { ...receipts.get(local.message.id), ...local });
  }
  for (const receipt of receipts.values()) {
    if (receipt.project !== currentProjectPath() || !receipt.message || (!receipt.error && !receipt.snapshotId)) continue;
    const userIndex = rows.findIndex(row => row.key === conversationMessageKey(receipt.message));
    if (userIndex < 0) continue;
    const nextUser = rows.findIndex((row, index) => index > userIndex && row.kind === "user");
    const reply = rows.slice(userIndex + 1, nextUser < 0 ? undefined : nextUser).findLast(row => row.kind === "message" && !row.inProcess);
    const key = reply?.key || rows[userIndex].key;
    const entry = [...list.children].find(node => node.dataset.processKey === key);
    const card = entry?.querySelector("article");
    if (!card) continue;
    for (const old of list.querySelectorAll(".assistant-reply-actions")) {
      if (old.dataset.messageId === receipt.message.id && old.parentElement !== card) old.remove();
    }
    const signature = JSON.stringify([receipt.error, receipt.snapshotId, receipt.uncertain]);
    // The card owns this UI seat; disk-derived artifacts need no browser receipt.
    receipt.footer = card.querySelector(".assistant-reply-actions");
    receipt.footerSignature = receipt.footer?.dataset.signature;
    if (receipt.footerSignature !== signature) { receipt.footer?.remove(); receipt.footer = null; receipt.footerSignature = signature; }
    if (!receipt.footer) {
      const footer = document.createElement("div");
      footer.className = "assistant-reply-actions";
      footer.dataset.signature = signature;
      footer.dataset.messageId = receipt.message.id;
      if (receipt.error) {
        const error = document.createElement("span");
        error.setAttribute("role", "status"); error.textContent = receipt.error;
        footer.append(error);
        const retry = document.createElement("button");
        retry.type = "button"; retry.textContent = t("重试");
        retry.dataset.control = "chrome.workspace.assistant.send";
        retry.addEventListener("click", () => void dispatchAssistantRequest(receipt.requestText, receipt));
        if (!receipt.uncertain) footer.append(retry);
      } else {
        const before = document.createElement("button");
        before.type = "button"; before.textContent = t("查看修改前");
        before.title = t(`查看修改前的 {p0}`, { p0: receipt.snapshotLabel || receipt.snapshotId.toUpperCase() });
        before.dataset.snapshotId = receipt.snapshotId;
        before.dataset.control = "chrome.history.versions.open";
        before.addEventListener("click", async () => {
          await refreshVersions();
          const version = versions.find(candidate => candidate.id === receipt.snapshotId);
          if (version) await enterHistoryPreview(version);
        });
        footer.append(before);
      }
      receipt.footer = footer;
    }
    if (receipt.footer.parentElement !== card) card.append(receipt.footer);
  }
}

function reconcileGenerationProcess(rows, active) {
  const list = $("editor-generation-event-list");
  if (!list) return;
  bindGenerationProcessScroll();
  if (generationProcessContext !== currentProjectPath()) {
    generationProcessContext = currentProjectPath();
    generationProcessChoices.clear();
    try {
      for (const [key, open] of JSON.parse(sessionStorage.getItem(`slides-chat-process:${generationProcessContext}`)) || []) {
        if (typeof key === "string" && typeof open === "boolean") generationProcessChoices.set(key, open);
      }
    } catch { /* optional UI state */ }
  }
  generationScroll.useContext(currentProjectPath());
  const reading = generationScroll.beforeUpdate();
  // A process the user is reading must not disappear when its turn finishes.
  const readingNode = reading.anchor && [...list.children].find(node => node.dataset.processKey === reading.anchor.key);
  if (!reading.following && readingNode?.classList.contains("is-process")) {
    rememberProcessChoice(readingNode.dataset.processGroup, true);
  }
  rows = conversationProcessRows(rows, active, generationProcessChoices);
  const heldSelection = captureSelectionInside(list);
  // Folding waits while the reader is selecting text inside a step.
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) {
    const holder = [...list.children].find(node => !node.hidden && node.contains(selection.anchorNode));
    const held = holder && rows.find(row => row.key === holder.dataset.processKey);
    if (held?.processHidden) held.processHidden = false;
  }
  const liveStatus = $("generation-think-status");
  const existing = new Map([...list.children].filter(node => node !== liveStatus).map((node) => [node.dataset.processKey, node]));
  const keep = new Set();
  const hydrating = existing.size === 0 && rows.length > 1;
  rows.forEach((row, index) => {
    let item = existing.get(row.key);
    if (!item || item.dataset.processKind !== row.kind) {
      item = createGenerationProcessNode(row);
      if (!hydrating && !prefersReducedMotion()) item.classList.add("is-enter");
    }
    keep.add(row.key);
    updateGenerationProcessNode(item, row);
    const current = list.children[index];
    if (current !== item) list.insertBefore(item, current || null);
  });
  for (const child of [...list.children]) {
    if (child !== liveStatus && !keep.has(child.dataset.processKey)) {
      child.__reason?.destroy();
      child.remove();
    }
  }
  paintWorkspaceEditReceipts(rows);
  if (liveStatus && list.lastElementChild !== liveStatus) list.append(liveStatus);
  if (liveStatus?.hidden) {
    const lastReply = [...list.children].findLast(node => !node.hidden && node.dataset.processKind === "message");
    const footer = lastReply?.querySelector(".assistant-reply-actions");
    const occupied = footer ? footer.getBoundingClientRect().height + parseFloat(getComputedStyle(footer).marginTop) : 0;
    liveStatus.style.setProperty("--reply-footer-space", `${Math.max(0, 36 - occupied)}px`);
  }
  restoreSelectionInside(heldSelection);
  generationScroll.afterUpdate();
  updateGenerationLatestButton();
}

function paintEditorGeneration(activity) {
  const box = $("editor-generation");
  if (!box) return;
  const current = mergeAcknowledgedCommentTurns(activity || {});
  const liveMode = liveGenerationRoute();
  const events = conversationEvents(current);
  const thread = $("work-thread");
  const empty = $("work-empty");
  const emptyIsOnlyThreadContent = Boolean(thread && empty && thread.children.length === 1 && thread.firstElementChild === empty);
  if (!aiReviewTurnActive && !liveMode && !current.sessionId && events.length === 0) {
    box.hidden = true;
    $("work-chat")?.classList.remove("is-live-generation");
    document.querySelector(".app")?.classList.remove("is-live-generation");
    const form = $("work-form");
    if (form) form.hidden = false;
    const lockNote = $("work-generation-lock");
    if (lockNote) lockNote.hidden = true;
    const briefInput = $("work-brief");
    if (briefInput) {
      briefInput.disabled = false;
      briefInput.readOnly = false;
    }
    const sendButton = document.querySelector("#work-form .composer-send");
    if (sendButton) {
      sendButton.disabled = false;
      sendButton.classList.remove("is-stopping");
    }
    if ($("notes-text")) $("notes-text").disabled = false;
    empty?.toggleAttribute("hidden", !emptyIsOnlyThreadContent);
    return;
  }
  const phase = current.phase || (liveMode ? "awaiting-project" : "idle");
  const disconnected = current.connectionState === "disconnected";
  const active = generationIsActive(current);
  const locked = workAgentSubmitPending || assistantTurnPending || current.phase === "discussing" || aiReviewTurnActive || generationInteractionLocked(current);
  const discussion = current.conversation?.mode === "discuss";
  const editing = current.conversation?.mode === "edit";
  const terminalPresentation = aiReviewTurnActive || discussion || editing ? null : generationTerminalPresentation(current);
  if (!aiReviewTurnActive && !discussion && !editing && phase === "paused" && generationPreviousPhase && generationPreviousPhase !== "paused") {
    showToast(humanizeGenerationFault(current) || t("生成已暂停"), 8000);
  }
  if (locked && (liveMode || aiReviewTurnActive) && !generationPanelUserToggled) generationPanelExpanded = true;
  generationPreviousPhase = phase;
  box.hidden = false;
  box.classList.toggle("is-expanded", generationPanelExpanded);
  const toggle = $("editor-generation-toggle");
  if (toggle) {
    toggle.textContent = generationPanelExpanded ? t("收起") : t("查看过程");
    toggle.setAttribute("aria-expanded", String(generationPanelExpanded));
  }
  const stop = $("editor-generation-stop");
  const stopControl = activeWorkspaceReviewControl || activeCommentReviewControl;
  const liveBusy = Boolean(liveGenerationSessionId() && (active || current.agentStatus === "busy" || current.execution?.recovery?.kind === "wait-or-stop"));
  if (stop) {
    if (aiReviewTurnActive) {
      stop.hidden = !stopControl;
      stop.disabled = !stopControl || stopControl.cancelRequested;
      stop.textContent = stopControl?.cancelRequested ? t("正在停止…") : t("停止修改");
      stop.dataset.control = "chrome.workspace.stop";
    } else {
      stop.hidden = !liveBusy && !generationStopPending;
      stop.disabled = generationStopPending || !liveBusy;
      stop.textContent = generationStopPending ? t("正在停止…") : t("停止生成");
      stop.dataset.control = "chrome.generation.stop";
    }
  }
  const resume = $("editor-generation-resume");
  const resumeRow = $("generation-resume-row");
  const resumeActionable = generationResumeActionable(current);
  if (resumeRow) resumeRow.hidden = !resumeActionable;
  if (resume) {
    const samePending = generationResumePending && current.sessionId;
    const sameUncertain = generationResumeUncertainSessionId === current.sessionId;
    resume.disabled = Boolean(samePending || sameUncertain);
    resume.textContent = samePending
      ? t("正在继续…")
      : sameUncertain
        ? t("正在确认是否已发送…")
        : t("继续完成生成");
  }
  $("work-chat")?.classList.toggle("is-live-generation", locked);
  document.querySelector(".app")?.classList.toggle("is-live-generation", locked && current.conversation?.mode !== "discuss");
  // The panel header shows the deck's real title; the raw brief stays available on
  // hover instead of being repeated in three places.
  const generationTitle = $("editor-generation-title");
  generationTitle.textContent = aiReviewTurnActive
    ? aiReviewLiveLabel || t("Agent 正在修改")
    : current.project?.title || current.brief || t("AI 正在生成");
  generationTitle.title = current.brief ? t(`原始需求：{p0}`, { p0: current.brief }) : "";
  const stages = Array.isArray(current.stages) ? current.stages : [];
  const activeStage = stages.find((stage) => stage.status === "active");
  const activeStageName = activeStage
    ? document.querySelector(`#editor-generation-stages span[data-stage="${activeStage.id === "pages" ? "write" : activeStage.id}"]`)?.textContent?.trim() || ""
    : "";
  const activeStageLabel = activeStage
    ? [activeStageName, activeStage.detail].filter(Boolean).join(" · ")
    : "";
  $("editor-generation-status").textContent = aiReviewTurnActive ? t("正在修改并校验") : phase === "edited" ? t("已修改") : phase === "discussion" ? t("继续聊聊") : phase === "discussing" ? t("正在回复")
    : terminalPresentation?.status
      ? terminalPresentation.status
    : phase === "complete"
    ? t("已完成")
    : phase === "paused"
      ? t("已暂停，可继续编辑")
      : phase === "failed"
        ? (discussion ? t("回复未完成") : editing ? t("修改未完成") : t("生成失败"))
        : disconnected
          ? t("连接中断，正在重连")
        : active
          // "实时更新" said nothing the streaming list below does not; name the
          // step the agent is on instead (策划 / 写页 / 审阅 / 封板).
          ? (activeStageLabel || t("生成中"))
          : t("正在连接");
  const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
  $("editor-generation-stages")?.querySelectorAll("span").forEach((node) => {
    const id = node.dataset.stage === "write" ? "pages" : node.dataset.stage;
    const stage = stagesById.get(id);
    node.classList.toggle("is-active", stage?.status === "active");
    node.classList.toggle("is-done", stage?.status === "complete");
    node.classList.toggle("is-attention", stage?.status === "needs-attention");
    node.title = stage?.detail || node.textContent;
  });
  const pages = Array.isArray(current.inspection?.pages) ? current.inspection.pages : [];
  // Never mistake an already-opened fixture or stale local deck for output of
  // the requested session. Until the durable session record is present, the
  // only truthful output is “not written yet”.
  const pageCount = current.sessionId ? Number(current.project?.pageCount) || pages.length : 0;
  const planned = Math.max(
    pageCount,
    pages.length,
    Number(stages.find((stage) => stage.id === "plan")?.detail?.match(/\d+/)?.[0]) || 0,
    1,
  );
  const pageBox = $("editor-generation-pages");
  pageBox.replaceChildren();
  for (let index = 0; index < Math.min(planned, 32); index += 1) {
    const page = pages[index];
    const tile = document.createElement("span");
    tile.textContent = String(index + 1).padStart(2, "0");
    tile.classList.toggle("is-written", Boolean(page) || index < pageCount);
    tile.classList.toggle("is-reviewed", page?.visualReview === "pass");
    tile.title = page?.visualReview === "pass"
      ? t(`第 {p0} 页已通过检查`, { p0: index + 1 })
      : page
        ? t(`第 {p0} 页已写入`, { p0: index + 1 })
        : t(`第 {p0} 页待生成`, { p0: index + 1 });
    pageBox.append(tile);
  }
  let processRows = projectGenerationProcess(events, {
    active,
    turnActive: aiReviewTurnActive,
    phase,
    error: current.error,
  }).filter((row) => {
    if (row.kind !== "tool") return true;
    const name = row.technicalName || row.title;
    return !["render_page", "render_deck", "_mark_image_emitted", "ask_user_question"].includes(name);
  });
  const folded = [];
  let thoughtStep = 0;
  for (const row of processRows) {
    const last = folded.at(-1);
    if ((row.kind === "thought" || row.kind === "reasoning") && last && last.turn === row.turn && (last.kind === "thought" || last.kind === "reasoning")) {
      last.detail = [last.detail, row.detail].filter(Boolean).join("\n\n");
      if (row.status === "running") last.status = "running";
      continue;
    }
    const next = { ...row };
    if (next.kind === "thought" || next.kind === "reasoning") {
      thoughtStep += 1;
      next.stepLabel = t(`步骤 {p0}`, { p0: thoughtStep });
    }
    folded.push(next);
  }
  // Consecutive identical calls (page rewrites/re-renders) collapse into one
  // row that carries the repeat count and the latest outcome, so the chat
  // never shows a pile of identical "Write · 1_cover" lines.
  const compact = [];
  for (const row of folded) {
    const last = compact.at(-1);
    if (
      row.kind === "tool" && last && last.kind === "tool" &&
      last.technicalName === row.technicalName && last.target === row.target &&
      last.status !== "running"
    ) {
      // The projector already relabels a retried failure as "recovered", so treat
      // that status as a failure predecessor here too; otherwise the merge would
      // overwrite the recovery signal with a plain success.
      const failed = [last.status, row.status].some((status) => status === "failed" || status === "recovered");
      last.repeat = (last.repeat || 1) + 1;
      last.target = `${row.target} ×${last.repeat}`;
      last.status = failed && row.status !== "failed" ? "recovered" : row.status;
      last.output = row.output;
      last.summary = row.summary;
      last.at = row.at;
      continue;
    }
    compact.push(row);
  }
  processRows = compact;
  if (locked && processRows.length === 0) {
    processRows = [{
      key: "live-waiting",
      kind: "thought",
      title: t("正在思考"),
      displayTitle: t("正在思考"),
      detail: "",
      status: "running",
    }];
  }
  const briefText = String(current.brief || "").trim();
  if (briefText) {
    processRows = [{
      key: "user-brief",
      kind: "user",
      detail: briefText,
      status: "info",
      title: t("用户"),
    }, ...processRows.filter((row) => row.key !== "user-brief" && row.key !== "turn-end")];
  }
  const hasReviewReceipt = Boolean(current.conversation?.messages?.at(-1)?.reviewSubmissionId);
  const hasWorkspaceReceipt = workspaceEditReceipts.has(current.conversation?.messages?.at(-1)?.id);
  const lastUserIndex = processRows.findLastIndex(row => row.kind === "user");
  const hasFinalReply = processRows.slice(lastUserIndex + 1).some(row => row.kind === "message" && !row.inProcess && row.detail);
  if (!hasReviewReceipt && !hasWorkspaceReceipt && !locked && processRows.length && (!hasFinalReply || ["paused", "failed", "cancelled", "canceled"].includes(phase)) && ["complete", "paused", "failed", "cancelled", "canceled", "discussion", "edited"].includes(phase)) {
    const duration = (() => {
      const stamps = processRows.map((row) => Date.parse(row.at || "")).filter(Number.isFinite);
      const first = stamps[0];
      const last = stamps.at(-1);
      if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return "";
      const total = Math.round((last - first) / 1000);
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes ? t(` · 用时 {p0} 分 {p1} 秒`, { p0: minutes, p1: seconds }) : t(` · 用时 {p0} 秒`, { p0: seconds });
    })();
    const endTitle = phase === "edited" ? t("本轮修改已完成，可以继续讨论或调整") : phase === "discussion" ? t("可以继续提问，也可以让我修改文稿") : phase === "complete"
      ? (pageCount ? t(`已完成 · {p0} 页{p1}`, { p0: pageCount, p1: duration }) : t(`已完成{p0}`, { p0: duration }))
      : phase === "paused"
        ? (terminalPresentation?.status || humanizeGenerationFault(current) || t("已暂停"))
        : phase === "failed"
          ? (terminalPresentation?.status || humanizeGenerationFault(current) || t("未完成"))
          : t("已停止");
    processRows = [...processRows, {
      key: "turn-end",
      kind: "status",
      title: endTitle,
      displayTitle: endTitle,
      detail: terminalPresentation ? [terminalPresentation.reason, terminalPresentation.action].filter(Boolean).join("\n") : "",
      status: phase === "complete" ? "success" : "info",
    }];
  }
  const questions = lastGenerationState?.questions || [];
  for (const question of questions) {
    const row = { key: `question:${question.id}`, kind: "question", at: question.at, status: question.status, question };
    const index = processRows.findIndex(item => item.at && item.at > question.at);
    processRows.splice(index < 0 ? processRows.length : index, 0, row);
  }
  const pendingQuestion = questions.some(question => question.status === "pending");
  const lastReadable = processRows.at(-1);
  const currentAction = lastReadable && (lastReadable.kind === "thought" || lastReadable.kind === "reasoning") && lastReadable.status === "running"
    ? t("模型正在思考")
    : lastReadable?.displayTitle || lastReadable?.title || "";
  const actionByPhase = {
    "awaiting-project": t("正在连接生成会话并准备编辑画布"),
    planning: t("正在梳理页面结构和事实来源"),
    generating: t("正在写入页面并刷新右侧画布"),
    reviewing: t("正在逐页检查可读性、遮挡与裁切"),
    complete: t("全部页面已经写入并通过当前验收"),
  };
  $("editor-generation-intent").textContent = clipChromeText(current.brief, 88) || t("正在读取生成任务");
  $("editor-generation-intent").title = current.brief || "";
  $("editor-generation-action").textContent = aiReviewTurnActive
    ? aiReviewLiveLabel || t("Agent 正在修改右侧页面")
    : terminalPresentation?.action
      ? terminalPresentation.action
    : currentAction || activeStage?.detail || actionByPhase[phase] || t("正在同步生成状态");
  $("editor-generation-output").textContent = terminalPresentation?.output || (pageCount
    ? t(`已写入 {p0} 页`, { p0: pageCount })
    : t("尚未写入页面"));
  const indicator = $("editor-generation-indicator");
  const detailEl = $("editor-generation-detail");
  if (indicator) {
    indicator.classList.toggle("is-running", active);
    indicator.classList.toggle("is-complete", phase === "complete");
    indicator.classList.toggle("is-attention", phase === "paused" || phase === "failed" || phase === "cancelled");
  }
  if (detailEl) {
    detailEl.textContent = terminalPresentation?.detail || (phase === "complete"
      ? t(`文稿生成完成 · 共 {p0} 页`, { p0: pageCount })
      : phase === "paused"
        ? current.error?.detail || t("生成已暂停 · 可继续或手动编辑")
        : phase === "failed"
          ? current.error?.detail || t("生成未完成 · 请重试")
          : phase === "cancelled"
            ? t("生成任务已取消")
            : disconnected
              ? t("连接中断，正在重连…")
              : currentAction || activeStage?.detail || actionByPhase[phase] || t("AI 正在生成文稿…"));
  }
  $("editor-generation-event-count").textContent = events.length ? t(`· {p0} 条`, { p0: events.length }) : "";
  paintThinkStatus(
    locked
      ? (pendingQuestion ? t("等待你的回答") : workAgentSubmitPending ? t("正在思考") : activeWorkspaceReviewControl?.stage || (currentAction && /思考|阅读|写入|检查|准备/.test(currentAction) ? currentAction : t("正在思考")))
      : "",
    locked,
  );
  // better-display protocol: while the turn is open, the LATEST thought stays
  // expanded and following; it collapses when a newer one arrives or the
  // session settles. Open state is therefore computed per paint, above the
  // per-row updates, so the latest card is open when its first real prefix arrives.
  const liveNow = locked || active;
  generationLiveThoughtKey = liveNow
    ? [...processRows].reverse().find((row) => row.kind === "thought" || row.kind === "reasoning")?.key ?? null
    : null;
  reconcileGenerationProcess(processRows, locked || active);
  const eventDetails = $("editor-generation-events");
  if (eventDetails && processRows.length) eventDetails.open = true;
  const eventLabel = $("editor-generation-event-label");
  if (eventLabel) eventLabel.textContent = eventDetails?.open ? t("收起生成过程") : t("生成过程");
  empty?.toggleAttribute("hidden", locked || processRows.length > 0 || !emptyIsOnlyThreadContent);
  const form = $("work-form");
  if (form) form.hidden = false;
  const sendButton = document.querySelector("#work-form .composer-send");
  const composerBrief = $("work-brief")?.value.trim() || "";
  if (sendButton) {
    const stopping = locked && !composerBrief && !generationStopPending;
    sendButton.disabled = Boolean(generationStopPending || workAgentSubmitPending);
    sendButton.classList.toggle("is-stopping", stopping);
    sendButton.title = pendingQuestion && composerBrief ? t("回答问题") : locked ? (composerBrief ? t("发送补充") : t("停止生成")) : selectedCommentEntries().length ? t(`发送 {p0} 条批注`, { p0: selectedCommentEntries().length }) : t("发送消息");
    sendButton.setAttribute("aria-label", sendButton.title);
    // The composer square is the ONE stop entry (generation and review turns
    // alike), so it carries the existing stop control id while it stops.
    if (stopping) sendButton.dataset.control = "chrome.workspace.stop";
    else sendButton.dataset.control = "chrome.workspace.assistant.send";
  }
  const briefInput = $("work-brief");
  if (briefInput) {
    briefInput.disabled = false;
    briefInput.readOnly = false;
    briefInput.placeholder = pendingQuestion
      ? t("也可以在这里直接回答…") : resumeActionable
      ? t("纠偏说明（可选），随「继续完成生成」一起发送") : locked
      ? (discussion ? t("助手正在回复，你可以先写下一个问题") : t("输入补充要求…"))
      : selectedCommentEntries().length ? t("补充要求（选填），或直接发送批注") : t("聊想法，或描述想修改的内容…");
  }
  const lockNote = $("work-generation-lock");
  if (lockNote) {
    lockNote.hidden = true;
    lockNote.textContent = locked
      ? t("生成尚未结束。右侧只展示已通过检查的页面；完成后才开放 Agent 修改与编辑工具。")
      : "";
  }
  if ($("notes-text")) $("notes-text").disabled = false;
  paintWorkAgentTarget();
  if ($("chat-close")) $("chat-close").disabled = false;
  void paintAssistantModel(current);
}

async function refreshLiveGeneratedProject(activity, force = false) {
  if (aiReviewTurnActive || !activity?.sessionId || (!force && !liveGenerationRoute() && activity.conversation?.mode !== "generate")) return;
  const pages = Array.isArray(activity.inspection?.pages) ? activity.inspection.pages : [];
  const revision = JSON.stringify({
    title: activity.project?.title || "",
    path: activity.project?.path || "",
    pageCount: Number(activity.project?.pageCount) || pages.length,
    pagePaths: Array.isArray(activity.project?.pagePaths) ? activity.project.pagePaths : [],
    pages: pages.map((page) => [page.pageId, page.revision, page.pageSha256]),
  });
  if (!revision || revision === generationRenderedRevision) return;
  const project = new URLSearchParams(location.search).get("project") || activity.project?.path;
  const data = await api("/api/open", {
    method: "POST",
    body: JSON.stringify({ path: project, page: model?.pageIndex ?? 0 }),
  });
  model = data.model;
  thumbs = data.thumbs || thumbs;
  generationRenderedRevision = revision;
  render();
  await refreshVersions();
}

async function refreshGenerationResumeAvailability(activity = generationActivity) {
  const requestId = ++generationResumeEligibilityRequest;
  const routeSessionId = liveGenerationSessionId();
  const sessionId = String(activity?.sessionId || routeSessionId || "");
  if (generationResumePending || !routeSessionId) {
    paintEditorGeneration(activity);
    return;
  }
  if (sessionId && routeSessionId !== sessionId) {
    paintEditorGeneration(activity);
    return;
  }
  try {
    const response = await fetch(`/slides/state/${encodeURIComponent(routeSessionId)}`);
    const state = await response.json();
    if (!response.ok) throw new Error(state?.error || t("无法读取生成会话状态"));
    if (requestId !== generationResumeEligibilityRequest || generationResumePending) return;
    lastGenerationState = state;
    generationResumeVerifiedSessionId = generationStateCanResume(state, routeSessionId) ? routeSessionId : "";
  } catch {
    if (requestId !== generationResumeEligibilityRequest || generationResumePending) return;
    generationResumeVerifiedSessionId = "";
  }
  paintEditorGeneration(activity);
}

function generationStateSessionId(state = {}) {
  return String(state?.inspection?.sessionId || state?.binding?.dshSessionId || state?.binding?.sessionId || "");
}

async function loadGenerationRoster() {
  if (generationRoster) return generationRoster;
  const response = await fetch("/slides/providers");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || t("无法读取可用模型"));
  generationRoster = parseProviderRoster(data);
  return generationRoster;
}

// A paused/failed run offers one recovery path: the 继续完成生成 row at the end of
// the timeline. Steering text and model choice ride the shared composer
// (#work-brief / #assistant-model), so resume needs no form of its own.
function generationResumeActionable(current) {
  if (!current) return false;
  const discussion = current.conversation?.mode === "discuss";
  const editing = current.conversation?.mode === "edit";
  const phase = current.phase || "idle";
  if (discussion || editing || phase === "discussion" || generationIsActive(current) || assistantTurnPending) return false;
  const candidate = generationResumeCandidate(current) || generationResumeCandidate({
    ...current,
    execution: lastGenerationState?.execution,
    sessionId: current.sessionId || lastGenerationState?.binding?.dshSessionId,
    phase: lastGenerationState?.phase?.kind || current.phase,
  });
  const modeContinue = generationComposerMode({
    agentStatus: lastGenerationState?.agentStatus,
    execution: lastGenerationState?.execution || current.execution,
  }) === "continue";
  if (!(candidate || modeContinue)) return false;
  const samePending = generationResumePending && current.sessionId;
  const sameUncertain = generationResumeUncertainSessionId === current.sessionId;
  const ready = generationResumeVerifiedSessionId === current.sessionId
    || (modeContinue && lastGenerationState?.agentStatus === "idle");
  return Boolean(samePending || sameUncertain || ready);
}

function generationStatePhase(state = {}) {
  return String(state?.phase?.kind || state?.phase || "");
}

async function readGenerationResumeState(sessionId) {
  const response = await fetch(`/slides/state/${encodeURIComponent(sessionId)}`);
  const state = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(state?.error || t("无法读取生成会话状态"));
  return state;
}

async function waitForGenerationResume(sessionId, baselineSignature, { startTimeoutMs = 45_000 } = {}) {
  const startedAt = Date.now();
  const hardTimeoutMs = 20 * 60 * 1000;
  let sawStart = false;
  while (Date.now() - startedAt < hardTimeoutMs) {
    const [stateResult, activityResult] = await Promise.allSettled([
      readGenerationResumeState(sessionId),
      api(generationActivityUrl(sessionId)),
    ]);
    const state = stateResult.status === "fulfilled" ? stateResult.value : null;
    const activity = activityResult.status === "fulfilled" ? activityResult.value : null;
    if (state && generationStateSessionId(state) !== sessionId) {
      throw new Error(t("生成会话已切换，停止等待继续任务"));
    }
    if (activity?.sessionId === sessionId) {
      const signature = generationActivityProgressSignature(activity);
      sawStart ||= Boolean(signature && signature !== baselineSignature);
      sawStart ||= generationIsActive(activity);
      generationActivity = activity;
      paintEditorGeneration(activity);
    }
    if (state) {
      sawStart ||= Boolean(state.agentStatus && state.agentStatus !== "idle");
      const statePhase = generationStatePhase(state);
      const terminal = state.agentStatus === "idle" && GENERATION_TERMINAL_PHASES.has(statePhase);
      const activityTerminal = activity?.sessionId === sessionId && GENERATION_TERMINAL_PHASES.has(activity.phase);
      if (sawStart && terminal && activityTerminal) {
        try {
          await refreshLiveGeneratedProject(activity, true);
        } catch {
          // The terminal session state is authoritative. A canvas refresh can
          // be retried by reopening the page without making another turn.
        }
        return activity;
      }
    }
    if (!sawStart && Date.now() - startedAt >= startTimeoutMs) {
      const error = new Error(t("无法确认继续请求是否已发送；请刷新页面重新读取会话状态，当前不会重复提交。"));
      error.code = "GENERATION_RESUME_UNCONFIRMED";
      throw error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, sawStart ? 1200 : 600));
  }
  const error = new Error(t("继续生成超过最长等待时间；请刷新页面检查会话状态，当前不会重复提交。"));
  error.code = "GENERATION_RESUME_UNCONFIRMED";
  throw error;
}

function finishGenerationResume(terminal) {
  generationResumePending = false;
  generationResumeUncertainSessionId = "";
  generationResumeVerifiedSessionId = "";
  generationActivity = terminal;
  paintEditorGeneration(terminal);
  void refreshGenerationResumeAvailability(terminal);
  showToast(terminal.phase === "complete" ? t("生成收尾已完成。") : t("继续任务已结束，请检查收尾状态。"), 5000);
}

async function resumeGeneration() {
  const activity = generationActivity;
  const routeSessionId = liveGenerationSessionId();
  const sessionId = String(activity?.sessionId || lastGenerationState?.binding?.dshSessionId || routeSessionId || "");
  const canContinue = generationResumeCandidate(activity)
    || generationResumeCandidate({
      ...activity,
      execution: lastGenerationState?.execution,
      sessionId,
      phase: lastGenerationState?.phase?.kind || activity?.phase,
    })
    || (lastGenerationState?.agentStatus === "idle" && lastGenerationState?.execution?.recovery?.kind === "continue");
  if (
    generationResumePending ||
    generationResumeUncertainSessionId ||
    !routeSessionId ||
    (sessionId && routeSessionId !== sessionId) ||
    !canContinue
  ) return;
  clearTimeout(generationPollTimer);
  generationResumePending = true;
  generationResumeVerifiedSessionId = "";
  paintEditorGeneration(activity);
  const baselineSignature = generationActivityProgressSignature(activity);
  let requestOutcomeUnknown = false;
  try {
    const state = await readGenerationResumeState(sessionId);
    lastGenerationState = state;
    if (state.agentStatus !== "idle") {
      throw new Error(t("当前会话尚未空闲。请先停止并等待确认后再继续。"));
    }
    if (!generationStateCanResume(state, sessionId)) {
      throw new Error(t("当前会话不再处于可继续的空闲状态，请刷新后检查最新进度。"));
    }
    const steer = String($("work-brief")?.value || "").trim();
    const modelSelection = assistantModelSelection();
    const response = await fetch(`/slides/sessions/${encodeURIComponent(sessionId)}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildGenerationTurnRequest({
        instruction: steer || generationResumeInstruction(state),
        resumeGeneration: true,
        modelSelection,
        expectedAttemptId: state.attemptId || state.execution?.attemptId,
        currentModel: currentModelFromState(state),
      })),
    }).catch((error) => {
      requestOutcomeUnknown = true;
      throw error;
    });
    const result = await response.json().catch(() => {
      requestOutcomeUnknown = true;
      return {};
    });
    if (!response.ok || result?.ok !== true) {
      throw new Error(result?.error || t("生成会话没有接受继续请求"));
    }
    if (steer) acknowledgeAssistantDraft(steer);
    const terminal = await waitForGenerationResume(sessionId, baselineSignature);
    finishGenerationResume(terminal);
  } catch (caughtError) {
    let error = caughtError;
    if (requestOutcomeUnknown) {
      generationResumePending = false;
      generationResumeUncertainSessionId = sessionId;
      paintEditorGeneration(generationActivity);
      try {
        const terminal = await waitForGenerationResume(sessionId, baselineSignature, { startTimeoutMs: 15_000 });
        finishGenerationResume(terminal);
        return;
      } catch (reconcileError) {
        error = reconcileError;
      }
    }
    generationResumePending = false;
    const uncertain = requestOutcomeUnknown || error?.code === "GENERATION_RESUME_UNCONFIRMED";
    generationResumeUncertainSessionId = uncertain ? sessionId : "";
    paintEditorGeneration(generationActivity);
    if (!uncertain) void refreshGenerationResumeAvailability(generationActivity);
    showToast(error instanceof Error ? error.message : String(error), 7000);
  }
}

function generationLiveOpen() {
  return generationLiveSource?.readyState === 1;
}

function adoptPolledGenerationActivity(polled) {
  mergeAcknowledgedCommentTurns(polled);
  generationActivity = generationLiveBuffer && polled.sessionId === generationLiveSession
    ? generationLiveBuffer.merge(polled, { connected: generationLiveOpen() }) : polled;
}

function closeGenerationLive() {
  generationLiveSource?.close();
  generationLiveSource = null;
  cancelAnimationFrame(generationLivePaint);
  generationLivePaint = 0;
}
window.addEventListener("pagehide", closeGenerationLive);

function connectGenerationLive() {
  const sessionId = liveGenerationSessionId();
  // Raster workers open the bare editor and wait for network idle. Only a
  // collaboration workspace owns a persistent event stream.
  const workspace = new URLSearchParams(location.search).get("workspace") === "1";
  if (!sessionId || (!workspace && !liveGenerationRoute()) || typeof EventSource === "undefined") {
    closeGenerationLive();
    return;
  }
  if (generationLiveSession !== sessionId) {
    closeGenerationLive();
    generationLiveSession = sessionId;
    generationLiveBuffer = createGenerationLiveBuffer(sessionId);
  }
  if (generationLiveSource && generationLiveSource.readyState !== 2) return;
  closeGenerationLive();
  const source = new EventSource(`/slides/sessions/${encodeURIComponent(sessionId)}/events`);
  generationLiveSource = source;
  source.onmessage = (event) => {
    if (source !== generationLiveSource) return;
    try {
      const data = JSON.parse(event.data);
      if (!generationLiveBuffer.accept(data)) return;
      if (!generationLivePaint) generationLivePaint = requestAnimationFrame(() => {
        generationLivePaint = 0;
        generationActivity = generationLiveBuffer.merge(generationActivity || {});
        paintEditorGeneration(generationActivity);
      });
    } catch {
      // An invalid transport frame never alters the durable project.
    }
  };
}

async function pollGenerationActivity() {
  clearTimeout(generationPollTimer);
  if (new URLSearchParams(location.search).get("render") === "1") return;
  // While a Create launch is still binding, there is no session of ours yet;
  // polling now would paint whichever session the server ran last.
  if (new URLSearchParams(location.search).has("launch")) return;
  try {
    connectGenerationLive();
    let activity = await api(generationActivityUrl());
    if (activity.sessionId) {
      const response = await fetch(`/slides/state/${encodeURIComponent(activity.sessionId)}`);
      if (!response.ok) throw new Error(t("无法确认助手状态"));
      const state = await response.json();
      lastGenerationState = state;
      if (state.agentStatus === "idle") assistantTurnPending = false;
      activity = settledAssistantActivity(activity, state.agentStatus);
    }
    void resumePendingWorkspaceEdit(activity);
    mergeAcknowledgedCommentTurns(activity);
    const latestMessage = activity.conversation?.messages?.at(-1);
    const latestReview = acceptedReviewSubmissions(activity).find(item => item.id === latestMessage?.reviewSubmissionId);
    if (latestReview) {
      activity.phase = latestReview.status === "running" ? "reviewing" : latestReview.status === "applied" ? "edited" : latestReview.status === "cancelled" ? "cancelled" : "failed";
      activity.error = latestReview.status === "failed" ? { detail: latestReview.error || t("这次修改未完成，可以在原消息下重试。") } : undefined;
    }
    generationPollFailures = 0;
    adoptPolledGenerationActivity(activity);
    renderCommentBatchChip();
    paintEditorGeneration(generationActivity);
    await refreshLiveGeneratedProject(generationActivity);
    await refreshGenerationResumeAvailability(generationActivity);
    if (generationResumePending || generationResumeUncertainSessionId === activity?.sessionId) {
      return;
    }
    if (generationIsActive(activity) || assistantTurnPending || readPendingWorkspaceEdit()) {
      generationPollTimer = window.setTimeout(pollGenerationActivity, generationLiveOpen() ? 4000 : 260);
    } else if (generationResumeCandidate(activity)) {
      // A paused or failed partial run may become resumable after its current
      // Host turn settles; keep watching without holding the editor lock.
      generationPollTimer = window.setTimeout(pollGenerationActivity, 4000);
    }
  } catch (error) {
    console.warn("Generation activity refresh failed:", error instanceof Error ? error.message : String(error));
    generationPollFailures += 1;
    generationActivity = {
      ...(generationActivity || {}),
      connectionState: "disconnected",
      error: {
        detail: t("生成状态暂时不可用；编辑仍受保护，正在重连并等待本次会话的最终状态。"),
      },
    };
    paintEditorGeneration(generationActivity);
    const delay = Math.min(10_000, 1200 * 2 ** Math.min(generationPollFailures - 1, 4));
    generationPollTimer = window.setTimeout(pollGenerationActivity, delay);
  }
}

function pageRevisionSnapshot(snapshot) {
  return new Map((snapshot?.inspection?.pages || []).map((page) => [
    page.pageId,
    { revision: page.revision, pageSha256: page.pageSha256 },
  ]));
}

function pageRevisionBaseline(snapshot, target) {
  const baseline = pageRevisionSnapshot(snapshot);
  for (const page of target?.lockedTargetPages || []) {
    if (!page?.pageId) continue;
    baseline.set(page.pageId, { revision: page.revision, pageSha256: page.pageSha256 });
  }
  return baseline;
}

function requiresEveryTargetPage(target) {
  // Structural edits change the page list, not every baseline page; a rewrite
  // replaces the list wholesale so "every baseline page changed" is not the bar.
  return !target?.structureOnly && !target?.rewrite && (target?.scope === "deck" || target?.scope === "pages");
}

function pageRevisionChanged(beforePages, afterPages, pageId) {
  const previous = beforePages.get(pageId);
  const current = afterPages.get(pageId);
  return Boolean(
    previous && current &&
    (previous.revision !== current.revision || previous.pageSha256 !== current.pageSha256),
  );
}

async function refreshAiReviewCanvas(snapshot, previousSnapshot, baselineSnapshot, target, updateStage) {
  const beforePages = previousSnapshot === baselineSnapshot
    ? pageRevisionBaseline(previousSnapshot, target)
    : pageRevisionSnapshot(previousSnapshot);
  const afterPages = pageRevisionSnapshot(snapshot);
  const newlyChanged = target?.structureOnly
    ? [
        ...[...afterPages.keys()].filter((pageId) => !beforePages.has(pageId)),
        ...(target.editablePageIds ?? []).filter((pageId) => pageRevisionChanged(beforePages, afterPages, pageId)),
      ]
    : target?.rewrite
      // A rewrite replaces the page list — any delta is progress.
      ? [
          ...[...afterPages.keys()].filter((pageId) => !beforePages.has(pageId)),
          ...[...afterPages.keys()].filter((pageId) => pageRevisionChanged(beforePages, afterPages, pageId)),
          ...[...beforePages.keys()].filter((pageId) => !afterPages.has(pageId)),
        ]
      : target.targetPageIds.filter((pageId) => pageRevisionChanged(beforePages, afterPages, pageId));
  if (!newlyChanged.length) return;
  const pageId = newlyChanged.at(-1);
  const pagePath = target.pagePaths.find((entry) => pageIdFromPath(entry) === pageId) || target.pagePath;
  const pageIndex = Math.max(0, (model?.pagePaths || []).indexOf(pagePath));
  const project = new URLSearchParams(location.search).get("project") || generationActivity?.project?.path;
  const opened = await api("/api/open", {
    method: "POST",
    body: JSON.stringify({ path: project, page: pageIndex }),
  });
  model = opened.model;
  thumbs = opened.thumbs || thumbs;
  render();
  const currentPages = pageRevisionSnapshot(snapshot);
  const changedCount = target.targetPageIds.filter((id) => pageRevisionChanged(pageRevisionBaseline(baselineSnapshot, target), currentPages, id)).length;
  updateStage?.(t("DSH Agent 正在修改"), requiresEveryTargetPage(target) ? t(`{p0}/{p1} 页已实时更新`, { p0: changedCount, p1: target.targetPageIds.length }) : target.label);
}

function aiReviewError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function waitForAiReviewTurn(sessionId, before, target, updateStage, control) {
  let started = Date.now();
  let polledAt = started;
  let waitingForAnswer = false;
  let unavailableSince = 0;
  let sawBusy = false;
  const beforePages = pageRevisionBaseline(before, target);
  let previousSnapshot = before;
  const targetPageIds = target.targetPageIds;
  const hardTimeoutMs = requiresEveryTargetPage(target) ? 20 * 60 * 1000 : 4 * 60 * 1000;
  const stalledTimeoutMs = requiresEveryTargetPage(target) ? 3 * 60 * 1000 : 2 * 60 * 1000;
  let lastProgressAt = started;
  let previousChangedCount = 0;
  let journalSignature = generationActivityProgressSignature(generationActivity);
  while (Date.now() - started < hardTimeoutMs && Date.now() - lastProgressAt < stalledTimeoutMs) {
    if (control?.cancelRequested) {
      throw aiReviewError("AI_USER_CANCELLED", t("已取消这次 Agent 修改"));
    }
    let snap;
    try {
      const response = await fetch(`/slides/state/${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(8000) });
      if ([408, 502, 503, 504].includes(response.status)) throw aiReviewError("AI_STATE_UNAVAILABLE", t("暂时连接不上助手，正在重连"));
      snap = await response.json();
      if (!response.ok) throw new Error(snap.error || t("无法读取 AI 修改进度"));
    } catch (error) {
      const transient = error?.code === "AI_STATE_UNAVAILABLE" || error instanceof TypeError || ["AbortError", "TimeoutError"].includes(error?.name);
      if (!transient) throw error;
      unavailableSince ||= Date.now();
      if (Date.now() - unavailableSince >= 30_000) throw aiReviewError("AI_STATE_UNAVAILABLE", t("持续无法确认助手状态，正在停止并恢复修改前版本"));
      updateStage?.(t("正在重连助手"), t("文稿仍受保护"));
      await new Promise(resolve => setTimeout(resolve, 1200));
      continue;
    }
    if (unavailableSince) updateStage?.(t("DSH Agent 正在修改"), target.label);
    unavailableSince = 0;
    lastGenerationState = snap;
    const now = Date.now();
    if (waitingForAnswer || snap.questions?.some(question => question.status === "pending")) {
      started += now - polledAt;
      lastProgressAt = now;
    }
    waitingForAnswer = Boolean(snap.questions?.some(question => question.status === "pending"));
    polledAt = now;
    sawBusy ||= snap.agentStatus === "busy";
    if (snap.phase?.kind === "failed") {
      throw aiReviewError("AI_TURN_FAILED", snap.phase?.error?.detail || t("AI 修改失败"));
    }
    if (snap.phase?.kind === "paused") {
      throw aiReviewError("AI_TURN_PAUSED", snap.phase?.detail || t("AI 修改已暂停"));
    }
    const afterPages = pageRevisionSnapshot(snap);
    // A structural turn is proven by new pageIds appearing plus, for compound
    // turns, revision moves on whitelisted pages, authorized removals, and
    // (for reorder turns) a manifest order change that moves no content at all.
    const pageOrderOf = (state) => state?.inspection?.pageOrder || (state?.inspection?.pages || []).map((p) => p.pageId);
    const reorderApplied = Boolean(target?.reorderPageIds?.length) &&
      JSON.stringify(pageOrderOf(snap)) !== JSON.stringify(pageOrderOf(before));
    const changedTargetPageIds = target?.structureOnly
      ? [
          ...[...afterPages.keys()].filter((pageId) => !beforePages.has(pageId)),
          ...(target.editablePageIds ?? []).filter((pageId) => pageRevisionChanged(beforePages, afterPages, pageId)),
          ...(target.deletablePageIds ?? []).filter((pageId) => beforePages.has(pageId) && !afterPages.has(pageId)),
          ...(reorderApplied ? target.reorderPageIds.filter((pageId) => afterPages.has(pageId)) : []),
        ]
      : target?.rewrite
        // Any visible delta — added, changed, removed or reordered pages —
        // counts as progress on a rewrite; the verify step pins the result to
        // the committed plan.
        ? [
            ...[...afterPages.keys()].filter((pageId) => !beforePages.has(pageId)),
            ...[...afterPages.keys()].filter((pageId) => pageRevisionChanged(beforePages, afterPages, pageId)),
            ...[...beforePages.keys()].filter((pageId) => !afterPages.has(pageId)),
            ...(JSON.stringify(pageOrderOf(snap)) !== JSON.stringify(pageOrderOf(before)) ? ["__order__"] : []),
          ]
        : targetPageIds.filter((pageId) => pageRevisionChanged(beforePages, afterPages, pageId));
    if (changedTargetPageIds.length > previousChangedCount) {
      previousChangedCount = changedTargetPageIds.length;
      lastProgressAt = Date.now();
    }
    try {
      const activity = await api(generationActivityUrl());
      if (activity?.sessionId === sessionId) {
        const nextJournalSignature = generationActivityProgressSignature(activity);
        if (nextJournalSignature && nextJournalSignature !== journalSignature) {
          lastProgressAt = Date.now();
        }
        journalSignature = nextJournalSignature;
        generationActivity = activity;
        paintEditorGeneration(activity);
      }
    } catch {
      // Session state remains authoritative; a temporary journal read failure
      // must not abort or falsely prolong the protected edit turn.
    }
    await refreshAiReviewCanvas(snap, previousSnapshot, before, target, updateStage);
    previousSnapshot = snap;
    if (snap.agentStatus === "idle" && (sawBusy || changedTargetPageIds.length)) {
      // A metadata-only turn (rename/theme) moves no page revision — let the
      // server verify decide from deckMetaFields instead of a page delta.
      if (!changedTargetPageIds.length && !target?.editableMeta?.length) {
        throw aiReviewError("AI_NO_CHANGE", t("AI 已结束，但目标范围没有产生可验证的修改"));
      }
      const unrelated = new Set([...beforePages.keys(), ...afterPages.keys()]);
      targetPageIds.forEach((pageId) => unrelated.delete(pageId));
      // A rewrite lock authorizes every page — there is no "outside target".
      const changedOutsideTarget = target?.rewrite ? [] : target?.structureOnly
        // Under a structural lock every baseline page outside the whitelists
        // must stay identical: deletablePageIds are expected to disappear,
        // editablePageIds may change, anything else is a violation.
        ? [...beforePages.keys()].filter((pageId) => {
            if (target.editablePageIds?.includes(pageId)) return false;
            const previous = beforePages.get(pageId);
            const current = afterPages.get(pageId);
            if (!current) return !target.deletablePageIds?.includes(pageId);
            return previous.revision !== current.revision || previous.pageSha256 !== current.pageSha256;
          })
        : [...unrelated].filter((pageId) => {
            const previous = beforePages.get(pageId);
            const current = afterPages.get(pageId);
            return !previous || !current || previous.revision !== current.revision || previous.pageSha256 !== current.pageSha256;
          });
      if (changedOutsideTarget.length) {
        throw aiReviewError(
          "AI_SCOPE_VIOLATION",
          t(`AI 同时改动了非目标页面：{p0}；正在恢复到修改前版本`, { p0: changedOutsideTarget.join("、") }),
        );
      }
      if (requiresEveryTargetPage(target) && changedTargetPageIds.length !== targetPageIds.length) {
        const missing = targetPageIds.filter((pageId) => !changedTargetPageIds.includes(pageId));
        return { snapshot: snap, changedPageIds: changedTargetPageIds, missingPageIds: missing };
      }
      return { snapshot: snap, changedPageIds: changedTargetPageIds, missingPageIds: [] };
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  throw aiReviewError(
    "AI_STILL_RUNNING",
    Date.now() - lastProgressAt >= stalledTimeoutMs
      ? t(`Agent 已连续 {p0} 分钟没有产生新的可验证页面；文稿继续保持写入保护`, { p0: Math.round(stalledTimeoutMs / 60_000) })
      : t(`Agent 修改超过{p0}的最长保护时间；文稿继续保持写入保护`, { p0: target.scope === "deck" ? t("整份文稿") : t("目标范围") }),
  );
}

async function restoreAiReviewSnapshot(versionId, aiLockToken) {
  if (!aiLockToken) throw aiReviewError("AI_RESTORE_LOCK_MISSING", t("AI 版本保护令牌缺失，拒绝恢复版本"));
  const data = await api("/api/versions/restore", {
    method: "POST",
    body: JSON.stringify({ id: versionId, lockToken: aiLockToken }),
  });
  model = data.model;
  thumbs = data.thumbs || thumbs;
  versions = data.versions || versions;
  generationRenderedRevision = "";
  render();
  await refreshVersions();
}

async function renewAiReviewLock(aiLockToken) {
  if (!aiLockToken) throw aiReviewError("AI_RENEW_LOCK_MISSING", t("AI 版本保护令牌缺失，拒绝续租版本保护"));
  return api("/api/reviews/ai-lock/renew", {
    method: "POST",
    body: JSON.stringify({ token: aiLockToken }),
  });
}

async function stopAiReviewTurn(sessionId) {
  if (!sessionId) throw aiReviewError("AI_STOP_UNCONFIRMED", t("无法确认 AI 会话已停止"));
  // An explicit JSON body: the kernel guard rejects untyped mutations.
  const response = await fetch(`/slides/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok !== true || result?.stopped === false) {
    throw aiReviewError(
      "AI_STOP_UNCONFIRMED",
      result?.error || t("AI 停止尚未得到服务端确认"),
    );
  }
  return result;
}

async function refreshAiReviewCommentAfterRestore(comment, pagePath) {
  const data = await api(`/api/reviews?pagePath=${encodeURIComponent(pagePath)}&project=${encodeURIComponent(currentProjectPath())}`);
  const latest = Array.isArray(data?.comments)
    ? data.comments.find((entry) => entry?.id === comment.id)
    : undefined;
  if (!latest) {
    throw aiReviewError(
      "AI_RESTORE_COMMENT_MISSING",
      t("版本已恢复，但找不到当前批注的最新记录；为避免覆盖协作内容，仍保持锁定"),
    );
  }
  Object.assign(comment, latest);
  return latest;
}

async function startCommentBatchReview(comments, { brief = "", onAccepted } = {}) {
  const items = (Array.isArray(comments) ? comments : [])
    .filter((comment) => comment && typeof comment.id === "string" && comment.id.trim());
  if (!items.length) throw new Error(t("没有可提交的批注"));

  const cancelControl = {
    commentId: items[0].id,
    commentIds: items.map((comment) => comment.id),
    sessionId: "",
    cancelRequested: false,
  };
  let sessionId = "";
  let aiLockToken = "";
  let snapshotId = "";
  let turnMayHaveStarted = false;
  let restored = false;
  let releaseAiLock = false;
  let keepAiLock = false;
  let aiLockRenewTimer = 0;
  let aiLockRenewUncertain = false;
  let applied = false;
  const reviewPagePaths = [];

  const renewCurrentAiLock = async () => {
    const renewed = await renewAiReviewLock(aiLockToken);
    // A successful request re-establishes the server-side lease, so an earlier
    // transient failure is no longer an uncertainty.
    aiLockRenewUncertain = false;
    return renewed;
  };
  activeCommentReviewControl = cancelControl;
  setAiReviewTurnActive(true);
  showWorkChat({ focusComposer: false });
  try {
    await commentSaveTail;
    const activity = generationActivity || await api(generationActivityUrl());
    generationActivity = activity;
    captureAiReviewEventBaseline(activity);
    sessionId = activity?.sessionId || new URLSearchParams(location.search).get("session") || "";
    cancelControl.sessionId = sessionId;
    if (!sessionId) throw new Error(NO_AI_SESSION_MESSAGE);
    const stateResponse = await fetch(`/slides/state/${encodeURIComponent(sessionId)}`);
    const before = await stateResponse.json();
    if (!stateResponse.ok) throw new Error(before.error || t("无法连接 AI 生成会话"));
    if (before.agentStatus !== "idle") {
      throw aiReviewError("AI_SESSION_BUSY", t("AI 正在生成或处理其他任务；请等当前任务完成后再提交这批批注"));
    }

    const requested = items.map((comment) => ({
      pagePath: comment.pagePath || model?.pagePaths?.[model?.pageIndex ?? 0] || "",
      commentId: comment.id,
      commentRevision: Number(comment.revision) || 0,
    }));
    if (requested.some((item) => !item.pagePath)) {
      throw new Error(t("有批注找不到所属页面，未提交"));
    }
    requested.forEach((item) => reviewPagePaths.push(item.pagePath));

    const lock = await api("/api/reviews/ai-lock/batch", {
      method: "POST",
      body: JSON.stringify({ project: currentProjectPath(), items: requested, brief }),
    }).catch((error) => {
      // A stale batch is refused before anything is marked running; tell the
      // user exactly which comments moved on.
      if (error?.code === "REVIEW_BATCH_CONFLICT" && Array.isArray(error?.stale)) {
        const names = error.stale
          .map((entry) => items.find((comment) => comment.id === entry.commentId))
          .filter(Boolean)
          .map((comment) => (comment.text || comment.id).slice(0, 18));
        throw aiReviewError("REVIEW_BATCH_CONFLICT", t(`这些批注指向的内容已经变了，请复核后再提交：{p0}`, { p0: names.join("、") }));
      }
      throw error;
    });
    aiLockToken = String(lock?.token || "");
    const lockedItems = Array.isArray(lock?.items) ? lock.items : [];
    if (!aiLockToken || lockedItems.length !== items.length) {
      throw new Error(t("无法保护这批批注的目标版本，未提交"));
    }
    for (const item of lockedItems) {
      if (
        !item.pageId ||
        !Number.isSafeInteger(item.pageRevision) ||
        item.pageRevision < 1 ||
        !/^[a-f0-9]{64}$/i.test(String(item.pageSha256 || "")) ||
        !Number.isInteger(item.commentRevision)
      ) {
        throw new Error(t("服务端没有返回可验证的批注范围，未提交"));
      }
    }
    aiLockRenewTimer = window.setInterval(() => {
      void renewCurrentAiLock().catch(() => {
        aiLockRenewUncertain = true;
      });
    }, 25_000);

    const snapshot = await api("/api/versions", {
      method: "POST",
      body: JSON.stringify({
        label: t("AI 修改前"),
        note: `ai-review-batch:${items.map((comment) => comment.id).join(",")}`,
        lockToken: aiLockToken,
      }),
    });
    snapshotId = String(snapshot?.version?.id || "");
    if (!snapshotId) throw new Error(t("无法创建 AI 修改前版本，未提交"));

    const byPage = new Map();
    for (const [index, item] of lockedItems.entries()) {
      const comment = items.find((candidate) => candidate.id === item.commentId) || {};
      const page = byPage.get(item.pageId) || {
        pageId: item.pageId,
        pagePath: item.pagePath,
        pageRevision: item.pageRevision,
        pageSha256: item.pageSha256,
        elementIds: new Set(),
        wholePage: false,
        comments: [],
      };
      if (item.kind === "elements") {
        for (const elementId of item.elementIds || []) page.elementIds.add(elementId);
      } else {
        page.wholePage = true;
      }
      page.comments.push({
        commentId: item.commentId,
        commentRevision: item.commentRevision,
        kind: item.kind,
        elementIds: [...(item.elementIds || [])],
        text: String(comment.text || "").trim() || t("（空批注）"),
        order: index,
      });
      byPage.set(item.pageId, page);
    }
    const pages = [...byPage.values()];
    const pageBlocks = pages.map((page) => {
      const target = page.wholePage
        ? "包含整页意见，可以修改这一页；每条对象意见仍对应其标记对象"
        : `只修改这些元素：${[...page.elementIds].join("、")}`;
      const lines = page.comments
        .sort((a, b) => a.order - b.order)
        .map((entry) => `  - 批注 ${JSON.stringify(entry.commentId)}（${entry.kind === "elements" ? `对象 ${entry.elementIds.join("、")}` : "整页"}）：${entry.text}`);
      return `页面 ${page.pagePath}（pageId=${JSON.stringify(page.pageId)}，revision=${page.pageRevision}，pageSha256=${page.pageSha256}）：${target}\n${lines.join("\n")}`;
    });
    const instruction = [
      brief ? `用户补充说明：${brief}` : "",
      `处理 ${lockedItems.length} 条批注，涉及 ${pages.length} 个页面。先对每个页面调用 read_page({pageId}) 读取权威页面，并从返回结果取得该页的 pageSha256。`,
      "写入时：整页批注用 write_page，并把该页 read_page 返回的 pageSha256 原样传为 expectedPageSha256；对象批注只调用 edit_elements，参数直接使用 {pageId, expectedPageSha256, elements}，不要增加 arguments 包裹，elements 必须恰好覆盖该页列出的目标元素且每项是修改后的完整 canonical 原生对象。",
      "每个页面必须使用它自己的 pageSha256；不要改动未列出的页面，不要复制整页，不要重做整份文稿，不要修改页面元数据。改完渲染并检查这些页面。",
      "",
      ...pageBlocks,
    ].filter((line) => line !== null && line !== undefined).join("\n").replace(/^\n+/, "");

    turnMayHaveStarted = true;
    const turnResponse = await fetch(`/slides/sessions/${encodeURIComponent(sessionId)}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: instruction,
        userText: [brief, ...items.map((comment, index) => t(`批注 {p0}：{p1}`, { p0: index + 1, p1: comment.text }))].filter(Boolean).join("\n"),
        modelSelection: assistantModelSelection(),
        editorEdit: {
          authorizationId: "comment-batch:" + lock.submission.id,
          pages: pages.map((page) => ({
            pageId: page.pageId,
            revision: page.pageRevision,
            pageSha256: page.pageSha256,
          })),
          reviewScope: {
            items: pages.flatMap((page) => page.comments.map((entry) => ({
              kind: entry.kind,
              pageId: page.pageId,
              elementIds: entry.kind === "elements" ? entry.elementIds : [],
              pageRevision: page.pageRevision,
              pageSha256: page.pageSha256,
              commentId: entry.commentId,
              commentRevision: entry.commentRevision,
            }))),
          },
        },
      }),
    });
    const started = await turnResponse.json();
    if (!turnResponse.ok || !started.ok) throw new Error(started.error || t("AI 没有接下这批批注"));
    onAccepted?.(started.userMessage, lock.submission);

    await waitForAiReviewTurn(sessionId, before, {
      scope: "pages",
      pageIndex: model?.pageIndex ?? 0,
      pagePath: pages[0].pagePath,
      pagePaths: pages.map((page) => page.pagePath),
      targetPageId: pages[0].pageId,
      targetPageIds: pages.map((page) => page.pageId),
      lockedTargetPages: pages.map((page) => ({
        pageId: page.pageId,
        revision: page.pageRevision,
        pageSha256: page.pageSha256,
      })),
      elementIds: [...new Set(pages.flatMap((page) => [...page.elementIds]))],
      label: t(`{p0} 条批注 · {p1} 页`, { p0: lockedItems.length, p1: pages.length }),
    }, undefined, cancelControl);

    await renewCurrentAiLock();
    const finished = await api("/api/reviews/ai-lock/batch/apply", {
      method: "POST",
      body: JSON.stringify({ project: currentProjectPath(), token: aiLockToken }),
    });
    if (!finished?.ok) throw new Error(t("AI 修改已完成，但批注状态没有写回"));
    applied = true;
    releaseAiLock = true;
    const project = new URLSearchParams(location.search).get("project") || activity.project?.path;
    const data = await api("/api/open", {
      method: "POST",
      body: JSON.stringify({ path: project, page: model?.pageIndex ?? 0 }),
    });
    model = data.model;
    thumbs = data.thumbs || thumbs;
    render();
    await refreshVersions();
    await pollGenerationActivity();
    return { ok: true, applied: lockedItems.length };
  } catch (caughtError) {
    let error = caughtError;
    if (turnMayHaveStarted && snapshotId) {
      try {
        await stopAiReviewTurn(sessionId);
        await renewCurrentAiLock();
        await restoreAiReviewSnapshot(snapshotId, aiLockToken);
        restored = true;
        if (error instanceof Error) error.message = error.message.replace(t("正在恢复修改前版本"), t("已恢复修改前版本"));
        await reloadCommentsFromServer().catch(() => undefined);
        releaseAiLock = true;
      } catch (restoreError) {
        keepAiLock = true;
        aiLockRenewUncertain = true;
        error = aiReviewError(
          "AI_STILL_LOCKED",
          t(`{p0}；{p1}。服务端保护状态不确定；未恢复版本，也未确认释放版本保护。本标签继续禁止写入。`, { p0: error instanceof Error ? error.message : String(error), p1: restoreError instanceof Error ? restoreError.message : String(restoreError) }),
        );
      }
    }
    // A failure before the turn was dispatched still holds the project lock:
    // release it (recording the reason) so the comments never stay "running"
    // and the user can fix and resubmit them.
    if (!turnMayHaveStarted && aiLockToken) {
      const message = error instanceof Error ? error.message : String(error);
      await api("/api/reviews/ai-lock/batch/cancel", {
        method: "POST",
        body: JSON.stringify({ project: currentProjectPath(), token: aiLockToken, error: message }),
      }).catch(() => undefined);
      aiLockToken = "";
      releaseAiLock = true;
      keepAiLock = false;
    }
    if (releaseAiLock && aiLockToken) {
      // Keep the comments actionable: a cancelled turn clears the running flag,
      // a failed one is recorded as retryable with its reason.
      const cancelled = error?.code === "AI_USER_CANCELLED";
      const message = error instanceof Error ? error.message : String(error);
      await api("/api/reviews/ai-lock/batch/cancel", {
        method: "POST",
        body: JSON.stringify({
          project: currentProjectPath(),
          token: aiLockToken,
          ...(cancelled ? {} : { error: message }),
        }),
      }).catch(() => undefined);
      aiLockToken = "";
    }
    throw error;
  } finally {
    if (aiLockRenewTimer) {
      window.clearInterval(aiLockRenewTimer);
      aiLockRenewTimer = 0;
    }
    if (keepAiLock) {
      renderComments();
      showToast(t("AI 修改尚未完成安全收尾；本标签继续禁止写入。"), 7000);
    }
    if (activeCommentReviewControl === cancelControl) activeCommentReviewControl = null;
    setAiReviewTurnActive(keepAiLock);
    if (!keepAiLock) {
      try {
        await reloadCommentsFromServer();
      } catch {
        renderComments();
      }
    }
    await pollGenerationActivity();
    void restored;
    void applied;
  }
}

function hideWorkChat({ restoreFocus = true } = {}) {
  const chat = $("work-chat");
  if (!chat) return;
  chat.hidden = true;
  propertyPanelAutoCollapsedForAgent = false;
  propertyPanelAgentUserOverride = false;
  updatePropertyPanel();
  $("btn-sparkles")?.setAttribute("aria-expanded", "false");
  $("btn-sparkles")?.setAttribute("aria-label", t("打开 AI 工作区"));
  if (restoreFocus) $("btn-sparkles")?.focus();
}

function showWorkChat({ focusComposer = true } = {}) {
  const chat = $("work-chat");
  if (!chat) return;
  chat.hidden = false;
  propertyPanelAgentUserOverride = false;
  propertyPanelAutoCollapsedForAgent = false;
  updatePropertyPanel();
  $("btn-sparkles")?.setAttribute("aria-expanded", "true");
  $("btn-sparkles")?.setAttribute("aria-label", t("收起 AI 工作区"));
  paintWorkAgentTarget();
  paintPersistedReason();
  void pollGenerationActivity();
  if (focusComposer) $("work-brief")?.focus();
}

for (const suggestion of document.querySelectorAll("[data-agent-prompt]")) {
  suggestion.addEventListener("click", () => {
    const brief = $("work-brief");
    if (!brief) return;
    brief.value = suggestion.getAttribute("data-agent-prompt") || "";
    paintWorkAgentTarget(brief.value);
    brief.focus();
  });
}

$("work-brief")?.addEventListener("input", (event) => paintWorkAgentTarget(event.currentTarget.value));
$("work-brief")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  $("work-form")?.requestSubmit();
});

$("editor-generation-toggle")?.addEventListener("click", () => {
  generationPanelUserToggled = true;
  generationPanelExpanded = !generationPanelExpanded;
  paintEditorGeneration(generationActivity);
});

async function waitForGenerationIdle(sessionId, { timeoutMs = 60_000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readGenerationResumeState(sessionId);
    lastGenerationState = state;
    if (generationStateSessionId(state) === sessionId && state.agentStatus === "idle") return state;
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  }
  throw new Error(t("停止后仍未确认空闲，未发送继续请求"));
}

async function stopLiveGeneration() {
  const sessionId = liveGenerationSessionId();
  if (!sessionId || generationStopPending || generationResumePending) return;
  generationStopPending = true;
  paintEditorGeneration(generationActivity);
  try {
    await stopAiReviewTurn(sessionId);
    const state = await waitForGenerationIdle(sessionId);
    generationStopPending = false;
    lastGenerationState = state;
    // Repaint from the settled session at once: the cached activity still says
    // "generating", and waiting for the next poll left ■ and 正在思考 on screen.
    await pollGenerationActivity();
    paintEditorGeneration(generationActivity);
    void refreshGenerationResumeAvailability(generationActivity);
    showToast(t("已停止并确认空闲，可以继续或换模型。"), 4000);
  } catch (error) {
    generationStopPending = false;
    paintEditorGeneration(generationActivity);
    showToast(error instanceof Error ? error.message : String(error), 7000);
  }
}

$("editor-generation-stop")?.addEventListener("click", () => {
  const control = activeWorkspaceReviewControl || activeCommentReviewControl;
  if (control) {
    if (control.cancelRequested) return;
    control.cancelRequested = true;
    paintEditorGeneration(generationActivity);
    showToast(t("正在停止 Agent 修改；确认停止后会恢复修改前版本。"), 5000);
    return;
  }
  void stopLiveGeneration();
});

$("editor-generation-resume")?.addEventListener("click", () => {
  void resumeGeneration();
});

$("editor-generation-events")?.addEventListener("toggle", (event) => {
  generationEventsUserToggled = true;
  const label = $("editor-generation-event-label");
  if (label) label.textContent = event.currentTarget.open ? t("收起完整行动记录") : t("查看完整行动记录");
});

if (new URLSearchParams(location.search).get("workspace") !== "0") {
  showWorkChat({ focusComposer: false });
}

function relTime(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return t("刚刚");
  if (sec < 3600) return t(`{p0}`, { p0: Math.floor(sec / 60) });
  if (sec < 86400) return t(`{p0}`, { p0: Math.floor(sec / 3600) });
  return t(`{p0}`, { p0: Math.floor(sec / 86400) });
}

const pendingWorkspaceEditKey = () => `slides.pending-edit:${currentProjectPath()}`;
function readPendingWorkspaceEdit() {
  try {
    const pending = JSON.parse(localStorage.getItem(pendingWorkspaceEditKey()) || "null");
    return pending?.project === currentProjectPath() && pending?.sessionId && pending?.aiLockToken && pending?.snapshotId && pending?.target?.targetPageIds?.length ? pending : null;
  } catch { return null; }
}
function persistPendingWorkspaceEdit(pending) {
  localStorage.setItem(pendingWorkspaceEditKey(), JSON.stringify(pending));
}
function clearPendingWorkspaceEdit(token) {
  if (readPendingWorkspaceEdit()?.aiLockToken === token) localStorage.removeItem(pendingWorkspaceEditKey());
}
async function runWorkAgentEdit(...args) {
  const run = () => executeWorkAgentEdit(...args);
  return navigator.locks ? navigator.locks.request(`slides.edit:${currentProjectPath()}`, run) : run();
}
async function resumePendingWorkspaceEdit(activity) {
  if (activeWorkspaceReviewControl) return;
  const pending = readPendingWorkspaceEdit();
  if (!pending || activity.sessionId !== pending.sessionId) return;
  const message = activity.conversation?.messages?.find(item => item.clientRequestId === pending.clientRequestId);
  if (!message) return; // Never resubmit an uncertain network request on refresh.
  const resume = async () => {
    if (activeWorkspaceReviewControl || readPendingWorkspaceEdit()?.aiLockToken !== pending.aiLockToken) return;
    const receipt = { project: pending.project, clientRequestId: pending.clientRequestId, message, requestText: pending.text };
    workspaceEditReceipts.set(message.id, receipt);
    const control = {cancelRequested: false, receipt, recovering: true};
    try {
      const result = await executeWorkAgentEdit(pending.text, pending.target, [], control, pending);
      Object.assign(receipt, {snapshotId: result.snapshotId, snapshotLabel: result.snapshotLabel});
    } catch (error) { failAssistantSend(receipt, error); }
    finally { workAgentSubmitPending = false; paintEditorGeneration(generationActivity); }
  };
  if (navigator.locks) await navigator.locks.request(`slides.edit:${currentProjectPath()}`, {ifAvailable: true}, lock => lock ? resume() : undefined);
  else await resume();
}

async function executeWorkAgentEdit(
  text,
  requestedTarget,
  attachments = [],
  control = { cancelRequested: false },
  recovery = null,
) {
  const target = requestedTarget;
  // Deletion is the destructive capability: before the snapshot even runs the
  // user sees exactly which pages will disappear and can still back out. A
  // recovery pass never re-asks — the answer was already given.
  if (!recovery && target.deletablePageIds?.length) {
    const ok = window.confirm(t(`{p0}：将删除页面 {p1}。删除后可通过版本历史找回，确定继续吗？`, { p0: target.label, p1: target.deletablePageIds.join("、") }));
    if (!ok) throw aiReviewError("AI_USER_CANCELLED", t("已取消删除页面"));
  }
  // A full rewrite is the strongest destructive turn: the user must see that
  // the whole deck is being replaced before the snapshot runs.
  if (!recovery && target.rewrite) {
    const ok = window.confirm(t(`{p0}：将推翻当前 {p1} 页文稿，按新大纲整体重写。重写前版本会自动存入版本历史，确定继续吗？`, { p0: target.label, p1: target.targetPageIds.length }));
    if (!ok) throw aiReviewError("AI_USER_CANCELLED", t("已取消整稿重写"));
  }
  aiReviewLiveLabel = target.label;
  const transactionId = `agent-chat-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  let snapshotId = "";
  let snapshotLabel = "";
  let turnMayHaveStarted = false;
  let restored = false;
  let sessionId = "";
  let aiLockToken = "";
  let releaseAiLock = false;
  let keepAiLock = false;
  let aiLockRenewTimer = 0;
  let aiLockRenewUncertain = false;
  let failure = null;
  let result = null;
  const updateStage = (label, detail) => {
    control.stage = [label.replace(/^DSH Agent /, ""), detail].filter(Boolean).join(" · ");
    paintEditorGeneration(generationActivity);
  };
  const renewCurrentAiLock = async () => {
    const lock = await renewAiReviewLock(aiLockToken);
    aiLockRenewUncertain = false;
    return lock;
  };

  activeWorkspaceReviewControl = control;
  setAiReviewTurnActive(true);
  try {
    let before;
    let activity;
    if (recovery) {
      ({snapshotId, snapshotLabel, sessionId, aiLockToken} = recovery);
      before = recovery.before;
      activity = generationActivity;
      turnMayHaveStarted = true;
      await renewCurrentAiLock();
      aiLockRenewTimer = window.setInterval(() => { void renewCurrentAiLock().catch(() => { aiLockRenewUncertain = true; }); }, 25_000);
      updateStage(t("正在继续本次修改"), target.label);
    } else {
    updateStage(t("保护修改前版本"), target.label);
    activity = await api(generationActivityUrl());
    generationActivity = activity;
    captureAiReviewEventBaseline(activity);
    sessionId = activity?.sessionId || new URLSearchParams(location.search).get("session") || "";
    if (!sessionId) throw aiReviewError("AI_SESSION_MISSING", t("这份文稿没有可继续对话的 DSH Agent 会话"));
    if (control.cancelRequested) throw aiReviewError("AI_USER_CANCELLED", t("已取消这次 Agent 修改"));
    const stateResponse = await fetch(`/slides/state/${encodeURIComponent(sessionId)}`);
    before = await stateResponse.json();
    if (!stateResponse.ok) throw new Error(before.error || t("无法连接 DSH Agent 会话"));
    if (before.agentStatus !== "idle") {
      throw aiReviewError("AI_SESSION_BUSY", t("Agent 正在处理其他任务；完成后再发起这次修改"));
    }
    const beforePages = pageRevisionSnapshot(before);
    let targetPages = target.targetPageIds.map((pageId) => {
      const revision = beforePages.get(pageId);
      if (!revision) throw new Error(t(`找不到 {p0} 的可验证版本，未发送修改请求`, { p0: pageId }));
      return { pageId, revision: revision.revision, pageSha256: revision.pageSha256 };
    });
    const lock = await api("/api/reviews/ai-lock", {
      method: "POST",
      body: JSON.stringify({
        project: currentProjectPath(),
        pagePath: target.pagePath,
        workspaceEdit: {
          authorizationId: transactionId,
          kind: target.scope === "meta" ? "page" : target.scope,
          pageId: target.targetPageId,
          elementIds: target.scope === "elements" ? target.elementIds : [],
          targetPages,
          requestText: text,
          ...(target.scope === "meta" ? { metaOnly: true } : {}),
          ...(target.rewrite ? { rewrite: true } : {}),
          ...(target.editableMeta?.length ? { editableMeta: target.editableMeta } : {}),
          ...(target.structureOnly ? { structureOnly: true, ...(target.insertIndex !== undefined ? { insertIndex: target.insertIndex } : {}),
            ...(target.editablePageIds?.length ? { editablePageIds: target.editablePageIds } : {}),
            ...(target.deletablePageIds?.length ? { deletablePageIds: target.deletablePageIds } : {}),
            ...(target.reorderPageIds?.length ? { reorderPageIds: target.reorderPageIds } : {}),
            ...(target.expectedAddCount ? { expectedAddCount: target.expectedAddCount } : {}) } : {}),
        },
      }),
    });
    aiLockToken = String(lock?.lock?.token || "");
    if (!aiLockToken) throw new Error(t("无法保护修改前版本，未发送修改请求"));
    const lockedTargetPages = Array.isArray(lock?.lock?.scope?.targetPages)
      ? lock.lock.scope.targetPages
      : [];
    const lockedTargetIds = lockedTargetPages.map((page) => String(page?.pageId || ""));
    const expectedTargetIds = target.targetPageIds.map(String);
    if (
      lockedTargetIds.length !== expectedTargetIds.length ||
      lockedTargetIds.some((pageId, index) => pageId !== expectedTargetIds[index]) ||
      lockedTargetPages.some((page) =>
        !Number.isSafeInteger(page?.revision) ||
        page.revision < 1 ||
        !/^[a-f0-9]{64}$/i.test(String(page?.pageSha256 || "")))
    ) {
      throw new Error(t("服务端没有返回当前文稿的可验证版本，未发送修改请求"));
    }
    targetPages = lockedTargetPages.map((page) => ({
      pageId: String(page.pageId),
      revision: page.revision,
      pageSha256: String(page.pageSha256).toLowerCase(),
    }));
    target.lockedTargetPages = targetPages;
    aiLockRenewTimer = window.setInterval(() => {
      void renewCurrentAiLock().catch(() => {
        aiLockRenewUncertain = true;
      });
    }, 25_000);

    const snapshot = await api("/api/versions", {
      method: "POST",
      body: JSON.stringify({
        label: versions.length ? t("Agent 修改前") : "V1",
        note: `agent-chat:${transactionId}:${target.scope}:${target.targetPageIds.join(",")}`,
        assistantRequestId: control.receipt?.clientRequestId,
        lockToken: aiLockToken,
      }),
    });
    snapshotId = String(snapshot?.version?.id || "");
    snapshotLabel = versionUiLabel(snapshot?.version || { id: snapshotId });
    if (!snapshotId) throw new Error(t("无法创建修改前版本，未发送修改请求"));
    if (control.cancelRequested) throw aiReviewError("AI_USER_CANCELLED", t("已取消这次 Agent 修改"));

    updateStage("DSH Agent 正在修改", target.label);
    const insertPosition = target.insertIndex === undefined ? ""
      : target.insertIndex >= target.targetPageIds.length
        ? "文稿末尾"
        : target.insertIndex <= 0
          ? "文稿最前面"
          : `第 ${target.insertIndex} 页之后、第 ${target.insertIndex + 1} 页之前`;
    const structuralActions = [
      target.insertIndex !== undefined ? `在${insertPosition}新增页面` : "",
      target.deletablePageIds?.length ? `删除页面 ${target.deletablePageIds.join("、")}` : "",
      target.reorderPageIds?.length ? `将页面顺序调整为 ${target.reorderPageIds.join("、")}` : "",
      target.editablePageIds?.length ? `允许修改现有页面 ${target.editablePageIds.join("、")}` : "",
    ].filter(Boolean).join("；");
    const metaScope = target.editableMeta?.length
      ? `本轮还授权修改文稿级字段：${target.editableMeta.map((field) => field === "title" ? "标题" : "主题").join("、")}——用 update_deck 只传这些字段，其他文稿级字段保持不变。`
      : "不得改动文稿标题和全局元数据。";
    const elementScope = target.scope === "meta"
      ? `本轮只授权修改文稿级字段：${target.editableMeta.map((field) => field === "title" ? "标题" : "主题").join("、")}——只能调用 update_deck 且只传这些字段；不得调用 write_page、edit_elements、edit_page_background 或任何页面写工具，所有页面和页面顺序必须逐字节保持不变。`
      : target.scope === "elements"
      ? `只允许修改所选元素 ${target.elementIds.join("、")}，且必须恰好覆盖这个集合；其他元素必须保持不变。`
      : target.rewrite
        ? `本轮是整稿重写：用户不满意当前文稿，新大纲将替换现有的全部 ${target.targetPageIds.length} 页（现有页面 id：${target.targetPageIds.join("、")}）。`
        : target.structureOnly
        ? `本轮只做页面结构修改：${structuralActions}。${metaScope}上述授权之外的现有页面必须逐字节保持不变，不得新增、删除或重排任何其他页面。`
        : target.scope === "deck"
          ? `整份文稿的授权页面依次为：${target.targetPageIds.join("、")}。只修改用户要求涉及且确实需要变化的内容；已经符合要求的页面可以保持不变。不得新增、删除或重排页面。${metaScope}`
          : target.scope === "pages"
            ? `只允许修改这些指定页面：${target.targetPageIds.join("、")}。其他页面必须保持不变，不得新增、删除或重排页面。${metaScope}`
          : `只允许修改当前页，其他页面必须保持不变。${metaScope}`;
    const readWriteScope = target.scope === "meta"
      ? `本轮没有页面写权限：不要调用 read_page、write_page、edit_elements、edit_page_background 或其他页面工具。直接调用 update_deck，只传授权的字段：${target.editableMeta.map((field) => field === "title" ? "title" : "theme").join("、")}；按用户原话取值，不要顺带修改其他文稿级字段。`
      : target.scope === "elements"
      ? `必须先调用 read_page({pageId:"${target.targetPageId}"}) 读取权威页面，并从返回结果取得 pageSha256；随后只调用 edit_elements，参数直接使用 {pageId, expectedPageSha256, elements}，不要增加 arguments 包裹。expectedPageSha256 必须是刚才 read_page 返回的值；elements 必须恰好包含所选元素 ${target.elementIds.join("、")} 的修改后完整 canonical 原生对象。不要复制整页、不要调用 write_page、不要传入或改动其他元素。`
      : target.rewrite
      ? `整稿重写的固定顺序：第一步调用 write_todo 提交新的大纲计划（items 数组逐项列出每页 id、标题和要点，页数和内容按用户要求重新规划，不复用旧大纲）；第二步按计划的顺序逐页调用 write_page 写出每一页——新页面 id 不传 expectedPageSha256，重写保留的现有页面必须先 read_page 取得最新 pageSha256 原样传入；第三步如果还有计划之外的旧页面残留，调用 delete_pages 删除它们；最后如果页面顺序与计划不一致，调用 reorder_pages 调整为计划的页面顺序。验收要求最终文稿的页面列表和顺序与 write_todo 提交的计划完全一致，多一页、少一页、顺序不对都会整轮回滚。`
      : target.structureOnly
      ? [
          target.insertIndex !== undefined
            ? `新页面不在既有授权页面集合内：用一个与现有页面不重复的新页面 id 直接调用 write_page 写完整新页（新页面没有基线，不传 expectedPageSha256）。write_page 写出的新页会由系统自动放到指定插入位置，无论插入位置在文稿中间还是末尾都同样调用 write_page，无需也不能通过 write_todo 或其他方式调整页面顺序。写完立刻 render_page 检查新页。`
            : "本轮没有新增页面的授权：不要调用 write_page 创建新页面，验收会拒绝任何新增。",
          target.deletablePageIds?.length
            ? `删除页面调用 delete_pages({pageIds:[${target.deletablePageIds.map((id) => `"${id}"`).join(",")}]})，只能删这些页面，每个页面 id 恰好一次，且这些页面必须全部被删除——少删或多删都会整轮回滚；合并页面时先把内容写进保留页再删除被吸收页。`
            : "",
          target.reorderPageIds?.length
            ? `页面顺序调整调用 reorder_pages({pageIds:[${target.reorderPageIds.map((id) => `"${id}"`).join(",")}]})——pageIds 必须恰好是这次授权的最终顺序（现有全部页面各一次，顺序不同），它只改页面排列不改任何页面内容。`
            : "",
          target.editablePageIds?.length
            ? `本轮还允许修改这些现有页面：${target.editablePageIds.join("、")}——修改它们必须先调用 read_page 取得最新 pageSha256，再以完整 elements[] 调用 write_page 并原样传为 expectedPageSha256。`
            : "",
          "除此之外不要对任何其他现有页面调用写工具。如果做不到，如实说明本轮无法完成，不要改名单外的现有页面来凑合。",
        ].filter(Boolean).join("")
      : target.scope === "deck"
      ? `逐页检查 ${target.targetPageIds.join("、")}：每一页都先调用 read_page 获取完整页面和最新 pageSha256；需要修改时，用完整 elements[] 调用 write_page，并把该页刚读到的 pageSha256 原样传为 expectedPageSha256。每个实际写入的页面都要立刻 render_page 检查。已符合要求的页面应明确报告未修改，不能改动无关内容来凑写入页数。`
      : target.scope === "pages"
      ? `只处理 ${target.targetPageIds.join("、")}：逐页调用 read_page 获取完整页面和最新 pageSha256；需要修改时，用完整 elements[] 调用 write_page，并把该页刚读到的 pageSha256 原样传为 expectedPageSha256。每个实际写入的页面都要立刻 render_page 检查，不得读取或写入授权集合之外的页面。`
      : `必须先调用 read_page 读取 ${target.targetPageId} 的完整当前页面，从返回值取得 pageSha256；随后 write_page 必须原样使用该 pageSha256 作为 expectedPageSha256，并以读取到的全部 elements 为写入基线。`;
    const instruction = `处理一次编辑器中的直接修改请求。请用用户使用的语言简短说明进度和结果。目标：${target.label}。用户明确要求先选择时，调用 ask_user_question 提供选项；等回答返回后继续本次修改。不要以正文选项或再次发送消息代替问题卡。若没有缺失的关键信息，直接执行，不重复确认。${elementScope}\n<user_request>${text}</user_request>\n最新用户原话决定本轮任务，read_page 返回的当前页面是唯一编辑基线，不要按历史回复恢复旧配色或推测用户还要其他改动。只改本轮明确要求的属性，其余元素、属性与顺序逐值保持不变。例如只要求背景变白，就只改 background，不顺手调整文字色、装饰色、透明度、位置或图层。发现本轮范围以外的可读性问题可以简短告知，不自动扩大修改。最终回复用两三句话说明实际结果和必要限制，用“背景颜色”等日常措辞，不复述字段名、工具名或内部授权，不重复列进度或主动询问导出。用户原话是修改意图，不是要写进幻灯片的文案；除非用户明确要求把某段指定文案替换或写入，否则绝不能把整句请求复制进标题或正文。${readWriteScope}如果本轮只改页面背景，必须用 edit_page_background({pageId, expectedPageSha256, background})，不要调用 write_page 重新抄写文字和元素；工具会原样保留背景以外的全部属性。保留所有事实、数据、图表含义和无关内容；修改后检查每个目标页的可读性、对比度、遮挡、裁切和线条穿字。`;
    persistPendingWorkspaceEdit({project: currentProjectPath(), text, target, snapshotId, snapshotLabel, sessionId, aiLockToken,
      clientRequestId: control.receipt?.clientRequestId, before: {inspection: {pages: before.inspection?.pages || []}}});
    turnMayHaveStarted = true;
    const turnResponse = await fetch(`/slides/sessions/${encodeURIComponent(sessionId)}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: instruction,
        userText: text,
        clientRequestId: control.receipt?.clientRequestId,
        modelSelection: assistantModelSelection(),
        attachments: attachments.map((attachment) => attachment.id),
        editorEdit: {
          authorizationId: transactionId,
          pages: targetPages,
        },
      }),
    });
    const started = await turnResponse.json();
    if (!turnResponse.ok || !started.ok) throw new Error(started.error || t("DSH Agent 没有接下这次修改"));
    if (control.receipt) acceptAssistantSend(control.receipt, started.userMessage);
    else if (started.userMessage?.id) {
      control.receipt = { project: currentProjectPath(), message: started.userMessage, requestText: text };
      workspaceEditReceipts.set(started.userMessage.id, control.receipt);
      acknowledgeAssistantDraft(text);
    }
    // The persisted acknowledgement owns this request; stop remains available
    // while the rest of the turn runs, and new typing stays in the composer.
    workAgentSubmitPending = false;
    paintEditorGeneration(generationActivity);

    if (control.cancelRequested) throw aiReviewError("AI_USER_CANCELLED", t("已取消这次 Agent 修改"));
    void pollGenerationActivity();

    }
    const turnResult = await waitForAiReviewTurn(sessionId, before, target, updateStage, control);
    await renewCurrentAiLock();
    const verified = await api("/api/reviews/ai-lock/verify", {
      method: "POST",
      body: JSON.stringify({ token: aiLockToken }),
    });
    const verifiedChangedPageIds = Array.isArray(verified.changedTargetPageIds)
      ? verified.changedTargetPageIds
      : turnResult.changedPageIds;
    const verifiedMetaFields = Array.isArray(verified.changedMetaFields) ? verified.changedMetaFields : [];
    if (!verified.changed || (!verifiedChangedPageIds.length && !verifiedMetaFields.length)) {
      throw aiReviewError("AI_NO_CHANGE", t("Agent 已结束，但目标范围与修改前版本相同"));
    }
    if (verified.scopeViolation) {
      const changed = Array.isArray(verified.changedElementIds) ? verified.changedElementIds.join("、") : "";
      const scopeDetail = changed || (verified.elementOrderChanged ? t("元素层级顺序") : t("页面或文稿级设置"));
      throw aiReviewError("AI_SCOPE_VIOLATION", t(`Agent 改动超出目标范围：{p0}；正在恢复修改前版本`, { p0: scopeDetail }));
    }

    updateStage(t("重新载入并校验"), target.label);
    const project = new URLSearchParams(location.search).get("project") || activity.project?.path;
    const opened = await api("/api/open", {
      method: "POST",
      body: JSON.stringify({ path: project, page: target.scope === "deck" ? model?.pageIndex ?? target.pageIndex : target.pageIndex }),
    });
    model = opened.model;
    thumbs = opened.thumbs || thumbs;
    render();
    await refreshVersions();
    await pollGenerationActivity();
    releaseAiLock = true;
    result = { snapshotId, snapshotLabel, target, changedPageCount: verifiedChangedPageIds.length };
  } catch (caughtError) {
    let error = caughtError;
    if (turnMayHaveStarted && snapshotId) {
      try {
        await stopAiReviewTurn(sessionId);
        await renewCurrentAiLock();
        await restoreAiReviewSnapshot(snapshotId, aiLockToken);
        restored = true;
        releaseAiLock = true;
      } catch (restoreError) {
        keepAiLock = true;
        aiLockRenewUncertain = true;
        error = aiReviewError(
          "AI_STILL_LOCKED",
          t(`{p0}；{p1}。服务端保护状态不确定；未恢复版本，也未确认释放版本保护。本标签继续禁止写入。`, { p0: error instanceof Error ? error.message : String(error), p1: restoreError instanceof Error ? restoreError.message : String(restoreError) }),
        );
      }
    } else if (turnMayHaveStarted) {
      keepAiLock = true;
      aiLockRenewUncertain = true;
    } else {
      releaseAiLock = true;
    }
    failure = aiReviewError(
      error?.code || "AI_EDIT_FAILED",
      `${error instanceof Error ? error.message : String(error)}${restored ? t("；已自动恢复到修改前版本") : ""}`,
    );
  } finally {
    if (aiLockToken && releaseAiLock && !keepAiLock) {
      try {
        await renewCurrentAiLock();
        if (aiLockRenewTimer) {
          window.clearInterval(aiLockRenewTimer);
          aiLockRenewTimer = 0;
        }
        await api("/api/reviews/ai-lock", {
          method: "DELETE",
          body: JSON.stringify({ token: aiLockToken }),
        });
      } catch {
        keepAiLock = true;
        aiLockRenewUncertain = true;
        failure = aiReviewError("AI_STILL_LOCKED", t("Agent 修改已结束，但版本保护的释放结果不确定；本标签继续禁止写入。"));
      }
    }
    if (aiLockRenewTimer) window.clearInterval(aiLockRenewTimer);
    if (keepAiLock) {
      showToast(
        aiLockRenewUncertain
          ? t("Agent 版本保护状态不确定；本标签继续禁止写入，请检查生成历程。")
          : t("Agent 修改尚未安全收尾；本标签继续禁止写入。"),
        7000,
      );
    }
    if (!keepAiLock) clearPendingWorkspaceEdit(aiLockToken);
    if (!keepAiLock && activeWorkspaceReviewControl === control) activeWorkspaceReviewControl = null;
    setAiReviewTurnActive(keepAiLock);
    if (!keepAiLock) aiReviewLiveLabel = "";
  }

  if (failure) throw failure;
  return result;
}

$("work-brief")?.addEventListener("input", () => {
  const locked = assistantTurnPending || aiReviewTurnActive || generationInteractionLocked();
  const sendButton = document.querySelector("#work-form .composer-send");
  const hasText = Boolean($("work-brief")?.value.trim());
  const stoppingNow = locked && !hasText && !generationStopPending;
  sendButton?.classList.toggle("is-stopping", stoppingNow);
  if (sendButton) {
    if (stoppingNow) sendButton.dataset.control = "chrome.workspace.stop";
    else sendButton.dataset.control = "chrome.workspace.assistant.send";
  }
  if (sendButton) {
    sendButton.title = locked ? (hasText ? t("发送补充") : t("停止生成")) : selectedCommentEntries().length ? t(`发送 {p0} 条批注`, { p0: selectedCommentEntries().length }) : t("发送消息");
    sendButton.setAttribute("aria-label", sendButton.title);
  }
});

let assistantModelPainting = false;
async function paintAssistantModel(activity) {
  const select = $("assistant-model");
  if (!select || !activity?.provider || assistantModelPainting || select.dataset.loaded) return;
  assistantModelPainting = true;
  try {
    const roster = await loadGenerationRoster();
    select.replaceChildren();
    for (const provider of roster.providers.filter((entry) => entry.ready)) {
      const group = document.createElement("optgroup"); group.label = provider.name;
      for (const name of provider.models) {
        const option = document.createElement("option"); option.value = modelOptionValue(provider.id, name); option.textContent = name; group.append(option);
      }
      select.append(group);
    }
    const current = activity?.provider;
    const value = current ? modelOptionValue(current.providerId, current.modelId) : "";
    if ([...select.options].some((option) => option.value === value)) select.value = value;
    select.dataset.loaded = "true";
    select.title = t("选择下一条消息使用的模型");
  } catch { select.title = t("模型列表暂时不可用；仍使用当前会话模型"); }
  finally { assistantModelPainting = false; }
}
function assistantModelSelection() {
  const select = $("assistant-model");
  if (!generationRoster || !select?.value) return undefined;
  const selection = selectedModelFromRoster(generationRoster, select.value);
  const current = generationActivity?.provider;
  return current?.providerId === selection.provider && current?.modelId === selection.model ? undefined : selection;
}


function acknowledgeAssistantDraft(submittedText) {
  const input = $("work-brief");
  if (!input) return;
  if (input.value.trim() === submittedText.trim()) input.value = "";
  // Do not steal focus if the user has moved to another task while waiting.
  if (document.activeElement === input || document.activeElement === document.querySelector("#work-form .composer-send")) {
    input.focus({ preventScroll: true });
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function beginAssistantSend(text, existingReceipt) {
  if (existingReceipt) {
    // Retry keeps the same message id/clientRequestId so the row keeps its
    // identity and the server can dedupe the resend.
    delete existingReceipt.error;
    delete existingReceipt.uncertain;
    existingReceipt.message.localPending = true;
    generationEventFollowing = true;
    generationScroll?.toLatest();
    $("assistant-feedback").hidden = true;
    paintEditorGeneration(generationActivity);
    return existingReceipt;
  }
  const requestId = crypto.randomUUID();
  const message = { id: `local:${requestId}`, clientRequestId: requestId, at: new Date().toISOString(), text, mode: "discuss", localPending: true };
  const receipt = { project: currentProjectPath(), message, requestText: text, clientRequestId: message.id.slice(6) };
  workspaceEditReceipts.set(message.id, receipt);
  generationEventFollowing = true;
  generationScroll?.toLatest();
  acknowledgeAssistantDraft(text);
  $("assistant-feedback").hidden = true;
  paintEditorGeneration(generationActivity);
  return receipt;
}

function acceptAssistantSend(receipt, message) {
  if (!message?.id) throw new Error(t("未收到发送回执，正在确认会话状态，请勿重复发送。"));
  workspaceEditReceipts.delete(receipt.message.id);
  receipt.message = message;
  delete receipt.error;
  workspaceEditReceipts.set(message.id, receipt);
}

function failAssistantSend(receipt, error, uncertain = false) {
  receipt.error = error instanceof Error ? error.message : String(error);
  receipt.uncertain = uncertain;
  if (uncertain) receipt.error += t("；正在确认会话状态，请勿重复发送。");
  paintEditorGeneration(generationActivity);
}

async function submitAssistantConversation(text, intent, receipt) {
  workAgentSubmitPending = true;
  let dispatched = false;
  try {
    await settlePendingEdits();
    const activity = await api(generationActivityUrl());
    generationActivity = activity;
    const sessionId = activity.sessionId;
    if (!sessionId) throw new Error(NO_AI_SESSION_MESSAGE);
    const context = (model?.pagePaths || []).map((p, i) => t(`第{p0}页：{p1}`, { p0: i + 1, p1: pageIdFromPath(p) })).join("；");
    const attachments = pendingAgentAttachments.filter((entry) => !entry.consumed);
    assistantTurnPending = true;
    paintEditorGeneration(generationActivity);
    dispatched = true;
    const response = await fetch(`/slides/sessions/${encodeURIComponent(sessionId)}/turn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, userText: text, clientRequestId: receipt.clientRequestId, conversationMode: intent === "discuss" ? "discuss" : "generate", context, modelSelection: assistantModelSelection(), attachments: attachments.map((entry) => entry.id) }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) { dispatched = false; throw new Error(result.error || t("助手没有接下这条消息")); }
    acceptAssistantSend(receipt, result.userMessage);
    await consumePendingAgentAttachments(attachments);
    workAgentSubmitPending = false;
    await pollGenerationActivity();
  } catch (error) {
    failAssistantSend(receipt, error, dispatched);
    if (!dispatched) assistantTurnPending = false;
    else void pollGenerationActivity();
  } finally { workAgentSubmitPending = false; paintEditorGeneration(generationActivity); }
}

$("work-form")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const pendingQuestion = lastGenerationState?.questions?.find(question => question.status === "pending");
  const answerText = $("work-brief")?.value.trim();
  if (pendingQuestion && answerText) {
    const card = [...$("editor-generation-event-list").children].find(item => item.dataset.processKey === `question:${pendingQuestion.id}`);
    if (await card?.__question.answerText(answerText)) acknowledgeAssistantDraft(answerText);
    return;
  }
  if (assistantTurnPending || generationActivity?.phase === "discussing") {
    if (!$("work-brief")?.value.trim()) await stopLiveGeneration();
    else showToast(t("助手正在回复，完成后可以继续发送；输入的内容会保留。"));
    return;
  }
  // Picked comments turn the composer into the batch submit entry point.
  if (commentSubmitPending && !aiReviewTurnActive) return;
  if (selectedCommentEntries().length && !generationInteractionLocked() && !aiReviewTurnActive) {
    if (await submitCommentBatch()) return;
  }
  if (generationInteractionLocked()) {
    const steer = $("work-brief")?.value.trim();
    const sessionId = liveGenerationSessionId();
    if (!steer) {
      const control = activeWorkspaceReviewControl || activeCommentReviewControl;
      if (control) {
        if (control.cancelRequested) return;
        control.cancelRequested = true;
        paintEditorGeneration(generationActivity);
        showToast(t("正在停止 Agent 修改…"), 4000);
        return;
      }
      void stopLiveGeneration();
      return;
    }
    if (!sessionId) return;
    try {
      const response = await fetch(`/slides/sessions/${encodeURIComponent(sessionId)}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: steer, steer: true }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error || t("纠偏没有被当前生成会话接受"));
      }
      acknowledgeAssistantDraft(steer);
      void pollGenerationActivity();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 5000);
    }
    return;
  }
  if (aiReviewTurnActive) {
    const reviewControl = activeWorkspaceReviewControl || activeCommentReviewControl;
    const typed = Boolean($("work-brief")?.value.trim());
    if (reviewControl && !typed) {
      // An empty composer during a locked review turn means "stop", the same
      // contract the generation flow already uses.
      if (reviewControl.cancelRequested) return;
      reviewControl.cancelRequested = true;
      paintEditorGeneration(generationActivity);
      showToast(t("正在停止 Agent 修改；确认停止后会恢复修改前版本。"), 5000);
      return;
    }
    showToast(t("Agent 正在修改并保护版本；完成或回滚后再发起新的请求。"));
    return;
  }
  if (workAgentSubmitPending) {
    showToast(t("正在准备上一条 Agent 请求。"));
    return;
  }
  if (agentAttachmentUploadActive) {
    showToast(t("附件仍在上传，请稍候再发送。"), 5000);
    return;
  }
  // A resumable generation turns the shared composer into the steer input:
  // whatever the user typed rides the same verified continue turn.
  if (generationResumeActionable(generationActivity)) {
    void resumeGeneration();
    return;
  }
  const text = $("work-brief")?.value.trim();
  if (!text) return;
  await dispatchAssistantRequest(text);
});

async function dispatchAssistantRequest(text, existingReceipt) {
  let plan;
  const contextKey = () => JSON.stringify([currentProjectPath(), model?.pageIndex, selectedIds()]);
  let submittedContext;
  const notice = $("assistant-feedback");
  const sendButton = document.querySelector("#work-form .composer-send");
  workAgentSubmitPending = true;
  notice.hidden = true;
  const receipt = beginAssistantSend(text, existingReceipt);
  if ($("work-form").contains(document.activeElement)) $("work-brief").focus({ preventScroll: true });
  sendButton.disabled = true;
  try {
    await settlePendingEdits();
    submittedContext = contextKey();
    const sessionId = liveGenerationSessionId();
    if (!sessionId) throw new Error(NO_AI_SESSION_MESSAGE);
    const response = await fetch("/slides/assistant-intent", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, sessionId, currentPage: (model?.pageIndex || 0) + 1,
        selectedCount: selectedIds().length, modelSelection: assistantModelSelection() }),
    });
    plan = await response.json();
    if (!response.ok || !plan.ok) throw new Error(plan.error || t("助手暂时无法处理这条消息，请重试。"));
    if (contextKey() !== submittedContext) throw new Error(t("你已切换页面或选区，这条消息未执行。请确认范围后重试。"));
    notice.hidden = true;
  } catch (error) {
    failAssistantSend(receipt, error);
    return;
  } finally {
    workAgentSubmitPending = false;
    sendButton.disabled = false;
    paintEditorGeneration(generationActivity);
  }
  if (plan.intent !== "edit") {
    await submitAssistantConversation(text, plan.intent, receipt);
    return;
  }
  // Semantic scope comes from the validated model plan. Do not reparse the
  // same text with a second, lossy page-number heuristic (e.g. “1、2两页”).
  const requestedTarget = workAgentTargetFromPlan(plan);
  if (!requestedTarget.ok) {
    failAssistantSend(receipt, requestedTarget.error);
    return;
  }
  workAgentSubmitPending = true;
  try {
    await settlePendingEdits();
  } catch (e) {
    workAgentSubmitPending = false;
    failAssistantSend(receipt, t(`保存当前编辑失败：{p0}`, { p0: e instanceof Error ? e.message : String(e) }));
    return;
  }
  const submittedAttachments = pendingAgentAttachments.filter((attachment) => !attachment.consumed);
  const control = { cancelRequested: false, receipt };
  $("work-empty")?.setAttribute("hidden", "");
  setPendingAgentAttachmentsBusy(true);
  try {
    const data = await runWorkAgentEdit(text, requestedTarget, submittedAttachments, control);
    if (control.receipt) Object.assign(control.receipt, { snapshotId: data.snapshotId, snapshotLabel: data.snapshotLabel });
    await consumePendingAgentAttachments(submittedAttachments);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    failAssistantSend(receipt, error);
  } finally {
    setPendingAgentAttachmentsBusy(false);
    workAgentSubmitPending = false;
    paintEditorGeneration(generationActivity);
  }
}

function bootEditor() {
  if (liveGenerationRoute()) paintEditorGeneration(null);

  api("/api/open", {
    method: "POST",
    body: JSON.stringify({
      path: new URLSearchParams(location.search).get("project") || undefined,
      page: new URLSearchParams(location.search).get("page") || undefined,
    }),
  })
    .then(async (data) => {
      model = data.model;
      if (data.llmConfigured != null) model.llmConfigured = data.llmConfigured;
      thumbs = data.thumbs;
      render();
      void revealWorkspace();
      await restorePendingAgentAttachments();
      refreshVersions();
      if (genBrief) runGenerateFlow(genBrief, genDesign, genCategory);
      else if (!liveGenerationRoute()) {
        try {
          paintPersistedReason();
        } catch {
          /* leftover reason must not block open / present */
        }
      }
      void pollGenerationActivity();
      if (new URLSearchParams(location.search).get("present") === "1") {
        await command("present", { on: true });
      }
    })
    .catch((err) => {
      $("doc-title").textContent = err.message;
      coverFailure(err.message, [{ label: t("重新载入"), primary: true, onClick: () => location.reload() }, { label: t("回首页"), href: "./" }]);
    });
}

/**
 * Launch mode (?launch=<id>): the Hub navigated here the moment Send was
 * pressed. The workspace cover shows the request and real progress while the
 * model reads it and the session is created; the page then binds to the live
 * session in place and boots normally, and the cover lifts once the layout
 * is stable.
 */
async function runEditorLaunch(launchId) {
  const record = readLaunch(launchId);
  if (!record) {
    location.replace("./");
    return;
  }
  const brief = String(record.request.brief || "");
  const title = clipChromeText(brief.replace(/\s+/g, " ").trim(), 28) || t("新的演示文稿");
  $("doc-title").textContent = title;
  document.title = `${title} · DSH SlideStudio`;
  document.querySelector(".app")?.classList.add("is-live-generation", "is-launching");
  setCover({ title: t("正在准备工作区"), detail: "", brief, steps: LAUNCH_STEPS, step: "intent", queue: null });
  const attempt = async () => {
    setCover({ title: t("正在准备工作区"), step: "intent" });
    try {
      const bound = await performLaunch(launchId, {
        onStatus: ({ step, text, queue }) => setCover({ detail: text, ...(step ? { step } : {}), ...(queue !== undefined ? { queue } : {}) }),
      });
      setCover({ step: "workspace", detail: t("正在连接生成会话…"), queue: null });
      handoffToLiveEditor(bound);
      document.querySelector(".app")?.classList.remove("is-launching");
      bootEditor();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = readLaunch(launchId)?.state === "pending";
      coverFailure(message, [
        ...(retryable ? [{ label: t("重试"), primary: true, className: "launch-retry", onClick: () => void attempt() }] : []),
        { label: t("回首页修改"), href: hubDraftHref(launchId), className: "launch-back" },
      ]);
    }
  };
  await attempt();
}

const launchId = new URLSearchParams(location.search).get("launch");
if (launchId) void runEditorLaunch(launchId);
else bootEditor();
