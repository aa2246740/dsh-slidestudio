/**
 * Minimal report-requirement semantics over the existing request, run facts
 * and page plan. These are non-renderable metadata: content sources, explicit
 * user requirements and design references are tracked without introducing a
 * rule platform or a second deck model.
 *
 * Mandatory requirements come only from the user's own words or a valid
 * clarifying answer. An attachment can be a source, but its text never grants
 * itself instruction authority: constructors for requirements do not read
 * material bodies, and attachment origins are rejected.
 */
import { DESIGN_ASPECTS, type DesignAspect, type DesignAspects } from "./design-aspects.js";
import { materialChunkCount, type MaterialRenderOptions } from "./material-content.js";
import { MaterialPackError, verifyMaterial, type MaterialKind } from "./material-pack.js";
import { missingChunksForPart } from "./material-read-receipts.js";
import { readRunLedger } from "./run-ledger.js";
import {
  pageCountRequirementFromBrief,
  pageCountRequirementSummary,
  type PageCountRequirement,
} from "./page-count-requirement.js";

// ---------------------------------------------------------------------------
// Requirement roles, origins and material associations.
// ---------------------------------------------------------------------------

export const REPORT_REQUIREMENT_ROLES = ["content-source", "explicit-requirement", "design-reference"] as const;
export type ReportRequirementRole = (typeof REPORT_REQUIREMENT_ROLES)[number];

export type ReportRequirementOrigin =
  | Readonly<{ kind: "user-request"; text?: string }>
  | Readonly<{ kind: "clarification-answer"; questionId: string; text?: string }>;

export type ReportRequirementMaterial = Readonly<{
  materialId: string;
  aspects?: readonly DesignAspect[];
  parts?: readonly string[];
  /** Source pages the requirement talks about, when the user names them. */
  sourcePages?: readonly number[];
}>;

export type ReportRequirement = Readonly<{
  id: string;
  role: ReportRequirementRole;
  statement: string;
  origin: ReportRequirementOrigin;
  material?: ReportRequirementMaterial;
}>;

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be non-empty text`);
  return value.trim();
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be a list`);
  const items = value.map((entry) => text(entry, field));
  return [...new Set(items)];
}

export function normalizeSourcePages(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("material.sourcePages must be a list");
  const pages = value.map((page) => {
    if (!Number.isSafeInteger(page) || Number(page) < 1) {
      throw new Error("material.sourcePages must contain positive page numbers");
    }
    return Number(page);
  });
  return [...new Set(pages)];
}

function parseOrigin(value: unknown): ReportRequirementOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("requirement origin is required");
  }
  const origin = value as Record<string, unknown>;
  const kind = origin.kind;
  if (kind === "user-request") {
    return {
      kind,
      ...(typeof origin.text === "string" && origin.text.trim() ? { text: origin.text.trim() } : {}),
    };
  }
  if (kind === "clarification-answer") {
    return {
      kind,
      questionId: text(origin.questionId, "origin.questionId"),
      ...(typeof origin.text === "string" && origin.text.trim() ? { text: origin.text.trim() } : {}),
    };
  }
  throw new Error(
    "requirement origin must be user-request or a valid clarification-answer; attachment text cannot authorize a requirement",
  );
}

function parseMaterial(value: unknown): ReportRequirementMaterial | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("requirement material must be an object");
  }
  const material = value as Record<string, unknown>;
  const materialId = text(material.materialId, "material.materialId").replace(/^material:/, "");
  if (!materialId) throw new Error("material.materialId is required");
  const rawAspects = stringList(material.aspects, "material.aspects");
  for (const aspect of rawAspects) {
    if (!(DESIGN_ASPECTS as readonly string[]).includes(aspect)) {
      throw new Error(`material.aspects contains an invalid aspect: ${aspect}`);
    }
  }
  const aspects = rawAspects as DesignAspect[];
  const parts = stringList(material.parts, "material.parts");
  const pages = normalizeSourcePages(material.sourcePages);
  return {
    materialId,
    ...(aspects.length ? { aspects } : {}),
    ...(parts.length ? { parts } : {}),
    ...(pages.length ? { sourcePages: pages } : {}),
  };
}

