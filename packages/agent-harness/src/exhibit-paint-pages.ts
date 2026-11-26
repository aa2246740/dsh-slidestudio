import type {
  Bounds,
  ChartElement,
  ChartSeries,
  PptdElement,
  ShapeElement,
  TableCell,
  TableElement,
  TextElement,
} from "@open-slidestudio/pptd-v2";
import type { Palette } from "./playbook.js";
import type { SkillPageInput } from "./skill-pages.js";
import {
  blobOf,
  extractKpis,
  extractPairs,
  extractPathSteps,
  extractTable,
  splitTwoCol,
  type HostPageCopy,
  type KpiCard,
  type NamedValue,
} from "./exhibit-paint.js";

const SLIDE_W = 960;
export const SLIDE_H = 540;

export function txt(
  id: string,
  bounds: Bounds,
  text: string,
  opts: { fontSize?: number; color?: string; bold?: boolean; wrap?: boolean } = {},
): TextElement {
  return {
    elementId: id,
    elementType: "text",
    bounds,
    content: {
      text,
      fontSize: opts.fontSize ?? 16,
      color: opts.color ?? "#333333",
      bold: opts.bold,
      wrap: opts.wrap !== false,
    },
  };
}

export function box(id: string, bounds: Bounds, color: string, shapeName = "roundRect"): ShapeElement {
  return {
    elementId: id,
    elementType: "shape",
    shapeName,
    bounds,
    fill: { type: "solid", color },
  };
}

function asTable(id: string, bounds: Bounds, columns: string[], rows: string[][], pal: Palette): TableElement {
  const colCount = columns.length;
  const width = bounds[2];
  const cells: TableCell[][] = [
    columns.map((c) => ({
      text: c,
      bold: true,
      color: pal.primary,
      fill: { type: "solid", color: mix(pal.background, pal.primary, 0.12) },
    })),
    ...rows.map((row) => row.map((c) => ({ text: c, color: pal.text }))),
  ];
  return {
    elementId: id,
    elementType: "table",
    bounds,
    columnWidths: Array.from({ length: colCount }, () => width / colCount),
    rows: cells,
  };
}

function asChart(
  id: string,
  bounds: Bounds,
  kind: "bar" | "line" | "pie",
  pairs: NamedValue[],
  title: string,
  pal: Palette,
): ChartElement {
  const cols = ["项", "值"];
  const rows = pairs.map((p) => [p.name, p.value]);
  const series: ChartSeries[] = [{ type: kind, name: "值", encode: { x: "项", y: "值" }, fill: pal.primary }];
  return {
    elementId: id,
    elementType: "chart",
    bounds,
    data: { cols, rows },
    series,
    title,
    legend: kind === "pie",
    labels: true,
  };
}

