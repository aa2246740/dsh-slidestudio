/**
 * Host exhibit painters. The harness picks a page kind and writes PPTD objects.
 * Copy/numbers come from the script — painters do not invent or round figures.
 */
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
  box,
  paintChart,
  paintContent,
  paintCover,
  paintKpi,
  paintPath,
  paintTable,
  paintToc,
  paintTwoCol,
  stampMissingFacts,
  txt,
} from "./exhibit-paint-pages.js";

function paintClose(copy: HostPageCopy, pal: Palette, index: number): SkillPageInput {
  const elements: PptdElement[] = [
    box("band", [0, 0, 16, SLIDE_H], pal.primary, "rect"),
    txt("kicker", [64, 140, 800, 24], copy.kicker || "收束", { fontSize: 14, color: pal.accent, bold: true }),
    txt("title", [64, 176, 800, 80], copy.title, { fontSize: 32, color: pal.primary, bold: true }),
    txt("body", [64, 272, 800, 160], copy.lines.join("\n"), { fontSize: 16, color: pal.text }),
    txt("foot", [64, 480, 800, 24], "本报告数据均为虚构，仅用于演示", { fontSize: 12, color: pal.muted }),
  ];
  return { id: copy.id, pageType: "close", background: { type: "solid", color: pal.background }, elements };
}

export type ExhibitKind = "cover" | "toc" | "kpi" | "two-col" | "chart" | "table" | "path" | "content" | "close";

export type HostPageCopy = {
  id: string;
  pageType: string;
  title: string;
  kicker?: string;
  lines: string[];
  body?: string;
  exhibit?: ExhibitKind;
};

export type KpiCard = { label: string; value: string; note?: string };
export type NamedValue = { name: string; value: number; raw: string };

const SLIDE_W = 960;
const SLIDE_H = 540;

export function blobOf(copy: HostPageCopy): string {
  return `${copy.pageType} ${copy.title} ${copy.kicker || ""} ${copy.body || ""} ${copy.lines.join(" ")}`;
}

export function classifyExhibit(copy: HostPageCopy, index: number, total: number): ExhibitKind {
  const blob = blobOf(copy);
  const type = (copy.pageType || "").toLowerCase();
  if (type === "cover" || /封面/.test(copy.title) || (index === 0 && /封面/.test(blob))) {
    return "cover";
  }
  if (type === "toc" || /目录/.test(copy.title) || /目录/.test(blob.slice(0, 80))) {
    return "toc";
  }
  if (/KPI|仪表盘|核心指标|一页看|大卡片|2\s*[×xX]\s*3|上6卡片|6卡片/.test(blob)) return "kpi";
  if (/利润表|四列表|区域表|对照表/.test(blob)) return "table";
  if (/环形|折线|柱状|瀑布|图表|sparkline|三图|拆解|趋势/.test(blob)) return "chart";
  if (/漏斗/.test(blob) || type === "route" || /路径|三步|流程/.test(blob)) return "path";
  if (slashRowCount(blob) >= 4 || /附表|渠道（/.test(blob)) return "table";
  if (/亮点|左右分栏|对照卡|两栏/.test(blob) && /预警|风险|线下|线上/.test(blob)) return "two-col";
  if (type === "close" || /收束|下一步|出发前|清单/.test(copy.title)) {
    return "close";
  }
  if (index === total - 1 && /附录|口径/.test(`${copy.title} ${copy.kicker || ""}`)) {
    return slashRowCount(blob) >= 2 || /附表/.test(blob) ? "table" : "content";
  }
  return "content";
}

