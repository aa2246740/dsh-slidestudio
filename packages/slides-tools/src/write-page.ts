import fs from "node:fs";
import path from "node:path";
import { SlideToolArgsError } from "./contract.js";
import { isCanonicalWritePageArgs, loadProject, type Theme } from "@open-slidestudio/pptd-v2";
import {
  parseSkillPage,
  countRawChartElements,
  DROPPED_CHART_DETAIL,
  pageRevisionSha256,
  persistPageKey,
  writePageSchemaIssues,
  writePageSchemaError,
  EMPTY_CLOSER_PRODUCE_NEXT,
  adoptedTemplateFontPolicy,
  backgroundColorWriteAuthority,
  projectPackColorContext,
  type TemplateFontPolicy,
  type SkillPageInput,
} from "@open-slidestudio/presentation-run";
import type { WritePageDecision } from "./outcome.js";
import { writePageMediaRefusal } from "./write-page-media.js";

export type WritePageLedgerView = {
  readonly pageId: string;
  readonly revision: number;
  readonly pageSha256: string;
  readonly lastVerdict?: "pass" | "revise";
  readonly yamlExists: boolean;
  /** Hash of the page file on disk; the ledger can name a newer revision after a version restore. */
  readonly savedPageSha256?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * MiniMax (and some JSON-schema tool wrappers) send arrays as `{ item: T }`.
 * Host only unwraps; it does not invent copy.
 */
export function unwrapToolValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => unwrapToolValue(item, depth + 1));
  const rec = asRecord(value);
  if (!rec) return value;
  const keys = Object.keys(rec);
  if (keys.length === 1 && keys[0] === "item") {
    return unwrapToolValue(rec.item, depth + 1);
  }
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(rec)) {
    next[key] = unwrapToolValue(nested, depth + 1);
  }
  return next;
}

function coerceBounds(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length < 4) return undefined;
  const nums = raw.slice(0, 4).map((n) => {
    if (typeof n === "number" && Number.isFinite(n)) return n;
    if (typeof n === "string" && n.trim() && Number.isFinite(Number(n))) return Number(n);
    return undefined;
  });
  if (nums.some((n) => n === undefined)) return undefined;
  return nums as number[];
}

/**
 * Flatten Gemini `{ rect, value }` and MiniMax `{ item: [...] }` dialects
 * into the fields parseSkillPage already accepts. Host does not invent copy.
 */
export function normalizeWritePageArgs(args: Record<string, unknown>): Record<string, unknown> {
  const unwrapped = unwrapToolValue(args) as Record<string, unknown>;
  if (typeof unwrapped.elements === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(unwrapped.elements);
    } catch {
      throw new SlideToolArgsError([
        "elements must be a JSON array; pass an actual array value, not a JSON-encoded string.",
      ]);
    }
    if (!Array.isArray(parsed)) {
      throw new SlideToolArgsError([
        "elements must be a JSON array; pass an actual array value, not a JSON-encoded string.",
      ]);
    }
    unwrapped.elements = parsed;
  }
  if (!Array.isArray(unwrapped.elements)) {
    throw new SlideToolArgsError(["elements must be a JSON array value."]);
  }
  return {
    ...unwrapped,
    elements: unwrapped.elements.map(normalizeWritePageElement),
  };
}

function normalizeElementBounds(merged: Record<string, unknown>, rect: Record<string, unknown> | undefined): void {
  const fromRect =
    rect && merged.bounds == null && merged.position == null
      ? [rect.left ?? rect.x, rect.top ?? rect.y, rect.width ?? rect.w, rect.height ?? rect.h]
      : undefined;
  const bounds = coerceBounds(merged.bounds) ?? coerceBounds(merged.position) ?? coerceBounds(fromRect);
  if (bounds) merged.bounds = bounds;
}

function normalizeElementText(merged: Record<string, unknown>): void {
  const isBold = asBool(merged.isBold);
  if (isBold === true && merged.fontWeight == null) merged.fontWeight = "bold";
  const content = asRecord(merged.content) ?? {};
  const bold = asBool(content.bold) ?? asBool(merged.bold) ?? isBold;
  if (typeof merged.text === "string" && content.text == null) {
    const fontSize = merged.fontSize;
    merged.content = {
      ...content,
      text: merged.text,
      ...(typeof fontSize === "number" || typeof fontSize === "string" ? { fontSize } : {}),
      ...(bold === true ? { bold: true } : {}),
      ...(typeof merged.color === "string" ? { color: merged.color } : {}),
    };
  } else if (bold === true && content.bold !== true) {
    merged.content = { ...content, bold: true };
  }
}

