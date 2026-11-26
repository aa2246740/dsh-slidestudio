/**
 * Image-placement parameters of `write_todo` (CAP-12). The per-image `use`
 * values carry no schema enum on purpose: the domain refuses a bad value in
 * Chinese, which the kernel's generic enum error would not.
 */

/** `items[].materials`: uploaded image ids planned for that page. */
export const PLAN_MATERIALS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: "Uploaded image ids (list_materials ids) this page shows; images only.",
} as const;

/** Top-level `materialUse`: what the plan does with images that are not simply placed. */
export const MATERIAL_USE_PARAMETER = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      materialId: { type: "string" },
      use: { type: "string" },
      reason: { type: "string" },
    },
  },
  description:
    "Per uploaded image: [{materialId, use, reason}]. use: placed | background | logo | style-reference | excluded. excluded needs a reason the user can read; a style-reference image needs no page; images in items[].materials need an entry only for background or logo. Omitted keeps the earlier declaration, [] clears it. Every uploaded image should end on a page, as a style-reference, or excluded with a reason.",
} as const;

/**
 * Top-level `periodMap` (CAP-17): the period last month's deck covers and the one this deck covers.
 * The strings carry no pattern: the domain refuses an unreadable period in Chinese.
 */
export const PERIOD_MAP_PARAMETER = {
  type: "object",
  additionalProperties: false,
  properties: { from: { type: "string" }, to: { type: "string" } },
  description:
    "Monthly update: {from, to}. from is the period last month's deck covers, to is the period this deck covers, e.g. {from:'2026年8月', to:'2026年9月'} or '2026-08' to '2026-09'. With it the Host flags numbers copied from last month's charts and tables (a non-blocking hint). Omitted keeps the earlier map.",
} as const;

/** Top-level `missingItems` (CAP-17): template charts and tables with no new-period data. */
export const MISSING_ITEMS_PARAMETER = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      page: { type: "number" },
      title: { type: "string" },
      materialId: { type: "string" },
    },
  },
  description:
    "Template charts or tables you have no new-period data for, the whole item or only some of its data points (blank cells in the new data table): [{page, title}], page and title as read_material lists them in the charts or tables part (optional materialId). Needs periodMap and that part read completely. The Host verifies each item and shows it on the delivery card as having no data for this period. Omitted keeps the earlier list, [] clears it.",
} as const;

/** The write_todo parameters that record how uploaded materials are used. */
export const WRITE_TODO_DATA_PARAMETERS = {
  materialUse: MATERIAL_USE_PARAMETER,
  periodMap: PERIOD_MAP_PARAMETER,
  missingItems: MISSING_ITEMS_PARAMETER,
} as const;

/** The plan item schema of commit_design, extended with the write_todo-only `materials`. */
export function writeTodoItemsParameter<T extends { readonly items: { readonly properties: Record<string, unknown> } }>(
  base: T,
): T {
  return {
    ...base,
    items: {
      ...base.items,
      properties: { ...base.items.properties, materials: PLAN_MATERIALS_PROPERTY },
    },
  };
}
