/**
 * Native structural QA — skill step 4 without export_images.py / Kimi iframe.
 * Media is optional: missing_media only fires if the agent chose a src.
 * compose mode: empty pages + unlabeled invented numbers + dangling src.
 * strict mode: also wants a non-image-or-image exhibit and rejects three plates.
 */
import type { ImageElement, PptdElement, ShapeElement, TableElement, TextElement } from "@open-slidestudio/pptd-v2";
import { colorRefusal, officialPptdColorKind, toRgbHex, type Theme } from "@open-slidestudio/pptd-v2";
import { persistPageKey, persistPagePathFromId } from "./page-identity.js";
import { TODO_EXHIBIT_KINDS, isTodoExhibitKind, type TodoExhibitKind } from "./page-plan.js";
export { TODO_EXHIBIT_KINDS, isTodoExhibitKind, type TodoExhibitKind } from "./page-plan.js";
export { persistPageKey, persistPagePathFromId } from "./page-identity.js";
import type { SkillPageInput } from "./skill-pages.js";
import { parseBounds } from "./skill-pages.js";
import { chartIssues, isGroupedBarExhibit, isVisibleChartExhibit } from "./layout-qa-chart.js";
import { visibleRoleElements } from "./layout-qa-visibility.js";
import { mediaExists } from "./media-store.js";
import { pageImageSrcs } from "./page-image-srcs.js";
import { holdsOnlyTemplateComponents, templateComponentPaintCheck } from "./template-component-paint.js";
import { hasHomemadeFourCircles, hasKidsDoodle, hasOfficialRecipe } from "./playbook-recipes.js";
import { inferTodoExhibits, type TodoExhibitContract } from "./todo-exhibits.js";
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  ownElements,
  ownPageView,
  pageGeometryIssues,
  pageHasReadableCopy,
  pageHasVisibleContent,
  photoExhibitIssues,
  reusedFullBleedSrcIssue,
  type LayoutIssue,
} from "./layout-gates.js";
export {
  REUSED_COVER_SRC_DETAIL,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  pageGeometryIssues,
  pageHasReadableCopy,
  pageHasVisibleContent,
  photoExhibitIssues,
  reusedFullBleedSrcIssue,
  type LayoutIssue,
} from "./layout-gates.js";
export {
  inferTodoExhibits,
  inferBriefPageExhibits,
  resolveTodoExhibits,
  type TodoExhibitContract,
} from "./todo-exhibits.js";

export type LayoutReview = {
  ok: boolean;
  visualQa: "skipped";
  issues: LayoutIssue[];
  pages: {
    id: string;
    coverage: number;
    exhibit: string | null;
    imageSrcs: string[];
  }[];
};

const SLIDE = SLIDE_WIDTH * SLIDE_HEIGHT;

const OFFICIAL_RECIPE_TYPES = new Set([
  "cover-botanical",
  "title-band",
  "coral-rule",
  "chapter",
  "page-title",
  "route-path",
  "method-panels",
  "two-column-45-55",
  "demo-band",
  "two-column-body",
  "result-bar",
  "next-action",
  "footer-chrome",
  "header",
  "list",
  "box",
  "circle",
  "band",
]);

function chartTypesOf(element: PptdElement): string[] {
  if (!isVisibleChartExhibit(element)) return [];
  return element.series.map((series) => {
    const raw = String(series.type ?? "bar").toLowerCase();
    return raw === "column" ? "bar" : raw;
  });
}

function hasStructuredDiagram(
  page: SkillPageInput,
  role: "funnel" | "gauge" | "pyramid" | "matrix" | "timeline",
): boolean {
  const contributors = visibleRoleElements(page, role);
  const shapes = contributors
    .filter((element) => element.elementType === "shape")
    .sort((left, right) => left.bounds[1] - right.bounds[1]);
  const labels = contributors.filter((element) => element.elementType === "text");
  if (role === "matrix") {
    return shapes.length >= 4 && labels.length >= 2;
  }
  if (role === "timeline") {
    const connectors = contributors.filter((element) => element.elementType === "line");
    return shapes.length >= 3 && labels.length >= 2 && connectors.length >= 1;
  }
  if (role === "gauge") {
    return shapes.length >= 2 && labels.length >= 1;
  }
  if (shapes.length < 3 || labels.length < 2) return false;
  const widths = shapes.map((shape) => shape.bounds[2]);
  if (role === "funnel") {
    return widths.every((width, index) => index === 0 || width <= widths[index - 1]! + 2);
  }
  return widths.every((width, index) => index === 0 || width + 2 >= widths[index - 1]!);
}

