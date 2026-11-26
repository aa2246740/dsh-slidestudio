/**
 * Operating-report facts. A 月报/年报/周报 brief with no named company and
 * no numeric facts must refuse — 示意/演示占位 is still fabricating.
 */
import { classifyBriefKind } from "./compose-ir.js";
import type { SkillPageInput } from "./skill-pages.js";

const GENERIC_ORG = /^(公司|本公司|贵公司|一家公司|该企业|企业|集团客户|管理层)$/;

const ORG_SUFFIX = /[\u4e00-\u9fffA-Za-z0-9]{2,16}(零售|科技|集团|股份|银行|保险|制造|食品|药业|商贸|控股)/;

/** Work reports name a team or department, not a company. */
const TEAM_NAME = /[\u4e00-\u9fffA-Za-z0-9]{2,14}(工作组|后端组|前端组|小组|项目组|团队|部门|中心|事业部)/;

export const NEED_DATA_REASON =
  "经营月报需要公司名和至少一组已核实数字。当前 brief 不足，拒绝生成，禁止编示意公司或示意 KPI。请补充公司名与数据后再试。";

export function reportBriefNeedsFacts(brief: string): boolean {
  if (classifyBriefKind(brief) !== "retail-monthly") return false;
  const multiPage = /第\s*[2-9]|共\s*\d+\s*页|约\s*\d+\s*页|二十页|20\s*页/.test(brief);
  const coverOnly =
    !multiPage &&
    /封面/.test(brief) &&
    (/一页|单页|一张/.test(brief) || /封面\s*$/.test(brief.trim()) || /月报封面/.test(brief));
  if (coverOnly) return false;
  return true;
}

function stripReportTitle(name: string): string {
  return name
    .replace(/\s*\d{4}\s*年\s*\d{1,2}\s*月.*$/, "")
    .replace(/经营月报|年度报告|年报|周报|月报/g, "")
    .trim();
}

export function hasNamedCompany(text: string): boolean {
  for (const m of text.matchAll(/[「『《]([^」』》]{2,24})[」』》]/g)) {
    const core = stripReportTitle(m[1] ?? "");
    if (core.length >= 2 && !GENERIC_ORG.test(core)) return true;
  }
  if (ORG_SUFFIX.test(text)) return true;
  if (TEAM_NAME.test(text)) return true;
  for (const m of text.matchAll(/([\u4e00-\u9fff]{2,12})(?:[\s\d年月日]{0,12})经营?(?:月报|年报|周报)/g)) {
    const name = (m[1] ?? "").trim();
    if (!name || GENERIC_ORG.test(name) || name === "公司") continue;
    if (/一份|做一|根据|下面/.test(name)) continue;
    return true;
  }
  return false;
}

export function hasNumericFacts(text: string): boolean {
  if (/\d+(?:\.\d+)?\s*(?:%|％|pt|PP|pp|万|亿|元|天)/.test(text)) return true;
  const nums = text.match(/\d{3,}/g) ?? [];
  return nums.some((n) => !/^(?:19|20)\d{2}$/.test(n));
}

export function hasOperatingFacts(brief: string, referenceText?: string): boolean {
  const blob = `${brief}\n${referenceText ?? ""}`;
  if (hasNamedCompany(blob) && hasNumericFacts(blob)) return true;
  // Hub attachments are sourced material even when the one-line brief has no company.
  if ((referenceText ?? "").trim() && hasNumericFacts(referenceText ?? "")) return true;
  // DSH Hub generate currently sends tables inside the brief, not attachments.md.
  if (hasNumericFacts(brief) && /虚构演示|演示数字/.test(brief)) return true;
  return false;
}

export function missingOperatingFactsReason(brief: string, referenceText?: string): string | undefined {
  if (!reportBriefNeedsFacts(brief)) return undefined;
  if (hasOperatingFacts(brief, referenceText)) return undefined;
  const blob = `${brief}\n${referenceText ?? ""}`;
  if (hasNamedCompany(blob) && /虚构演示|演示数字/.test(blob)) {
    return undefined;
  }
  return NEED_DATA_REASON;
}

export function extractMarkedGaps(brief: string): string[] {
  const out: string[] = [];
  const after = brief.match(/缺失[^。\n]{0,40}[：:]([^。\n]+)/);
  if (after?.[1]) {
    for (const part of after[1].split(/[；;、,，]/)) {
      const t = part
        .replace(/禁止.*$/, "")
        .replace(/[「」『』]/g, "")
        .trim();
      if (t.length >= 2 && t.length <= 16) out.push(t);
    }
  }
  for (const m of brief.matchAll(/([\u4e00-\u9fffA-Za-z0-9]{2,12})[：:]\s*缺失/g)) {
    const name = (m[1] ?? "").trim();
    if (name && !/以下|三个数|两项/.test(name)) out.push(name);
  }
  return [...new Set(out)];
}

