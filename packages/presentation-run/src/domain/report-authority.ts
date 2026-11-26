/**
 * Planning-time integration of report requirements: what the user or a valid
 * clarification answer actually requires, which material parts those
 * requirements depend on, and which current-epoch read receipts prove it.
 *
 * Requirements are non-renderable runtime metadata. An attachment never grants
 * itself authority, and a clarification answer counts only while the question
 * record is answered, belongs to the same context epoch, and its text matches
 * the answer the user actually gave. Cancelled, interrupted, expired or
 * re-asked questions therefore cannot silently change the effective authority.
 */
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";
import type { DesignAuthority } from "./design-authority.js";
import type { MaterialRenderOptions } from "./material-content.js";
import { readMaterialsManifest } from "./material-pack.js";
import {
  checkReportMaterialDependencies,
  materialDependenciesForRequirements,
  normalizeReportRequirements,
  type ReportMaterialDependency,
  type ReportRequirement,
  type UnreadMaterialDependency,
  type UnreadableMaterialDependency,
} from "./report-requirements.js";

const RUNTIME_REL = path.join("_agent", "runtime.json");
const QUESTIONS_REL = path.join("_agent", "assistant-questions.v1.json");

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Persisted requirement declarations.
// ---------------------------------------------------------------------------

/**
 * The latest declaration, or undefined when this project has never stored one.
 * An unreadable or malformed declaration fails closed instead of granting.
 */
export function readRecordedReportRequirements(projectRoot: string): readonly ReportRequirement[] | undefined {
  const file = path.join(projectRoot, RUNTIME_REL);
  if (!fs.existsSync(file)) return undefined;
  const runtime = record(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!Object.prototype.hasOwnProperty.call(runtime, "reportRequirements")) return undefined;
  return normalizeReportRequirements(runtime.reportRequirements);
}

/**
 * A plan call that omits the field keeps the saved declaration; an explicit
 * array, including [], replaces it. `normalizeReportRequirements` rejects
 * attachment-authored or malformed requirements before anything is saved.
 */
export function resolvePlanningReportRequirements(
  projectRoot: string,
  args: Record<string, unknown>,
): readonly ReportRequirement[] {
  if (!Object.prototype.hasOwnProperty.call(args, "reportRequirements")) {
    return readRecordedReportRequirements(projectRoot) ?? [];
  }
  return normalizeReportRequirements(args.reportRequirements);
}

/** Save the declaration beside the other non-renderable runtime metadata. */
export function persistPlanningReportRequirements(
  projectRoot: string,
  requirements: readonly ReportRequirement[],
): void {
  const file = path.join(projectRoot, RUNTIME_REL);
  let runtime: Record<string, unknown> = {};
  if (fs.existsSync(file)) runtime = record(JSON.parse(fs.readFileSync(file, "utf8")));
  const { reportRequirements: _prior, ...rest } = runtime;
  writeJsonAtomic(file, {
    ...rest,
    ...(requirements.length ? { reportRequirements: requirements } : {}),
  });
}

/**
 * Persist the requirements and the current style authority in one atomic write.
 * `keep` leaves the saved decision untouched; `set` stores this call's decision.
 */
export function persistPlanningAuthority(
  projectRoot: string,
  requirements: readonly ReportRequirement[],
  authority: Readonly<{ mode: "keep" | "set"; decision?: DesignAuthority }>,
): void {
  const file = path.join(projectRoot, RUNTIME_REL);
  let runtime: Record<string, unknown> = {};
  if (fs.existsSync(file)) runtime = record(JSON.parse(fs.readFileSync(file, "utf8")));
  const { reportRequirements: _prior, designAuthority: prior, ...rest } = runtime;
  const decision = authority.mode === "set" ? authority.decision : prior;
  writeJsonAtomic(file, {
    ...rest,
    ...(requirements.length ? { reportRequirements: requirements } : {}),
    ...(decision !== undefined ? { designAuthority: decision } : {}),
  });
}

// ---------------------------------------------------------------------------
// Clarification answers as authority.
// ---------------------------------------------------------------------------

export const CLARIFICATION_AUTHORITY_ERRORS = [
  "clarification_missing",
  "clarification_not_answered",
  "clarification_expired",
  "clarification_mismatch",
  "clarification_superseded",
] as const;
export type ClarificationAuthorityError = (typeof CLARIFICATION_AUTHORITY_ERRORS)[number];