function satisfiesRequestedExhibit(page: SkillPageInput, requirement: TodoExhibitKind): boolean {
  if (requirement === "none") return true;
  if (requirement === "table") {
    return page.elements.some((element) => element.elementType === "table");
  }
  if (requirement === "kpi-cards") {
    return visibleRoleElements(page, "kpi-card").filter((element) => element.elementType === "shape").length >= 3;
  }
  if (requirement === "comparison-cards") {
    return (
      visibleRoleElements(page, "comparison-card").filter((element) => element.elementType === "shape").length >= 2
    );
  }
  if (requirement.startsWith("chart:")) {
    const expected = requirement.slice("chart:".length);
    if (expected === "stacked" || expected === "percentStacked") {
      return page.elements.some((element) => isGroupedBarExhibit(element, expected));
    }
    if (expected === "combo") {
      return page.elements.some((element) => {
        if (!isVisibleChartExhibit(element)) return false;
        const chart = element;
        return new Set(chartTypesOf(chart)).size >= 2 && chart.series.some((series) => series.axis === "secondary");
      });
    }
    return page.elements.some((element) => {
      const actual = chartTypesOf(element);
      if (expected === "line") {
        return actual.some((type) => type === "line" || type === "area");
      }
      return actual.includes(expected);
    });
  }
  const role = requirement.slice("diagram:".length) as "funnel" | "gauge" | "pyramid" | "matrix" | "timeline";
  if (role === "matrix" && page.elements.some((element) => chartTypesOf(element).includes("scatter"))) {
    return true;
  }
  return hasStructuredDiagram(page, role);
}

export function requestedExhibitIssues(page: SkillPageInput, todo: TodoExhibitContract | undefined): LayoutIssue[] {
  if (!todo) return [];
  const declared = todo.exhibits?.filter(isTodoExhibitKind) ?? [];
  const requested = todo.exhibits !== undefined ? declared : inferTodoExhibits(`${todo.title}\n${todo.note ?? ""}`);
  const content = ownPageView(page);
  return requested
    .filter((requirement) => !satisfiesRequestedExhibit(content, requirement))
    .map((requirement) => ({
      pageId: page.id,
      code: "missing_requested_exhibit" as const,
      message: `page ${page.id} requires ${requirement} from ${todo.exhibitOrigins?.[requirement] ?? "plan declaration in write_todo"} but did not implement it as editable PPTD elements`,
    }));
}

function area(el: PptdElement): number {
  const [, , w, h] = el.bounds;
  return Math.max(0, w) * Math.max(0, h);
}

export function pageCoverage(elements: PptdElement[]): number {
  let sum = 0;
  for (const el of elements) sum += area(el);
  return Math.min(1, sum / SLIDE);
}

export function pageText(elements: PptdElement[]): string {
  const bits: string[] = [];
  for (const el of elements) {
    if (el.elementType !== "text") continue;
    const text = (el as TextElement).content?.text;
    if (text) bits.push(text);
  }
  return bits.join("\n");
}

/** Compose/write refuse: send produce back. Do not host-fill leftover YAML. */
export const EMPTY_CLOSER_PRODUCE_NEXT =
  "closing page has no readable copy — the last page needs at least two visible text elements (a title plus recap or the meeting ask). write_page that page; do not call compose_deck or review_pages until the write lands. Host will not paint leftover pages.";

/** Host-opened seed listed beside a real agent cover. Do not paint it. */
export const HOST_SEED_PRODUCE_NEXT =
  "host-opened seed 1_cover.page is still listed in the composed deck. persist-by-id kept the filename; compose will not seal a leftover seed as slide 1. write_page id 1_cover with real cover copy, or do not list the seed. Host will not paint leftover pages.";

export type DeckPageView = {
  readonly path: string;
  readonly page: {
    readonly pageType?: string;
    readonly elements: readonly PptdElement[];
  };
};

export type ComposedPageLeftoverIssue = {
  readonly pageId: string;
  readonly path: string;
  readonly kind: "host_seed" | "leftover_content" | "empty_closer";
  readonly message: string;
};

/** Exact `createEmptyProject` basename. `01_cover` / `p01_cover` are agent ids. */
export function isHostOpenedSeedPath(name: string): boolean {
  return name.replace(/\\/g, "/").split("/").pop() === "1_cover.page";
}

/**
 * Leftover host seed: white title-only `pages/1_cover.page` still in a multi-page
 * deck. Agent overwrite in place (readable copy on that file) is not leftover.
 */
export function isHostOpenedSeedPage(loaded: DeckPageView, deckPageCount: number): boolean {
  if (!isHostOpenedSeedPath(loaded.path)) return false;
  if (deckPageCount <= 1) return false;
  return !pageHasReadableCopy({ elements: loaded.page.elements });
}

/**
 * Scan the whole composed page list. Last-page-only leftover-closer missed the
 * host seed sitting as slide 1 in front of a real agent cover.
 */