export function extractRequiredTableColumns(brief: string): string[] {
  const fixed = brief.match(/列固定为[：:]\s*([^\n。]+)/);
  const named =
    brief.match(/(?:表头|列名)(?:固定)?(?:为|是|[：:])\s*[“"「『]([^”"」』]+)[”"」』]/) ??
    brief.match(/(?:表头|列名)(?:固定)?(?:为|是|[：:])\s*([^\n。；;]+)/);
  const counted = brief.match(/\d+\s*列\s*[（(]([^)）]+)[)）]/);
  // A dimension explanation is not a list of column names.
  const parenthetical = counted?.[1] ?? "";
  const describesRows = /\d+\s*(?:行|个?单元格)/.test(parenthetical);
  const raw = fixed?.[1] ?? named?.[1] ?? (describesRows ? "" : parenthetical);
  if (!raw.trim()) return [];
  return [
    ...new Set(
      raw
        .split(/[/／、,，|｜]/)
        .map((s) => s.replace(/列|必须|含/g, "").trim())
        .filter((s) => s.length >= 2 && s.length <= 12),
    ),
  ];
}

export function extractListedPeople(brief: string): string[] {
  const out: string[] = [];
  for (const m of brief.matchAll(/(?:线上|线下)\s+([\u4e00-\u9fff]{2,4})/g)) {
    const name = (m[1] ?? "").trim();
    if (name && !/渠道|占比|毛利/.test(name)) out.push(name);
  }
  return [...new Set(out)];
}

function cellText(cell: unknown): string {
  if (typeof cell === "string") return cell;
  if (cell && typeof cell === "object" && "text" in cell) {
    const text = (cell as { text?: unknown }).text;
    return text == null ? "" : String(text);
  }
  return "";
}

function elementPlainText(el: SkillPageInput["elements"][number]): string[] {
  const rec = el as unknown as {
    elementType?: string;
    content?: { text?: unknown };
    rows?: unknown;
    data?: { rows?: unknown };
  };
  const bits: string[] = [];
  if (rec.elementType === "text" && rec.content?.text != null) {
    bits.push(String(rec.content.text));
  }
  if (rec.elementType === "table" && Array.isArray(rec.rows)) {
    for (const row of rec.rows) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const text = cellText(cell);
        if (text) bits.push(text);
      }
    }
  }
  if (rec.elementType === "chart" && Array.isArray(rec.data?.rows)) {
    for (const row of rec.data.rows) {
      if (!Array.isArray(row)) continue;
      bits.push(row.map((cell) => (cell == null ? "" : String(cell))).join(" "));
    }
  }
  return bits;
}

export function skillPagesPlainText(pages: SkillPageInput[]): string {
  const bits: string[] = [];
  for (const page of pages) {
    for (const el of page.elements ?? []) bits.push(...elementPlainText(el));
  }
  return bits.join("\n");
}

type LockedNumber = {
  raw: string;
  canonical: string;
  negative: boolean;
};

const LOCKED_NUMBER_RE =
  /[+\-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s*(?:%|％|pct|pp|万|亿|元|天|家|店|人次|人|单|小时|分钟|次))?|[+\-−]?\d+(?:\.\d+)?\s*(?:%|％|pct|pp|万|亿|元|天|家|店|人次|人|单|小时|分钟|次)|[+\-−]?\d+\.\d+/gi;

function canonicalNumber(raw: string): string {
  const numeric = raw.match(/\d[\d,]*(?:\.\d+)?/)?.[0]?.replace(/,/g, "") ?? "";
  if (!numeric) return "";
  const value = Number(numeric);
  return Number.isFinite(value) ? String(value) : numeric;
}

function lockedNumbers(text: string): LockedNumber[] {
  const tokens: LockedNumber[] = [];
  const add = (raw: string) => {
    const canonical = canonicalNumber(raw);
    if (!canonical) return;
    const negative = /^\s*[-−]/.test(raw);
    if (!tokens.some((token) => token.canonical === canonical && token.negative === negative)) {
      tokens.push({ raw: raw.trim(), canonical, negative });
    }
  };
  for (const match of text.matchAll(LOCKED_NUMBER_RE)) add(match[0]);
  for (const match of text.matchAll(/\b(?:NPS|DSO)\s*([+\-−]?\d+(?:\.\d+)?)/gi)) {
    if (match[1]) add(match[1]);
  }
  return tokens;
}

function allNumbers(text: string): LockedNumber[] {
  const tokens: LockedNumber[] = [];
  for (const match of text.matchAll(/[+\-−]?\d[\d,]*(?:\.\d+)?/g)) {
    const raw = match[0];
    const canonical = canonicalNumber(raw);
    if (!canonical) continue;
    const negative = /^\s*[-−]/.test(raw);
    if (!tokens.some((token) => token.canonical === canonical && token.negative === negative)) {
      tokens.push({ raw, canonical, negative });
    }
  }
  return tokens;
}

