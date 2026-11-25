import type { Animation, Fill, PptdElement } from "./types.js";
import { SUPPORTED_SHAPE_NAMES } from "./shape-catalog.js";
import { CUSTOM_SHAPE_NAME, customGeometryIssues } from "./custom-geometry.js";
import { record, typeIssue, unionIssues } from "./write-page-diagnostics.js";
import { misplacedStyleIssue } from "./write-page-style-catalog.js";
import { PROVENANCE_PROPERTY, canonicalProvenanceIssues, type ProvenanceDeclaration } from "./write-page-provenance.js";
import { semanticIssues } from "./write-page-semantics.js";
import { effectIssues, fillEffectIssues, shadowIssues } from "./effect-issues.js";

export type Schema =
  | {
      readonly type: "string";
      readonly enum?: readonly string[];
      readonly const?: string;
      readonly description?: string;
    }
  | { readonly type: "number"; readonly description?: string }
  | { readonly type: "integer"; readonly description?: string }
  | { readonly type: "boolean"; readonly description?: string }
  | { readonly type: "null"; readonly description?: string }
  | {
      readonly type: "array";
      readonly items?: Schema;
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly description?: string;
    }
  | {
      readonly type: "object";
      readonly properties?: PropertyMap;
      readonly additionalProperties: boolean;
      readonly description?: string;
    }
  | { readonly oneOf: readonly [Schema, Schema, ...Schema[]]; readonly description?: string };

export type Property = Schema & { readonly required?: true };
export type PropertyMap = Readonly<Record<string, Property>>;

export const string = (description?: string) => ({ type: "string", ...(description ? { description } : {}) }) as const;
export const number = (description?: string) => ({ type: "number", ...(description ? { description } : {}) }) as const;
export const boolean = (description?: string) =>
  ({ type: "boolean", ...(description ? { description } : {}) }) as const;
export const array = (items: Schema, description?: string) =>
  ({ type: "array", items, ...(description ? { description } : {}) }) as const;
const tuple = (items: Schema, length: number, description?: string) =>
  ({ ...array(items, description), minItems: length, maxItems: length }) as const;
export const object = (properties: PropertyMap, additionalProperties = false, description?: string) =>
  ({
    type: "object",
    properties,
    additionalProperties,
    ...(description ? { description } : {}),
  }) as const;
export const oneOf = (...branches: [Schema, Schema, ...Schema[]]) => ({ oneOf: branches }) as const;
export const required = <T extends Schema>(schema: T): T & { readonly required: true } =>
  ({ ...schema, required: true }) as T & { readonly required: true };

const color = string("Official #RRGGBB/#RRGGBBAA or an adopted Theme.colors $token.");
const finiteNumberArray = array(number());
const bounds = tuple(number(), 4, "Exactly [x,y,width,height]; all values finite and width/height positive.");
const alignment = tuple(string(), 2, "Exactly [horizontal,vertical].");

