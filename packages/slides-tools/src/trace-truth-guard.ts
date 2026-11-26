/**
 * 轨迹事实护栏（防幻觉）：将助手回复投影到编辑器前，对照磁盘上的 presentation-run
 * 持久化账本事实（审查、封版、导出），若文本宣称已完成而账本未达成，追加客观校正注记。
 */
import fs from "node:fs";
import path from "node:path";
import { inspectRunLedger, readRunLedger, readVerifiedDelivery } from "@open-slidestudio/presentation-run";
/** The trace-row fields the guard reads; host trace rows are structurally compatible. */
export type TruthGuardTraceRow = {
  readonly kind: string;
  readonly status: string;
  readonly detail?: string;
};

export const TRUTH_GUARD_MARKER = "[系统事实校验]";

const NEGATION_PREFIX = "(?:未|尚未|还未|没有|没|未能|暂未|无法|不能|不可|不代表|并未|并没有)";
const REVIEW_CLAIM_RE = new RegExp(
  `(?<!${NEGATION_PREFIX})(?:审查已通过|审核已通过|已通过(?:全部|当前)?(?:结构|视觉|页面)?(?:审查|审核|验收)|(?:结构|页面|全部)审查(?:均|都)?已?通过|review_pages\\s*(?:已通过|通过))`,
  "i",
);
const COMPOSE_CLAIM_RE = new RegExp(
  `(?<!${NEGATION_PREFIX})(?:已(?:成功|完成)?封版|封版已完成|已(?:成功|完成)?合稿|合稿已完成|compose_deck\\s*(?:已完成|已封版|成功))`,
  "i",
);
const EXPORT_CLAIM_RE = new RegExp(
  `(?<!${NEGATION_PREFIX})(?:已(?:成功|完成)?导出(?:\\s*PPTX|\\s*PDF|\\s*文稿|\\s*文件)?|PPTX\\s*已(?:成功)?(?:生成|导出)|导出已完成|export_deck\\s*(?:已完成|成功))`,
  "i",
);
const ALL_DONE_CLAIM_RE = new RegExp(
  `(?<!${NEGATION_PREFIX})(?:全部修改(?:均|都)?已?完成|所有(?:页面|修改)(?:均|都)?已完成|已(?:全部|彻底)完成(?:所有|全部)?修改)`,
  "i",
);

export type LedgerTruthSnapshot = {
  readonly initialized: boolean;
  readonly structuralReviewPassed: boolean;
  readonly composed: boolean;
  readonly exported: boolean;
  readonly composeBlockers: readonly string[];
};

/** 从项目磁盘账本读取当前 revision 的审查、封版与导出真实状态。 */
export function readLedgerTruth(projectRoot: string): LedgerTruthSnapshot | undefined {
  if (!projectRoot || !fs.existsSync(projectRoot)) return undefined;
  const ledger = readRunLedger(projectRoot);
  if (!ledger) {
    if (!fs.existsSync(path.join(projectRoot, "deck.pptd"))) return undefined;
    return {
      initialized: false,
      structuralReviewPassed: false,
      composed: false,
      exported: false,
      composeBlockers: ["run ledger is not initialized"],
    };
  }
  const inspection = inspectRunLedger(projectRoot);
  const verifiedDelivery = readVerifiedDelivery(projectRoot);
  let lastExportIdx = -1;
  let lastMutationIdx = -1;
  ledger.facts.forEach((fact, index) => {
    if (fact.type === "export.succeeded") lastExportIdx = index;
    if (fact.type === "page.revision-committed" || fact.type === "layout.revision-committed") {
      lastMutationIdx = index;
    }
  });
  const ledgerExportCurrent = lastExportIdx >= 0 && lastExportIdx > lastMutationIdx && inspection.composed;
  return {
    initialized: inspection.initialized,
    structuralReviewPassed: inspection.structuralReview === "pass",
    composed: inspection.composed,
    exported: verifiedDelivery !== null || ledgerExportCurrent,
    composeBlockers: inspection.composeBlockers,
  };
}

const CONDITIONAL_CLAUSE_RE =
  /^\s*(?:如果|若|倘若|假设|假如|一旦|待|等到|等|只要|当|准备|计划|将要|将会|下一步|if\b|once\b|when\b)/i;

/** 核对助手回复中的状态宣称与账本事实，有偏差时在原文末尾追加简明客观校验注记。 */
export function guardAssistantMessageTruth(projectRoot: string, text: string): string {
  if (!text || text.includes(TRUTH_GUARD_MARKER)) return text;
  const clauses = text
    .split(/[，。,.;；！？!?\r\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !CONDITIONAL_CLAUSE_RE.test(part));
  const claimsReview = clauses.some((clause) => REVIEW_CLAIM_RE.test(clause));
  const claimsCompose = clauses.some((clause) => COMPOSE_CLAIM_RE.test(clause));
  const claimsExport = clauses.some((clause) => EXPORT_CLAIM_RE.test(clause));
  const claimsAllDone = clauses.some((clause) => ALL_DONE_CLAIM_RE.test(clause));
  if (!claimsReview && !claimsCompose && !claimsExport && !claimsAllDone) return text;

  const truth = readLedgerTruth(projectRoot);
  if (!truth) return text;

  const unmet: string[] = [];
  if (claimsReview && !truth.structuralReviewPassed) {
    unmet.push("当前版本尚未通过结构审查（review_pages）");
  }
  if (claimsCompose && !truth.composed) {
    unmet.push("当前版本尚未完成封版（compose_deck）");
  }
  if (claimsExport && !truth.exported) {
    unmet.push("当前版本尚未完成导出（export_deck）");
  }
  if (claimsAllDone && (!truth.structuralReviewPassed || !truth.composed)) {
    const missingStages = [
      ...(!truth.structuralReviewPassed ? ["结构审查未通过"] : []),
      ...(!truth.composed ? ["尚未封版"] : []),
    ];
    unmet.push(`全量修改宣称与账本不一致（${missingStages.join("、")}）`);
  }
  if (!unmet.length) return text;
  return `${text}\n\n${TRUTH_GUARD_MARKER} 磁盘持久化账本显示以下阶段尚未达成：${unmet.join("；")}。以上以实际账本状态为准。`;
}

/** 对已完成投影的助手消息行应用事实护栏，不修改原文内容、不干预流式增量与工具行。 */
export function applyTraceTruthGuard<Row extends TruthGuardTraceRow>(
  projectRoot: string,
  rows: readonly Row[],
  maxDetail = 8_192,
): Row[] {
  if (!projectRoot || !rows.length) return [...rows];
  return rows.map((row) => {
    if (row.kind !== "message" || row.status !== "complete" || typeof row.detail !== "string") {
      return row;
    }
    const guarded = guardAssistantMessageTruth(projectRoot, row.detail);
    if (guarded === row.detail) return row;
    if (guarded.length <= maxDetail) {
      return { ...row, detail: guarded };
    }
    const noteIndex = guarded.lastIndexOf(`\n\n${TRUTH_GUARD_MARKER}`);
    const note = noteIndex >= 0 ? guarded.slice(noteIndex) : "";
    const keepBody = Math.max(0, maxDetail - note.length - 1);
    return {
      ...row,
      detail: `${guarded.slice(0, keepBody)}…${note}`,
      truncated: true,
    };
  });
}
