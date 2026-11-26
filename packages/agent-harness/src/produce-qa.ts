/**
 * Structural QA for host-painted pages. Vision is optional and lives in host-produce.
 */
import type { PptdElement } from "@open-slidestudio/pptd-v2";
import type { HostPageCopy } from "./exhibit-paint.js";
import type { SkillPageInput } from "./skill-pages.js";

export type ProduceIssueCode = "overflow" | "overlap" | "empty" | "missing_number" | "no_exhibit";

export type ProduceIssue = {
  pageId: string;
  code: ProduceIssueCode;
  message: string;
};

const CANVAS_W = 960;
const CANVAS_H = 540;
const SLACK = 8;

function area(el: PptdElement): number {
  const [, , w, h] = el.bounds;
  return Math.max(0, w) * Math.max(0, h);
}

export function pageTextBlob(elements: PptdElement[]): string {
  const bits: string[] = [];
  for (const el of elements) {
    if (el.elementType === "text") {
      const t = (el as { content?: { text?: string } }).content?.text;
      if (t) bits.push(t);
    }
    if (el.elementType === "table") {
      const rows = (el as { rows?: { text?: string }[][] }).rows || [];
      for (const row of rows) for (const cell of row) if (cell.text) bits.push(cell.text);
    }
    if (el.elementType === "chart") {
      const data = (el as { data?: { rows?: (string | number | null)[][] } }).data;
      for (const row of data?.rows || []) bits.push(row.map(String).join(" "));
    }
  }
  return bits.join("\n");
}

function distinctiveNumbers(text: string): string[] {
  const found = text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+%|\d+\.\d+(?=\s*(?:万|亿|元))/g) || [];
  return [...new Set(found)].filter((n) => n.replace(/[,.]/g, "").length >= 3).slice(0, 8);
}

export function qaPaintedPage(page: SkillPageInput): ProduceIssue[] {
  const issues: ProduceIssue[] = [];
  const els = page.elements || [];
  if (!els.length) {
    issues.push({ pageId: page.id, code: "empty", message: `${page.id} has no elements` });
    return issues;
  }
  let covered = 0;
  for (const el of els) {
    covered += area(el);
    const [x, y, w, h] = el.bounds;
    if (x + w > CANVAS_W + SLACK || y + h > CANVAS_H + SLACK || x < -SLACK || y < -SLACK) {
      issues.push({
        pageId: page.id,
        code: "overflow",
        message: `${el.elementId} ${el.bounds.join(",")} leaves 960x540`,
      });
    }
  }
  if (covered < CANVAS_W * CANVAS_H * 0.08) {
    issues.push({ pageId: page.id, code: "empty", message: `${page.id} coverage too low` });
  }
  const texts = els.filter((el) => el.elementType === "text");
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (overlap(texts[i]!.bounds, texts[j]!.bounds) > 0.35) {
        issues.push({
          pageId: page.id,
          code: "overlap",
          message: `${texts[i]!.elementId} overlaps ${texts[j]!.elementId}`,
        });
      }
    }
  }
  return issues;
}

function overlap(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = x * y;
  const smaller = Math.min(a[2] * a[3], b[2] * b[3]) || 1;
  return inter / smaller;
}

export function repairPaintedPage(page: SkillPageInput): SkillPageInput {
  return {
    ...page,
    elements: page.elements.map((el) => {
      let [x, y, w, h] = el.bounds;
      if (w < 8) w = 8;
      if (h < 8) h = 8;
      if (x < 0) x = 0;
      if (y < 0) y = 0;
      if (x + w > CANVAS_W) w = Math.max(8, CANVAS_W - x);
      if (y + h > CANVAS_H) h = Math.max(8, CANVAS_H - y);
      if (x + w > CANVAS_W) x = Math.max(0, CANVAS_W - w);
      if (y + h > CANVAS_H) y = Math.max(0, CANVAS_H - h);
      return { ...el, bounds: [x, y, w, h] };
    }),
  };
}

export function qaScriptFidelity(painted: SkillPageInput[], scripted: HostPageCopy[]): ProduceIssue[] {
  const issues: ProduceIssue[] = [];
  if (scripted.length >= 3 && painted.length !== scripted.length) {
    issues.push({
      pageId: "deck",
      code: "missing_number",
      message: `script has ${scripted.length} pages, painted ${painted.length}`,
    });
  }
  for (let i = 0; i < Math.min(painted.length, scripted.length); i++) {
    const src = `${scripted[i]!.body || ""} ${scripted[i]!.lines.join(" ")}`;
    const nums = distinctiveNumbers(src);
    if (!nums.length) continue;
    const blob = pageTextBlob(painted[i]!.elements);
    const hit = nums.some((n) => blob.includes(n));
    if (!hit) {
      issues.push({
        pageId: painted[i]!.id,
        code: "missing_number",
        message: `${painted[i]!.id} dropped ${nums.slice(0, 3).join(", ")}`,
      });
    }
    const wantExhibit = /KPI|仪表盘|利润表|区域表|环形|三图|四列表/.test(src + scripted[i]!.title);
    if (wantExhibit) {
      const has =
        painted[i]!.elements.some((el) => el.elementType === "table" || el.elementType === "chart") ||
        painted[i]!.elements.filter((el) => el.elementType === "shape").length >= 4;
      if (!has) {
        issues.push({
          pageId: painted[i]!.id,
          code: "no_exhibit",
          message: `${painted[i]!.id} asked for an exhibit but has none`,
        });
      }
    }
  }
  return issues;
}
