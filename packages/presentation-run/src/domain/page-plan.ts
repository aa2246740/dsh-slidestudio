import { validatePlanPageIds } from "./page-identity.js";

export const TODO_EXHIBIT_KINDS = [
  "none",
  "chart:bar",
  "chart:line",
  "chart:pie",
  "chart:doughnut",
  "chart:radar",
  "chart:stacked",
  "chart:percentStacked",
  "chart:waterfall",
  "chart:scatter",
  "chart:combo",
  "table",
  "photo",
  "diagram:funnel",
  "diagram:gauge",
  "diagram:pyramid",
  "diagram:matrix",
  "diagram:timeline",
  "kpi-cards",
  "comparison-cards",
] as const;
export type TodoExhibitKind = (typeof TODO_EXHIBIT_KINDS)[number];
const exhibitKinds = new Set<string>(TODO_EXHIBIT_KINDS);
export function isTodoExhibitKind(value: unknown): value is TodoExhibitKind {
  return typeof value === "string" && exhibitKinds.has(value);
}

export type CanonicalPlanPage = Readonly<{
  pageId: string;
  title: string;
  layoutFamily: string;
  exhibits: readonly TodoExhibitKind[];
  note?: string;
  purpose?: string;
  /** The write_layout id this page is planned to use; it sits beside layoutFamily. */
  layoutId?: string;
  /** Image material ids the agent planned for this page (`material:` prefix removed). */
  materials?: readonly string[];
}>;

function parsePlanMaterials(raw: unknown, index: number): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`plan[${index}].materials must be a list of material ids`);
  const ids = raw.map((value) => {
    const id = typeof value === "string" ? value.trim().replace(/^material:/, "") : "";
    if (!id) throw new Error(`plan[${index}].materials must contain only non-empty material ids`);
    return id;
  });
  return [...new Set(ids)];
}

/** Validate explicit model-authored metadata; never infer a plan from page content. */
export function parseCanonicalPagePlan(raw: unknown): readonly CanonicalPlanPage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("a complete page plan must contain at least one page");
  const pages = raw.map((item: unknown, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`plan[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    for (const key of ["pageId", "title", "layoutFamily"] as const) {
      if (typeof record[key] !== "string" || !record[key].trim()) throw new Error(`plan[${index}].${key} is required`);
    }
    if (!Array.isArray(record.exhibits) || !record.exhibits.every(isTodoExhibitKind)) {
      throw new Error(`plan[${index}].exhibits must explicitly list supported exhibit kinds, or be empty`);
    }
    if (record.exhibits.includes("none") && record.exhibits.length !== 1)
      throw new Error(`plan[${index}] mixes none with required exhibits`);
    for (const key of ["note", "purpose", "layoutId"] as const) {
      if (record[key] !== undefined && typeof record[key] !== "string")
        throw new Error(`plan[${index}].${key} must be text`);
    }
    const materials = parsePlanMaterials(record.materials, index);
    return {
      pageId: (record.pageId as string).trim(),
      title: (record.title as string).trim(),
      layoutFamily: (record.layoutFamily as string).trim(),
      exhibits: [...record.exhibits],
      ...(typeof record.note === "string" ? { note: record.note } : {}),
      ...(typeof record.purpose === "string" ? { purpose: record.purpose } : {}),
      ...(typeof record.layoutId === "string" && record.layoutId.trim() ? { layoutId: record.layoutId.trim() } : {}),
      ...(materials.length ? { materials } : {}),
    };
  });
  const identities = validatePlanPageIds(pages.map((page) => page.pageId));
  if (!identities.ok) throw new Error(identities.reason);
  return pages.map((page, index) => ({ ...page, pageId: identities.canonicalIds[index]! }));
}