function structuredBriefPages(brief: string): Map<number, string> {
  const pages = new Map<number, string>();
  for (const match of brief.matchAll(/【第\s*(\d+)\s*页[^】]*】([\s\S]*?)(?=【第\s*\d+\s*页|生成时自检|$)/g)) {
    const pageNumber = Number(match[1]);
    if (Number.isSafeInteger(pageNumber) && pageNumber >= 1) {
      pages.set(pageNumber, match[2] ?? "");
    }
  }
  return pages;
}

export function missingLockedPageFacts(
  brief: string,
  pages: SkillPageInput[],
): { pageId: string; missing: string[] }[] {
  const scripted = structuredBriefPages(brief);
  if (scripted.size < 3) return [];
  const issues: { pageId: string; missing: string[] }[] = [];
  for (const [index, page] of pages.entries()) {
    const source = scripted.get(index + 1);
    if (!source) continue;
    const required = lockedNumbers(source);
    if (!required.length) continue;
    const present = allNumbers(page.elements.flatMap((element) => elementPlainText(element)).join("\n"));
    const missing = required
      .filter(
        (fact) =>
          !present.some(
            (candidate) => candidate.canonical === fact.canonical && (!fact.negative || candidate.negative),
          ),
      )
      .map((fact) => fact.raw);
    if (missing.length) issues.push({ pageId: page.id, missing });
  }
  return issues;
}

export type ReportFactIssue = {
  pageId: string;
  code: "unnamed_gap" | "missing_column" | "missing_locked_fact";
  message: string;
};

export function reportFactIssues(brief: string, pages: SkillPageInput[], referenceText?: string): ReportFactIssue[] {
  const issues: ReportFactIssue[] = [];
  const blob = skillPagesPlainText(pages);
  const deckId = pages[0]?.id ?? "deck";
  for (const gap of extractMarkedGaps(brief)) {
    const named = blob.includes(gap);
    const marked = /缺失/.test(blob) && /待补/.test(blob);
    if (!named || !marked) {
      issues.push({
        pageId: deckId,
        code: "unnamed_gap",
        message: `gap ${gap} must appear on a page with 缺失，待补 — do not summarize as 三项数据`,
      });
    }
  }
  const cols = extractRequiredTableColumns(`${brief}\n${referenceText ?? ""}`);
  if (cols.length) {
    const tables: { pageId: string; header: string[]; bodyRows: string[][]; n: number }[] = [];
    for (const page of pages) {
      for (const el of page.elements ?? []) {
        const rec = el as unknown as { elementType?: string; rows?: unknown };
        if (rec.elementType !== "table" || !Array.isArray(rec.rows) || !Array.isArray(rec.rows[0])) {
          continue;
        }
        const header = rec.rows[0].map((cell: unknown) => cellText(cell).trim());
        const bodyRows = rec.rows
          .slice(1)
          .map((row: unknown) => (Array.isArray(row) ? row.map((cell) => cellText(cell).trim()) : []));
        tables.push({ pageId: page.id, header, bodyRows, n: rec.rows.length });
      }
    }
    const people = extractListedPeople(brief);
    const dense = tables.filter((t) => t.n >= 10).sort((a, b) => b.n - a.n)[0];
    const target = dense ?? tables.sort((a, b) => b.n - a.n)[0];
    const headerOk = Boolean(target && cols.every((col) => target.header.includes(col)));
    if (!headerOk) {
      issues.push({
        pageId: target?.pageId ?? deckId,
        code: "missing_column",
        message: `dense SKU table header must include every listed column: ${cols.join("/")}`,
      });
    }
    const ownerIdx = target?.header.indexOf("负责人") ?? -1;
    const ownerCells = ownerIdx >= 0 ? (target?.bodyRows.map((row) => row[ownerIdx] ?? "") ?? []) : [];
    if (people.length >= 8) {
      const missingPeople = people.filter((name) => !ownerCells.includes(name));
      if (missingPeople.length) {
        issues.push({
          pageId: target?.pageId ?? deckId,
          code: "missing_column",
          message: `负责人 names missing from the dense table 负责人 column: ${missingPeople.slice(0, 8).join("、")}`,
        });
      }
    } else if (people.length >= 3) {
      const missingPeople = people.filter((name) => !blob.includes(name));
      if (missingPeople.length) {
        issues.push({
          pageId: deckId,
          code: "missing_column",
          message: `负责人 names missing from cells: ${missingPeople.slice(0, 8).join("、")}`,
        });
      }
    }
  }
  for (const factIssue of missingLockedPageFacts(brief, pages)) {
    issues.push({
      pageId: factIssue.pageId,
      code: "missing_locked_fact",
      message: `page dropped locked numeric facts from its brief section: ${factIssue.missing.join(", ")}`,
    });
  }
  return issues;
}