export function composedPageLeftoverIssues(pages: readonly DeckPageView[]): ComposedPageLeftoverIssue[] {
  const issues: ComposedPageLeftoverIssue[] = [];
  const last = pages.length - 1;
  for (const [index, loaded] of pages.entries()) {
    const pageId = persistPageKey(loaded.path);
    if (isHostOpenedSeedPage(loaded, pages.length)) {
      issues.push({
        pageId,
        path: loaded.path,
        kind: "host_seed",
        message: HOST_SEED_PRODUCE_NEXT,
      });
      continue;
    }
    if (isLeftoverContentBasename(loaded.path)) {
      const empty = !pageHasVisibleContent({ elements: loaded.page.elements });
      if (empty || index === last) {
        issues.push({
          pageId,
          path: loaded.path,
          kind: index === last ? "empty_closer" : "leftover_content",
          message: EMPTY_CLOSER_PRODUCE_NEXT,
        });
        continue;
      }
    }
    if (index === last && pages.length > 1 && !pageHasReadableCopy({ elements: loaded.page.elements })) {
      issues.push({
        pageId,
        path: loaded.path,
        kind: "empty_closer",
        message: EMPTY_CLOSER_PRODUCE_NEXT,
      });
    }
  }
  return issues;
}

/**
 * Recorded rendered hard fail always blocks compose. Strict local-editor runs
 * additionally require a current deterministic pass even when vision is none.
 */
export function renderedLayoutBlocksCompose(
  layout: "pass" | "fail" | "unavailable" | "missing",
  requireCurrentPass = false,
): boolean {
  return layout === "fail" || (requireCurrentPass && layout !== "pass");
}

/** Cover/TOC are not closers. Last page, pageType final/close, or id closing. */
export function isCloserPage(page: { id?: string; pageType?: string }, index?: number, last?: number): boolean {
  const type = (page.pageType || "").toLowerCase();
  const id = (page.id || "").toLowerCase();
  if (/^(final|close|closing|end)$/.test(type)) return true;
  if (/(?:^|_|-)(closing|final|end)(?:$|_|-)/.test(id) || /结束/.test(id)) return true;
  if (index != null && last != null && last > 0 && index === last) return true;
  return false;
}

export function pageIdMatchesFile(pageId: string, filePath: string): boolean {
  const id = pageId.trim();
  if (!id) return false;
  const key = persistPageKey(id);
  if (!key) return false;
  return key === persistPageKey(filePath);
}

export function isLeftoverContentBasename(name: string): boolean {
  return /^\d+_content$/i.test(persistPageKey(name));
}

export function isPlaceholderReviewIssue(issue: string): boolean {
  return /^(none|n\/a|na|null|ok|pass|-|无|没有)$/i.test(issue.trim());
}

function asIssueRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (Object.keys(rec).length === 1 && "item" in rec) return asIssueRecord(rec.item);
  return rec;
}

function rawBoundsTuple(raw: unknown): number[] | undefined {
  const rec = asIssueRecord(raw);
  if (!rec) return undefined;
  const parsed =
    parseBounds(rec.bounds) ??
    parseBounds(rec.position) ??
    parseBounds(
      rec.x != null || rec.left != null
        ? [rec.x ?? rec.left, rec.y ?? rec.top, rec.w ?? rec.width, rec.h ?? rec.height]
        : undefined,
    );
  return parsed ?? undefined;
}

function rawBoundsPresent(raw: unknown): boolean {
  const rec = asIssueRecord(raw);
  if (!rec) return false;
  if (rec.bounds != null || rec.position != null) return true;
  const rect = asIssueRecord(rec.rect);
  if (rect && (rect.left != null || rect.x != null)) return true;
  const style = asIssueRecord(rec.style);
  if (style && (style.left != null || style.x != null) && (style.width != null || style.w != null)) {
    return true;
  }
  return rec.x != null || rec.left != null;
}

function rawBoundsZeroArea(raw: unknown): boolean {
  const rec = asIssueRecord(raw);
  if (!rec) return false;
  const candidate = rec.bounds ?? rec.position;
  if (!Array.isArray(candidate) || candidate.length < 4) return false;
  const width = Number(candidate[2]);
  const height = Number(candidate[3]);
  return Number.isFinite(width) && Number.isFinite(height) && width * height <= 0;
}

function isOfficialRecipeType(raw: unknown): boolean {
  const rec = asIssueRecord(raw);
  const type = typeof rec?.type === "string" ? rec.type.trim().toLowerCase() : "";
  return Boolean(type) && OFFICIAL_RECIPE_TYPES.has(type);
}

function coerceRawElements(rawPage: Record<string, unknown>): unknown[] {
  const elements = rawPage.elements;
  if (Array.isArray(elements)) return elements;
  const rec = asIssueRecord(elements);
  if (rec && Array.isArray(rec.item)) return rec.item;
  return [];
}

/** Reject omitted / invented / zero-area bounds on the agent payload, before parse fills them. */
export function rawPageBoundsIssues(rawPage: Record<string, unknown>, pageId: string): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  for (const [index, raw] of coerceRawElements(rawPage).entries()) {
    if (isOfficialRecipeType(raw)) continue;
    const rec = asIssueRecord(raw);
    const elementId =
      (typeof rec?.elementId === "string" && rec.elementId) ||
      (typeof rec?.id === "string" && rec.id) ||
      `el-${index + 1}`;
    if (rawBoundsZeroArea(raw)) {
      issues.push({
        pageId,
        code: "zero_area",
        message: `element ${elementId} has zero-area bounds`,
      });
      continue;
    }
    if (!rawBoundsPresent(raw) || !rawBoundsTuple(raw)) {
      issues.push({
        pageId,
        code: "bounds_omitted",
        message: `element ${elementId} omitted bounds — host will not invent them`,
      });
    }
  }
  return issues;
}

