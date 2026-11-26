import type { LayoutIssue } from "./layout-schema.js";
import type { PptdElement, Page, Presentation } from "./types.js";

/** Largest offset, in slide pixels, at which a page element still counts as the layout's element. */
const DUPLICATE_TOLERANCE_PX = 4;

function sourceOf(element: PptdElement): string {
  const src = (element as { src?: unknown }).src;
  return typeof src === "string" ? src.trim() : "";
}

function textOf(element: PptdElement): string {
  const text = (element as { content?: { text?: unknown } }).content?.text;
  return typeof text === "string" ? text.trim() : "";
}

/** The same kind of element with the same picture source, or the same non-empty text. */
function sameMark(own: PptdElement, shown: PptdElement): boolean {
  if (own.elementType !== shown.elementType) return false;
  const src = sourceOf(own);
  if (src && src === sourceOf(shown)) return true;
  const text = textOf(own);
  return text !== "" && text === textOf(shown);
}

/**
 * How the refusal names the layout element. Wording only: it never decides a refusal, and a
 * layout logo is recognised from its id because the element model has no logo role.
 */
function kindLabel(element: PptdElement): string {
  if (element.elementType === "image" && /(^|[-_])logo($|[-_])/i.test(element.elementId)) {
    return "Logo";
  }
  switch (element.elementType) {
    case "image":
      return "这张图片";
    case "text":
      return "这段文字";
    case "shape":
      return "这个形状";
    case "line":
      return "这条线";
    case "icon":
      return "这个图标";
    default:
      return "这个元素";
  }
}

/** The Chinese refusal. A Latin name such as Logo keeps a space before 已在; Chinese names do not. */
function refusalDetail(twin: PptdElement, layoutName: string): string {
  const label = kindLabel(twin);
  const joiner = /^[A-Za-z]/.test(label) ? " " : "";
  return `${label}${joiner}已在版式『${layoutName}』里，不要在页面上重复画`;
}

function nearby(own: PptdElement, shown: PptdElement): boolean {
  return (
    Math.abs(own.bounds[0] - shown.bounds[0]) <= DUPLICATE_TOLERANCE_PX &&
    Math.abs(own.bounds[1] - shown.bounds[1]) <= DUPLICATE_TOLERANCE_PX
  );
}

/** What a page with this layout shows: the master's elements when they are shown, then the layout's. */
function shownDefinitions(presentation: Presentation, layoutId: string): PptdElement[] {
  const layout = presentation.layouts?.find((item) => item.id === layoutId);
  if (!layout) return [];
  const master =
    layout.masterId === undefined ? undefined : presentation.masters?.find((item) => item.id === layout.masterId);
  const masterElements = master && layout.showMasterElements !== false ? master.elements : [];
  return [...masterElements, ...layout.elements];
}

/**
 * A page must not redraw an element its layout already shows. An own element of the same kind,
 * with the same picture source or the same text, within 4 px of the layout's element, is refused.
 * Copies already on the page are skipped, and a dangling layoutId is left to layoutReferenceIssues.
 */
export function layoutDuplicateIssues(presentation: Presentation, page: Page): LayoutIssue[] {
  if (page.layoutId === undefined) return [];
  const layout = presentation.layouts?.find((item) => item.id === page.layoutId);
  if (!layout) return [];
  const shown = shownDefinitions(presentation, layout.id);
  const issues: LayoutIssue[] = [];
  for (const element of page.elements) {
    if (element.inherited !== undefined) continue;
    const twin = shown.find((definition) => sameMark(element, definition) && nearby(element, definition));
    if (twin) {
      issues.push({
        code: "duplicate_layout_element",
        detail: refusalDetail(twin, layout.name),
      });
    }
  }
  return issues;
}