/** Validate untrusted requirement declarations; never coerce an attachment into authority. */
export function normalizeReportRequirements(values: unknown): readonly ReportRequirement[] {
  if (!Array.isArray(values)) throw new Error("report requirements must be a list");
  const seen = new Set<string>();
  return values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("report requirement must be an object");
    }
    const record = value as Record<string, unknown>;
    const id = text(record.id, "requirement.id");
    if (seen.has(id)) throw new Error(`report requirement id is duplicated: ${id}`);
    seen.add(id);
    const role = record.role;
    if (typeof role !== "string" || !(REPORT_REQUIREMENT_ROLES as readonly string[]).includes(role)) {
      throw new Error(`report requirement role is invalid: ${String(role)}`);
    }
    const statement = text(record.statement, "requirement.statement");
    const origin = parseOrigin(record.origin);
    const material = parseMaterial(record.material);
    return {
      id,
      role: role as ReportRequirementRole,
      statement,
      origin,
      ...(material ? { material } : {}),
    };
  });
}

export function isEnforceableReportRequirement(requirement: ReportRequirement): boolean {
  return (
    requirement.role === "explicit-requirement" &&
    (requirement.origin.kind === "user-request" ||
      (requirement.origin.kind === "clarification-answer" && requirement.origin.questionId.length > 0))
  );
}

// ---------------------------------------------------------------------------
// Requirements from the existing planning request and design-aspect declarations.
// ---------------------------------------------------------------------------

const VISUAL_ASPECTS = new Set<DesignAspect>(["palette", "fonts", "logo", "layouts", "decorations", "photos"]);

function pageCountStatement(requirement: PageCountRequirement): string {
  return `页面数量：${pageCountRequirementSummary(requirement)}`;
}

/**
 * Build the minimum requirement metadata the existing planning path can prove:
 * an explicit page total from the user's brief or a valid answer, and the
 * content/design roles already declared through `designAspects`. Material
 * bodies are never read here, so attachment prose cannot become a requirement.
 */
export function planningReportRequirements(input: {
  readonly brief: string;
  readonly designAspects?: DesignAspects;
  readonly clarificationAnswers?: readonly { readonly questionId: string; readonly text: string }[];
}): readonly ReportRequirement[] {
  const requirements: ReportRequirement[] = [];
  const briefCount = pageCountRequirementFromBrief(input.brief);
  if (briefCount.kind !== "unspecified") {
    requirements.push({
      id: "page-count:brief",
      role: "explicit-requirement",
      statement: pageCountStatement(briefCount),
      origin: { kind: "user-request", text: input.brief },
    });
  }
  for (const answer of input.clarificationAnswers ?? []) {
    const questionId = text(answer.questionId, "clarification answer questionId");
    const count = pageCountRequirementFromBrief(answer.text);
    if (count.kind === "unspecified") continue;
    requirements.push({
      id: `page-count:answer:${questionId}`,
      role: "explicit-requirement",
      statement: pageCountStatement(count),
      origin: { kind: "clarification-answer", questionId, text: answer.text },
    });
  }
  for (const declaration of input.designAspects ?? []) {
    const sourceId = String(declaration.source ?? "").trim();
    if (!sourceId.includes("material:")) continue;
    const materialId = sourceId.slice(sourceId.indexOf("material:") + "material:".length);
    if (!materialId) continue;
    const aspects = [...new Set(declaration.aspects)];
    const contentAspects = aspects.filter((aspect) => aspect === "content" || aspect === "data");
    const designAspects = aspects.filter((aspect) => VISUAL_ASPECTS.has(aspect));
    if (contentAspects.length) {
      requirements.push({
        id: `material:${materialId}:content-source`,
        role: "content-source",
        statement: `内容来源：material:${materialId}（${contentAspects.join("、")}）`,
        origin: { kind: "user-request" },
        material: { materialId, aspects: contentAspects },
      });
    }
    if (designAspects.length) {
      requirements.push({
        id: `material:${materialId}:design-reference`,
        role: "design-reference",
        statement: `设计参考：material:${materialId}（${designAspects.join("、")}）`,
        origin: { kind: "user-request" },
        material: { materialId, aspects: designAspects },
      });
    }
  }
  return normalizeReportRequirements(requirements);
}