const fit = object({ mode: required({ type: "string", enum: ["fill", "contain", "cover"] }) });
const imageCrop = object(
  { left: number(), top: number(), right: number(), bottom: number() },
  false,
  "Fractions from 0 to 1 of the picture removed from each side. left plus right and top plus bottom must stay below 1.",
);
const shapeNameOrCustom = {
  type: "string",
  enum: [...SUPPORTED_SHAPE_NAMES, CUSTOM_SHAPE_NAME],
  description:
    "Use an official SHAPE_CATALOG name (for example rect, roundRect, ellipse, triangle), or custom together with geometry for a free path. Accepted alias: rectangle means rect. Unknown names are rejected for new writes.",
} as const;
const customGeometry = object(
  {
    viewBox: required(tuple(number(), 2, "Exactly two positive numbers [width,height] in path units.")),
    path: required(
      string(
        "Absolute M/L/C/Q/Z path in viewBox units: one command letter per segment, at most 256 segments and 4 KiB. arcTo and H/V/S/T are not allowed.",
      ),
    ),
  },
  false,
  "Required when shapeName is custom; never on a preset shape.",
);
const imageCropShape = object(
  {
    shapeName: required(shapeNameOrCustom),
    adjustments: finiteNumberArray,
    geometry: customGeometry,
  },
  false,
  "A picture clip: an official preset name, or custom with geometry (the picture is drawn inside that path).",
);
const gradientStop = object({
  position: required(number()),
  color: required(color),
  alpha: number("Stop opacity from 0 to 1; it multiplies the alpha of the colour."),
});
const solidFill = object({
  type: required({ type: "string", const: "solid" }),
  color: required(color),
});
const gradientFill = object({
  type: required({ type: "string", const: "gradient" }),
  gradientType: required({ type: "string", enum: ["linear", "radial"] }),
  stops: required(array(gradientStop)),
  angle: number("Degrees clockwise, 0 is left to right. Leaving it out resets it to 0."),
});
const imageFill = object({
  type: required({ type: "string", const: "image" }),
  src: required(string()),
  fit,
  opacity: number(),
  mode: {
    type: "string",
    enum: ["stretch", "tile"],
    description: "stretch (default) draws the picture once across the shape; tile repeats it at natural size.",
  },
  crop: imageCrop,
});
export const fill = oneOf(solidFill, gradientFill, imageFill);
const border = object({
  style: string(),
  width: number(
    "Stroke width in PPTD px for every shape and line (1 px = 9525 EMU = 0.75 pt), the same unit as x and y. A colour without a width draws 1 px; an unstyled line draws 2 px.",
  ),
  color,
});
const shadow = object(
  {
    blur: number("Blur radius in PPTD px; zero or more."),
    color,
    offsetX: number(),
    offsetY: number(),
    opacity: number("Shadow opacity from 0 to 1; it multiplies the alpha of the colour."),
  },
  false,
  "Element shadow in PPTD px. Omitted blur, offsetX and offsetY take 12, 0 and 4.",
);
const smartArt = object({
  id: required(string()),
  layout: required({ type: "string", enum: ["process", "cycle", "hierarchy"] }),
  role: required({ type: "string", enum: ["node", "label", "connector"] }),
  index: { type: "integer" },
  pinned: boolean(),
});

const baseProperties = {
  elementId: required(string("Stable id unique within the page.")),
  bounds: required(bounds),
  rotation: number(),
  opacity: number(),
  flipH: boolean(),
  flipV: boolean(),
  locked: boolean(),
  hidden: boolean(),
  groupId: string(),
  shadow,
  layoutRole: { type: "string", enum: ["footer", "content", "decoration"] },
  exhibitRole: {
    type: "string",
    enum: ["funnel", "gauge", "pyramid", "matrix", "timeline", "kpi-card", "comparison-card"],
  },
  smartArt,
} as const satisfies PropertyMap;

const textContent = object({
  text: required(
    string(
      'Plain or rich-text HTML string. Quote numeric labels too: "1", "2", "3". Inline CSS belongs only inside this string.',
    ),
  ),
  style: string("Theme text-style reference such as $title. Never pass a style object here."),
  color,
  fontSize: number("Font size belongs directly on content."),
  fontFamily: oneOf(
    string(
      "Only a common Office face: 微软雅黑, 黑体, 宋体, 楷体, 仿宋, Arial, Times New Roman, Georgia, Verdana, Tahoma, Courier New. Any other name is rewritten to the closest one and reported back.",
    ),
    object({
      latin: required(string("Latin face from the same list.")),
      ea: required(string("East Asian face from the same list.")),
    }),
  ),
  bold: boolean(),
  italic: boolean(),
  underline: boolean(),
  backgroundColor: color,
  lineHeight: number(),
  letterSpacing: number(),
  align: alignment,
  wrap: boolean(),
  list: { type: "string", enum: ["bullet", "number"] },
  href: string(),
  field: {
    type: "string",
    enum: ["pageNumber"],
    description:
      "pageNumber shows the page's own number: {page} becomes its 1-based position and {pages} the deck total. Never zero-pad the tokens.",
  },
});

