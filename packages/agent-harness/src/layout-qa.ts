/**
 * Native structural QA — skill step 4 without export_images.py / Kimi iframe.
 * Media is optional: missing_media only fires if the agent chose a src.
 * compose mode: empty pages + unlabeled invented numbers + dangling src.
 * strict mode: also wants a non-image-or-image exhibit and rejects three plates.
 */
import type {
  ChartElement,
  ExhibitRole,
  ImageElement,
  LineElement,
  PptdElement,
  ShapeElement,
  TextElement,
} from "@open-slidestudio/pptd-v2";
import { colorAlpha, drawnBorderWidth } from "@open-slidestudio/pptd-v2";
import type { SkillPageInput } from "./skill-pages.js";
import { mediaExists } from "./media-store.js";
import { hasHomemadeFourCircles, hasKidsDoodle, hasOfficialRecipe } from "./playbook-recipes.js";

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
    | "broken_gauge";
  message: string;
};

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

const SLIDE = 960 * 540;

export const TODO_EXHIBIT_KINDS = [
  "none",
  "chart:bar",
  "chart:line",
  "chart:pie",
  "chart:waterfall",
  "chart:scatter",
  "chart:combo",
  "table",
  "diagram:funnel",
  "diagram:gauge",
  "diagram:pyramid",
  "diagram:matrix",
  "diagram:timeline",
  "kpi-cards",
  "comparison-cards",
] as const;

export type TodoExhibitKind = (typeof TODO_EXHIBIT_KINDS)[number];

export type TodoExhibitContract = {
  title: string;
  note?: string;
  exhibits?: TodoExhibitKind[];
};

const TODO_EXHIBIT_SET = new Set<string>(TODO_EXHIBIT_KINDS);

export function isTodoExhibitKind(value: unknown): value is TodoExhibitKind {
  return typeof value === "string" && TODO_EXHIBIT_SET.has(value);
}

/** Compatibility path for old outlines. New Pi runs must write typed exhibits. */
export function inferTodoExhibits(text: string): TodoExhibitKind[] {
  const normalized = text
    .replace(/(?:无|不含|不要|without|no)\s*(?:数据)?表(?:格)?/gi, "")
    .replace(/(?:无|不含|不要|without|no)\s*图表/gi, "");
  const found: TodoExhibitKind[] = [];
  const add = (kind: TodoExhibitKind, pattern: RegExp) => {
    if (pattern.test(normalized) && !found.includes(kind)) found.push(kind);
  };
  add("chart:waterfall", /waterfall|瀑布/i);
  add("chart:scatter", /scatter|risk\s*matrix|风险矩阵/i);
  add("chart:pie", /donut|\bring\b|环形|饼图|圆环/i);
  add("chart:line", /spark(?:line)?|\bline\b|折线|趋势线/i);
  add("chart:bar", /\bbars\b|\bbar\s+(?:chart|graph)\b|stack(?:ed)?|柱|条形|堆[叠积]条|时效条|拆分条|账龄条/i);
  add("chart:combo", /combo|dual[-\s]?axis|双轴图/i);
  add("table", /\btables?\b|四列表|区域表|附表|数据表|底表|活动表|拆解表|缺货表|表格/i);
  add("diagram:funnel", /funnel|转化漏斗|漏斗/i);
  add("diagram:gauge", /gauge|仪表盘|进度环|达成率环/i);
  add("diagram:pyramid", /pyramid|金字塔|层级塔/i);
  add("diagram:matrix", /decision\s*matrix|priority\s*matrix|2[×x]2|四象限|九宫格|(?<!风险)矩阵/i);
  add("diagram:timeline", /timeline|时间线|时间轴|路线图|里程碑|发展历程|演进路线/i);
  add("kpi-cards", /\bkpi\b|kpi\s*卡|(?:大|小)?卡片/i);
  add("comparison-cards", /comparison\s*cards?|对照卡/i);
  return found;
}

export function inferBriefPageExhibits(brief: string, pageNumber: number): TodoExhibitKind[] {
  const sections = [...brief.matchAll(/【第\s*(\d+)\s*页[^】]*】([\s\S]*?)(?=【第\s*\d+\s*页|$)/g)];
  const section = sections.find((match) => Number(match[1]) === pageNumber)?.[2];
  return section ? inferTodoExhibits(section) : [];
}

