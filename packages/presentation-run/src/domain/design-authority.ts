/**
 * The project's current effective design authority.
 *
 * The Hub style chosen when the project opened stays in the presentation-run
 * binding and in `_agent/runtime.json#designSystemId` as history. A later
 * explicit user decision, or a valid current-epoch answer to a style question,
 * can make another source effective without pretending an attachment is a
 * catalog `designSystemId`. Requirements stay metadata; this module only
 * answers which source currently governs colour, type and layout language.
 *
 * No decision is invented here: this module never reads an attachment body and
 * never turns a reference into authority.
 */
import fs from "node:fs";
import path from "node:path";
import { verifyMaterial } from "./material-pack.js";
import {
  clarificationAnswerCheck,
  supersededClarificationIssue,
  type ClarificationRecord,
} from "./report-authority.js";

const RUNTIME_REL = path.join("_agent", "runtime.json");

/** A declaration that keeps the Hub choice; stored so supersession has a timestamp. */
export const HUB_CHOICE_SOURCE = "hub-choice";

export type DesignAuthorityOrigin =
  | Readonly<{ kind: "user-request"; text: string }>
  | Readonly<{ kind: "clarification-answer"; questionId: string; text: string }>;

export type DesignAuthority = Readonly<{
  /** `material:<id>`, a catalog pack id, or `hub-choice`. */
  source: string;
  origin: DesignAuthorityOrigin;
  /** When this decision became current; an older answer never replaces it. */
  decidedAt: string;
}>;

export type DesignAuthorityIssue = Readonly<{
  code: string;
  detail: string;
  questionId?: string;
}>;