function normalizeChartLegendAndTitle(merged: Record<string, unknown>): void {
  if (typeof merged.legend === "string") {
    const flag = asBool(merged.legend);
    if (flag !== undefined) merged.legend = flag;
    else delete merged.legend;
  } else if (Array.isArray(merged.legend)) {
    merged.legend = true;
  }
  if (merged.title != null && typeof merged.title !== "string") {
    const title = asRecord(merged.title);
    if (title && typeof title.text === "string") merged.title = { text: title.text };
    else delete merged.title;
  }
}

function normalizeChartElement(merged: Record<string, unknown>): void {
  if (merged.elementType !== "chart" && merged.data == null && merged.series == null) return;
  delete merged.xAxis;
  delete merged.yAxis;
  delete merged.dataLabels;
  if (Array.isArray(merged.series)) {
    for (const series of merged.series) {
      const row = asRecord(series);
      if (row) delete row.dataLabels;
    }
  }
  normalizeChartLegendAndTitle(merged);
}

export function normalizeWritePageElement(raw: unknown): unknown {
  const rec = asRecord(unwrapToolValue(raw));
  if (!rec) return raw;
  const value = asRecord(rec.value);
  const merged: Record<string, unknown> = { ...(value ?? {}), ...rec };
  delete merged.value;
  normalizeElementBounds(merged, asRecord(rec.rect));
  normalizeElementText(merged);
  normalizeChartElement(merged);
  return merged;
}

/** The page's revision identity: its own body, so copies of a layout never make it a new revision. */
export function pageBodySha256(page: SkillPageInput): string {
  return pageRevisionSha256(page, page.id);
}

export type WritePageDiskView = {
  readonly projectRoot?: string;
  readonly lastBasename?: string;
  readonly pageCount: number;
  readonly theme?: Theme;
  readonly adoptedPackId?: string;
  readonly adoptedPackHexes?: ReadonlySet<string>;
  readonly otherPackHexes?: ReadonlySet<string>;
  readonly adoptedDesignSourceIds?: readonly string[];
  readonly materialError?: string;
  readonly templateKitRoot?: string;
  readonly templateFontPolicy?: TemplateFontPolicy;
  readonly templateFontPolicyError?: string;
  readonly imageSrcs?: readonly { pageId: string; src: string }[];
  readonly backgroundColors?: readonly { pageId: string; color: string }[];
};

function imageSrcsFromLoadedPages(pages: ReturnType<typeof loadProject>["pages"]): { pageId: string; src: string }[] {
  const rows: { pageId: string; src: string }[] = [];
  for (const loaded of pages) {
    const rec = loaded.page as Record<string, unknown>;
    const pageId = path.basename(loaded.path, ".page") || (typeof rec.id === "string" ? rec.id.trim() : "");
    if (!pageId) continue;
    for (const el of loaded.page.elements) {
      if (el.elementType === "image" && typeof el.src === "string" && el.src) {
        rows.push({ pageId, src: el.src });
      }
    }
  }
  return rows;
}

function backgroundColorsFromLoadedPages(
  pages: ReturnType<typeof loadProject>["pages"],
): { pageId: string; color: string }[] {
  const rows: { pageId: string; color: string }[] = [];
  for (const loaded of pages) {
    if (loaded.page.background?.type !== "solid") continue;
    rows.push({
      pageId: path.basename(loaded.path, ".page"),
      color: loaded.page.background.color,
    });
  }
  return rows;
}

export function readWritePageDisk(projectRoot: string): WritePageDiskView | undefined {
  try {
    if (!fs.existsSync(path.join(projectRoot, "deck.pptd"))) return undefined;
    const project = loadProject(projectRoot);
    const last = project.pages.at(-1);
    let templateFontPolicy: TemplateFontPolicy | undefined;
    let templateFontPolicyError: string | undefined;
    try {
      templateFontPolicy = adoptedTemplateFontPolicy(projectRoot);
    } catch {
      templateFontPolicyError = "已采用的设计源字体信息无法通过回执校验，请重新上传后再试";
    }
    return {
      projectRoot,
      pageCount: project.pages.length,
      lastBasename: last ? path.basename(last.path, ".page") : undefined,
      theme: project.presentation.theme,
      imageSrcs: imageSrcsFromLoadedPages(project.pages),
      backgroundColors: backgroundColorsFromLoadedPages(project.pages),
      ...(templateFontPolicy ? { templateFontPolicy } : {}),
      ...(templateFontPolicyError ? { templateFontPolicyError } : {}),
      ...projectPackColorContext(projectRoot),
    };
  } catch {
    return undefined;
  }
}

type ParsedPage = NonNullable<ReturnType<typeof parseSkillPage>>;

function rejected(detail: string, error?: string): WritePageDecision {
  return { action: "reject", outcome: { outcome: "rejected", detail, ...(error ? { error } : {}) } };
}

