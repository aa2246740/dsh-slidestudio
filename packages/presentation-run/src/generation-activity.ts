import {
  inspectRunLedger,
  readRunLedger,
  type RunFact,
  type RunLedgerInspection,
  type RunLedgerV1,
} from "./domain/run-ledger.js";
import { projectExecution } from "./execution.js";
import { resolveProjectPageIdentities } from "./domain/page-identity.js";
import { inspectProjectCapabilities } from "./capabilities.js";
import type { ExecutionProjection } from "./types.js";
import { readProduceTraceEvents } from "./generation-activity-trace.js";

export { generationActivityEventsFromTraceRows, readProduceTraceEvents } from "./generation-activity-trace.js";

/** Metadata facts whose tool call or plan row already tells the story in the timeline. */
const QUIET_FACT_TYPES: ReadonlySet<RunFact["type"]> = new Set([
  "page.provenance-declared",
  "page.material-figures",
  "page.number-conflicts",
  "page.computed-figures",
  "material.query-computed",
  "material.image-viewed",
  "material.use-declared",
  "plan.period-map-declared",
  "plan.missing-items-declared",
  "layout.revision-committed",
  "template.component-used",
  "reference.chunk-prepared",
  "reference.epoch-carried",
]);

/** A persisted, presentation-safe event for the generation-history UI. */
export type GenerationActivityEvent = Readonly<{
  id: string;
  type: string;
  at: string;
  label: string;
  status: "running" | "complete" | "failed" | "cancelled" | "needs-attention";
  pageId?: string;
  revision?: number;
  detail?: string;
  truncated?: boolean;
  ok?: boolean;
  kind?: "message" | "reasoning" | "tool" | "result" | "turn" | "ledger" | "think";
  name?: string;
  callId?: string;
  turn?: number;
  step?: number;
}>;

export type GenerationActivityStage = Readonly<{
  id: "plan" | "pages" | "review" | "compose";
  label: string;
  status: "pending" | "active" | "complete" | "needs-attention";
  detail: string;
}>;

export type GenerationActivity = Readonly<{
  /** Derived only from durable project artifacts; never an in-memory agent claim. */
  phase: "awaiting-project" | "planning" | "generating" | "reviewing" | "complete";
  updatedAt?: string;
  stages: readonly GenerationActivityStage[];
  events: readonly GenerationActivityEvent[];
}>;

export type GenerationActivitySnapshot = Readonly<{
  inspection: RunLedgerInspection;
  activity: GenerationActivity;
  execution?: ExecutionProjection;
}>;

function pageFrom(fact: RunFact): Pick<GenerationActivityEvent, "pageId" | "revision"> {
  if ("pageId" in fact) {
    return {
      pageId: fact.pageId,
      ...(typeof fact.revision === "number" ? { revision: fact.revision } : {}),
    };
  }
  return {};
}

function pagePipelineActivity(fact: RunFact, page: ReturnType<typeof pageFrom>): GenerationActivityEvent | undefined {
  switch (fact.type) {
    case "reference.chunk-returned":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已读取参考资料",
        status: "complete",
      };
    case "todo.committed":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已建立页面计划",
        status: "complete",
        detail: `${fact.itemCount} 页`,
      };
    case "page.revision-committed":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已写入页面",
        status: "complete",
        ...page,
      };
    case "page.edit-authorized":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已授权编辑器 Agent 修改",
        status: "complete",
        detail: `仅限 ${fact.pageId} revision ${fact.revision}`,
        ...page,
      };
    case "page.raster-committed":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已渲染页面",
        status: fact.layoutStatus === "fail" ? "needs-attention" : "complete",
        detail: fact.layoutStatus === "fail" ? "布局检查需要修订" : undefined,
        ...page,
      };
    case "page.image-result-prepared":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已准备页面预览",
        status: "complete",
        ...page,
      };
    case "page.image-content-emitted":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已展示页面预览",
        status: "complete",
        ...page,
      };
    case "page.visual-review-recorded":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已完成页面视觉检查",
        status: fact.verdict === "revise" ? "needs-attention" : "complete",
        detail: fact.issues.length ? fact.issues.join("；") : undefined,
        ...page,
      };
    case "deck.structural-review-recorded":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已完成结构检查",
        status: fact.ok ? "complete" : "needs-attention",
        detail: fact.issues.length ? fact.issues.join("；") : undefined,
      };
    case "deck.composed":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已完成整稿",
        status: "complete",
        detail: fact.title,
      };
    case "export.succeeded":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已导出演示文稿",
        status: "complete",
        detail: `${fact.slideCount} 页 · ${fact.artifactPath}`,
      };
    case "web-search.executed":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已完成网页检索",
        status: "complete",
        detail: fact.queries.join("；"),
      };
    default:
      return undefined;
  }
}