const MATERIAL_SOURCE = /^material:([^/\\\0]+)$/;
const PACK_SOURCE = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VISUAL_ASPECTS = new Set(["palette", "fonts", "logo", "layouts", "decorations", "photos"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be non-empty text`);
  return value.trim();
}

/** The material id of `material:<id>`, or undefined for a catalog id or `hub-choice`. */
export function designAuthorityMaterialId(source: string): string | undefined {
  const match = MATERIAL_SOURCE.exec(source.trim());
  const id = match?.[1]?.trim();
  return id && !id.includes("..") ? id : undefined;
}

export function isHubChoiceAuthority(authority: DesignAuthority): boolean {
  return authority.source === HUB_CHOICE_SOURCE;
}

/**
 * The catalog pack the effective authority names, if any. A material authority
 * and `hub-choice` never claim a catalog id.
 */
export function authorityCatalogPackId(
  authority: DesignAuthority | undefined,
  hubPackId: string | undefined,
): string | undefined {
  if (!authority) return hubPackId;
  if (isHubChoiceAuthority(authority)) return hubPackId;
  return designAuthorityMaterialId(authority.source) ? undefined : authority.source;
}

/** Validate one model declaration. `decidedAt` belongs to the Host, never to the model. */
export function normalizeDesignAuthority(value: unknown): DesignAuthority {
  const rec = record(value);
  const source = text(rec.source, "designAuthority.source");
  if (source !== HUB_CHOICE_SOURCE && !designAuthorityMaterialId(source) && !PACK_SOURCE.test(source)) {
    throw new Error("designAuthority.source must be material:<id>, a catalog pack id, or hub-choice");
  }
  const origin = record(rec.origin);
  const stated = text(origin.text, "designAuthority.origin.text");
  if (origin.kind === "user-request") {
    return { source, origin: { kind: "user-request", text: stated }, decidedAt: "" };
  }
  if (origin.kind === "clarification-answer") {
    return {
      source,
      origin: {
        kind: "clarification-answer",
        questionId: text(origin.questionId, "designAuthority.origin.questionId"),
        text: stated,
      },
      decidedAt: "",
    };
  }
  throw new Error(
    "designAuthority.origin must be user-request or a valid clarification-answer; an attachment cannot authorize a style switch",
  );
}

export type DesignAuthorityReading =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "invalid"; detail: string }>
  | Readonly<{ kind: "valid"; authority: DesignAuthority }>;

export type ProvenanceDesignSource = Readonly<{
  /** The original Hub pack, kept as history. */
  hubDesignSystemId: string | null;
  /** The catalog pack the effective decision names, if any. */
  designSystemId: string | null;
  authority?: DesignAuthority;
}>;

/** The design section of delivery provenance: history beside the effective decision. */
export function provenanceDesignSource(projectRoot: string): ProvenanceDesignSource {
  const reading = readDesignAuthority(projectRoot);
  const hub = readHubDesignSystemId(projectRoot) ?? null;
  const authority = reading.kind === "valid" ? reading.authority : undefined;
  return {
    hubDesignSystemId: hub,
    designSystemId: authorityCatalogPackId(authority, hub ?? undefined) ?? null,
    ...(authority ? { authority } : {}),
  };
}

function parseSavedDesignAuthority(value: unknown): DesignAuthority {
  const rec = record(value);
  const authority = normalizeDesignAuthority(rec);
  const decidedAt = typeof rec.decidedAt === "string" ? rec.decidedAt.trim() : "";
  if (!decidedAt || !Number.isFinite(Date.parse(decidedAt))) {
    throw new Error("designAuthority.decidedAt must be a valid timestamp");
  }
  return { ...authority, decidedAt };
}

/** The saved decision, absent for projects that never needed one, or invalid (fail closed). */
export function readDesignAuthority(projectRoot: string): DesignAuthorityReading {
  const file = path.join(projectRoot, RUNTIME_REL);
  if (!fs.existsSync(file)) return { kind: "absent" };
  let runtime: Record<string, unknown>;
  try {
    runtime = record(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return { kind: "invalid", detail: "无法读取项目的运行记录，不能确认当前风格权威" };
  }
  if (!Object.prototype.hasOwnProperty.call(runtime, "designAuthority")) return { kind: "absent" };
  try {
    return { kind: "valid", authority: parseSavedDesignAuthority(runtime.designAuthority) };
  } catch (error) {
    return {
      kind: "invalid",
      detail: `保存的风格权威无效：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The original Hub pack in runtime, kept as history; undefined for freestyle. */
export function readHubDesignSystemId(projectRoot: string): string | undefined {
  try {
    const runtime = record(JSON.parse(fs.readFileSync(path.join(projectRoot, RUNTIME_REL), "utf8")));
    const id = typeof runtime.designSystemId === "string" ? runtime.designSystemId.trim() : "";
    return id && id !== "freestyle" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The catalog pack every existing palette/theme check must use now. */
export function effectiveCatalogPackId(projectRoot: string, fallbackHubPackId?: string): string | undefined {
  const hub = readHubDesignSystemId(projectRoot) ?? fallbackHubPackId;
  const reading = readDesignAuthority(projectRoot);
  if (reading.kind === "valid") return authorityCatalogPackId(reading.authority, hub);
  return hub;
}

/**
 * True when a valid saved decision leaves a catalog pack in force. Host and the
 * Agent hand both read this, so a legitimate style switch counts as the user's
 * explicit choice in either place; with no decision it is false and the
 * direction-derived limits stay as they were.
 */
export function decidedCatalogPackIsExplicit(projectRoot: string, fallbackHubPackId?: string): boolean {
  return (
    Boolean(effectiveCatalogPackId(projectRoot, fallbackHubPackId)) && readDesignAuthority(projectRoot).kind === "valid"
  );
}

export type PlanningDesignAuthority = Readonly<{
  /** The effective decision; undefined when the project never declared one. */
  authority?: DesignAuthority;
  /** The already-saved decision, used to reject an older answer. */
  existing?: DesignAuthority;
  declared: boolean;
  issue?: DesignAuthorityIssue;
}>;

/**
 * Resolve the plan call's own declaration, else the saved decision. An omitted
 * field keeps the saved authority; an unreadable saved record fails closed
 * instead of silently relaxing the Hub restriction.
 */
export function resolvePlanningDesignAuthority(
  projectRoot: string,
  args: Record<string, unknown>,
): PlanningDesignAuthority {
  const reading = readDesignAuthority(projectRoot);
  const existing = reading.kind === "valid" ? reading.authority : undefined;
  if (!Object.prototype.hasOwnProperty.call(args, "designAuthority")) {
    if (reading.kind === "invalid") {
      return {
        declared: false,
        issue: {
          code: "design_authority_invalid",
          detail: `${reading.detail}；请在本次规划中重新声明当前风格，或声明 hub-choice 保留首页风格。`,
        },
      };
    }
    return { declared: false, ...(existing ? { authority: existing, existing } : {}) };
  }
  try {
    return {
      declared: true,
      authority: normalizeDesignAuthority(args.designAuthority),
      ...(existing ? { existing } : {}),
    };
  } catch (error) {
    return {
      declared: true,
      issue: {
        code: "design_authority_invalid",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export type PlanningStyleAuthority = PlanningDesignAuthority & Readonly<{ stylePackId?: string }>;

/**
 * The plan call's effective style, after validating that a clarification answer
 * is the latest usable answer for this project and current context. Requirement
 * and style decisions share this rule, so a cancelled, interrupted, expired or
 * superseded answer never changes either one.
 */
export function resolvePlanningStyleAuthority(input: {
  projectRoot: string;
  args: Record<string, unknown>;
  hubPackId?: string;
  records: readonly ClarificationRecord[];
  contextEpochId: string;
}): PlanningStyleAuthority {
  const planned = resolvePlanningDesignAuthority(input.projectRoot, input.args);
  const stylePackId = authorityCatalogPackId(planned.authority, input.hubPackId);
  if (planned.issue || !planned.authority) return { ...planned, stylePackId };
  const { authority, existing } = planned;
  if (authority.origin.kind !== "clarification-answer") return { ...planned, stylePackId };
  const subject = `风格决定「${authority.source}」`;
  const check = clarificationAnswerCheck({
    questionId: authority.origin.questionId,
    subject,
    answerText: authority.origin.text,
    records: input.records,
    contextEpochId: input.contextEpochId,
  });
  if (check.issue) return { ...planned, issue: check.issue, stylePackId };
  if (check.record && existing && existing.source !== authority.source) {
    const superseded = supersededClarificationIssue({
      currentDecidedAt: existing.decidedAt,
      record: check.record,
      subject,
    });
    if (superseded) return { ...planned, issue: superseded, stylePackId };
  }
  return { ...planned, stylePackId };
}

/** True when a repeated declaration names the same decision and must not switch twice. */
export function sameDesignAuthorityDecision(left: DesignAuthority, right: DesignAuthority): boolean {
  if (left.source !== right.source || left.origin.kind !== right.origin.kind) return false;
  if (left.origin.kind === "clarification-answer" && right.origin.kind === "clarification-answer") {
    return left.origin.questionId === right.origin.questionId && left.origin.text === right.origin.text;
  }
  return true;
}

/** Stamp a new decision, or keep the existing timestamp for a duplicate. */
export function designAuthorityDecision(authority: DesignAuthority, existing?: DesignAuthority): DesignAuthority {
  if (existing && sameDesignAuthorityDecision(existing, authority)) return existing;
  return { ...authority, decidedAt: new Date().toISOString() };
}

export type DesignAuthoritySourceInput = Readonly<{
  projectRoot: string;
  authority: DesignAuthority;
  hubPackId?: string;
  adoptedSourceIds: readonly string[];
  designAspects: readonly Readonly<{ source: string; aspects: readonly string[] }>[];
  knownCatalogPack: (id: string) => boolean;
}>;

function aspectsFor(rows: DesignAuthoritySourceInput["designAspects"], source: string): readonly string[] {
  const wantedMaterial = designAuthorityMaterialId(source);
  for (const row of rows) {
    const rowSource = String(row.source ?? "").trim();
    if (rowSource === source) return row.aspects;
    const candidate = designAuthorityMaterialId(rowSource);
    if (wantedMaterial && candidate && candidate === wantedMaterial) return row.aspects;
  }
  return [];
}

/**
 * Validate that the decision names a real source the plan actually uses. This
 * is still planning metadata: it grants no page, element or layout edit right.
 */
export function designAuthoritySourceIssue(input: DesignAuthoritySourceInput): DesignAuthorityIssue | undefined {
  const { authority } = input;
  if (isHubChoiceAuthority(authority)) return undefined;
  const materialId = designAuthorityMaterialId(authority.source);
  if (!materialId) {
    if (!input.knownCatalogPack(authority.source)) {
      return {
        code: "design_authority_unknown_pack",
        detail: `风格「${authority.source}」不在当前目录中；请改用目录里的风格，或声明 hub-choice 保留首页风格。`,
      };
    }
    return undefined;
  }
  const adopted = input.adoptedSourceIds.some(
    (id) => String(id).trim() === authority.source || designAuthorityMaterialId(String(id)) === materialId,
  );
  if (!adopted) {
    return {
      code: "design_authority_not_adopted",
      detail: `风格决定引用了附件 ${authority.source}，但本次计划没有采用它；请把 ${authority.source} 加入 adoptedSourceIds，或只把它作为参考。`,
    };
  }
  try {
    verifyMaterial(input.projectRoot, materialId);
  } catch (error) {
    return {
      code: "design_authority_material_invalid",
      detail: `风格决定引用的附件 ${authority.source} 无法通过回执校验：${
        error instanceof Error ? error.message : "资料校验失败"
      }。请重新上传后再试。`,
    };
  }
  if (!aspectsFor(input.designAspects, authority.source).some((aspect) => VISUAL_ASPECTS.has(aspect))) {
    return {
      code: "design_authority_missing_aspect",
      detail: `风格决定引用了 ${authority.source}，但没有声明配色、字体、Logo、版式、装饰或照片用途；请声明用户要求的视觉用途，或不要把它作为当前风格。`,
    };
  }
  return undefined;
}
