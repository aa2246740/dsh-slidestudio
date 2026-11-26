/**
 * Layout QA merge rules (masters-layouts §3.20). The copies a page inherits from its master and
 * layout carry an `inherited` mark. They are judged once, where the layout is written
 * (write_layout's layoutIssues), so on a page they never count as content, never repeat a
 * picture and never trip overflow or colour checks. An own element that collides with a copy is
 * still refused. Split out of layout-qa.ts, which stays at its module budget.
 */
import {
  footerZoneTopForSlide,
  type ChartElement,
  type ImageElement,
  type PptdElement,
  type TableElement,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import { mediaExists } from "./media-store.js";
import { persistPageKey } from "./page-identity.js";
import type { SkillPageInput } from "./skill-pages.js";

export type LayoutIssue = {
  pageId: string;
  code:
    | "empty"
    | "no_exhibit"
    | "unlabeled_stat"
    | "missing_media"
    | "three_plates"
    | "doc_wall"
    | "no_color"
    | "empty_box"
    | "homemade"
    | "unnamed_gap"
    | "missing_column"
    | "missing_locked_fact"
    | "unsupported_chart"
    | "invalid_chart_data"
    | "implicit_chart_palette"
    | "missing_requested_exhibit"
    | "weak_title"
    | "tiny_text"
    | "text_wall"
    | "overstuffed"
    | "chart_pileup"
    | "chart_too_small"
    | "edge_cling"
    | "broken_gauge"
    | "empty_cell"
    | "overflow"
    | "overlap"
    | "overlap_layout"
    | "zero_area"
    | "bounds_omitted"
    | "footer_zone"
    | "invalid_color"
    | "pack_color"
    | "reused_cover_src"
    | "out_of_bounds";
  message: string;
};

export const SLIDE_WIDTH = 960;
export const SLIDE_HEIGHT = 540;
const TEXT_OVERLAP_PX = 4;
const FULL_BLEED_AREA = SLIDE_WIDTH * SLIDE_HEIGHT * 0.45;

/** The page's own elements. Copies from the master and layout are not page content. */
export function ownElements(elements: readonly PptdElement[]): PptdElement[] {
  return elements.filter((el) => el.inherited === undefined);
}

/** The page as a content check may judge it: the same page with its copies removed. */
export function ownPageView<T extends { elements: readonly PptdElement[] }>(page: T): T {
  return { ...page, elements: ownElements(page.elements) };
}

/** A real 结束页 needs title + recap (at least two visible text runs). */
export function pageHasReadableCopy(page: { elements: readonly PptdElement[] }): boolean {
  const texts = visibleTextRuns(page);
  const blob = texts.map((el) => el.content.text.replace(/\s+/g, "")).join("");
  return texts.length >= 2 && blob.length >= 16;
}

function visibleTextRuns(page: { elements: readonly PptdElement[] }): TextElement[] {
  return ownElements(page.elements).filter((el): el is TextElement => {
    if (el.elementType !== "text") return false;
    if (el.hidden || (el.opacity ?? 1) < 0.2) return false;
    const text = el as TextElement;
    return Boolean(text.content?.text?.trim());
  });
}

function tableHasBodyValues(el: PptdElement): boolean {
  if (el.elementType !== "table") return false;
  const rows = (el as TableElement).rows;
  if (!Array.isArray(rows) || rows.length < 2) return false;
  return rows
    .slice(1)
    .some((row) => row.some((cell) => Boolean(String((cell as { text?: unknown }).text ?? "").trim())));
}

function chartHasSeriesValues(el: PptdElement): boolean {
  if (el.elementType !== "chart") return false;
  const chart = el as ChartElement;
  const rows = chart.data?.rows ?? [];
  const hasValues = rows.some((row) => row.some((cell) => cell != null && String(cell).trim() !== ""));
  return hasValues && (chart.series?.length ?? 0) > 0;
}

/**
 * Visible content is own text, table body values, or chart series.
 * Shape-area coverage is not content. A full-bleed navy rect is empty.
 */
export function pageHasVisibleContent(page: { elements: readonly PptdElement[] }): boolean {
  if (visibleTextRuns(page).length > 0) return true;
  return ownElements(page.elements).some((el) => tableHasBodyValues(el) || chartHasSeriesValues(el));
}

function rectsOverlap(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
  minPx: number,
): boolean {
  const overlapW = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const overlapH = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return overlapW >= minPx && overlapH >= minPx;
}

/**
 * A copy that own text must not sit on: text, pictures, lines and icons. A shape is a band the
 * text may sit on, and a full-bleed picture is a background.
 */
function collidesWithCopy(el: PptdElement): boolean {
  if (el.elementType === "shape") return false;
  if (el.elementType !== "image") return true;
  const [, , w, h] = el.bounds;
  return w * h < FULL_BLEED_AREA;
}

export function pageGeometryIssues(page: Pick<SkillPageInput, "id" | "elements">): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const texts: TextElement[] = [];
  const copies: PptdElement[] = [];
  const collectElements = () => {
    for (const el of page.elements) {
      if (el.inherited !== undefined) {
        if (collidesWithCopy(el)) copies.push(el);
        continue;
      }
      const [x, y, w, h] = el.bounds;
      if (w <= 0 || h <= 0) {
        issues.push({
          pageId: page.id,
          code: "zero_area",
          message: `element ${el.elementId} has zero-area bounds ${w}×${h}`,
        });
      }
      const contentBox = el.elementType === "text" || el.elementType === "table" || el.elementType === "chart";
      if (contentBox && (x < 0 || y < 0 || x + w > SLIDE_WIDTH || y + h > SLIDE_HEIGHT)) {
        issues.push({
          pageId: page.id,
          code: "overflow",
          message: `element ${el.elementId} overflows 960×540 at [${x},${y},${w},${h}]`,
        });
      }
      if (el.elementType === "text") texts.push(el as TextElement);
    }
  };
  collectElements();
  const footerTop = footerZoneTopForSlide(SLIDE_HEIGHT);
  for (const text of texts) {
    if (text.hidden) continue;
    if (text.layoutRole === "footer" || text.layoutRole === "decoration") continue;
    const [, y, , h] = text.bounds;
    if (y >= footerTop || y + h > footerTop) {
      issues.push({
        pageId: page.id,
        code: "footer_zone",
        message: `text ${text.elementId} sits in the footer reserve starting at ${footerTop} without layoutRole=footer`,
      });
    }
  }
  for (let i = 0; i < texts.length; i += 1) {
    const own = texts[i]!;
    for (let j = i + 1; j < texts.length; j += 1) {
      const right = texts[j]!;
      if (!rectsOverlap(own.bounds, right.bounds, TEXT_OVERLAP_PX)) continue;
      issues.push({
        pageId: page.id,
        code: "overlap",
        message: `text ${own.elementId} overlaps ${right.elementId}`,
      });
    }
    for (const copy of copies) {
      if (!rectsOverlap(own.bounds, copy.bounds, TEXT_OVERLAP_PX)) continue;
      issues.push({
        pageId: page.id,
        code: "overlap_layout",
        message: `text ${own.elementId} overlaps ${copy.elementId}, which the layout draws on this page`,
      });
    }
  }
  return issues;
}

