/**
 * `write_todo` image placement (CAP-12): the agent says which uploaded images
 * go on which page (`items[].materials`) and what it does with the others
 * (`materialUse`). The Host only checks that the ids are real image uploads,
 * persists the declaration as a ledger fact and echoes it back; it never
 * assigns an image to a page and never classifies an image by its name.
 */
import { readMaterialsManifest, type MaterialManifestEntry } from "./material-pack.js";
import type { CanonicalPlanPage } from "./page-plan.js";
import { appendFact, factId, readRunLedger, type RunLedgerV1, type RunToolContext } from "./run-ledger.js";

export const MATERIAL_USE_KINDS = ["placed", "background", "logo", "style-reference", "excluded"] as const;
export type MaterialUseKind = (typeof MATERIAL_USE_KINDS)[number];

export type MaterialUseEntry = Readonly<{
  materialId: string;
  use: MaterialUseKind;
  reason?: string;
}>;

/** The agent's latest `materialUse` declaration. A newer fact replaces the older one. */
export type MaterialUseFact = Readonly<{
  type: "material.use-declared";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  entries: readonly MaterialUseEntry[];
}>;

/** One uploaded image as the plan sees it: planned pages (1-based) and the declared use. */
export type PlanImageRow = Readonly<{
  materialId: string;
  name: string;
  pages: readonly number[];
  use?: MaterialUseKind;
  reason?: string;
}>;

export type PlanMaterials = Readonly<{
  /** Present only when this call carried `materialUse`; absent means "keep the earlier one". */
  declared?: readonly MaterialUseEntry[];
  /** True when the project has uploaded images, so the plan result carries `materialPlan`. */
  hasImages: boolean;
  rows: readonly PlanImageRow[];
  hints: readonly string[];
}>;

const REASON_MAX_CHARS = 200;
const HINT_MAX_NAMES = 8;
const KIND_LIST = MATERIAL_USE_KINDS.join("、");

const canonicalId = (value: string): string => value.trim().replace(/^material:/, "");

/** Names shown in a hint: 『a』、『b』 …, bounded so one hint never grows without limit. */
export function quotedNames(names: readonly string[]): string {
  const shown = names.slice(0, HINT_MAX_NAMES).map((name) => `『${name}』`);
  return names.length > HINT_MAX_NAMES ? `${shown.join("、")}等 ${names.length} 张` : shown.join("、");
}

/** The most recent declaration in the ledger, or none. */
export function latestMaterialUse(ledger: RunLedgerV1 | undefined): readonly MaterialUseEntry[] {
  const fact = ledger?.facts.filter((entry): entry is MaterialUseFact => entry.type === "material.use-declared").at(-1);
  return fact?.entries ?? [];
}

function imageEntries(root: string): ReadonlyMap<string, MaterialManifestEntry> {
  return new Map(
    readMaterialsManifest(root)
      .filter((entry) => entry.kind === "image")
      .map((entry) => [entry.id, entry]),
  );
}

function requireImage(
  root: string,
  images: ReadonlyMap<string, MaterialManifestEntry>,
  id: string,
  where: string,
  rule: string,
): MaterialManifestEntry {
  const image = images.get(id);
  if (image) return image;
  const other = readMaterialsManifest(root).find((entry) => entry.id === id);
  if (!other) return fail(`${where}里的资料「${id}」不存在，请使用 list_materials 返回的 id`);
  return fail(`${where}里的资料「${id}」（${other.name}）不是图片（${other.kind}），${rule}`);
}

function fail(message: string): never {
  throw new Error(message);
}

