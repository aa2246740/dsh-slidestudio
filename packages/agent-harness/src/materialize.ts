/** Turn ComposeDeck + playbook palette into a YAML PPTD v2 project. */
import fs from "node:fs";
import path from "node:path";
import type { Page, PptdElement, PptdProject, TableCell, TableElement, TextElement } from "@open-slidestudio/pptd-v2";
import type { ComposeChart, ComposeDeck, ComposePage } from "./compose-ir.js";
import type { Palette } from "./playbook.js";

const SLIDE_W = 960;
const GUTTER = 40;
const ZONE = "#F1F1F1";
const MINT = "#D1F5E2";
const RULE = "#E5E5E5";
const DEFAULT_KICKER = "内部讨论 · 草稿";

export function titleFontSize(s: string, kind: "cover" | "body"): number {
  const n = [...s].length;
  if (kind === "cover") {
    if (n <= 10) return 34;
    if (n <= 18) return 32;
    if (n <= 28) return 28;
    return 24;
  }
  if (n <= 16) return 20;
  if (n <= 28) return 18;
  return 16;
}

function contentBottom(p: ComposePage): number {
  return p.soWhat ? 432 : 500;
}

function text(
  id: string,
  bounds: [number, number, number, number],
  body: string,
  opts: Partial<TextElement["content"]> = {},
): TextElement {
  return {
    elementId: id,
    elementType: "text",
    bounds,
    content: { text: body, wrap: true, ...opts },
  };
}

function rect(id: string, bounds: [number, number, number, number], color: string): PptdElement {
  return {
    elementId: id,
    elementType: "shape",
    bounds,
    shapeName: "rect",
    fill: { type: "solid", color },
  };
}

export function pageFile(index: number, role: string): string {
  const n = String(index + 1).padStart(2, "0");
  return `pages/${n}_${role}.page`;
}

export function stripIndexPrefix(s: string): string {
  return s.replace(/^\s*(?:\d+[\.、\)\:：]\s*|[（(]\d+[）)]\s*)/, "").trim();
}

export function chartHasNumericY(chart: ComposeChart): boolean {
  return chart.rows.some((row) => typeof row[1] === "number" && Number.isFinite(row[1]));
}

function nn(n: number): string {
  return String(n).padStart(2, "0");
}

function isWeakSubtitle(s?: string): boolean {
  if (!s) return true;
  return /^(目录|纲要|contents?|toc)$/i.test(s.trim());
}

function tableEl(
  id: string,
  bounds: [number, number, number, number],
  cols: string[],
  rows: (string | number | null)[][],
  pal: Palette,
): TableElement {
  const colW = cols.map(() => bounds[2] / Math.max(cols.length, 1));
  const header: TableCell[] = cols.map((h) => ({
    text: h,
    bold: true,
    color: "#FFFFFF",
    fill: { type: "solid", color: pal.primary },
    align: ["left", "middle"],
  }));
  const body: TableCell[][] = rows.map((row) =>
    cols.map((_, i) => ({
      text: row[i] == null ? "" : String(row[i]),
      color: pal.text,
      align: ["left", "middle"] as [string, string],
    })),
  );
  return {
    elementId: id,
    elementType: "table",
    bounds,
    columnWidths: colW,
    rows: [header, ...body],
  };
}

function footer(elements: PptdElement[], pal: Palette, index: number, note?: string): void {
  const footnote = text("fn", [GUTTER, 516, 800, 14], note ?? "", {
    fontSize: 9,
    color: pal.muted,
  });
  footnote.layoutRole = "footer";
  const pageNumber = text("pg", [880, 516, 40, 14], String(index + 1), {
    fontSize: 10,
    color: pal.muted,
    align: ["right", "middle"],
    wrap: false,
  });
  pageNumber.layoutRole = "footer";
  elements.push(footnote, pageNumber);
}