const CHART_SLOT_LABEL = /走势|架构|跃迁|示意图|趋势图|规模.*示意|三层架构/;

function boundsOverlap(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
  minPx = 24,
): boolean {
  const overlapW = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const overlapH = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return overlapW >= minPx && overlapH >= minPx;
}

function isExhibitElement(el: PptdElement): boolean {
  if (el.elementType === "chart" || el.elementType === "table" || el.elementType === "image") {
    return true;
  }
  if (el.elementType !== "shape") return false;
  const [, , w, h] = el.bounds;
  return w >= 120 && h >= 48;
}

/** Label promised a figure; host will not leave a hollow slot. */
export function chartSlotWithoutExhibitIssues(page: SkillPageInput): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const own = ownElements(page.elements);
  for (const el of own) {
    if (el.elementType !== "text") continue;
    const text = ((el as TextElement).content?.text ?? "").replace(/\s+/g, "");
    if (!CHART_SLOT_LABEL.test(text)) continue;
    const [x, y, w, h] = el.bounds;
    const slot: [number, number, number, number] = [
      x,
      y + h,
      Math.max(w, 200),
      Math.max(80, Math.min(280, 500 - (y + h))),
    ];
    const filled = own.some(
      (other) => other.elementId !== el.elementId && isExhibitElement(other) && boundsOverlap(other.bounds, slot),
    );
    if (filled) continue;
    issues.push({
      pageId: page.id,
      code: "empty_box",
      message: `page ${page.id} label "${(el as TextElement).content?.text}" has no chart, table, or figure in the slot below it`,
    });
  }
  return issues;
}

export function tableEmptyCellIssues(page: SkillPageInput): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  for (const el of ownElements(page.elements)) {
    if (el.elementType !== "table") continue;
    const rows = (el as TableElement).rows;
    if (!Array.isArray(rows) || rows.length < 2) continue;
    const header = rows[0]!.map((cell) => (cell?.text ?? "").trim());
    for (const [col, title] of header.entries()) {
      if (!title) continue;
      for (const [rowIndex, row] of rows.slice(1).entries()) {
        const value = (row[col]?.text ?? "").trim();
        if (value) continue;
        issues.push({
          pageId: page.id,
          code: "empty_cell",
          message: `table ${el.elementId} header ${title} has an empty body value in row ${rowIndex + 1}`,
        });
      }
    }
  }
  return issues;
}

export type WritePageSchemaContext = {
  writtenIndex?: number;
  writtenLast?: number;
  lastDiskBasename?: string;
  diskPageCount?: number;
  /**
   * Whether this page is the last one of the committed plan; absent without a plan. Pages are
   * written in deck order, so each is the last one written for a moment. With a plan, only the
   * plan's last page is a closer by position.
   */
  planLast?: boolean;
  theme?: Theme;
  adoptedPackId?: string;
  adoptedPackHexes?: ReadonlySet<string> | readonly string[];
  otherPackHexes?: ReadonlySet<string> | readonly string[];
  adoptedDesignSourceIds?: readonly string[];
  materialError?: string;
  /** Project whose template kits identify the template-component paint a write may keep. */
  templateKitRoot?: string;
  backgroundColorOverride?: boolean;
  persistedBackgroundColor?: string;
  siblingImageSrcs?: readonly { pageId: string; src: string }[];
  photoExhibit?: boolean;
  projectRoot?: string;
};

/** The colour context of one write. `tool` names the refusing tool in Chinese messages (default write_page). */
export type PackColorContext = Pick<
  WritePageSchemaContext,
  | "adoptedPackId"
  | "adoptedPackHexes"
  | "otherPackHexes"
  | "adoptedDesignSourceIds"
  | "materialError"
  | "templateKitRoot"
  | "backgroundColorOverride"
  | "persistedBackgroundColor"
> & { tool?: "write_page" | "write_layout" };

function isLastDiskPage(page: SkillPageInput, ctx: WritePageSchemaContext): boolean {
  const last = ctx.lastDiskBasename;
  if (!last || (ctx.diskPageCount ?? 0) <= 1) return false;
  return persistPageKey(page.id) === persistPageKey(last);
}

export function isWritePageCloser(page: SkillPageInput, ctx: WritePageSchemaContext = {}): boolean {
  const byPosition = ctx.planLast !== false;
  if (isCloserPage(page, byPosition ? ctx.writtenIndex : undefined, ctx.writtenLast)) return true;
  if (byPosition && isLastDiskPage(page, ctx)) return true;
  if (isLeftoverContentBasename(page.id) && (ctx.diskPageCount ?? 0) > 1) return true;
  return false;
}