function materialActivity(fact: RunFact): GenerationActivityEvent | undefined {
  switch (fact.type) {
    case "material.chunk-returned":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已读取上传资料",
        status: "complete",
        detail: fact.part ? `${fact.materialId} ${fact.part}` : fact.materialId,
      };
    case "material.page-viewed":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已查看上传资料的页面图片",
        status: "complete",
        detail: `${fact.materialId} 第 ${fact.page} 页`,
      };
    case "material.overview-viewed":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: fact.overviewKind === "all-images" ? "已查看全部图片总览" : "已查看 PDF 页面总览",
        status: "complete",
        detail: `${fact.tiles.length} 格 · ${fact.materialIds.join("、")}`,
      };
    case "material.notes-recorded":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已记录图片说明",
        status: "complete",
        detail: fact.page
          ? `${fact.materialId} 第 ${fact.page} 页`
          : fact.mediaId
            ? `${fact.materialId} ${fact.mediaId}`
            : fact.materialId,
      };
    case "material.image-viewed":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已查看上传资料图片",
        status: "complete",
        detail: fact.materialId,
      };
    case "material.query-computed":
      // The query_material tool row tells this story (see QUIET_FACT_TYPES).
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已查询资料数据",
        status: "complete",
        detail: `${fact.materialId} ${fact.part}`,
      };
    default:
      return undefined;
  }
}

function planMetaActivity(fact: RunFact, page: ReturnType<typeof pageFrom>): GenerationActivityEvent | undefined {
  switch (fact.type) {
    case "page.computed-figures":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已记录计算数字的来源",
        status: "complete",
        ...page,
      };
    case "material.use-declared":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已记录图片安排",
        status: "complete",
        detail: `${fact.entries.length} 张`,
      };
    case "page.provenance-declared":
    case "page.material-figures":
    case "page.number-conflicts":
      // Provenance metadata stays in the ledger for the delivery summary; it
      // adds no timeline rows of its own.
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已记录数字来源",
        status: "complete",
        ...page,
      };
    case "plan.period-map-declared":
      // The write_todo tool row tells this story (see QUIET_FACT_TYPES).
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已记录期间对应",
        status: "complete",
        detail: `${fact.periodMap.from} → ${fact.periodMap.to}`,
      };
    case "plan.missing-items-declared":
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已记录没有本期数据的项目",
        status: "complete",
        detail: `${fact.items.length} 项`,
      };
    case "layout.revision-committed":
      // The write_layout tool row tells this story; the fact is quiet (see QUIET_FACT_TYPES).
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已定义版式",
        status: "complete",
      };
    case "template.component-used":
      // The write_page / write_layout tool row already tells this story (see QUIET_FACT_TYPES).
      return {
        id: fact.factId,
        type: fact.type,
        at: fact.at,
        label: "已使用模板组件",
        status: "complete",
        ...(fact.pageId ? { pageId: fact.pageId, revision: fact.revision } : {}),
      };
    default:
      return undefined;
  }
}

function eventFor(fact: RunFact): GenerationActivityEvent {
  const page = pageFrom(fact);
  const event = pagePipelineActivity(fact, page) ?? materialActivity(fact) ?? planMetaActivity(fact, page);
  if (!event) throw new Error(`unhandled activity fact ${fact.type}`);
  return event;
}

function stageStatus(
  state: "pending" | "active" | "complete" | "needs-attention",
  label: GenerationActivityStage["label"],
  detail: string,
): GenerationActivityStage {
  const id = label === "规划" ? "plan" : label === "生成页面" ? "pages" : label === "检查" ? "review" : "compose";
  return { id, label, status: state, detail };
}

