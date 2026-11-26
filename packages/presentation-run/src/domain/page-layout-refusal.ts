/**
 * The three layout refusals every page write passes (masters-layouts §3.20): a layoutId that names
 * no layout, an own element id that uses a copy prefix, and an own element that redraws an element
 * the page's layout already shows. Copies on the page are ignored here; the host strips them first.
 */
import {
  layoutDuplicateIssues,
  layoutReferenceIssues,
  pageOwnershipIssues,
  type LayoutIssueCode,
  type Page,
  type Presentation,
} from "@open-slidestudio/pptd-v2";

export type PageLayoutRefusalCode = "layout_missing" | "reserved_element_id" | "duplicate_layout_element";

export type PageLayoutRefusal = { error: PageLayoutRefusalCode; detail: string };

const REFUSAL_CODES: ReadonlySet<LayoutIssueCode> = new Set<LayoutIssueCode>([
  "layout_missing",
  "reserved_element_id",
  "duplicate_layout_element",
]);

export function isPageLayoutRefusalCode(error: unknown): error is PageLayoutRefusalCode {
  return error === "layout_missing" || error === "reserved_element_id" || error === "duplicate_layout_element";
}

/** The first layout refusal of a page, or undefined when the page may be written. */
export function pageLayoutRefusal(presentation: Presentation, page: Page): PageLayoutRefusal | undefined {
  const issue = [
    ...layoutReferenceIssues(presentation, page),
    ...pageOwnershipIssues(presentation, page),
    ...layoutDuplicateIssues(presentation, page),
  ].find((entry) => REFUSAL_CODES.has(entry.code));
  if (!issue || !isPageLayoutRefusalCode(issue.code)) return undefined;
  return { error: issue.code, detail: issue.detail };
}