function toCatalogHexSet(value: WritePageSchemaContext["adoptedPackHexes"]): Set<string> | undefined {
  if (!value) return undefined;
  const set = new Set<string>();
  for (const raw of value) {
    const hex = String(raw).trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(hex)) set.add(hex);
  }
  return set.size ? set : undefined;
}

function recordWritePageColor(
  value: string,
  trail: string,
  pageId: string,
  issues: LayoutIssue[],
  theme?: Theme,
  pack?: PackColorContext,
): void {
  if (officialPptdColorKind(value) === "omitted") return;
  const tool = pack?.tool ?? "write_page";
  const refusal = colorRefusal(value, theme);
  if (refusal) {
    issues.push({
      pageId,
      code: "invalid_color",
      message: `位置 ${trail}：${refusal}${tool} 已拒绝；无效颜色不会变成 #000000。`,
    });
    return;
  }
  const hex = toRgbHex(value, theme);
  const adopted = toCatalogHexSet(pack?.adoptedPackHexes);
  if (!adopted || adopted.has(hex)) return;
  if (trail === "background.color") {
    if (pack?.backgroundColorOverride === true) return;
    if (pack?.persistedBackgroundColor) {
      try {
        if (toRgbHex(pack.persistedBackgroundColor, theme) === hex) return;
      } catch {
        // An invalid baseline never grants a pack exception.
      }
    }
  }
  const packId = pack?.adoptedPackId?.trim() || "pack";
  const paletteSource = pack?.adoptedDesignSourceIds?.length ? "已采用的设计源" : `${packId} PART B 【Color Palette】`;
  issues.push({
    pageId,
    code: "pack_color",
    message:
      `color ${JSON.stringify(value)} → ${hex} at ${trail} is not allowed by ${paletteSource}. ` +
      `Allowed pack colors: ${[...adopted].sort().join(", ")}. ` +
      `After adoption, official Color must be an allowed palette hex or a Theme.colors $token that resolves to it. ` +
      `${tool} refused. Host did not snap colors. Host did not paint and did not rebind Theme.colors.`,
  });
}

const HTML_STYLE_COLOR_KEYS = new Set(["color", "background-color"]);

/** Rich-text `color` and `background-color` are colours. A plain hex mention is not. */
function visitHtmlStyleColors(
  html: string,
  trail: string,
  pageId: string,
  issues: LayoutIssue[],
  theme?: Theme,
  pack?: PackColorContext,
): void {
  const styleAttr = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = styleAttr.exec(html))) {
    const css = match[2] ?? "";
    for (const part of css.split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      const key = part.slice(0, colon).trim().toLowerCase();
      if (!HTML_STYLE_COLOR_KEYS.has(key)) continue;
      let raw = part.slice(colon + 1).trim();
      if (
        (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
        (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
      ) {
        raw = raw.slice(1, -1).trim();
      }
      if (!raw) continue;
      recordWritePageColor(raw, `${trail}@style.${key}`, pageId, issues, theme, pack);
    }
  }
}

function visitWritePageColors(
  value: unknown,
  trail: string,
  pageId: string,
  issues: LayoutIssue[],
  theme?: Theme,
  pack?: PackColorContext,
): void {
  if (value == null) return;
  if (typeof value === "string") {
    const leaf = trail.split(".").pop() ?? "";
    if (leaf === "text" && /<[a-z]/i.test(value)) {
      visitHtmlStyleColors(value, trail, pageId, issues, theme, pack);
      return;
    }
    const colorLeaf = leaf === "color" || leaf === "backgroundColor" || leaf === "fill" || /^colors\[\d+\]$/.test(leaf);
    if (!colorLeaf) return;
    recordWritePageColor(value, trail, pageId, issues, theme, pack);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitWritePageColors(item, `${trail}[${index}]`, pageId, issues, theme, pack));
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      visitWritePageColors(nested, trail ? `${trail}.${key}` : key, pageId, issues, theme, pack);
    }
  }
}

/** Colour refusals for a page already on disk, checked against a theme (update_deck guard). */
export function storedPageColorIssues(
  page: { elements: readonly PptdElement[]; background?: unknown },
  pageId: string,
  theme?: Theme,
): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  visitWritePageColors(ownElements(page.elements), "elements", pageId, issues, theme);
  if (page.background) visitWritePageColors(page.background, "background", pageId, issues, theme);
  return issues;
}

export function writePageColorIssues(
  page: Pick<SkillPageInput, "id" | "elements" | "background">,
  theme?: Theme,
  pack?: PackColorContext,
): LayoutIssue[] {
  if (pack?.materialError) {
    const tool = pack.tool ?? "write_page";
    return [
      {
        pageId: page.id,
        code: "pack_color",
        message:
          `${pack.materialError} 已采用的设计源未通过校验，${tool} refused；` + "请重新上传有效的设计源后再写入页面。",
      },
    ];
  }
  const issues: LayoutIssue[] = [];
  // A template component keeps the template's own colours; every other element is checked, and a
  // skipped slot stays null so the element indexes in the refusal text still match the page.
  const keepsTemplatePaint = pack?.templateKitRoot ? templateComponentPaintCheck(pack.templateKitRoot) : undefined;
  const painted = ownElements(page.elements).map((el) => (keepsTemplatePaint?.(el) ? null : el));
  visitWritePageColors(painted, "elements", page.id, issues, theme, pack);
  if (page.background) visitWritePageColors(page.background, "background", page.id, issues, theme, pack);
  return issues;
}