const tableCell = object({
  text: string(),
  bold: boolean(),
  color,
  fill,
  align: alignment,
  rowSpan: { type: "integer" },
  colSpan: { type: "integer" },
});
const chartScalar = oneOf(number(), string(), { type: "null" });
const chartData = object({
  cols: required(array(string())),
  rows: required(array(array(chartScalar))),
});
const chartSeries = object({
  type: required(string()),
  name: string(),
  encode: object({}, true),
  fill: oneOf(string(), gradientFill),
  axis: { type: "string", enum: ["primary", "secondary"] },
});
const chartAxis = object({ x: string(), y: string(), secondaryY: string() });
const lineArrow = oneOf(
  {
    type: "string",
    enum: ["arrow", "stealth", "diamond", "oval", "none", "null", ""],
    description: 'Use JSON null for no head. The string "null", none, or {} are accepted and stored as no head.',
  },
  { type: "null" },
  object({}, false, "Empty object means no arrow head."),
);
const animation = object({
  elementId: required(string()),
  effect: required(string()),
  trigger: string(),
  direction: string(),
  durationMs: number(),
  delayMs: number(),
});

/** Canonical native PPTD element contract shared by whole-page and scoped edits. */
export const PPTD_ELEMENT_PARAMETER_SPEC = oneOf(
  object({
    ...baseProperties,
    elementType: required({ type: "string", const: "text" }),
    content: required(textContent),
  }),
  object({
    ...baseProperties,
    elementType: required({ type: "string", const: "shape" }),
    shapeName: required(shapeNameOrCustom),
    geometry: customGeometry,
    fill,
    border,
    adjustments: finiteNumberArray,
  }),
  object({
    ...baseProperties,
    elementType: required({ type: "string", const: "image" }),
    src: required(string()),
    fit,
    crop: imageCrop,
    cropShape: imageCropShape,
  }),
  object({
    ...baseProperties,
    elementType: required({ type: "string", const: "table" }),
    columnWidths: required(finiteNumberArray),
    rowHeights: finiteNumberArray,
    rows: required(array(array(tableCell))),
  }),
  object({
    ...baseProperties,
    elementType: required({ type: "string", const: "chart" }),
    data: required(chartData),
    series: required(array(chartSeries)),
    colors: array(color),
    background: fill,
    title: oneOf(string(), object({ text: required(string()) })),
    legend: oneOf(boolean(), object({}, true)),
    labels: boolean(),
    axis: chartAxis,
    grouping: {
      type: "string",
      enum: ["clustered", "stacked", "percentStacked"],
      description: "Bar grouping. Omit for clustered. stacked and percentStacked apply to bar charts only.",
    },
  }),
  object({
    ...baseProperties,
    elementType: required({ type: "string", const: "icon" }),
    iconName: required(string()),
    fill,
  }),
  object({
    ...baseProperties,
    elementType: required({ type: "string", const: "line" }),
    viewBox: required(
      tuple(
        number(),
        2,
        "Exactly two numbers [width,height], for example [300,120]. Do not use the four-number SVG viewBox form.",
      ),
    ),
    points: required(string()),
    border,
    curve: string(),
    arrow: tuple(lineArrow, 2),
    connects: tuple(string(), 2),
    label: string(),
  }),
);

/**
 * Single model-facing shape contract for generated PPTD pages. It deliberately
 * uses the dsh-tools author schema subset without importing the DSH runtime.
 */
export const WRITE_PAGE_PARAMETER_SPEC = {
  id: required(string()),
  pageType: string(),
  background: fill,
  notes: string(),
  elements: required(
    array(PPTD_ELEMENT_PARAMETER_SPEC, "A non-empty complete-page replacement using canonical PPTD v2 elements."),
  ),
  animations: array(animation),
  expectedPageSha256: string("pageSha256 returned by read_page when replacing an editor-locked existing page."),
  layoutId: string(
    "Optional id of a page layout the deck already defines. The page inherits its copies; omit it for a page without a layout.",
  ),
  provenance: PROVENANCE_PROPERTY,
} as const satisfies PropertyMap;