/**
 * Resolve the executable exhibit contract for one todo page.
 * Explicit declarations, legacy outline wording, and page-specific brief
 * requirements are additive. A real requirement always removes `none`.
 */
export function resolveTodoExhibits(todo: TodoExhibitContract, index: number, brief: string): TodoExhibitKind[] {
  const supplied = todo.exhibits?.filter(isTodoExhibitKind) ?? [];
  const inferred = inferTodoExhibits(`${todo.title}\n${todo.note ?? ""}`);
  const briefRequired = inferBriefPageExhibits(brief, index + 1);
  let exhibits = [...new Set([...supplied, ...inferred, ...briefRequired])];
  if (exhibits.some((kind) => kind !== "none")) {
    exhibits = exhibits.filter((kind) => kind !== "none");
  }
  return exhibits.length ? exhibits : ["none"];
}

function isVisibleChartExhibit(element: PptdElement): element is ChartElement {
  if (element.elementType !== "chart") return false;
  const [, , width, height] = element.bounds;
  return width >= 24 && height >= 18 && (element.opacity ?? 1) >= 0.2;
}

function chartTypesOf(element: PptdElement): string[] {
  if (!isVisibleChartExhibit(element)) return [];
  return element.series.map((series) => {
    const raw = String(series.type ?? "bar").toLowerCase();
    return raw === "column" ? "bar" : raw;
  });
}

const EXPLICIT_CHART_COLOR = /^#[0-9A-F]{6}$/i;

function seriesColor(chart: ChartElement, index: number): string | undefined {
  const chartColor = chart.colors?.[index];
  if (chartColor && EXPLICIT_CHART_COLOR.test(chartColor)) return chartColor;
  const fill = chart.series[index]?.fill;
  if (typeof fill === "string" && EXPLICIT_CHART_COLOR.test(fill)) return fill;
  if (fill && typeof fill === "object" && "color" in fill) {
    const color = fill.color;
    if (typeof color === "string" && EXPLICIT_CHART_COLOR.test(color)) return color;
  }
  return undefined;
}

export function explicitChartPaletteIssues(page: SkillPageInput): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  for (const element of page.elements) {
    if (!isVisibleChartExhibit(element)) continue;
    const types = chartTypesOf(element);
    if (types.includes("waterfall") || types.includes("scatter")) continue;
    if (types.includes("pie")) {
      const categoryCount = element.data.rows.length;
      const missing = Array.from({ length: categoryCount }, (_, index) => index).filter(
        (index) => !element.colors?.[index] || !EXPLICIT_CHART_COLOR.test(element.colors[index]!),
      );
      if (missing.length) {
        issues.push({
          pageId: page.id,
          code: "implicit_chart_palette",
          message: `chart ${element.elementId} is pie: set colors to one #RRGGBB swatch per category (${categoryCount} required); series.fill cannot color individual slices and the implicit rainbow palette is forbidden`,
        });
      }
      continue;
    }
    element.series.forEach((_, index) => {
      if (seriesColor(element, index)) return;
      issues.push({
        pageId: page.id,
        code: "implicit_chart_palette",
        message: `chart ${element.elementId} series[${index}] must set fill or colors[${index}] to #RRGGBB; the implicit editor palette is forbidden`,
      });
    });
  }
  return issues;
}

function roleElements(page: SkillPageInput, role: ExhibitRole): PptdElement[] {
  return page.elements.filter((element) => element.exhibitRole === role);
}

function colorIsVisible(color: string | undefined): boolean {
  return (colorAlpha(color) ?? 1) >= 0.2;
}