/**
 * Deterministic YAML/schema refuse for write_page. Empty navy, empty table
 * cells, and invented bounds are not vision problems.
 */
export function writePageSchemaIssues(
  page: SkillPageInput,
  ctx: WritePageSchemaContext = {},
  rawPage?: Record<string, unknown>,
): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  if (rawPage) issues.push(...rawPageBoundsIssues(rawPage, page.id));
  if (isWritePageCloser(page, ctx) && !pageHasReadableCopy(page)) {
    issues.push({
      pageId: page.id,
      code: "empty",
      message: EMPTY_CLOSER_PRODUCE_NEXT,
    });
  } else if (!pageHasVisibleContent(page) && !holdsOnlyTemplateComponents(page, ctx.projectRoot)) {
    issues.push({
      pageId: page.id,
      code: "empty",
      message: `page ${page.id} has no visible text, table body values, or chart series — shape-area coverage is not content`,
    });
  }
  issues.push(...tableEmptyCellIssues(page));
  issues.push(...pageGeometryIssues(page));
  issues.push(...chartSlotWithoutExhibitIssues(page));
  issues.push(...photoExhibitIssues(page, ctx));
  issues.push(...writePageColorIssues(page, ctx.theme, ctx));
  if (ctx.siblingImageSrcs?.length) {
    const reused = reusedFullBleedSrcIssue(page, ctx.siblingImageSrcs);
    if (reused) issues.push(reused);
  }
  return issues;
}

export function writePageSchemaError(
  issues: readonly LayoutIssue[],
  page: SkillPageInput,
  ctx: WritePageSchemaContext = {},
): { error: string; detail: string; pageId: string } | undefined {
  if (!issues.length) return undefined;
  const structural = issues.find(
    (issue) =>
      issue.code === "bounds_omitted" ||
      issue.code === "zero_area" ||
      issue.code === "overflow" ||
      issue.code === "overlap" ||
      issue.code === "overlap_layout" ||
      issue.code === "empty_cell" ||
      issue.code === "footer_zone" ||
      issue.code === "invalid_color" ||
      issue.code === "pack_color" ||
      issue.code === "empty_box" ||
      issue.code === "reused_cover_src" ||
      issue.code === "missing_media",
  );
  if (structural) {
    return {
      error: structural.code,
      detail: issues.map((issue) => issue.message).join("\n"),
      pageId: page.id,
    };
  }
  const closer = issues.find(
    (issue) => issue.code === "empty" && isWritePageCloser(page, ctx) && !pageHasReadableCopy(page),
  );
  if (closer) {
    return {
      error: "empty_closer",
      detail: EMPTY_CLOSER_PRODUCE_NEXT,
      pageId: page.id,
    };
  }
  const first = issues[0]!;
  return {
    error: first.code,
    detail: issues.map((issue) => issue.message).join("\n"),
    pageId: page.id,
  };
}

function isBody(page: SkillPageInput, index: number, last: number): boolean {
  const t = (page.pageType || "").toLowerCase();
  if (t === "cover" || t === "close" || t === "toc") return false;
  if (index === 0 || index === last) return false;
  return true;
}

/** Every classroom page, including cover and takeaway, needs a drawing — not cards+copy. */
export function isCoursewareExhibitPage(_page: SkillPageInput, _index: number, _last?: number): boolean {
  return true;
}

function isPlateShape(el: PptdElement): boolean {
  if (el.elementType !== "shape") return false;
  const name = String((el as ShapeElement).shapeName || "rect").toLowerCase();
  return name === "rect" || name === "roundrect" || name === "round_rect";
}

function shapeNameOf(el: PptdElement): string {
  return el.elementType === "shape" ? String((el as ShapeElement).shapeName || "").toLowerCase() : "";
}

/**
 * Agent-drawn paper-white layouts (no host recipe ids).
 * Cover: giant blush circle + band. Route: coral rule + vertical spine + stations.
 * Concept: coral rule + two columns. Method: three condition panels.
 * Demo: top band + result bar. Transfer: action panel.
 */