export function parseNumberToken(raw: string): number | null {
  const t = raw.replace(/[,，\s]/g, "").replace(/%$/, "");
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function extractKpis(copy: HostPageCopy): KpiCard[] {
  const text = copy.body || copy.lines.join("\n");
  const cards: KpiCard[] = [];
  const seen = new Set<string>();
  const push = (card: KpiCard) => {
    const key = `${card.label}|${card.value}`;
    if (seen.has(key) || !card.label || !card.value) return;
    seen.add(key);
    cards.push(card);
  };
  const cardBlock = text.match(/卡片[:：]([\s\S]{0,900}?)(?:Sparkline|脚注|版式|分层|【|$)/);
  const pool = cardBlock?.[1] || text;
  const pieces: string[] = [];
  for (const raw of pool.split(/\n+/)) {
    const line = raw.trim();
    if (!line || /^(版式|结论|脚注|输出)/.test(line)) continue;
    if (/[｜|]/.test(line) && line.split(/[｜|]/).length >= 3) {
      pieces.push(
        ...line
          .split(/[｜|]/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else {
      pieces.push(line);
    }
  }
  for (const line of pieces) {
    const parsed = splitKpiLine(line);
    if (parsed) push(parsed);
    if (cards.length >= 6) break;
  }
  if (cards.length < 3) {
    for (const line of copy.lines) {
      const parsed = splitKpiLine(line);
      if (parsed) push(parsed);
      if (cards.length >= 6) break;
    }
  }
  return cards.slice(0, 6);
}

export function splitKpiLine(line: string): KpiCard | null {
  const cleaned = line
    .replace(/^\s*(?:\d+[\.、．)]\s*|[•●\-]\s*)/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 4) return null;
  const pipe = cleaned.split(/[｜|]/);
  const head = pipe[0]!.trim();
  const note = pipe.slice(1).join(" · ").replace(/[↑↓]/g, "").trim();
  const tail = head.match(/^(.+?)\s+([+\-−]?\d[\d,.]*(?:\.\d+)?\s*(?:亿|万|元|%|pct|家|万单|天|人|次|分钟)?)\s*$/i);
  if (tail) {
    return {
      label: tail[1]!
        .replace(/[:：]\s*$/, "")
        .trim()
        .slice(0, 16),
      value: tail[2]!.trim(),
      note: note || undefined,
    };
  }
  const colon = head.match(/^(.{2,16})[:：]\s*(.+)$/);
  if (colon) {
    return {
      label: colon[1]!.trim(),
      value: colon[2]!.trim().slice(0, 24),
      note: note || undefined,
    };
  }
  return null;
}

export function extractPairs(text: string): NamedValue[] {
  const out: NamedValue[] = [];
  const seen = new Set<string>();
  const slashChunks = text.split(/\n+/);
  for (const line of slashChunks) {
    if (/[\/／]/.test(line) && /\d/.test(line)) {
      for (const part of line.split(/[\/／]/)) {
        const hit = namedValue(part.trim());
        if (hit && !seen.has(hit.name)) {
          seen.add(hit.name);
          out.push(hit);
        }
      }
    }
  }
  if (out.length >= 2) return out.slice(0, 8);
  const re = /([\u4e00-\u9fffA-Za-z0-9＋+\-]{1,12})\s+([+\-−]?\d[\d,.]*)\s*(万|亿|%|元|家|天)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1]!.trim();
    if (/^(近|本|上|同比|环比|结论|版式|必须)/.test(name)) continue;
    const n = parseNumberToken(m[2]!);
    if (n === null) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value: n, raw: `${m[2]}${m[3] || ""}` });
    if (out.length >= 8) break;
  }
  return out;
}

function namedValue(part: string): NamedValue | null {
  const m = part.match(/([\u4e00-\u9fffA-Za-z0-9]{1,12})\s+([+\-−]?\d[\d,.]*)\s*(万|亿|%|元|家|天|pct)?/);
  if (!m) return null;
  const n = parseNumberToken(m[2]!);
  if (n === null) return null;
  const extra = part.match(/[（(]([^）)]+)[）)]/)?.[1]?.trim();
  const raw = [`${m[2]}${m[3] || ""}`, extra].filter(Boolean).join(" ");
  return { name: m[1]!.trim(), value: n, raw };
}

export function extractTable(copy: HostPageCopy): { columns: string[]; rows: string[][] } | null {
  const text = copy.body || copy.lines.join("\n");
  const colHit = text.match(/(?:列|表)[:：]\s*([^\n]+)|（([^）]{4,40})）[:：]?/);
  let columns: string[] = [];
  if (colHit) {
    const raw = (colHit[1] || colHit[2] || "").replace(/[。．]/g, "");
    columns = raw
      .split(/[\/／|｜]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const rows: string[][] = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!/[\/／]/.test(line) || !/\d/.test(line)) continue;
    if (/^(列|版式|结论|脚注)/.test(line)) continue;
    const cells = slashRow(line);
    if (cells && cells.length >= 3) rows.push(cells);
  }
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((r) => r.length), columns.length);
  if (!columns.length) {
    columns = ["项", ...Array.from({ length: width - 1 }, (_, i) => `列${i + 1}`)];
  } else if (columns.length === width - 1) {
    columns = ["项", ...columns];
  }
  while (columns.length < width) columns.push(`列${columns.length + 1}`);
  return {
    columns: columns.slice(0, width),
    rows: rows.map((r) => {
      const next = r.slice(0, width);
      while (next.length < width) next.push("");
      return next;
    }),
  };
}