/** Element-scoped edit contract. The array contains only the authorized target
 * elements, but every item is a complete canonical native PPTD element. */
export const EDIT_ELEMENTS_PARAMETER_SPEC = {
  pageId: required(string("Existing PPTD page id. Must match the active editor element scope.")),
  expectedPageSha256: required(string("Current pageSha256 returned by read_page.")),
  elements: required(
    array(PPTD_ELEMENT_PARAMETER_SPEC, "Complete replacements for exactly the authorized target elementIds."),
  ),
} as const satisfies PropertyMap;

/** Lower one shared parameter spec to standard JSON Schema. DSH's author DSL drops array
 * cardinality keywords, so providers receive this lossless form. */
export function compileParameterSchema(schema: Property): Record<string, unknown> {
  const { required: _required, ...node } = schema;
  if ("oneOf" in node) return { ...node, oneOf: node.oneOf.map(compileParameterSchema) };
  if (node.type === "array") return { ...node, ...(node.items ? { items: compileParameterSchema(node.items) } : {}) };
  if (node.type === "object") {
    const entries = Object.entries(node.properties ?? {});
    const requiredFields = entries.filter(([, child]) => child.required).map(([key]) => key);
    return {
      ...node,
      properties: Object.fromEntries(entries.map(([key, child]) => [key, compileParameterSchema(child)])),
      ...(requiredFields.length ? { required: requiredFields } : {}),
    };
  }
  return node;
}

/** Compile the shared write_page specification to standard JSON Schema for providers. */
export function writePageJsonSchema(): Record<string, unknown> {
  return compileParameterSchema(object(WRITE_PAGE_PARAMETER_SPEC));
}

export function editElementsJsonSchema(): Record<string, unknown> {
  return compileParameterSchema(object(EDIT_ELEMENTS_PARAMETER_SPEC));
}

export type CanonicalWritePageArgs = {
  id: string;
  pageType?: string;
  background?: Fill;
  notes?: string;
  elements: PptdElement[];
  animations?: Animation[];
  expectedPageSha256?: string;
  layoutId?: string;
  /** Runtime metadata only: recorded in the run ledger, never persisted into the page. */
  provenance?: ProvenanceDeclaration;
};

export type CanonicalEditElementsArgs = {
  pageId: string;
  expectedPageSha256: string;
  elements: PptdElement[];
};

function schemaIssues(schema: Schema, value: unknown, path: string): string[] {
  if ("oneOf" in schema) return unionIssues(schema.oneOf, value, path, schemaIssues);
  if (schema.type === "null") return value === null ? [] : [typeIssue(path, "null", value)];
  if (schema.type === "string") {
    if (typeof value !== "string") return [typeIssue(path, "a string", value)];
    if (schema.const !== undefined && value !== schema.const) return [`${path} must equal ${schema.const}`];
    if (schema.enum && !schema.enum.includes(value)) return [`${path} must be one of ${schema.enum.join(", ")}`];
    return [];
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
      return [typeIssue(path, `a finite JSON ${schema.type}`, value)];
    }
    if (schema.type === "integer" && !Number.isInteger(value)) {
      return [typeIssue(path, "an integer", value)];
    }
    return [];
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean" ? [] : [typeIssue(path, "a boolean", value)];
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [typeIssue(path, "an array", value)];
    if (!schema.items) return [];
    return value.flatMap((item, index) => schemaIssues(schema.items!, item, `${path}[${index}]`));
  }
  const candidate = record(value);
  if (!candidate) return [typeIssue(path, "an object", value)];
  const properties = schema.properties ?? {};
  const issues: string[] = [];
  for (const [key, property] of Object.entries(properties)) {
    if (property.required && !Object.hasOwn(candidate, key)) issues.push(`${path}.${key} is required`);
    if (Object.hasOwn(candidate, key)) issues.push(...schemaIssues(property, candidate[key], `${path}.${key}`));
  }
  if (!schema.additionalProperties) {
    for (const key of Object.keys(candidate)) {
      if (!Object.hasOwn(properties, key)) issues.push(misplacedStyleIssue(candidate, key, path));
    }
  }
  return issues;
}