export function hasPaperWhiteStructure(elements: PptdElement[]): boolean {
  if (hasOfficialRecipe(elements)) return true;
  const shapes = elements.filter((el) => el.elementType === "shape");
  const ellipses = shapes.filter((el) => shapeNameOf(el) === "ellipse");
  const plates = shapes.filter((el) => isPlateShape(el));
  const texts = elements.filter((el) => el.elementType === "text");
  const giant = ellipses.some((el) => el.bounds[2] >= 280 && el.bounds[3] >= 280);
  const band = plates.some((el) => el.bounds[1] >= 240 && el.bounds[2] >= 400 && el.bounds[3] >= 80);
  if (giant && band) return true;
  const coralRule = plates.some((el) => el.bounds[2] <= 120 && el.bounds[3] <= 16);
  const spine = plates.some((el) => el.bounds[2] <= 12 && el.bounds[3] >= 200);
  if ((coralRule || spine) && ellipses.length >= 3) return true;
  const left = texts.some((el) => el.bounds[0] < 200 && el.bounds[2] >= 280);
  const right = texts.some((el) => el.bounds[0] >= 480 && el.bounds[2] >= 280);
  if (coralRule && left && right) return true;
  const columns = plates.filter((el) => el.bounds[2] >= 220 && el.bounds[2] <= 340 && el.bounds[3] >= 180);
  if (columns.length >= 3) return true;
  const topBand = plates.some(
    (el) => el.bounds[0] <= 8 && el.bounds[2] >= 800 && el.bounds[3] >= 48 && el.bounds[3] <= 140,
  );
  const resultBar = plates.some((el) => el.bounds[2] >= 700 && el.bounds[3] >= 48 && el.bounds[1] >= 350);
  if (topBand && (resultBar || texts.length >= 4)) return true;
  const actionPanel = plates.some((el) => el.bounds[2] >= 700 && el.bounds[3] >= 160);
  if (actionPanel && texts.length >= 3) return true;
  return false;
}

/** Official recipe or a real exhibit — not two colored cards plus homework copy. */
export function hasDrawnExhibit(elements: PptdElement[]): boolean {
  if (hasPaperWhiteStructure(elements)) return true;
  if (elements.some((el) => el.elementType === "image" && Boolean((el as ImageElement).src))) {
    return true;
  }
  if (elements.some((el) => el.elementType === "table" || el.elementType === "chart")) {
    return true;
  }
  const drawn = elements.filter((el) => el.elementType === "shape" && !isPlateShape(el));
  if (drawn.length >= 2) return true;
  if (drawn.length === 1 && area(drawn[0]!) >= 80 * 80) return true;
  return false;
}

export function detectExhibit(elements: PptdElement[]): string | null {
  if (hasPaperWhiteStructure(elements)) return "shape";
  if (elements.some((el) => el.elementType === "image" && Boolean((el as ImageElement).src))) {
    return "image";
  }
  if (elements.some((el) => el.elementType === "table")) return "table";
  if (elements.some((el) => el.elementType === "chart")) return "chart";
  const big = elements.filter((el) => el.elementType === "shape" && area(el) >= 200 * 140);
  if (big.length >= 1) return "shape";
  return null;
}

/** Three equal-width plates — the stamp the skill forbids as a default. */
export function hasThreePlates(elements: PptdElement[]): boolean {
  const rects = elements.filter((el) => {
    if (el.elementType !== "shape") return false;
    const [, , w, h] = el.bounds;
    return w >= 220 && w <= 340 && h >= 180;
  });
  return rects.length >= 3;
}

const HEX_RE = /#([0-9A-Fa-f]{6})\b/g;

/** Cream / white / gray / near-black — a Google-Doc wall, not courseware. */
const COURSEWARE_HEX = new Set(["#44712E", "#F5987E", "#D7EBCE", "#F9DED8", "#56687A"].map((h) => h.toUpperCase()));

export function isNeutralHex(hex: string): boolean {
  const h = hex.replace("#", "").toUpperCase();
  if (COURSEWARE_HEX.has(`#${h}`)) return false;
  if (h.length !== 6) return true;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (sat < 0.14) return true;
  if (lum > 0.9 && sat < 0.28) return true;
  return false;
}

export function collectPageHexes(page: SkillPageInput): string[] {
  const found = new Set<string>();
  const blob = JSON.stringify(page);
  for (const m of blob.matchAll(HEX_RE)) {
    found.add(`#${m[1]!.toUpperCase()}`);
  }
  return [...found];
}

export function hasCoursewareColor(page: SkillPageInput): boolean {
  return collectPageHexes(page).some((hex) => !isNeutralHex(hex));
}