// ---------------------------------------------------------------------------
// Task-dependent material parts and their existing read receipts.
// ---------------------------------------------------------------------------

export const REPORT_MATERIAL_DEPENDENCY_REASONS = [
  "content-source",
  "design-reference",
  "per-page-responsibility",
  "layout-reuse",
  "table-check",
  "chart-explanation",
  "component-reuse",
] as const;
export type ReportMaterialDependencyReason = (typeof REPORT_MATERIAL_DEPENDENCY_REASONS)[number];

export type ReportMaterialDependency = Readonly<{
  materialId: string;
  part: string;
  reason: ReportMaterialDependencyReason;
  sourcePages?: readonly number[];
}>;

export type ReportMaterialKind = Readonly<{
  materialId: string;
  kind: MaterialKind;
  /** Table part id from list_materials, e.g. sheet:明细; defaults to rows. */
  defaultPart?: string;
}>;

import { materialPartDependency, perPageResponsibilityDependency } from "./report-requirement-parts.js";
export { materialPartDependency, perPageResponsibilityDependency };

function defaultContentPart(entry: ReportMaterialKind): string {
  switch (entry.kind) {
    case "deck-template":
      return "slides";
    case "document":
      return "document";
    case "text":
      return "text";
    case "image":
      return "image";
    case "table":
      return entry.defaultPart ?? "rows";
  }
}

function designParts(aspects: readonly DesignAspect[]): string[] {
  const parts = new Set<string>();
  for (const aspect of aspects) {
    if (aspect === "palette") parts.add("palette");
    else if (aspect === "layouts") parts.add("layouts");
    else if (VISUAL_ASPECTS.has(aspect)) parts.add("design");
  }
  return [...parts];
}

/**
 * The parts the declared requirements actually depend on. An explicit part
 * list wins; otherwise a content source resolves by material kind, source
 * pages imply `slides`, and visual aspects map to the part that carries them.
 */
function recordListedParts(
  requirement: ReportRequirement,
  materialId: string,
  parts: readonly string[],
  pages: readonly number[] | undefined,
  add: (dependency: ReportMaterialDependency) => void,
): void {
  const reason = requirement.role === "design-reference" ? "design-reference" : "content-source";
  for (const part of parts) {
    add(
      materialPartDependency(
        materialId,
        part,
        part === "slides" && pages?.length ? "per-page-responsibility" : reason,
        pages,
      ),
    );
  }
}

