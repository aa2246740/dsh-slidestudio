/**
 * The write_layout parameter contract (masters-layouts §3.20): one deck master or one page layout,
 * replaced whole. Elements use the write_page element shapes. A template component reference is
 * accepted too; the Host expands it into native elements before the layout is checked.
 */
import { COMPONENT_ELEMENT } from "./component-element-schema.js";
import {
  PPTD_ELEMENT_PARAMETER_SPEC,
  array,
  boolean,
  compileParameterSchema,
  fill,
  number,
  object,
  oneOf,
  required,
  string,
  type PropertyMap,
} from "./write-page-schema.js";

const LAYOUT_SLOT = object(
  {
    role: required({
      type: "string",
      enum: ["title", "subtitle", "body", "chart", "image", "note"],
    }),
    bounds: required(array(number())),
  },
  true,
);

export const WRITE_LAYOUT_PARAMETER_SPEC = {
  id: required(string("Layout id: lowercase letters, digits and hyphens, 1-32 characters, e.g. body.")),
  scope: required({
    type: "string",
    enum: ["master", "layout"],
    description: "master defines the deck master; layout defines one page layout.",
  }),
  name: required(string("Name shown in the layout list, 1-24 characters.")),
  masterId: string("The master this layout uses; the deck master id, normally main."),
  showMasterElements: boolean("false hides the master's elements on this layout."),
  background: fill,
  elements: required(
    array(
      oneOf(PPTD_ELEMENT_PARAMETER_SPEC, COMPONENT_ELEMENT),
      "Complete layout elements: text, shape, image, line or icon, at most 40, or a template component reference (elementType component). No chart, table or SmartArt.",
    ),
  ),
  slots: array(LAYOUT_SLOT, "Reference positions for the layout; slots are never painted."),
  archetype: string("Optional layout family label."),
  expectedLayoutSha256: string("layoutSha256 from the last write_layout for this layout; a stale value is refused."),
} as const satisfies PropertyMap;

/** Standard JSON Schema for the write_layout tool, lowered like the write_page schema. */
export function writeLayoutJsonSchema(): Record<string, unknown> {
  return compileParameterSchema(object(WRITE_LAYOUT_PARAMETER_SPEC));
}