export function coursewarePageIssues(page: SkillPageInput, opts: { body: boolean }): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const content = ownPageView(page);
  const shapes = content.elements.filter((el) => el.elementType === "shape");
  if (hasHomemadeFourCircles(content.elements) || hasKidsDoodle(content.elements)) {
    issues.push({
      pageId: page.id,
      code: "homemade",
      message: `page ${page.id} used homemade 4-step circles or a soil/sun doodle — use the official paper-white list/tool or cover recipe`,
    });
  }
  const exhibitKind = detectExhibit(content.elements);
  if (!hasCoursewareColor(content) && exhibitKind !== "chart" && exhibitKind !== "table" && exhibitKind !== "image") {
    issues.push({
      pageId: page.id,
      code: "no_color",
      message: `page ${page.id} is cream/black only — use courseware green #44712E, coral #F5987E, or a supporting fill`,
    });
  }
  if (!pageText(content.elements).trim()) {
    issues.push({
      pageId: page.id,
      code: "doc_wall",
      message: `page ${page.id} has no readable copy — empty color boxes are not a lesson`,
    });
  }
  const official = hasPaperWhiteStructure(content.elements);
  if (opts.body && !official && !detectExhibit(content.elements)) {
    issues.push({
      pageId: page.id,
      code: "no_exhibit",
      message: `page ${page.id} has no official recipe or exhibit (list panels / result bar / large shape / table / chart).`,
    });
  }
  if (opts.body && !official && !hasDrawnExhibit(content.elements)) {
    issues.push({
      pageId: page.id,
      code: "empty_box",
      message: `page ${page.id} is cards+copy or an empty panel — use paper-white list/tool, editorial columns, or a result bar`,
    });
  }
  if (!opts.body && shapes.length === 0) {
    issues.push({
      pageId: page.id,
      code: "doc_wall",
      message: `page ${page.id} cover/close needs a colored shape panel, not a wall of black text`,
    });
  }
  if (
    opts.body &&
    shapes.length === 0 &&
    !content.elements.some((el) => el.elementType === "table" || el.elementType === "chart")
  ) {
    issues.push({
      pageId: page.id,
      code: "doc_wall",
      message: `page ${page.id} is text-only — draw the exhibit with shapes`,
    });
  }
  return issues;
}

export function hasUnlabeledStat(text: string, researchHadGap: boolean): boolean {
  if (!researchHadGap) return false;
  const hasStat = /人均|[¥￥$€]\s*\d|\d{2,}\s*(?:元|万|亿|人|次|分钟)|(?:\d{1,3}(?:\.\d+)?\s*%)/.test(text);
  if (!hasStat) return false;
  return !/占位|示意|待补|课堂练习|不是统计/.test(text);
}

export function reviewSkillPages(
  pages: SkillPageInput[],
  opts: {
    projectRoot?: string;
    researchHadGap?: boolean;
    todos?: readonly TodoExhibitContract[];
    /** compose = empty/fake/dangling src only. strict = also require an exhibit. */
    mode?: "compose" | "strict";
    /** K-12 courseware: reject cream+black text walls. */
    courseware?: boolean;
  } = {},
): LayoutReview {
  const mode = opts.mode ?? "strict";
  const issues: LayoutIssue[] = [];
  const last = Math.max(0, pages.length - 1);
  const summaries: LayoutReview["pages"] = [];
  for (const [i, page] of pages.entries()) {
    const content = ownPageView(page);
    const coverage = pageCoverage(content.elements);
    const exhibit = detectExhibit(content.elements);
    const imageSrcs = pageImageSrcs(page);
    summaries.push({ id: page.id, coverage, exhibit, imageSrcs });
    issues.push(...chartIssues(content));
    issues.push(...requestedExhibitIssues(page, opts.todos?.[i]));

    if (!pageHasVisibleContent(page)) {
      issues.push({
        pageId: page.id,
        code: "empty",
        message: `page ${page.id} has no visible text, table body values, or chart series — a full-bleed shape is empty (coverage ${coverage.toFixed(2)} is not content)`,
      });
    }
    if (isCloserPage(page, i, last) && !pageHasReadableCopy(page)) {
      issues.push({
        pageId: page.id,
        code: "empty",
        message: `page ${page.id} closer has no readable copy — write a 结束页 with title, one-line recap, and next-month ask; empty navy is not a closer`,
      });
    }
    issues.push(...tableEmptyCellIssues(page));
    issues.push(...pageGeometryIssues(page));
    if (mode === "strict" && isBody(page, i, last) && !exhibit) {
      issues.push({
        pageId: page.id,
        code: "no_exhibit",
        message: `page ${page.id} has no main exhibit (image/table/chart/one large shape)`,
      });
    }
    if (mode === "strict" && isBody(page, i, last) && hasThreePlates(content.elements)) {
      issues.push({
        pageId: page.id,
        code: "three_plates",
        message: `page ${page.id} is title + three plates — not a main exhibit`,
      });
    }
    if (hasUnlabeledStat(pageText(content.elements), Boolean(opts.researchHadGap))) {
      issues.push({
        pageId: page.id,
        code: "unlabeled_stat",
        message: `page ${page.id} has numbers after a research gap — mark 占位/示意/待补`,
      });
    }
    if (opts.courseware) {
      issues.push(...coursewarePageIssues(page, { body: isCoursewareExhibitPage(page, i, last) }));
    }
    if (opts.projectRoot) {
      for (const src of imageSrcs) {
        if (!mediaExists(opts.projectRoot, src)) {
          issues.push({
            pageId: page.id,
            code: "missing_media",
            message: `page ${page.id} chose an image src ${src} that is not on disk — generate_image, or drop the image or picture fill that uses it`,
          });
        }
      }
    }
  }
  return {
    ok: issues.length === 0,
    visualQa: "skipped",
    issues,
    pages: summaries,
  };
}
