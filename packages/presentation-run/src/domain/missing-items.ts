/**
 * `write_todo.missingItems` (CAP-17): the template charts and tables the agent has no new-period
 * data for. The mechanism is agent-declared and Host-verified: the agent names an item by its
 * template page and title; the Host accepts it only when it resolves to one chart or table of a
 * template whose part was read in the current epoch (receipt re-hashed), and then records the
 * resolved item as a ledger fact. Provenance and the card list those facts and nothing else, so
 * every listed item traces to a recorded read and a recorded declaration.
 */
import type { PeriodMap } from "./period-map.js";
import { appendFact, factId, type RunLedgerV1, type RunToolContext } from "./run-ledger.js";
import { normalizeItemName, readTemplateItems, type TemplateItem } from "./template-items.js";

export type MissingItem = Readonly<{
  materialId: string;
  sourcePage: number;
  kind: "chart" | "table";
  itemId: string;
  title: string;
}>;

export type MissingItemsFact = Readonly<{
  type: "plan.missing-items-declared";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  items: readonly MissingItem[];
}>;

export type MissingItemRequest = Readonly<{ page: number; title: string; materialId?: string }>;

const MAX_LISTED_CANDIDATES = 8;

export const MISSING_ITEM_SUFFIX = "：未提供本期数据";

function fail(message: string): never {
  throw new Error(message);
}

/** Validate the declared shape; throws a Chinese Error naming the entry. */
export function parseMissingItemRequests(raw: unknown): readonly MissingItemRequest[] {
  if (!Array.isArray(raw)) {
    fail("missingItems 必须是数组，每项写成 {page, title}：page 是模板的来源页码，title 是该页图表或表格的标题");
  }
  return raw.map((value: unknown, index): MissingItemRequest => {
    const at = `missingItems[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(`${at} 必须是对象：{page, title}`);
    }
    const row = value as Record<string, unknown>;
    const page = typeof row.page === "string" && /^\d+$/.test(row.page.trim()) ? +row.page : row.page;
    if (typeof page !== "number" || !Number.isSafeInteger(page) || page <= 0) {
      return fail(`${at}.page 必须是模板的来源页码（正整数）`);
    }
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!title) return fail(`${at}.title 缺少图表或表格的标题`);
    const materialId = typeof row.materialId === "string" ? row.materialId.trim().replace(/^material:/, "") : "";
    return { page, title, ...(materialId ? { materialId } : {}) };
  });
}

/** `第 7 页『专题汇报』`; a table says so, because its slide title may equal a chart's. */
export function missingItemText(item: Pick<MissingItem, "sourcePage" | "title" | "kind">): string {
  return `第 ${item.sourcePage} 页『${item.title}』${item.kind === "table" ? "（表格）" : ""}`;
}

/** The provenance entry for an item: its text plus the fixed 「未提供本期数据」 reason. */
export function missingItemEntry(item: MissingItem): string {
  return `${missingItemText(item)}${MISSING_ITEM_SUFFIX}`;
}

function candidates(items: readonly TemplateItem[]): string {
  const shown = items.slice(0, MAX_LISTED_CANDIDATES).map((item) => missingItemText(item));
  return items.length > MAX_LISTED_CANDIDATES ? `${shown.join("、")}等 ${items.length} 项` : shown.join("、");
}

function resolveOne(all: readonly TemplateItem[], request: MissingItemRequest): MissingItem {
  const wanted = normalizeItemName(request.title);
  const named = `第 ${request.page} 页『${request.title}』`;
  const matches = all.filter(
    (item) =>
      item.sourcePage === request.page &&
      (!request.materialId || item.materialId === request.materialId) &&
      item.names.some((name) => normalizeItemName(name) === wanted),
  );
  const verified = all.filter((item) => item.verified);
  if (!matches.length) {
    if (!verified.length && all.length) return unread(all[0]!, named);
    return fail(
      verified.length
        ? `missingItems 里的${named}不是已读模板里的图表或表格；可选：${candidates(verified)}`
        : `missingItems 里的${named}无法核对：没有可核对的模板图表或表格，请先用 read_material 读完 PPT 模板的 charts 和 tables 分段`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((item) => `${item.itemId}（${item.kind === "chart" ? "图表" : "表格"}）`);
    return fail(`missingItems 里的${named}对应多个图表或表格：${ids.join("、")}；请把 title 写成其中一个标识`);
  }
  const item = matches[0]!;
  if (!item.verified) return unread(item, named);
  return {
    materialId: item.materialId,
    sourcePage: item.sourcePage,
    kind: item.kind,
    itemId: item.itemId,
    title: item.title,
  };
}

function unread(item: TemplateItem, named: string): never {
  return fail(
    `missingItems 里的${named}还不能核对：请先用 read_material 读完资料「${item.materialName}」里该项目所在的分段（图表读 charts，表格读 tables），再声明`,
  );
}

/**
 * Validate a `missingItems` declaration before anything is recorded. Returns undefined when the
 * call carried none (the earlier declaration stays) and `[]` when it cleared the list. Throws a
 * Chinese Error that names the offending entry, so a refused call changes nothing.
 */
export function resolveMissingItems(
  root: string,
  contextEpochId: string,
  raw: unknown,
  periodMap: PeriodMap | undefined,
): readonly MissingItem[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const requests = parseMissingItemRequests(raw);
  if (!requests.length) return [];
  if (!periodMap) {
    fail("missingItems 需要先用 periodMap 说明从哪个期间更新到哪个期间，再声明没有本期数据的项目");
  }
  const all = readTemplateItems(root, contextEpochId);
  const seen = new Set<string>();
  const items: MissingItem[] = [];
  for (const request of requests) {
    const item = resolveOne(all, request);
    const key = `${item.materialId}#${item.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

/** The latest declaration; a plan that omits `missingItems` keeps it. */
export function latestMissingItems(ledger: RunLedgerV1 | undefined): readonly MissingItem[] {
  const fact = ledger?.facts
    .filter((entry): entry is MissingItemsFact => entry.type === "plan.missing-items-declared")
    .at(-1);
  return fact?.items ?? [];
}

export function recordMissingItems(root: string, context: RunToolContext, items: readonly MissingItem[]): void {
  const payload = {
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    items,
  };
  appendFact(root, {
    type: "plan.missing-items-declared",
    factId: factId("plan.missing-items-declared", payload),
    at: new Date().toISOString(),
    ...payload,
  });
}