function diagramContributorIsVisible(element: PptdElement): boolean {
  const [, , width, height] = element.bounds;
  if (element.hidden || (element.opacity ?? 1) < 0.2) return false;
  if (Math.max(width, height) < 8) return false;
  if (element.elementType === "text") {
    const text = element as TextElement;
    return (
      text.content.text.trim().length > 0 && (text.content.fontSize ?? 18) >= 4 && colorIsVisible(text.content.color)
    );
  }
  if (element.elementType === "line") {
    return colorIsVisible((element as LineElement).border?.color);
  }
  if (element.elementType !== "shape") return false;
  const shape = element as ShapeElement;
  const borderVisible = drawnBorderWidth(shape.border) > 0 && colorIsVisible(shape.border?.color);
  if (borderVisible) return true;
  if (!shape.fill) {
    // Path-based shapes have a visible native default paint; CSS primitives
    // without an explicit fill or border are transparent.
    return !["rect", "roundRect", "ellipse"].includes(shape.shapeName);
  }
  if (shape.fill.type === "solid") return colorIsVisible(shape.fill.color);
  if (shape.fill.type === "gradient") {
    return shape.fill.stops.some((stop) => colorIsVisible(stop.color));
  }
  return (shape.fill.opacity ?? 1) >= 0.2;
}

