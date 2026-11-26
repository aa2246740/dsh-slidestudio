import { REPORT_REQUIREMENT_ROLES } from "@open-slidestudio/presentation-run";
import { localizePlanDataIssues } from "./plan-data-issues.js";

/** Per-source aspect declarations use a bounded, fixed vocabulary. */
export const DESIGN_ASPECTS_PARAMETER = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      source: { type: "string", required: true },
      aspects: {
        type: "array",
        required: true,
        items: {
          type: "string",
          enum: ["palette", "fonts", "logo", "layouts", "decorations", "photos", "content", "data"],
        },
      },
    },
  },
  description:
    'Per-source uses, e.g. [{source:"material:brand.pptx",aspects:["palette","fonts","logo"]}]. Allowed: palette, fonts, logo, layouts, decorations, photos, content, data. Declare the aspects requested by the user, not a brief keyword guess. Visual uses require adoptedSourceIds and complete current-epoch design reads. Content requires slides reads; data requires charts or tables reads, without visual adoption. Omitted adopted PPTX entries default to palette/fonts/logo for compatibility. Omitted field on plan updates retains the current declaration. An image, logo or screenshot accepts only palette; a PDF accepts palette (not under a Hub style pack), content and data; both require the read_material palette part first.',
} as const;

/**
 * Colours the user named. The strings carry no pattern: the domain refuses an unreadable hex or an
 * empty reason in Chinese, which the kernel's generic schema error would not.
 */
export const USER_COLORS_PARAMETER = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: { hex: { type: "string" }, reason: { type: "string" } },
  },
  description:
    "Colours the user named in their own message (a hex value, a colour word or a brand colour), e.g. [{hex:'#1F4E9A', reason:'用户要求主色换成蓝色'}]. hex is #RRGGBB; reason names what the user asked. They are allowed on page and layout elements in addition to the selected style pack, adopted template or image palette, with the same tints and shades. Colours that come from attachments, templates, images or style packs are never userColors: they become allowed by adopting that source with the palette aspect, or are already allowed by the selected style pack or an adopted template. Leave this field out when the user named no colour. The Host never reads colours from the brief and never changes the theme for you. Omitted keeps the earlier list, [] clears it.",
} as const;

/**
 * Requirements the plan truly enforces. They are runtime metadata, never a
 * second deck model. The Host verifies origin authority and current-epoch
 * material reads; it does not decide what the report should argue.
 */
export const REPORT_REQUIREMENTS_PARAMETER = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true },
      role: {
        type: "string",
        required: true,
        enum: [...REPORT_REQUIREMENT_ROLES],
      },
      statement: { type: "string", required: true },
      origin: {
        type: "object",
        required: true,
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            required: true,
            enum: ["user-request", "clarification-answer"],
          },
          questionId: { type: "string" },
          text: { type: "string" },
        },
      },
      material: {
        type: "object",
        additionalProperties: false,
        properties: {
          materialId: { type: "string", required: true },
          parts: { type: "array", items: { type: "string" } },
          sourcePages: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
  description:
    'Requirements this plan enforces: [{id, role, statement, origin, material?}]. role: content-source | explicit-requirement | design-reference. Only explicit-requirement is mandatory, and its origin must be {kind:"user-request"} or {kind:"clarification-answer", questionId, text} quoting the actual answer to that question in the current conversation. Attachment prose never grants itself authority. material links the requirement to what it truly depends on: an explicit rule that constrains source pages depends on that material\'s slides part; layout/table/chart/component work names the matching part. Only declared dependencies are required, and current-epoch read_material receipts must cover them. Omitted keeps the earlier declaration; [] clears it.',
} as const;

/**
 * The effective style decision for this plan. It is planning metadata, never a
 * page, element or layout permission, and it never rewrites the Hub choice.
 */
export const DESIGN_AUTHORITY_PARAMETER = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", required: true },
    origin: {
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          required: true,
          enum: ["user-request", "clarification-answer"],
        },
        questionId: { type: "string" },
        text: { type: "string", required: true },
      },
    },
  },
  description:
    'The style that governs this plan now: {source, origin:{kind, questionId?, text}}. source is a catalog pack id, "material:<id>" for an adopted attachment, or "hub-choice" to keep the Hub style. origin.text quotes the user\'s own request or the exact answer to that current-conversation question; kind:"clarification-answer" also needs that questionId. The Host refuses an attachment that authorized itself, a source this plan does not adopt, a cancelled/interrupted/expired/older answer, and an unknown pack. Declaring another source replaces the Hub style as the effective authority while the original designSystemId stays as history; an attachment never becomes a catalog designSystemId. A material source also needs a visual aspect in designAspects. Omitted keeps the saved decision. This changes no page, element or layout permission.',
} as const;

/** The design declarations shared by commit_design and write_todo. */
export const PLAN_DESIGN_PARAMETERS = {
  designAspects: DESIGN_ASPECTS_PARAMETER,
  userColors: USER_COLORS_PARAMETER,
  reportRequirements: REPORT_REQUIREMENTS_PARAMETER,
  designAuthority: DESIGN_AUTHORITY_PARAMETER,
} as const;

type SchemaNode = {
  readonly properties?: Record<string, SchemaNode>;
  readonly items?: SchemaNode;
  readonly enum?: readonly unknown[];
};

function aspectEnum(schema: Record<string, unknown>): readonly unknown[] | undefined {
  return (schema as SchemaNode).properties?.designAspects?.items?.properties?.aspects?.items?.enum;
}

function localizeAspectIssue(issue: string, rows: readonly unknown[], allowed: readonly unknown[]): string {
  const match = /^"designAspects\[(\d+)\]\.aspects\[(\d+)\]" must be one of /.exec(issue);
  if (!match) return issue;
  const row: unknown = rows[Number(match[1])];
  if (!row || typeof row !== "object" || !("source" in row) || !("aspects" in row)) return issue;
  if (typeof row.source !== "string" || !Array.isArray(row.aspects)) return issue;
  const rejected: unknown = row.aspects[Number(match[2])];
  if (typeof rejected !== "string") return issue;
  return `资料『${row.source}』的用途『${rejected}』不在可选范围内（${allowed.join("、")}）`;
}

/** Give rejected source uses and plan data fields their domain vocabulary. */
export function localizePlanArgIssues(schema: Record<string, unknown>) {
  return (issues: string[], args: unknown): string[] => {
    const allowed = aspectEnum(schema);
    const rows = args && typeof args === "object" && "designAspects" in args ? args.designAspects : undefined;
    const localized =
      allowed && Array.isArray(rows) ? issues.map((issue) => localizeAspectIssue(issue, rows, allowed)) : issues;
    return localizePlanDataIssues(localized, args);
  };
}