/** Normalize and parse the provider page; undefined when it is not a page at all. */
function parsedWritePage(
  args: Record<string, unknown>,
): { normalizedArgs: Record<string, unknown>; parsed: ParsedPage } | undefined {
  let normalizedArgs: Record<string, unknown>;
  try {
    normalizedArgs = isCanonicalWritePageArgs(args) ? structuredClone(args) : normalizeWritePageArgs(args);
  } catch (error) {
    if (!(error instanceof SlideToolArgsError)) throw error;
    return undefined;
  }
  const parsed = parseSkillPage(normalizedArgs, 0);
  return parsed?.id ? { normalizedArgs, parsed } : undefined;
}

function writeSchemaContext(parsed: ParsedPage, disk: WritePageDiskView | undefined) {
  const samePage = (pageId: string) => persistPageKey(pageId) === persistPageKey(parsed.id);
  const siblingImageSrcs = (disk?.imageSrcs ?? []).filter((row) => !samePage(row.pageId));
  const persistedBackgroundColor = disk?.backgroundColors?.find((row) => samePage(row.pageId))?.color;
  return {
    lastDiskBasename: disk?.lastBasename,
    diskPageCount: disk?.pageCount,
    theme: disk?.theme,
    adoptedPackId: disk?.adoptedPackId,
    adoptedPackHexes: disk?.adoptedPackHexes,
    otherPackHexes: disk?.otherPackHexes,
    adoptedDesignSourceIds: disk?.adoptedDesignSourceIds,
    materialError: disk?.materialError,
    templateKitRoot: disk?.templateKitRoot,
    projectRoot: disk?.projectRoot,
    ...backgroundColorWriteAuthority({ projectRoot: disk?.projectRoot, pageId: parsed.id, persistedBackgroundColor }),
    ...(siblingImageSrcs.length ? { siblingImageSrcs } : {}),
  };
}

/** Content refusals that precede the identity decision (charts, schema, media). */
function pageContentRefusal(
  normalizedArgs: Record<string, unknown>,
  parsed: ParsedPage,
  disk: WritePageDiskView | undefined,
): WritePageDecision | undefined {
  const keptCharts = parsed.elements.filter((el) => el.elementType === "chart").length;
  if (countRawChartElements(normalizedArgs.elements) > keptCharts) return rejected(DROPPED_CHART_DETAIL);
  const schemaCtx = writeSchemaContext(parsed, disk);
  const schemaError = writePageSchemaError(writePageSchemaIssues(parsed, schemaCtx, normalizedArgs), parsed, schemaCtx);
  if (schemaError) {
    return rejected(
      schemaError.error === "empty_closer"
        ? `empty_closer: ${EMPTY_CLOSER_PRODUCE_NEXT}`
        : `${schemaError.error}: ${schemaError.detail}`,
    );
  }
  // Before the skip check: an identical page whose media was deleted is still refused.
  const mediaRefusal = writePageMediaRefusal(normalizedArgs.elements, disk?.projectRoot);
  if (mediaRefusal) return rejected(`${mediaRefusal.error}: ${mediaRefusal.detail}`, mediaRefusal.error);
  return undefined;
}

/** An unchanged body is skipped, refused, or rewritten when the file no longer holds it. */
function identicalPageDecision(current: WritePageLedgerView, pageId: string, pageSha256: string): WritePageDecision {
  if (!current.yamlExists) return rejected(`ledger-file-mismatch for ${pageId}`);
  if (current.lastVerdict === "revise") {
    return {
      action: "reject",
      outcome: { outcome: "revise-requires-change", pageId, revision: current.revision, pageSha256 },
    };
  }
  // Only a page the file also holds is identical: a restored page file is written again.
  if (current.savedPageSha256 !== undefined && current.savedPageSha256 !== pageSha256) {
    return { action: "write", pageId, pageSha256 };
  }
  return {
    action: "skip",
    outcome: { outcome: "skipped-identical", pageId, revision: current.revision, pageSha256 },
  };
}

export function decideWritePage(
  args: Record<string, unknown>,
  current: WritePageLedgerView | undefined,
  disk?: WritePageDiskView,
): WritePageDecision {
  if (disk?.templateFontPolicyError) {
    return {
      action: "reject",
      outcome: {
        outcome: "rejected",
        error: "template_font_policy",
        detail: disk.templateFontPolicyError,
        painted: false,
      },
    };
  }
  const page = parsedWritePage(args);
  if (!page) return rejected("invalid page");
  const refusal = pageContentRefusal(page.normalizedArgs, page.parsed, disk);
  if (refusal) return refusal;
  const pageSha256 = pageBodySha256(page.parsed);
  if (current && current.pageSha256 === pageSha256) return identicalPageDecision(current, page.parsed.id, pageSha256);
  return { action: "write", pageId: page.parsed.id, pageSha256 };
}