export const REUSED_COVER_SRC_DETAIL =
  "full-bleed image src is already used on another page; each photo-led page needs its own media id";

function isCoverWritePage(page: SkillPageInput): boolean {
  if (page.pageType === "cover") return true;
  const key = persistPageKey(page.id);
  return key === "cover" || key === "1_cover";
}

function isFullBleedImage(el: PptdElement): el is ImageElement {
  if (el.elementType !== "image") return false;
  const [x, y, w, h] = el.bounds;
  if (w * h >= FULL_BLEED_AREA) return true;
  return x <= 12 && y <= 12 && w >= 880 && h >= 480;
}

export function reusedFullBleedSrcIssue(
  page: SkillPageInput,
  siblingImageSrcs: readonly { pageId: string; src: string }[],
): LayoutIssue | undefined {
  if (isCoverWritePage(page)) return undefined;
  for (const el of ownElements(page.elements)) {
    if (!isFullBleedImage(el)) continue;
    const src = el.src.trim();
    if (!src) continue;
    const other = siblingImageSrcs.find(
      (row) => persistPageKey(row.pageId) !== persistPageKey(page.id) && row.src === src,
    );
    if (other) {
      return {
        pageId: page.id,
        code: "reused_cover_src",
        message: `reused full-bleed src ${src} already used on ${other.pageId}. ${REUSED_COVER_SRC_DETAIL}`,
      };
    }
  }
  return undefined;
}

export type PhotoExhibitContext = {
  photoExhibit?: boolean;
  projectRoot?: string;
  siblingImageSrcs?: readonly { pageId: string; src: string }[];
};

/** A photo todo promises a photo-led page; media must exist before write_page. */
export function photoExhibitIssues(page: SkillPageInput, ctx: PhotoExhibitContext): LayoutIssue[] {
  if (!ctx.photoExhibit) return [];
  const images = ownElements(page.elements).filter((el): el is ImageElement => el.elementType === "image");
  if (!images.length) {
    return [
      {
        pageId: page.id,
        code: "missing_media",
        message: `page ${page.id} todo marks a photo-led page — decide the photo frame, generate_image with that width and height, then include the image element in write_page`,
      },
    ];
  }
  const issues: LayoutIssue[] = [];
  for (const el of images) {
    if (ctx.projectRoot && !mediaExists(ctx.projectRoot, el.src)) {
      issues.push({
        pageId: page.id,
        code: "missing_media",
        message: `page ${page.id} chose an image src ${el.src} that is not in media/ — run search_image or generate_image first`,
      });
    }
  }
  const unique = images.some((el) => !ctx.siblingImageSrcs?.some((row) => row.src === el.src));
  if (!unique) {
    issues.push({
      pageId: page.id,
      code: "reused_cover_src",
      message: `page ${page.id} photo hero reuses another page's src — each photo-led page needs its own media id`,
    });
  }
  return issues;
}