export type ClarificationRecord = Readonly<{
  questionId: string;
  status: "pending" | "answered" | "cancelled" | "interrupted";
  contextEpochId?: string;
  /** The selected labels and custom text, joined the way the answer is read back. */
  answerText?: string;
  at: string;
  answeredAt?: string;
}>;

export type RequirementAuthorityIssue = Readonly<{
  code: ClarificationAuthorityError;
  questionId: string;
  detail: string;
}>;

const QUESTION_STATUSES = new Set<ClarificationRecord["status"]>(["pending", "answered", "cancelled", "interrupted"]);

function recordTime(row: ClarificationRecord): number {
  const value = Date.parse(row.answeredAt || row.at);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Read the product's persisted native question records. A malformed file or a
 * record without a stable question id grants nothing; it does not throw, so
 * one bad row cannot stop a plan that cites no clarification authority.
 */
function appendClarificationQuestions(
  records: ClarificationRecord[],
  questions: readonly unknown[],
  answers: readonly unknown[],
  status: ClarificationRecord["status"],
  at: string,
  contextEpochId: string | undefined,
  answeredAt: string | undefined,
): void {
  for (const rawQuestion of questions) {
    const question = record(rawQuestion);
    const questionId = typeof question.id === "string" && question.id.trim() ? question.id.trim() : "";
    if (!questionId) continue;
    const item = record(answers.find((entry) => record(entry).id === questionId));
    const selected = Array.isArray(item.selected)
      ? item.selected.filter((value): value is string => typeof value === "string")
      : [];
    const custom = typeof item.custom === "string" ? item.custom.trim() : "";
    const text = [...selected, custom].filter(Boolean).join("、");
    records.push({
      questionId,
      status,
      at,
      ...(contextEpochId ? { contextEpochId } : {}),
      ...(text ? { answerText: text } : {}),
      ...(answeredAt ? { answeredAt } : {}),
    });
  }
}

export function readClarificationRecords(projectRoot: string): readonly ClarificationRecord[] {
  const file = path.join(projectRoot, QUESTIONS_REL);
  if (!fs.existsSync(file)) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const records: ClarificationRecord[] = [];
  for (const raw of rows) {
    const row = record(raw);
    const status = QUESTION_STATUSES.has(row.status as ClarificationRecord["status"])
      ? (row.status as ClarificationRecord["status"])
      : "interrupted";
    const questions = Array.isArray(row.questions) ? row.questions : [];
    const answer = record(row.answer);
    const answers = Array.isArray(answer.answers) ? answer.answers : [];
    const at = typeof row.at === "string" && row.at.trim() ? row.at.trim() : "";
    if (!at) continue;
    const contextEpochId =
      typeof row.contextEpochId === "string" && row.contextEpochId.trim() ? row.contextEpochId.trim() : undefined;
    const answeredAt = typeof row.answeredAt === "string" && row.answeredAt.trim() ? row.answeredAt.trim() : undefined;
    appendClarificationQuestions(records, questions, answers, status, at, contextEpochId, answeredAt);
  }
  return records;
}

function statusDetail(status: ClarificationRecord["status"]): string {
  switch (status) {
    case "pending":
      return "仍在等待回答";
    case "cancelled":
      return "已被取消，取消不等于同意";
    case "interrupted":
      return "所在对话已中断";
    case "answered":
      return "已回答";
  }
}

/**
 * The usable answer of every question: only the newest record of a question id
 * counts, and it must be answered inside the current context epoch. A later
 * cancelled, interrupted or re-asked record therefore retires an earlier answer.
 */
export function currentAnsweredClarifications(
  records: readonly ClarificationRecord[],
  contextEpochId: string,
): readonly ClarificationRecord[] {
  const latest = new Map<string, ClarificationRecord>();
  for (const row of records) {
    const prior = latest.get(row.questionId);
    if (!prior || recordTime(row) >= recordTime(prior)) latest.set(row.questionId, row);
  }
  return [...latest.values()].filter(
    (row) => row.status === "answered" && row.contextEpochId === contextEpochId && (row.answerText ?? "").trim() !== "",
  );
}

export function clarificationRecordTime(row: ClarificationRecord): number {
  return recordTime(row);
}

export type ClarificationAnswerCheck = Readonly<{
  issue?: RequirementAuthorityIssue;
  /** The latest record for the question, present when the answer is usable. */
  record?: ClarificationRecord;
}>;

/**
 * Validate a clarification answer against the current request context. The
 * same rule protects enforced requirements and a style-authority decision.
 */
export function clarificationAnswerCheck(input: {
  questionId: string;
  /** What the answer would authorize, e.g. `要求「…」` or `风格决定「…」`. */
  subject: string;
  answerText?: string;
  records: readonly ClarificationRecord[];
  contextEpochId: string;
}): ClarificationAnswerCheck {
  const { questionId, subject } = input;
  // A later ask with the same question id supersedes the earlier answer, so
  // an old approval can never authorize a newer, cancelled or re-asked choice.
  const latest = input.records
    .filter((row) => row.questionId === questionId)
    .sort((a, b) => recordTime(a) - recordTime(b))
    .at(-1);
  if (!latest) {
    return {
      issue: {
        code: "clarification_missing",
        questionId,
        detail: `${subject}引用了问题「${questionId}」的回答，但这个问题在当前项目中不存在；请先通过 ask_user_question 提问并等待回答。`,
      },
    };
  }
  if (latest.status !== "answered") {
    return {
      issue: {
        code: "clarification_not_answered",
        questionId,
        detail: `问题「${questionId}」${statusDetail(latest.status)}，不能作为${subject}的依据；请重新提问并等待用户回答。`,
      },
    };
  }
  if (latest.contextEpochId !== input.contextEpochId) {
    return {
      issue: {
        code: "clarification_expired",
        questionId,
        detail: latest.contextEpochId
          ? `问题「${questionId}」的回答属于更早的上下文，已过期；请在当前对话中重新确认，不能沿用旧回答修改${subject}。`
          : `问题「${questionId}」的回答没有记录当前上下文标记，无法证明它属于本次请求；请重新提问并等待回答。`,
      },
    };
  }
  const answer = (latest.answerText ?? "").trim();
  const stated = (input.answerText ?? "").trim();
  if (!answer || !stated || stated !== answer) {
    return {
      issue: {
        code: "clarification_mismatch",
        questionId,
        detail: `${subject}的 origin.text 与问题「${questionId}」的实际回答不一致；请把回答原文写入 origin.text，或重新提问。`,
      },
    };
  }
  return { record: latest };
}

/**
 * An answer recorded before the current decision cannot replace it. Repeating
 * the current decision is handled as idempotent by the caller, not here.
 */
export function supersededClarificationIssue(input: {
  currentDecidedAt: string;
  record: ClarificationRecord;
  subject: string;
}): RequirementAuthorityIssue | undefined {
  const answered = recordTime(input.record);
  const current = Date.parse(input.currentDecidedAt);
  if (!Number.isFinite(current) || answered > current) return undefined;
  return {
    code: "clarification_superseded",
    questionId: input.record.questionId,
    detail: `${input.subject}引用的回答早于当前有效的风格决定；旧回答不能覆盖新决定。请使用本轮最新的明确要求，或重新提问确认。`,
  };
}

/**
 * Only an explicit requirement backed by the user's own request or by the
 * latest answer to the same current-epoch question may constrain the plan.
 * Content sources and design references stay descriptive metadata.
 */
export function requirementAuthorityIssue(
  requirements: readonly ReportRequirement[],
  records: readonly ClarificationRecord[],
  contextEpochId: string,
): RequirementAuthorityIssue | undefined {
  for (const requirement of requirements) {
    if (requirement.origin.kind !== "clarification-answer") continue;
    const check = clarificationAnswerCheck({
      questionId: requirement.origin.questionId,
      subject: `要求「${requirement.statement}」`,
      answerText: requirement.origin.text,
      records,
      contextEpochId,
    });
    if (check.issue) return check.issue;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Task-dependent reads for the declared requirements.
// ---------------------------------------------------------------------------

export type PlanningReportRequirementCheck = Readonly<{
  ok: boolean;
  requirements: readonly ReportRequirement[];
  dependencies: readonly ReportMaterialDependency[];
  missing: readonly UnreadMaterialDependency[];
  unreadable: readonly UnreadableMaterialDependency[];
}>;

/**
 * Resolve the parts the declared requirements actually depend on and compare
 * them with current `read_material` receipts. A design receipt never satisfies
 * a per-page responsibility, and an unrelated part stays optional.
 */
export function checkPlanningReportRequirements(
  projectRoot: string,
  contextEpochId: string,
  requirements: readonly ReportRequirement[],
  options: MaterialRenderOptions = {},
): PlanningReportRequirementCheck {
  const kinds = readMaterialsManifest(projectRoot).map((entry) => ({
    materialId: entry.id,
    kind: entry.kind,
  }));
  const dependencies = materialDependenciesForRequirements(requirements, kinds);
  const check = checkReportMaterialDependencies(projectRoot, contextEpochId, dependencies, options);
  return { ...check, requirements, dependencies };
}