function mix(a: string, b: string, t: number): string {
  const pa = hex(a);
  const pb = hex(b);
  if (!pa || !pb) return a;
  const ch = (i: number) => Math.round(pa[i]! * (1 - t) + pb[i]! * t);
  return `#${[ch(0), ch(1), ch(2)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function hex(c: string): [number, number, number] | null {
  const m = c.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function header(copy: HostPageCopy, pal: Palette, index: number, ink: string): PptdElement[] {
  return [
    box("rule", [48, 28, 56, 5], pal.accent, "rect"),
    txt("kicker", [720, 22, 192, 22], copy.kicker || String(index + 1).padStart(2, "0"), {
      fontSize: 13,
      color: pal.muted,
      wrap: false,
    }),
    txt("title", [48, 42, 860, 44], copy.title, {
      fontSize: copy.title.length > 18 ? 24 : 28,
      color: ink,
      bold: true,
    }),
  ];
}

export function paintCover(copy: HostPageCopy, pal: Palette, imageSrc?: string): SkillPageInput {
  const navy = /海军|深蓝|月报|密级/.test(blobOf(copy));
  const bg = navy ? "#0B1F3A" : pal.background || "#F7F4EE";
  const ink = navy ? "#F4F1EA" : pal.primary || "#1F4E3D";
  const muted = navy ? "#B7C0CC" : pal.text || "#333333";
  const accent = pal.accent || "#C45C26";
  const meta = copy.lines.slice(0, 3).join("  ·  ") || copy.kicker || "";
  const elements: PptdElement[] = navy
    ? [
        box("ground", [0, 0, SLIDE_W, SLIDE_H], bg, "rect"),
        box("gold", [628, 72, 2, 396], accent, "rect"),
        txt("kicker", [80, 150, 520, 24], copy.kicker || "内部资料", {
          fontSize: 14,
          color: accent,
          bold: true,
        }),
        txt("title", [80, 186, 520, 120], copy.title, {
          fontSize: 36,
          color: ink,
          bold: true,
        }),
        txt("sub", [80, 330, 520, 56], meta, { fontSize: 15, color: muted }),
      ]
    : [
        box("band", [0, 0, 280, SLIDE_H], pal.primary || "#1F4E3D", "rect"),
        txt("kicker", [320, 160, 600, 28], copy.kicker || "", {
          fontSize: 14,
          color: accent,
          bold: true,
        }),
        txt("title", [320, 200, 600, 120], copy.title, {
          fontSize: 36,
          color: pal.primary || "#1F4E3D",
          bold: true,
        }),
        txt("sub", [320, 340, 600, 80], meta, { fontSize: 16, color: pal.text || "#333333" }),
      ];
  if (imageSrc) {
    elements.push({
      elementId: "hero",
      elementType: "image",
      bounds: navy ? [660, 120, 240, 300] : [0, 0, 280, 540],
      src: imageSrc,
      fit: { mode: "cover" },
    });
  }
  return { id: copy.id, pageType: "cover", background: { type: "solid", color: bg }, elements };
}

export function paintToc(copy: HostPageCopy, pal: Palette, index: number, all: HostPageCopy[]): SkillPageInput {
  const items = all.length > 2 ? all.map((p, i) => `${String(i + 1).padStart(2, "0")}  ${p.title}`) : copy.lines;
  const mid = Math.ceil(items.length / 2);
  const left = items.slice(0, mid);
  const right = items.slice(mid);
  const elements: PptdElement[] = [
    ...header(copy, pal, index, pal.primary),
    box("col-l", [48, 104, 420, 396], mix(pal.background, pal.primary, 0.06)),
    box("col-r", [492, 104, 420, 396], mix(pal.background, pal.accent, 0.06)),
  ];
  left.forEach((line, i) => {
    elements.push(txt(`l-${i}`, [68, 124 + i * 36, 380, 32], line, { fontSize: 15, color: pal.text }));
  });
  right.forEach((line, i) => {
    elements.push(txt(`r-${i}`, [512, 124 + i * 36, 380, 32], line, { fontSize: 15, color: pal.text }));
  });
  return {
    id: copy.id,
    pageType: "toc",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

export function paintKpi(copy: HostPageCopy, pal: Palette, index: number): SkillPageInput {
  const cards = extractKpis(copy);
  const used: KpiCard[] = cards.length
    ? cards
    : copy.lines.slice(0, 6).map((l, i) => ({
        label: `指标${i + 1}`,
        value: l.slice(0, 16),
      }));
  const cols = used.length > 4 ? 3 : Math.min(2, used.length) || 2;
  const rows = Math.ceil(used.length / cols) || 1;
  const gridX = 48;
  const gridY = 108;
  const gridW = 864;
  const gridH = used.length >= 4 ? 300 : 340;
  const gap = 14;
  const cw = (gridW - gap * (cols - 1)) / cols;
  const ch = (gridH - gap * (rows - 1)) / rows;
  const elements: PptdElement[] = [...header(copy, pal, index, pal.primary)];
  used.forEach((card, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = gridX + c * (cw + gap);
    const y = gridY + r * (ch + gap);
    elements.push(
      box(
        `kpi-${i}`,
        [x, y, cw, ch],
        i % 2 ? mix(pal.background, pal.accent, 0.1) : mix(pal.background, pal.primary, 0.1),
      ),
    );
    elements.push(
      txt(`kpi-l-${i}`, [x + 16, y + 16, cw - 32, 24], card.label, {
        fontSize: 13,
        color: pal.muted,
      }),
    );
    elements.push(
      txt(`kpi-v-${i}`, [x + 16, y + 44, cw - 32, 44], card.value, {
        fontSize: 26,
        color: pal.primary,
        bold: true,
      }),
    );
    if (card.note) {
      elements.push(
        txt(`kpi-n-${i}`, [x + 16, y + ch - 36, cw - 32, 24], card.note, {
          fontSize: 12,
          color: pal.text,
        }),
      );
    }
  });
  const spark = extractPairs((copy.body || "").split(/Sparkline|近6月营收/)[1] || "");
  if (spark.length >= 3) {
    elements.push(asChart("spark", [48, 424, 864, 92], "line", spark, "近6月", pal));
  }
  return {
    id: copy.id,
    pageType: copy.pageType || "content",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

export function paintTable(copy: HostPageCopy, pal: Palette, index: number): SkillPageInput {
  const parsed = extractTable(copy);
  const elements: PptdElement[] = [...header(copy, pal, index, pal.primary)];
  if (copy.kicker && copy.kicker.length > 4) {
    elements.push(txt("so", [48, 90, 864, 28], copy.kicker, { fontSize: 14, color: pal.text }));
  }
  if (parsed) {
    elements.push(asTable("table", [48, 124, 864, 380], parsed.columns, parsed.rows, pal));
  } else {
    copy.lines.slice(0, 8).forEach((line, i) => {
      elements.push(txt(`line-${i}`, [48, 124 + i * 42, 864, 38], line, { fontSize: 16, color: pal.text }));
    });
  }
  return {
    id: copy.id,
    pageType: copy.pageType || "content",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

export function paintChart(copy: HostPageCopy, pal: Palette, index: number): SkillPageInput {
  const blob = blobOf(copy);
  const pairs = extractPairs(copy.body || copy.lines.join("\n"));
  const kind: "bar" | "line" | "pie" = /环形|饼|占比/.test(blob)
    ? "pie"
    : /折线|趋势|近\d月/.test(blob)
      ? "line"
      : "bar";
  const elements: PptdElement[] = [...header(copy, pal, index, pal.primary)];
  if (copy.kicker && copy.kicker.length > 4) {
    elements.push(txt("so", [48, 90, 864, 24], copy.kicker, { fontSize: 14, color: pal.text }));
  }
  const blocks = splitChartBlocks(copy.body || "");
  if (blocks.length >= 2 && pairs.length >= 3) {
    const width = (864 - 16 * (Math.min(blocks.length, 3) - 1)) / Math.min(blocks.length, 3);
    blocks.slice(0, 3).forEach((block, i) => {
      const local = extractPairs(block);
      const used = local.length >= 2 ? local : pairs.slice(i * 2, i * 2 + 3);
      if (!used.length) return;
      const localKind: "bar" | "line" | "pie" = /环形|饼/.test(block) ? "pie" : /折/.test(block) ? "line" : "bar";
      const x = 48 + i * (width + 16);
      elements.push(asChart(`chart-${i}`, [x, 124, width, 336], localKind, used, block.slice(0, 12), pal));
      elements.push(
        txt(`cap-${i}`, [x, 468, width, 36], used.map((p) => `${p.name} ${p.raw}`).join(" · "), {
          fontSize: 11,
          color: pal.muted,
        }),
      );
    });
  } else if (pairs.length >= 2) {
    elements.push(asChart("chart", [48, 124, 864, 352], kind, pairs, copy.title, pal));
    elements.push(
      txt("cap", [48, 484, 864, 28], pairs.map((p) => `${p.name} ${p.raw}`).join("  ·  "), {
        fontSize: 12,
        color: pal.muted,
      }),
    );
  } else {
    copy.lines.slice(0, 8).forEach((line, i) => {
      elements.push(txt(`line-${i}`, [48, 124 + i * 42, 864, 38], line, { fontSize: 16, color: pal.text }));
    });
  }
  return {
    id: copy.id,
    pageType: copy.pageType || "content",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

function splitChartBlocks(body: string): string[] {
  const parts = body
    .split(/\n- |\n• |环形|堆叠|条形|折线/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && /\d/.test(s));
  return parts.slice(0, 3);
}

export function paintTwoCol(copy: HostPageCopy, pal: Palette, index: number): SkillPageInput {
  const split = splitTwoCol(copy);
  const elements: PptdElement[] = [
    ...header(copy, pal, index, pal.primary),
    box("left", [48, 108, 420, 396], mix(pal.background, pal.primary, 0.1)),
    box("right", [492, 108, 420, 396], mix(pal.background, pal.danger || "#B42318", 0.08)),
    txt("lt", [68, 124, 380, 28], split.leftTitle, {
      fontSize: 16,
      color: pal.primary,
      bold: true,
    }),
    txt("rt", [512, 124, 380, 28], split.rightTitle, {
      fontSize: 16,
      color: pal.danger || "#B42318",
      bold: true,
    }),
  ];
  split.left.forEach((line, i) => {
    elements.push(txt(`ll-${i}`, [68, 168 + i * 76, 380, 68], line, { fontSize: 15, color: pal.text }));
  });
  split.right.forEach((line, i) => {
    elements.push(txt(`rl-${i}`, [512, 168 + i * 76, 380, 68], line, { fontSize: 15, color: pal.text }));
  });
  return {
    id: copy.id,
    pageType: copy.pageType || "content",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

export function paintPath(copy: HostPageCopy, pal: Palette, index: number): SkillPageInput {
  const steps = extractPathSteps(copy);
  const elements: PptdElement[] = [...header(copy, pal, index, pal.primary)];
  const n = Math.max(steps.length, 1);
  const w = Math.min(200, (864 - 16 * (n - 1)) / n);
  steps.forEach((step, i) => {
    const x = 48 + i * (w + 16);
    elements.push(box(`step-${i}`, [x, 180, w, 200], mix(pal.background, pal.primary, 0.12)));
    elements.push(
      txt(`sn-${i}`, [x + 12, 196, w - 24, 28], String(i + 1).padStart(2, "0"), {
        fontSize: 18,
        color: pal.accent,
        bold: true,
      }),
    );
    elements.push(txt(`st-${i}`, [x + 12, 232, w - 24, 128], step, { fontSize: 14, color: pal.text }));
    if (i < steps.length - 1) {
      elements.push(box(`join-${i}`, [x + w, 272, 16, 4], pal.accent, "rect"));
    }
  });
  return {
    id: copy.id,
    pageType: copy.pageType || "content",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

export function paintContent(copy: HostPageCopy, pal: Palette, index: number, imageSrc?: string): SkillPageInput {
  const shown = copy.lines.slice(0, 8);
  const lineH = shown.length > 4 ? 40 : 52;
  const fontSize = shown.length > 4 ? 15 : 18;
  const elements: PptdElement[] = [...header(copy, pal, index, pal.primary)];
  if (imageSrc) {
    elements.push({
      elementId: "photo",
      elementType: "image",
      bounds: [560, 120, 352, 380],
      src: imageSrc,
      fit: { mode: "cover" },
    });
    shown.forEach((line, i) => {
      elements.push(
        txt(`line-${i}`, [48, 108 + i * lineH, 488, lineH - 4], line, {
          fontSize,
          color: pal.text,
        }),
      );
    });
  } else {
    shown.forEach((line, i) => {
      elements.push(
        txt(`line-${i}`, [48, 108 + i * lineH, 864, lineH - 4], line, {
          fontSize,
          color: pal.text,
        }),
      );
    });
  }
  return {
    id: copy.id,
    pageType: copy.pageType || "content",
    background: { type: "solid", color: pal.background },
    elements,
  };
}

function distinctiveNumbers(text: string): string[] {
  const found = text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+%|\d+\.\d+(?=\s*(?:万|亿|元))/g) || [];
  return [...new Set(found)].filter((n) => n.replace(/[,.]/g, "").length >= 3).slice(0, 8);
}

function pageCopyBlob(elements: PptdElement[]): string {
  const bits: string[] = [];
  for (const el of elements) {
    if (el.elementType === "text") {
      const t = (el as TextElement).content?.text;
      if (t) bits.push(t);
    }
    if (el.elementType === "table") {
      for (const row of (el as TableElement).rows || []) {
        for (const cell of row) if (cell.text) bits.push(cell.text);
      }
    }
    if (el.elementType === "chart") {
      for (const row of (el as ChartElement).data?.rows || []) bits.push(row.map(String).join(" "));
    }
  }
  return bits.join("\n");
}

export function stampMissingFacts(page: SkillPageInput, copy: HostPageCopy, pal: Palette): SkillPageInput {
  const src = `${copy.body || ""} ${copy.lines.join(" ")}`;
  const missing = distinctiveNumbers(src).filter((n) => !pageCopyBlob(page.elements).includes(n));
  if (!missing.length) return page;
  if (page.elements.some((el) => el.elementId === "facts")) return page;
  const bottom = Math.max(0, ...page.elements.map((el) => el.bounds[1] + el.bounds[3]));
  if (bottom > 516) return page;
  page.elements.push(
    txt("facts", [48, 518, 864, 18], missing.slice(0, 6).join("  ·  "), {
      fontSize: 11,
      color: pal.muted,
    }),
  );
  return page;
}