export function materialDependenciesForRequirements(
  requirements: readonly ReportRequirement[],
  materials: readonly ReportMaterialKind[] = [],
): readonly ReportMaterialDependency[] {
  const kinds = new Map(materials.map((entry) => [entry.materialId, entry]));
  const byKey = new Map<string, ReportMaterialDependency>();
  const add = (dependency: ReportMaterialDependency) => {
    const key = `${dependency.materialId}\u0000${dependency.part}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, dependency);
      return;
    }
    byKey.set(key, {
      ...existing,
      ...(existing.sourcePages || dependency.sourcePages
        ? {
            sourcePages: [...new Set([...(existing.sourcePages ?? []), ...(dependency.sourcePages ?? [])])],
          }
        : {}),
    });
  };
  for (const requirement of requirements) {
    if (!requirement.material) continue;
    const { materialId, parts = [], aspects = [], sourcePages: pages } = requirement.material;
    if (parts.length) {
      recordListedParts(requirement, materialId, parts, pages, add);
      continue;
    }
    if (requirement.role === "explicit-requirement") {
      // An explicit rule that names the source pages it constrains depends on
      // the source's per-page content, never on its design summary.
      if (aspects.length) {
        if (aspects.some((aspect) => aspect === "content" || aspect === "data")) {
          const entry = kinds.get(materialId);
          const part = entry ? defaultContentPart(entry) : "slides";
          add(
            materialPartDependency(
              materialId,
              part,
              part === "slides" && pages?.length ? "per-page-responsibility" : "content-source",
              pages,
            ),
          );
        }
        for (const part of designParts(aspects)) {
          add(
            materialPartDependency(materialId, part, part === "layouts" ? "layout-reuse" : "design-reference", pages),
          );
        }
        continue;
      }
      const entry = kinds.get(materialId);
      const part = entry ? defaultContentPart(entry) : "slides";
      add(
        materialPartDependency(
          materialId,
          part,
          part === "slides" ? "per-page-responsibility" : "content-source",
          pages,
        ),
      );
      continue;
    }
    if (requirement.role === "content-source") {
      const entry = kinds.get(materialId);
      add(materialPartDependency(materialId, entry ? defaultContentPart(entry) : "slides", "content-source", pages));
      continue;
    }
    if (requirement.role === "design-reference") {
      for (const part of designParts(aspects)) {
        add(materialPartDependency(materialId, part, part === "layouts" ? "layout-reuse" : "design-reference"));
      }
    }
  }
  return [...byKey.values()];
}

export type UnreadMaterialDependency = Readonly<{
  materialId: string;
  part: string;
  chunkIndex: number;
  rows?: Readonly<{ start: number; end: number }>;
  reason: ReportMaterialDependencyReason;
  sourcePages?: readonly number[];
}>;

export type UnreadableMaterialDependency = Readonly<{
  dependency: ReportMaterialDependency;
  detail: string;
}>;

export type ReportMaterialDependencyCheck = Readonly<{
  ok: boolean;
  missing: readonly UnreadMaterialDependency[];
  unreadable: readonly UnreadableMaterialDependency[];
}>;

/**
 * Check task dependencies against current `read_material` receipts. A receipt
 * from another material, a stale upload hash or a partial part stays missing;
 * an absent/tampered material or unreadable part is reported explicitly and
 * never counts as a successful read.
 */
export function checkReportMaterialDependencies(
  projectRoot: string,
  contextEpochId: string,
  dependencies: readonly ReportMaterialDependency[],
  options: MaterialRenderOptions = {},
): ReportMaterialDependencyCheck {
  const ledger = readRunLedger(projectRoot);
  const missing: UnreadMaterialDependency[] = [];
  const unreadable: UnreadableMaterialDependency[] = [];
  const byMaterial = new Map<string, ReportMaterialDependency[]>();
  for (const dependency of dependencies) {
    const list = byMaterial.get(dependency.materialId) ?? [];
    list.push(dependency);
    byMaterial.set(dependency.materialId, list);
  }
  for (const [materialId, parts] of byMaterial) {
    let material: ReturnType<typeof verifyMaterial>;
    try {
      material = verifyMaterial(projectRoot, materialId);
    } catch (error) {
      const detail =
        error instanceof MaterialPackError ? error.message : `资料 material:${materialId} 无法读取，请重新上传后再试`;
      for (const dependency of parts) unreadable.push({ dependency, detail });
      continue;
    }
    for (const dependency of parts) {
      try {
        const count = materialChunkCount(material, dependency.part, options);
        if (count < 1) {
          unreadable.push({
            dependency,
            detail: `资料「${material.name}」没有可读取的 ${dependency.part} 分部`,
          });
          continue;
        }
        const absent = missingChunksForPart(material, dependency.part, count, ledger, contextEpochId, options);
        for (const chunk of absent) {
          missing.push({
            materialId,
            part: dependency.part,
            chunkIndex: chunk.chunkIndex,
            ...(chunk.rows ? { rows: chunk.rows } : {}),
            reason: dependency.reason,
            ...(dependency.sourcePages ? { sourcePages: dependency.sourcePages } : {}),
          });
        }
      } catch (error) {
        unreadable.push({
          dependency,
          detail:
            error instanceof MaterialPackError
              ? error.message
              : `资料「${material.name}」的 ${dependency.part} 分部无法读取`,
        });
      }
    }
  }
  return { ok: missing.length === 0 && unreadable.length === 0, missing, unreadable };
}
