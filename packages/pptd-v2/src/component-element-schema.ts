/**
 * The template-component reference a write_page or write_layout call may carry in `elements`
 * (architecture §3.21). It is a request, never a stored element: the Host expands it into native
 * PPTD elements before schema validation, so a saved page or layout holds none.
 */
import {
  PPTD_ELEMENT_PARAMETER_SPEC,
  WRITE_PAGE_PARAMETER_SPEC,
  array,
  compileParameterSchema,
  number,
  object,
  oneOf,
  required,
  string,
} from "./write-page-schema.js";

export const COMPONENT_ELEMENT = object({
  elementType: required({ type: "string", const: "component" }),
  ref: required(
    string(
      "Template component reference material:<materialId>#<componentId>, copied from read_material part kit. The Host expands it into native elements; it never creates a page.",
    ),
  ),
  bounds: array(
    number(),
    "Optional target rectangle [x,y,w,h] in 960x540 slide px; omitted keeps the template position.",
  ),
  elementId: string(
    "Optional and ignored: the Host names the elements a component expands into. Allowed because a model names every element it writes, and a closed branch refused the whole call with no reason.",
  ),
  layoutRole: string("Optional and ignored: the expanded elements keep the roles the template gave them."),
  texts: array(
    oneOf(string(), array(string())),
    "SmartArt components only: one entry per node, in reading order. An entry is the node's text, or a list of its paragraphs (the first paragraph is the node's main line). A process component grows or shrinks to the entry count; every other kind must match its node count exactly.",
  ),
});

export type ComponentReference = {
  elementType: "component";
  ref: string;
  bounds?: unknown;
  elementId?: unknown;
  layoutRole?: unknown;
  texts?: unknown;
};

export function isComponentReference(value: unknown): value is ComponentReference {
  return (
    typeof value === "object" && value !== null && (value as { elementType?: unknown }).elementType === "component"
  );
}

/**
 * The provider-facing write_page schema: the canonical page contract, with a component reference
 * as one more element branch beside the canonical ones (kept flat, as providers read it best).
 * Validation still runs on the expanded page against writePageJsonSchema, so a component that was
 * not expanded never passes it.
 */
export function writePageProviderJsonSchema(): Record<string, unknown> {
  return compileParameterSchema(
    object({
      ...WRITE_PAGE_PARAMETER_SPEC,
      elements: required(
        array(
          oneOf(...PPTD_ELEMENT_PARAMETER_SPEC.oneOf, COMPONENT_ELEMENT),
          "A non-empty complete-page replacement using canonical PPTD v2 elements; a template component reference may stand in for a decoration group.",
        ),
      ),
    }),
  );
}