export function generationActivityFromLedger(
  ledger: RunLedgerV1 | undefined,
  inspection: RunLedgerInspection,
): GenerationActivity {
  const factEvents = ledger?.facts.filter((fact) => !QUIET_FACT_TYPES.has(fact.type)).map(eventFor) ?? [];
  if (!ledger) {
    return {
      phase: "awaiting-project",
      stages: [
        stageStatus("active", "规划", "等待生成任务初始化"),
        stageStatus("pending", "生成页面", "等待页面计划"),
        stageStatus("pending", "检查", "等待页面生成"),
        stageStatus("pending", "合稿", "等待检查完成"),
      ],
      events: factEvents,
    };
  }
  const planned = inspection.todoCount > 0;
  const drafted = inspection.pages.length > 0;
  const reviewNeedsAttention =
    inspection.structuralReview === "fail" ||
    inspection.pages.some((page) => page.layout === "fail" || page.visualReview === "revise");
  const latestEditorAuthorization = ledger
    ? [...ledger.facts].reverse().find((fact) => fact.type === "page.edit-authorized")
    : undefined;
  const editorEditCompleted = Boolean(
    latestEditorAuthorization &&
    inspection.pages.some(
      (page) =>
        page.pageId === latestEditorAuthorization.pageId &&
        page.revision === latestEditorAuthorization.revision + 1 &&
        page.pageSha256 !== latestEditorAuthorization.pageSha256 &&
        page.raster &&
        page.layout === "pass",
    ),
  );
  const reviewed = inspection.composeReady || inspection.composed || editorEditCompleted;
  const completed = inspection.composed || editorEditCompleted;
  const phase: GenerationActivity["phase"] = completed
    ? "complete"
    : reviewed || reviewNeedsAttention
      ? "reviewing"
      : drafted
        ? "generating"
        : planned
          ? "generating"
          : "planning";
  return {
    phase,
    updatedAt: ledger.updatedAt,
    stages: [
      stageStatus(
        planned || completed ? "complete" : "active",
        "规划",
        planned ? `已规划 ${inspection.todoCount} 页` : completed ? "已完成整稿" : "正在建立页面计划",
      ),
      stageStatus(
        drafted ? "complete" : planned ? "active" : "pending",
        "生成页面",
        drafted ? `已持久化 ${inspection.pages.length} 页` : "等待页面写入",
      ),
      stageStatus(
        reviewed ? "complete" : reviewNeedsAttention ? "needs-attention" : drafted ? "active" : "pending",
        "检查",
        reviewed
          ? editorEditCompleted && !inspection.composed
            ? "本次 Agent 修改已完成渲染与布局检查"
            : "结构与合稿检查已通过"
          : reviewNeedsAttention
            ? "存在需要修订的检查项"
            : drafted
              ? "正在检查页面布局与可读性"
              : "等待页面生成",
      ),
      stageStatus(
        completed ? "complete" : reviewed ? "active" : "pending",
        "合稿",
        completed
          ? editorEditCompleted && !inspection.composed
            ? "可回放本次 Agent 修改与修改前版本"
            : "可回放已完成的生成历程"
          : reviewed
            ? "等待写入完整演示文稿"
            : "等待检查完成",
      ),
    ],
    events: factEvents,
  };
}

/** Reads only durable artifacts, so completed runs remain replayable after a server restart. */
export function inspectGenerationActivity(root: string): GenerationActivity {
  return inspectGenerationActivitySnapshot(root).activity;
}

/**
 * Reads the ledger once and derives the UI activity plus inspection from that
 * same immutable fact snapshot. This avoids exposing a mixed old/new response
 * while the generator atomically appends its next fact.
 */
export function inspectGenerationActivitySnapshot(root: string): GenerationActivitySnapshot {
  const ledger = readRunLedger(root);
  const inspection = inspectRunLedger(root, undefined, process.env, ledger);
  const activity = generationActivityFromLedger(ledger, inspection);
  const live = readProduceTraceEvents(root);
  const capability = inspectProjectCapabilities(root);
  const execution = projectExecution({
    ledger,
    inspection,
    identity: resolveProjectPageIdentities(root),
    capability,
  });
  return {
    inspection,
    activity: live.length ? { ...activity, events: live } : activity,
    execution,
  };
}