function visibleRoleElements(page: SkillPageInput, role: ExhibitRole): PptdElement[] {
  return roleElements(page, role).filter(diagramContributorIsVisible);
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
  const requested = declared.length ? declared : inferTodoExhibits(`${todo.title}\n${todo.note ?? ""}`);
  return requested
    .filter((requirement) => !satisfiesRequestedExhibit(page, requirement))
    .map((requirement) => ({
      pageId: page.id,
      code: "missing_requested_exhibit" as const,
      message: `page ${page.id} promised ${requirement} in write_todo but did not implement it as editable PPTD elements`,
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

function collectImageSrcs(page: SkillPageInput): string[] {
  const srcs: string[] = [];
  if (page.background?.type === "image" && page.background.src) {
    srcs.push(page.background.src);
  }
  for (const el of page.elements) {
    if (el.elementType !== "image") continue;
    const src = (el as ImageElement).src;
    if (src) srcs.push(src);
  }
  return srcs;
}

const SUPPORTED_CHART_TYPES = new Set(["bar", "column", "line", "area", "pie", "waterfall", "scatter"]);

function chartIssues(page: SkillPageInput): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  for (const element of page.elements) {
    if (element.elementType !== "chart") continue;
    const chart = element as ChartElement;
    const type = String(chart.series[0]?.type ?? "bar").toLowerCase();
    if (!SUPPORTED_CHART_TYPES.has(type)) {
      issues.push({
        pageId: page.id,
        code: "unsupported_chart",
        message: `page ${page.id} chart ${chart.elementId} uses unsupported type ${type}`,
      });
      continue;
    }
    if (type !== "scatter" && type !== "waterfall") continue;
    const encode = chart.series[0]?.encode;
    const xName = encode?.x;
    const yName = encode?.y;
    const xIndex = xName ? chart.data.cols.indexOf(xName) : -1;
    const yIndex = yName ? chart.data.cols.indexOf(yName) : -1;
    const hasNumericRows =
      xIndex >= 0 &&
      yIndex >= 0 &&
      chart.data.rows.some(
        (row) => Number.isFinite(Number(row[yIndex])) && (type === "waterfall" || Number.isFinite(Number(row[xIndex]))),
      );
    if (xIndex < 0 || yIndex < 0 || xIndex === yIndex || !hasNumericRows) {
      issues.push({
        pageId: page.id,
        code: "invalid_chart_data",
        message: `page ${page.id} chart ${chart.elementId} must encode distinct existing x/y columns with numeric rows for ${type}`,
      });
    }
  }
  return issues;
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
  const shapes = page.elements.filter((el) => el.elementType === "shape");
  if (hasHomemadeFourCircles(page.elements) || hasKidsDoodle(page.elements)) {
    issues.push({
      pageId: page.id,
      code: "homemade",
      message: `page ${page.id} used homemade 4-step circles or a soil/sun doodle — use the official paper-white list/tool or cover recipe`,
    });
  }
  const exhibitKind = detectExhibit(page.elements);
  if (!hasCoursewareColor(page) && exhibitKind !== "chart" && exhibitKind !== "table" && exhibitKind !== "image") {
    issues.push({
      pageId: page.id,
      code: "no_color",
      message: `page ${page.id} is cream/black only — use courseware green #44712E, coral #F5987E, or a supporting fill`,
    });
  }
  if (!pageText(page.elements).trim()) {
    issues.push({
      pageId: page.id,
      code: "doc_wall",
      message: `page ${page.id} has no readable copy — empty color boxes are not a lesson`,
    });
  }
  const official = hasPaperWhiteStructure(page.elements);
  if (opts.body && !official && !detectExhibit(page.elements)) {
    issues.push({
      pageId: page.id,
      code: "no_exhibit",
      message: `page ${page.id} has no official recipe or exhibit (list panels / result bar / large shape / table / chart).`,
    });
  }
  if (opts.body && !official && !hasDrawnExhibit(page.elements)) {
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
    !page.elements.some((el) => el.elementType === "table" || el.elementType === "chart")
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

/**
 * Measurable taste gates for taste-gated strict runs. These encode the
 * objective layer of the nine-axis deck review: type scale, density budget,
 * chart composition, and editorial whitespace. They are necessary, not
 * sufficient — the model's grounded review still owns the aesthetic verdict.
 */
export const TASTE_GATE_LIMITS = {
  /** Smallest readable slide title on a content page. */
  minTitleFontSize: 20,
  /** Cover and closing titles must dominate the page. */
  minCoverTitleFontSize: 28,
  /** Smallest readable supporting copy. */
  minBodyFontSize: 11,
  /** Maximum total characters of copy on one content page. */
  maxBodyTextChars: 900,
  /** Maximum visible elements on one content page. */
  maxVisibleElements: 48,
  /** Maximum summed element area relative to the slide (overlap counts). */
  maxPageCoverage: 1.35,
  /** Text at or below this y is footer/page-number chrome, exempt from tiny_text. */
  footerZoneTop: 505,
  /** Maximum legible charts on one page. */
  maxChartsPerPage: 2,
  minChartWidth: 200,
  minChartHeight: 140,
  /** Text may not start closer than this to the left/right slide edge. */
  edgeMarginX: 12,
} as const;

const SLIDE_WIDTH = 960;

function tasteVisibleText(element: PptdElement): element is TextElement {
  if (element.elementType !== "text") return false;
  if (element.hidden || (element.opacity ?? 1) < 0.2) return false;
  const text = (element as TextElement).content;
  return Boolean(text && text.text.trim()) && (text.fontSize ?? 18) >= 4;
}

function tasteVisibleElement(element: PptdElement): boolean {
  if (element.hidden || (element.opacity ?? 1) < 0.2) return false;
  const [, , width, height] = element.bounds;
  return Math.max(width, height) >= 8;
}

const GAUGE_CIRCLE_FAMILY = new Set(["donut", "ellipse", "pie", "arc", "blockarc", "block_arc", "chord", "circle"]);

/**
 * A gauge is one concentric circular instrument. The first real deck drew a
 * small donut beside an unrelated flat ellipse and the loose structural check
 * (≥2 shapes, ≥1 label) passed it as a gauge that reads like a broken pie.
 */
export function gaugeCompositionIssues(page: SkillPageInput, todo: TodoExhibitContract | undefined): LayoutIssue[] {
  if (!todo) return [];
  const declared = todo.exhibits?.filter(isTodoExhibitKind) ?? [];
  const requested = declared.length ? declared : inferTodoExhibits(`${todo.title}\n${todo.note ?? ""}`);
  if (!requested.includes("diagram:gauge")) return [];
  const shapes = visibleRoleElements(page, "gauge").filter(
    (element): element is ShapeElement => element.elementType === "shape",
  );
  if (shapes.length < 2) return [];
  const issues: LayoutIssue[] = [];
  const offFamily = shapes.filter((shape) => !GAUGE_CIRCLE_FAMILY.has(String(shape.shapeName || "").toLowerCase()));
  if (offFamily.length) {
    issues.push({
      pageId: page.id,
      code: "broken_gauge",
      message: `page ${page.id} gauge uses non-circular shapes (${offFamily.map((s) => `${s.elementId}:${s.shapeName}`).join(", ")}) — build the gauge from concentric circles/donuts/arcs only`,
    });
  }
  const discs = shapes.filter((shape) => {
    const [x, y, w, h] = shape.bounds;
    return w > 0 && h > 0;
  });
  const flat = discs.filter((shape) => {
    const [, , w, h] = shape.bounds;
    return w / h > 1.4 || h / w > 1.4;
  });
  if (flat.length) {
    issues.push({
      pageId: page.id,
      code: "broken_gauge",
      message: `page ${page.id} gauge contains flattened ellipses (${flat.map((s) => s.elementId).join(", ")}) — every gauge disc must stay near-circular`,
    });
  }
  const centers = discs.map((shape) => {
    const [x, y, w, h] = shape.bounds;
    return { x: x + w / 2, y: y + h / 2 };
  });
  const maxDiameter = Math.max(...discs.map((shape) => Math.max(shape.bounds[2], shape.bounds[3])));
  const medianX = centers.map((c) => c.x).sort((a, b) => a - b)[Math.floor(centers.length / 2)] ?? 0;
  const medianY = centers.map((c) => c.y).sort((a, b) => a - b)[Math.floor(centers.length / 2)] ?? 0;
  const scattered = centers.filter((center) => Math.hypot(center.x - medianX, center.y - medianY) > maxDiameter * 0.6);
  if (discs.length >= 2 && scattered.length) {
    issues.push({
      pageId: page.id,
      code: "broken_gauge",
      message: `page ${page.id} gauge shapes are not concentric (${scattered.length} of ${centers.length} off-center) — stack the discs on one shared center`,
    });
  }
  return issues;
}

export function tasteGateIssues(
  page: SkillPageInput,
  opts: { body: boolean; todo?: TodoExhibitContract },
): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const texts = page.elements.filter(tasteVisibleText);
  const titleSize = Math.max(0, ...texts.map((el) => el.content.fontSize ?? 18));
  const minTitle = opts.body ? TASTE_GATE_LIMITS.minTitleFontSize : TASTE_GATE_LIMITS.minCoverTitleFontSize;
  if (texts.length && titleSize < minTitle) {
    issues.push({
      pageId: page.id,
      code: "weak_title",
      message: `page ${page.id} largest text is ${titleSize}pt < ${minTitle}pt — the title must dominate the page`,
    });
  }
  if (opts.body) {
    // Bottom chrome (footer strip, page numbers) may stay small; it is not
    // supporting copy. Everything above the strip must stay readable.
    const tiny = texts
      .filter(
        (el) =>
          el.bounds[1] < TASTE_GATE_LIMITS.footerZoneTop &&
          (el.content.fontSize ?? 18) < TASTE_GATE_LIMITS.minBodyFontSize,
      )
      .map((el) => el.elementId);
    if (tiny.length) {
      issues.push({
        pageId: page.id,
        code: "tiny_text",
        message: `page ${page.id} has text below ${TASTE_GATE_LIMITS.minBodyFontSize}pt (${tiny.slice(0, 5).join(", ")}${tiny.length > 5 ? "…" : ""}) — enlarge or cut the copy`,
      });
    }
    const chars = texts.reduce((sum, el) => sum + el.content.text.length, 0);
    if (chars > TASTE_GATE_LIMITS.maxBodyTextChars) {
      issues.push({
        pageId: page.id,
        code: "text_wall",
        message: `page ${page.id} carries ${chars} characters > ${TASTE_GATE_LIMITS.maxBodyTextChars} — move detail to an appendix page or the speaker notes`,
      });
    }
    const visibleCount = page.elements.filter(tasteVisibleElement).length;
    const coverage = pageCoverage(page.elements);
    if (visibleCount > TASTE_GATE_LIMITS.maxVisibleElements || coverage > TASTE_GATE_LIMITS.maxPageCoverage) {
      issues.push({
        pageId: page.id,
        code: "overstuffed",
        message: `page ${page.id} is overstuffed (${visibleCount} visible elements, coverage ${coverage.toFixed(2)}) — split content across pages or remove decoration`,
      });
    }
    const charts = page.elements.filter(isVisibleChartExhibit);
    if (charts.length > TASTE_GATE_LIMITS.maxChartsPerPage) {
      issues.push({
        pageId: page.id,
        code: "chart_pileup",
        message: `page ${page.id} shows ${charts.length} charts > ${TASTE_GATE_LIMITS.maxChartsPerPage} — one chart argument per page`,
      });
    }
    for (const chart of charts) {
      const [, , width, height] = chart.bounds;
      if (width < TASTE_GATE_LIMITS.minChartWidth || height < TASTE_GATE_LIMITS.minChartHeight) {
        issues.push({
          pageId: page.id,
          code: "chart_too_small",
          message: `page ${page.id} chart ${chart.elementId} is ${Math.round(width)}×${Math.round(height)} < ${TASTE_GATE_LIMITS.minChartWidth}×${TASTE_GATE_LIMITS.minChartHeight} — too small to read`,
        });
      }
    }
    const clinging = texts
      .filter((el) => {
        const [x, , width] = el.bounds;
        return x < TASTE_GATE_LIMITS.edgeMarginX || x + width > SLIDE_WIDTH - TASTE_GATE_LIMITS.edgeMarginX;
      })
      .map((el) => el.elementId);
    if (clinging.length) {
      issues.push({
        pageId: page.id,
        code: "edge_cling",
        message: `page ${page.id} text touches the left/right edge (${clinging.slice(0, 5).join(", ")}${clinging.length > 5 ? "…" : ""}) — respect the editorial margin`,
      });
    }
  }
  return issues;
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
    /** Taste-gated Pi runs must choose chart colors instead of inheriting editor defaults. */
    requireExplicitChartColors?: boolean;
    /** Taste-gated Pi runs also enforce the measurable type/density/chart/whitespace gates. */
    tasteGates?: boolean;
  } = {},
): LayoutReview {
  const mode = opts.mode ?? "strict";
  const issues: LayoutIssue[] = [];
  const last = Math.max(0, pages.length - 1);
  const summaries: LayoutReview["pages"] = [];
  for (const [i, page] of pages.entries()) {
    const coverage = pageCoverage(page.elements);
    const exhibit = detectExhibit(page.elements);
    const imageSrcs = collectImageSrcs(page);
    summaries.push({ id: page.id, coverage, exhibit, imageSrcs });
    issues.push(...chartIssues(page));
    if (opts.requireExplicitChartColors) {
      issues.push(...explicitChartPaletteIssues(page));
    }
    issues.push(...requestedExhibitIssues(page, opts.todos?.[i]));

    const minCover = isBody(page, i, last) ? (mode === "strict" ? 0.32 : 0.18) : mode === "strict" ? 0.14 : 0.08;
    if (coverage < minCover) {
      issues.push({
        pageId: page.id,
        code: "empty",
        message: `page ${page.id} coverage ${coverage.toFixed(2)} < ${minCover} — page is too empty`,
      });
    }
    if (mode === "strict" && isBody(page, i, last) && !exhibit) {
      issues.push({
        pageId: page.id,
        code: "no_exhibit",
        message: `page ${page.id} has no main exhibit (image/table/chart/one large shape)`,
      });
    }
    if (mode === "strict" && isBody(page, i, last) && hasThreePlates(page.elements)) {
      issues.push({
        pageId: page.id,
        code: "three_plates",
        message: `page ${page.id} is title + three plates — not a main exhibit`,
      });
    }
    if (hasUnlabeledStat(pageText(page.elements), Boolean(opts.researchHadGap))) {
      issues.push({
        pageId: page.id,
        code: "unlabeled_stat",
        message: `page ${page.id} has numbers after a research gap — mark 占位/示意/待补`,
      });
    }
    if (opts.courseware) {
      issues.push(...coursewarePageIssues(page, { body: isCoursewareExhibitPage(page, i, last) }));
    }
    if (opts.tasteGates) {
      issues.push(...tasteGateIssues(page, { body: isBody(page, i, last), todo: opts.todos?.[i] }));
      issues.push(...gaugeCompositionIssues(page, opts.todos?.[i]));
    }
    if (opts.projectRoot) {
      for (const src of imageSrcs) {
        if (!mediaExists(opts.projectRoot, src)) {
          issues.push({
            pageId: page.id,
            code: "missing_media",
            message: `page ${page.id} chose an image src ${src} that is not on disk — generate_image or drop the image element`,
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