/** Validate structure and the tuple/non-empty rules outside DSH's JSON Schema subset. */
export function canonicalWritePageIssues(value: unknown): string[] {
  const root = record(value);
  if (!root) return [typeIssue("$", "an object", value)];
  // Provenance issues come first so an invalid basis value is always reported
  // with its Chinese schema error, whatever else is wrong with the page.
  const provenanceIssues = canonicalProvenanceIssues(root.provenance);
  if (provenanceIssues.length) return provenanceIssues;
  // Custom-path refusals are Chinese and name the element, so they also precede the schema.
  const geometryIssues = customGeometryIssues(root.elements);
  if (geometryIssues.length) return geometryIssues;
  // So are the M5 effect refusals (shadow and stop-alpha ranges, non-finite numbers).
  const effectRangeIssues = effectIssues({ background: root.background, elements: root.elements });
  if (effectRangeIssues.length) return effectRangeIssues;
  const rootSchema = object(WRITE_PAGE_PARAMETER_SPEC);
  const issues = schemaIssues(rootSchema, value, "$");
  if (issues.length) return issues;
  return semanticIssues(value as CanonicalWritePageArgs);
}

/** Validate the closed scoped-edit root and every complete native element. */
export function canonicalEditElementsIssues(value: unknown): string[] {
  const root = record(value);
  if (!root) return [typeIssue("$", "an object", value)];
  const geometryIssues = customGeometryIssues(root.elements);
  if (geometryIssues.length) return geometryIssues;
  const effectRangeIssues = effectIssues({ elements: root.elements });
  if (effectRangeIssues.length) return effectRangeIssues;
  const rootSchema = object(EDIT_ELEMENTS_PARAMETER_SPEC);
  const issues = schemaIssues(rootSchema, value, "$");
  if (issues.length) return issues;
  const args = value as CanonicalEditElementsArgs;
  const semantic = semanticIssues({ id: args.pageId, elements: args.elements });
  if (!/^[a-f0-9]{64}$/i.test(args.expectedPageSha256.trim())) {
    semantic.push("$.expectedPageSha256 must be a 64-character hexadecimal SHA-256");
  }
  return semantic;
}

export function isCanonicalEditElementsArgs(value: unknown): value is CanonicalEditElementsArgs {
  return canonicalEditElementsIssues(value).length === 0;
}

export function isCanonicalWritePageArgs(value: unknown): value is CanonicalWritePageArgs {
  return canonicalWritePageIssues(value).length === 0;
}

/** Validate a single Fill value (solid/gradient/image) against the write schema. */
export function canonicalFillIssues(value: unknown): string[] {
  const effects = fillEffectIssues(value);
  return effects.length ? effects : schemaIssues(fill, value, "$");
}

/** Validate one element shadow (blur ≥ 0, opacity 0 to 1) for a scoped shadow edit. */
export function canonicalShadowIssues(value: unknown): string[] {
  const ranges = shadowIssues(value);
  return ranges.length ? ranges : schemaIssues(shadow, value, "$");
}

/**
 * Validate a text-style patch field by field: only textContent properties are
 * accepted and each must match its declared type. Unlike the full text
 * content object, no key is required — a patch only carries what it changes.
 */
export function canonicalTextStylePatchIssues(patch: unknown): string[] {
  const rec = record(patch);
  if (!rec) return [typeIssue("$", "an object", patch)];
  const properties = textContent.properties ?? {};
  const issues: string[] = [];
  for (const [key, value] of Object.entries(rec)) {
    const spec = properties[key];
    if (!spec) {
      issues.push(`$.${key} is not allowed`);
      continue;
    }
    // null/undefined are the patch protocol's delete markers, not values.
    if (value === null || value === undefined) continue;
    issues.push(...schemaIssues(spec, value, `$.${key}`));
  }
  return issues;
}

export { coerceLineArrowHead, normalizeWritePageLineArrows, normalizeWritePageDialect } from "./write-page-dialect.js";