function bodyChrome(elements: PptdElement[], p: ComposePage, pal: Palette): void {
  elements.push(rect("top", [0, 0, SLIDE_W, 6], pal.primary));
  if (p.chapter) {
    elements.push(rect("vrule", [GUTTER, 22, 3, 16], pal.primary));
    elements.push(
      text("chap", [52, 20, 400, 20], p.chapter, {
        fontSize: 11,
        color: pal.muted,
        bold: true,
      }),
    );
  }
  elements.push(
    text("title", [GUTTER, 44, 880, 68], p.title, {
      fontSize: titleFontSize(p.title, "body"),
      bold: true,
      color: pal.primary,
    }),
  );
  if (p.subtitle && !isWeakSubtitle(p.subtitle)) {
    elements.push(
      text("sub", [GUTTER, 114, 880, 22], p.subtitle, {
        fontSize: 12,
        color: pal.muted,
      }),
    );
  }
}

function soWhatBar(elements: PptdElement[], pal: Palette, message: string): void {
  elements.push(rect("swbg", [GUTTER, 448, 880, 56], ZONE));
  elements.push(rect("swacc", [GUTTER, 448, 4, 56], pal.primary));
  elements.push(
    text("sw", [56, 456, 852, 40], message, {
      fontSize: 12,
      color: pal.text,
    }),
  );
}

