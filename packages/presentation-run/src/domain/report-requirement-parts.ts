import {
  normalizeSourcePages,
  text,
  type ReportMaterialDependency,
  type ReportMaterialDependencyReason,
} from "./report-requirements.js";

export type { ReportMaterialDependency, ReportMaterialDependencyReason };

/** One thing the task truly depends on; unrelated parts are never required. */
export function materialPartDependency(
  materialId: string,
  part: string,
  reason: ReportMaterialDependencyReason,
  sourcePages?: readonly number[],
): ReportMaterialDependency {
  const id = text(materialId, "dependency.materialId").replace(/^material:/, "");
  const pageList = sourcePages ? normalizeSourcePages(sourcePages) : [];
  return {
    materialId: id,
    part: text(part, "dependency.part"),
    reason,
    ...(pageList.length ? { sourcePages: pageList } : {}),
  };
}

/**
 * Per-page responsibility is source-page work: it needs the source's `slides`
 * part. Reading only `design` describes colours/type and can never satisfy it.
 */
export function perPageResponsibilityDependency(
  materialId: string,
  sourcePages?: readonly number[],
): ReportMaterialDependency {
  return materialPartDependency(materialId, "slides", "per-page-responsibility", sourcePages);
}