function parseMaterialUse(
  root: string,
  images: ReadonlyMap<string, MaterialManifestEntry>,
  raw: unknown,
): readonly MaterialUseEntry[] {
  if (!Array.isArray(raw)) fail("materialUse 必须是数组，每项写成 {materialId, use, reason}");
  const seen = new Set<string>();
  return raw.map((value: unknown, index) => {
    const at = `materialUse[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return fail(`${at} 必须是对象：{materialId, use, reason}`);
    }
    const row = value as Record<string, unknown>;
    const id = typeof row.materialId === "string" ? canonicalId(row.materialId) : "";
    if (!id) return fail(`${at} 缺少 materialId`);
    const image = requireImage(root, images, id, "materialUse ", "materialUse 只用于图片资料");
    if (seen.has(id)) return fail(`materialUse 里的图片「${image.name}」重复出现，请合并成一条`);
    seen.add(id);
    const use = row.use;
    if (typeof use !== "string" || !MATERIAL_USE_KINDS.includes(use as MaterialUseKind)) {
      const shown = typeof use === "string" ? use : "（缺少）";
      return fail(`${at}.use 无效：「${shown}」；可选 ${KIND_LIST}`);
    }
    const reason =
      typeof row.reason === "string" ? Array.from(row.reason.trim()).slice(0, REASON_MAX_CHARS).join("") : "";
    if (use === "excluded" && !reason) {
      return fail(`图片「${image.name}」在 materialUse 里标为 excluded 时，需要在 reason 里写明不使用的原因`);
    }
    return { materialId: id, use: use as MaterialUseKind, ...(reason ? { reason } : {}) };
  });
}

function plannedPages(items: readonly CanonicalPlanPage[], materialId: string): number[] {
  return items.flatMap((item, index) => (item.materials?.includes(materialId) ? [index + 1] : []));
}

/**
 * Validate the plan's image fields before anything is recorded. Throws a
 * Chinese Error naming the offending id, so a refused call leaves the plan
 * and the earlier declaration untouched.
 */
export function resolvePlanMaterials(
  root: string,
  items: readonly CanonicalPlanPage[],
  rawMaterialUse: unknown,
): PlanMaterials {
  const images = imageEntries(root);
  items.forEach((item, index) => {
    for (const id of item.materials ?? []) {
      requireImage(
        root,
        images,
        id,
        `第 ${index + 1} 页（${item.pageId}）的 materials `,
        "materials 只用于计划放进该页的图片",
      );
    }
  });
  const declared =
    rawMaterialUse === undefined || rawMaterialUse === null
      ? undefined
      : parseMaterialUse(root, images, rawMaterialUse);
  for (const entry of declared ?? []) {
    const pages = plannedPages(items, entry.materialId);
    if (entry.use === "excluded" && pages.length) {
      const name = images.get(entry.materialId)?.name ?? entry.materialId;
      fail(`图片「${name}」在 materialUse 里标为 excluded，却被计划放进第 ${pages.join("、")} 页，请二选一`);
    }
  }
  const effective = (declared ?? latestMaterialUse(readRunLedger(root))).filter((entry) =>
    images.has(entry.materialId),
  );
  const rows: PlanImageRow[] = [];
  const unaccounted: string[] = [];
  for (const image of images.values()) {
    const pages = plannedPages(items, image.id);
    const entry = effective.find((candidate) => candidate.materialId === image.id);
    if (!pages.length && !entry) unaccounted.push(image.name);
    if (!pages.length && !entry) continue;
    rows.push({
      materialId: image.id,
      name: image.name,
      pages,
      ...(entry ? { use: entry.use, ...(entry.reason ? { reason: entry.reason } : {}) } : {}),
    });
  }
  const hints = unaccounted.length
    ? [
        `还有 ${unaccounted.length} 张图片没有安排页面，也没有说明不用的原因：${quotedNames(unaccounted)}。请在 items[].materials 里写明放进哪一页，或在 materialUse 里标为 excluded 并写明原因；这条提示不阻止保存计划。`,
      ]
    : [];
  return { ...(declared ? { declared } : {}), hasImages: images.size > 0, rows, hints };
}

/** Append the declaration once the plan itself is committed. */
export function recordPlanMaterialUse(root: string, context: RunToolContext, plan: PlanMaterials): void {
  if (!plan.declared) return;
  const payload = {
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    entries: plan.declared,
  };
  appendFact(root, {
    type: "material.use-declared",
    factId: factId("material.use-declared", payload),
    at: new Date().toISOString(),
    ...payload,
  });
}

/** The model-facing fields a plan result gains from the image plan. */
export function planMaterialsPayload(plan: PlanMaterials): Record<string, unknown> {
  return plan.hasImages ? { materialPlan: plan.rows } : {};
}

/**
 * The fields of the domain's plan result the model should still see after the
 * presentation layer rebuilds it: the image plan, the non-blocking hints and the monthly-update
 * declarations (`periodMap`, `missingItems`) the Host accepted.
 */
export function forwardPlanFeedback(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) return {};
  const source = payload as Record<string, unknown>;
  const list = (value: unknown) => (Array.isArray(value) && value.length ? value : undefined);
  return {
    ...(Array.isArray(source.materialPlan) ? { materialPlan: source.materialPlan } : {}),
    ...(list(source.notInPlan) ? { notInPlan: source.notInPlan } : {}),
    ...(list(source.hints) ? { hints: source.hints } : {}),
    ...(source.periodMap ? { periodMap: source.periodMap } : {}),
    ...(list(source.missingItems) ? { missingItems: source.missingItems } : {}),
  };
}