function buildCover(p: ComposePage, pal: Palette, index: number): Page {
  const elements: PptdElement[] = [
    rect("band", [0, 0, 200, 540], pal.primary),
    rect("mint", [200, 0, 12, 540], MINT),
    rect("foot", [0, 528, SLIDE_W, 12], pal.primary),
    text("kicker", [236, 150, 680, 22], String(p.kicker ?? DEFAULT_KICKER), {
      fontSize: 11,
      color: pal.muted,
      bold: true,
      letterSpacing: 1.4,
    }),
    text("title", [236, 186, 680, 130], p.title, {
      fontSize: titleFontSize(p.title, "cover"),
      bold: true,
      color: pal.primary,
    }),
  ];
  if (p.subtitle) {
    elements.push(
      text("sub", [236, 328, 680, 48], p.subtitle, {
        fontSize: 14,
        color: pal.text,
      }),
    );
  }
  const pageNumber = text("pg", [900, 500, 36, 14], String(index + 1), {
    fontSize: 10,
    color: pal.muted,
    align: ["right", "middle"],
    wrap: false,
  });
  pageNumber.layoutRole = "footer";
  elements.push(pageNumber);
  return {
    pageType: "cover",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

function tocRailFallback(p: ComposePage): string {
  const title = p.title || "";
  if (/今天要搞懂|记住什么/.test(title)) {
    return "先看今天要搞懂什么，再学概念，最后用例子带走一句能复述的话。";
  }
  if (/汇报结构/.test(title)) {
    return "先看进展，再看问题，最后只写能核验的下一步。";
  }
  if (/报告结构/.test(title)) {
    return "先锁定问题，再看方法边界，结论只写已给材料支撑的部分。";
  }
  if (/这一页之后记住/.test(title)) {
    return "先抓住记忆点，再读主张，最后带走一句能转述的话。";
  }
  return "先读标题判断，再看需要补的材料，最后落到能核对的动作。";
}

function buildToc(p: ComposePage, pal: Palette, index: number): Page {
  const elements: PptdElement[] = [];
  bodyChrome(elements, p, pal);
  const items = (p.items ?? p.bullets ?? []).map(stripIndexPrefix).slice(0, 6);
  items.forEach((item, i) => {
    const y = 150 + i * 50;
    elements.push(
      text(`n${i}`, [GUTTER, y, 56, 28], nn(i + 1), {
        fontSize: 18,
        bold: true,
        color: pal.primary,
        wrap: false,
        align: ["left", "middle"],
      }),
    );
    elements.push(
      text(`t${i}`, [108, y, 500, 28], item, {
        fontSize: 15,
        color: pal.text,
        align: ["left", "middle"],
      }),
    );
    elements.push(rect(`l${i}`, [108, y + 34, 500, 1], RULE));
  });
  elements.push(rect("rail", [640, 150, 280, 280], ZONE));
  elements.push(rect("railacc", [640, 150, 4, 280], pal.primary));
  elements.push(
    text("railt", [656, 166, 248, 24], "阅读路径", {
      fontSize: 12,
      bold: true,
      color: pal.primary,
    }),
  );
  const railBody = p.soWhat || (!isWeakSubtitle(p.subtitle) ? p.subtitle : undefined) || tocRailFallback(p);
  elements.push(
    text("railb", [656, 198, 248, 210], railBody, {
      fontSize: 13,
      color: pal.text,
    }),
  );
  footer(elements, pal, index);
  return {
    pageType: "content",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

function buildEvidence(p: ComposePage, pal: Palette, index: number): Page {
  const elements: PptdElement[] = [];
  bodyChrome(elements, p, pal);
  const c = p.chart;
  if (c && chartHasNumericY(c)) {
    elements.push({
      elementId: "chart",
      elementType: "chart",
      bounds: [GUTTER, 148, 500, 280],
      data: { cols: c.cols, rows: c.rows },
      series: [
        {
          type: "bar",
          name: c.cols[1] ?? "值",
          encode: { x: c.cols[0] ?? "项", y: c.cols[1] ?? "值" },
          fill: pal.primary,
        },
      ],
      legend: false,
    });
    const pairCols = [c.cols[0] ?? "项", c.cols[1] ?? "值"];
    const pairRows = c.rows.map((row) => [row[0] ?? "", row[1] ?? ""]);
    elements.push(tableEl("tbl", [560, 148, 360, 280], pairCols, pairRows, pal));
  } else if (c) {
    elements.push(tableEl("tbl", [GUTTER, 148, 880, 280], c.cols, c.rows, pal));
  }
  const note = p.note ?? c?.note ?? "结构示意";
  footer(elements, pal, index, note);
  if (p.soWhat) soWhatBar(elements, pal, p.soWhat);
  return {
    pageType: "content",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

/** IR fallback only. Education skill: title → one exhibit → support. No cards / 2×2. */
function buildClaims(p: ComposePage, pal: Palette, index: number): Page {
  const elements: PptdElement[] = [];
  bodyChrome(elements, p, pal);
  const bullets = (p.bullets ?? p.items ?? []).map(stripIndexPrefix).slice(0, 6);
  const bottom = contentBottom(p);
  if (bullets.length) {
    const exhibit = bullets[0]!;
    const support = bullets.slice(1);
    elements.push(rect("exrule", [GUTTER, 148, 4, 96], pal.primary));
    elements.push(
      text("exhibit", [GUTTER + 20, 148, 860, 96], exhibit, {
        fontSize: 18,
        bold: true,
        color: pal.primary,
      }),
    );
    support.forEach((b, i) => {
      const y = 260 + i * 34;
      if (y + 28 > bottom) return;
      elements.push(
        text(`n${i}`, [GUTTER, y, 36, 28], nn(i + 1), {
          fontSize: 14,
          bold: true,
          color: pal.primary,
          wrap: false,
          align: ["left", "middle"],
        }),
      );
      elements.push(
        text(`b${i}`, [GUTTER + 44, y, 836, 28], b, {
          fontSize: 14,
          color: pal.text,
          align: ["left", "middle"],
        }),
      );
    });
  }
  if (p.soWhat) soWhatBar(elements, pal, p.soWhat);
  footer(elements, pal, index, p.note);
  return {
    pageType: "content",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

function buildTimeline(p: ComposePage, pal: Palette, index: number): Page {
  const elements: PptdElement[] = [];
  bodyChrome(elements, p, pal);
  const items = (p.items ?? p.bullets ?? []).map(stripIndexPrefix).slice(0, 7);
  const n = Math.max(2, items.length);
  const y = 248;
  const x0 = GUTTER + 16;
  const x1 = SLIDE_W - GUTTER - 16;
  const span = x1 - x0;
  const slot = n <= 1 ? span : span / (n - 1);
  const labelW = Math.min(Math.max(88, slot - 10), 168);
  const labelH = 58;
  const charsPerLine = Math.max(8, Math.floor(labelW / 11));
  const maxLabelChars = charsPerLine * 4;
  elements.push(rect("track", [x0, y, span, 2], pal.primary));
  items.forEach((item, i) => {
    const x = x0 + (span * i) / Math.max(1, n - 1);
    const above = i % 2 === 0;
    const lx = Math.max(8, Math.min(SLIDE_W - 8 - labelW, x - labelW / 2));
    const label = item.length > maxLabelChars ? `${item.slice(0, Math.max(1, maxLabelChars - 1))}…` : item;
    const bodyY = above ? y - 14 - labelH : y + 38;
    const numberY = above ? bodyY - 22 : y + 16;
    elements.push({
      elementId: `tl${i}`,
      elementType: "shape",
      bounds: [x - 5, y - 5, 10, 10],
      shapeName: "ellipse",
      fill: { type: "solid", color: i === n - 1 ? pal.accent : pal.primary },
    });
    elements.push(
      text(`tt${i}`, [lx, numberY, labelW, 18], nn(i + 1), {
        fontSize: 11,
        bold: true,
        color: pal.primary,
        align: ["center", "top"],
        wrap: false,
      }),
    );
    elements.push(
      text(`tb${i}`, [lx, bodyY, labelW, labelH], label, {
        fontSize: 11,
        color: pal.text,
        align: ["center", "top"],
      }),
    );
  });
  if (p.soWhat) soWhatBar(elements, pal, p.soWhat);
  footer(elements, pal, index, p.note);
  return { pageType: "content", background: { type: "solid", color: pal.background }, elements };
}

function buildMatrix(p: ComposePage, pal: Palette, index: number): Page {
  const elements: PptdElement[] = [];
  bodyChrome(elements, p, pal);
  const items = (p.items ?? p.bullets ?? []).map(stripIndexPrefix).slice(0, 4);
  const cells: [string, number, number][] = [];
  const w = 380;
  const h = 120;
  const gap = 24;
  items.forEach((item, i) => {
    const x = GUTTER + (i % 2) * (w + gap);
    const y = 160 + Math.floor(i / 2) * (h + gap);
    cells.push([item, x, y]);
  });
  cells.forEach(([item, x, y], i) => {
    elements.push(rect(`mx${i}`, [x, y, w, h], ZONE));
    elements.push(rect(`ma${i}`, [x, y, 4, h], pal.primary));
    elements.push(
      text(`mt${i}`, [x + 18, y + 14, w - 36, 24], nn(i + 1), {
        fontSize: 14,
        bold: true,
        color: pal.primary,
      }),
    );
    elements.push(
      text(`mb${i}`, [x + 18, y + 40, w - 36, 64], item, {
        fontSize: 12,
        color: pal.text,
      }),
    );
  });
  if (p.soWhat) soWhatBar(elements, pal, p.soWhat);
  footer(elements, pal, index, p.note);
  return { pageType: "content", background: { type: "solid", color: pal.background }, elements };
}

function buildPage(p: ComposePage, pal: Palette, index: number): Page {
  if (p.role === "cover") return buildCover(p, pal, index);
  if (p.role === "toc") return buildToc(p, pal, index);
  if (p.role === "evidence") return buildEvidence(p, pal, index);
  if (p.role === "timeline") return buildTimeline(p, pal, index);
  if (p.role === "matrix") return buildMatrix(p, pal, index);
  return buildClaims(p, pal, index);
}

export function materializeDeck(project: PptdProject, deck: ComposeDeck, pal: Palette): void {
  project.presentation.title = deck.title;
  project.presentation.theme = {
    colors: {
      primary: pal.primary,
      accent: pal.accent,
      text: pal.text,
      muted: pal.muted,
      background: pal.background,
      danger: pal.danger,
    },
    textStyles: {
      title: { fontSize: 28, bold: true, color: pal.primary },
      body: { fontSize: 15, color: pal.text },
    },
  };

  project.pages = deck.pages.map((page, i) => ({
    path: pageFile(i, page.role),
    page: buildPage(page, pal, i),
  }));
  project.presentation.pages = project.pages.map((p) => p.path);

  const pagesDir = path.join(project.rootDir, "pages");
  if (fs.existsSync(pagesDir)) {
    const keep = new Set(project.pages.map((p) => path.basename(p.path)));
    for (const name of fs.readdirSync(pagesDir)) {
      if (!keep.has(name)) fs.unlinkSync(path.join(pagesDir, name));
    }
  }
}