function slashRow(line: string): string[] | null {
  const cleaned = line.replace(/^[•●\-]\s*/, "");
  const m = cleaned.match(/^([^/／]+?)\s+(-?[\d].*)$/);
  if (m && /[\/／]/.test(m[2]!)) {
    return [m[1]!.trim(), ...m[2]!.split(/[\/／]/).map((s) => s.trim())];
  }
  const parts = cleaned
    .split(/[\/／]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length >= 3 ? parts : null;
}

function slashRowCount(text: string): number {
  return text.split(/\n+/).filter((l) => /[\/／]/.test(l) && /\d/.test(l)).length;
}

export function extractPathSteps(copy: HostPageCopy): string[] {
  const text = copy.body || copy.lines.join(" ");
  const arrow = text
    .split(/→|->/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  if (arrow.length >= 3) return arrow.slice(0, 6).map((s) => s.slice(0, 28));
  const numbered = (copy.body || "")
    .split(/\n+/)
    .map((l) => l.replace(/^\s*\d+[\.、．)]\s*/, "").trim())
    .filter((l) => l.length >= 2 && l.length <= 36 && !/^(版式|结论|脚注)/.test(l));
  if (numbered.length >= 3) return numbered.slice(0, 6);
  return copy.lines.filter((l) => l.length >= 2).slice(0, 6);
}

export function splitTwoCol(copy: HostPageCopy): {
  leftTitle: string;
  left: string[];
  rightTitle: string;
  right: string[];
} {
  const text = copy.body || copy.lines.join("\n");
  const items = (src: string) =>
    src
      .split(/\n+|；|;|①|②|③|④|⑤/)
      .map((s) => s.replace(/^[•●\-]\s*/, "").trim())
      .filter((s) => s.length >= 4 && !/^(版式|结论|脚注|左|右|绿底|红\/黄)/.test(s))
      .slice(0, 4)
      .map((s) => s.slice(0, 48));
  const offline = text.match(/线下[:：]([\s\S]*?)(?=\n线上[:：]|$)/);
  const online = text.match(/线上[:：]([\s\S]*?)(?=\n脚注[:：]|\n附[:：]|$)/);
  if (offline && online) {
    return {
      leftTitle: "线下",
      left: items(offline[1]!),
      rightTitle: "线上",
      right: items(online[1]!),
    };
  }
  const leftHit = text.match(/亮点[:：]([\s\S]*?)(?=\n预警[:：]|\n风险[:：]|$)/);
  const rightHit = text.match(/预警[:：]([\s\S]*?)(?=\n脚注[:：]|\n红灯[:：]|\n黄灯[:：]|$)/);
  const left = items(leftHit?.[1] || "");
  const right = items(rightHit?.[1] || "");
  return {
    leftTitle: "亮点",
    left: left.length ? left : copy.lines.slice(0, 3),
    rightTitle: "预警",
    right: right.length ? right : copy.lines.slice(3, 6),
  };
}

export function paintExhibit(
  copy: HostPageCopy,
  pal: Palette,
  index: number,
  all: HostPageCopy[],
  opts: { imageSrc?: string } = {},
): SkillPageInput {
  const kind = classifyExhibit(copy, index, all.length);
  let page: SkillPageInput;
  switch (kind) {
    case "cover":
      page = paintCover(copy, pal, opts.imageSrc);
      break;
    case "toc":
      page = paintToc(copy, pal, index, all);
      break;
    case "kpi":
      page = paintKpi(copy, pal, index);
      break;
    case "table":
      page = paintTable(copy, pal, index);
      break;
    case "chart":
      page = paintChart(copy, pal, index);
      break;
    case "two-col":
      page = paintTwoCol(copy, pal, index);
      break;
    case "path":
      page = paintPath(copy, pal, index);
      break;
    case "close":
      page = paintClose(copy, pal, index);
      break;
    default:
      page = paintContent(copy, pal, index, opts.imageSrc);
  }
  if (kind !== "cover") stampMissingFacts(page, copy, pal);
  return page;
}
