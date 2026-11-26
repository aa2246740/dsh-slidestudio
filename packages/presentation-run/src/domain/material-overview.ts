/**
 * Plans for the numbered overview images a vision model can ask for:
 * `view_material {materialId:"all-images"}` (every session image, in manifest
 * order) and `view_material {materialId:<pdf>}` (the first rendered pages).
 *
 * This module only collects and verifies the tiles; the Tool Host composes the
 * mosaic (it owns the image library) and then calls `_record_material_overview`,
 * which re-derives the same plan, requires the same tiles and writes the
 * ledger fact. Nothing here decodes or invents pixels.
 */
import path from "node:path";
import { orientationOf, sniffImageSize } from "./image-size.js";
import {
  MaterialPackError,
  readMaterialsManifest,
  verifiedMaterialImage,
  verifyMaterial,
  type VerifiedMaterial,
} from "./material-pack.js";
import { isPdfMaterial, MATERIAL_PAGE_VIEW_MAX_PAGES, verifiedPageOf } from "./material-pages.js";
import { verifiedTemplatePhoto } from "./template-photo.js";
import type { ToolExecution } from "./agent-tools.js";
import { appendFact, factId, type RunToolContext } from "./run-ledger.js";
import type { MaterialOverviewFact, MaterialOverviewTileFact } from "./material-view-facts.js";

/** Pseudo material id of the all-images overview. */
export const ALL_IMAGES_ID = "all-images";
/** Mirrors IMAGE_OVERVIEW_MAX_TILES in dsh-slides-host (6 × 6 grid). */
export const OVERVIEW_MAX_TILES = 36;
/** Mirrors IMAGE_OVERVIEW_PDF_MAX_PAGES in dsh-slides-host. */
export const OVERVIEW_PDF_MAX_PAGES = 12;
const MAX_MOSAIC_EDGE = 1568;

export type Orientation = "landscape" | "portrait" | "square";

export type OverviewTile = Readonly<{
  number: number;
  materialId: string;
  mediaId?: string;
  page?: number;
  name: string;
  width?: number;
  height?: number;
  orientation?: Orientation;
  sha256: string;
  /** Project-relative path of the verified bytes; read by the Tool Host, never shown to the model. */
  file: string;
}>;

export type OverviewPlan = Readonly<{
  kind: "all-images" | "pdf-pages";
  /** `all-images`, or the PDF's material id. */
  materialId: string;
  name: string;
  tiles: readonly OverviewTile[];
  /** Images (or rendered pages) available, including ones the mosaic cannot show. */
  total: number;
  truncated: boolean;
  /** PDF page count, when known. */
  pageCount?: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function sizeFields(width: number | undefined, height: number | undefined, declared?: unknown) {
  if (width === undefined || height === undefined) return {};
  const orientation =
    declared === "landscape" || declared === "portrait" || declared === "square"
      ? declared
      : orientationOf(width, height);
  return { width, height, orientation };
}

function relativeFile(root: string, material: VerifiedMaterial, file: string): string {
  return path.relative(root, path.join(material.directory, file));
}

function imageTile(root: string, entryId: string, number: number): OverviewTile {
  const { material, bytes, sha256 } = verifiedMaterialImage(root, entryId);
  const image = isRecord(material.derivative.image) ? material.derivative.image : {};
  const size = sniffImageSize(bytes);
  return {
    number,
    materialId: material.id,
    name: material.name,
    sha256,
    file: relativeFile(root, material, "normalized.jpg"),
    ...sizeFields(
      positiveInt(image.width) ?? size?.width,
      positiveInt(image.height) ?? size?.height,
      image.orientation,
    ),
  };
}

function templatePhotoTile(root: string, material: VerifiedMaterial, mediaId: string, number: number): OverviewTile {
  const photo = verifiedTemplatePhoto(material, mediaId);
  const entry = material.receipt.media?.find((item) => item.mediaId === mediaId);
  const size = sniffImageSize(photo.bytes);
  return {
    number,
    materialId: material.id,
    mediaId,
    name: `${material.name}（模板照片）`,
    sha256: photo.sha256,
    file: relativeFile(root, material, String(entry?.file ?? "")),
    ...sizeFields(size?.width, size?.height),
  };
}

/** Template photos worth showing: originals only (the grayscale copy is the same picture). */
function templatePhotoIds(media: readonly Record<string, unknown>[] | undefined): string[] {
  return (media ?? [])
    .filter(
      (item) => item.role === "template-photo" && item.variant !== "grayscale" && typeof item.mediaId === "string",
    )
    .map((item) => String(item.mediaId));
}

/** Every session image in manifest order, each verified against its receipt. */
export function planAllImagesOverview(root: string): OverviewPlan {
  const tiles: OverviewTile[] = [];
  let total = 0;
  for (const entry of readMaterialsManifest(root)) {
    if (entry.kind === "image") {
      total += 1;
      if (tiles.length < OVERVIEW_MAX_TILES) tiles.push(imageTile(root, entry.id, tiles.length + 1));
    } else if (entry.kind === "deck-template") {
      const photoIds = templatePhotoIds(entry.media);
      if (!photoIds.length) continue;
      const material = verifyMaterial(root, entry.id);
      for (const mediaId of photoIds) {
        total += 1;
        if (tiles.length < OVERVIEW_MAX_TILES) {
          tiles.push(templatePhotoTile(root, material, mediaId, tiles.length + 1));
        }
      }
    }
  }
  if (!total) {
    throw new MaterialPackError(
      "本次没有可查看的图片资料：上传的资料里没有图片，也没有带照片的 PPT 模板，无法生成图片总览；请先用 list_materials 查看资料清单",
    );
  }
  return {
    kind: "all-images",
    materialId: ALL_IMAGES_ID,
    name: "全部图片",
    tiles,
    total,
    truncated: total > tiles.length,
  };
}

/** The first rendered pages of one PDF, numbered by page number. */
export function planPdfPagesOverview(root: string, materialId: string): OverviewPlan {
  const material = verifyMaterial(root, materialId);
  if (!isPdfMaterial(material)) {
    throw new MaterialPackError(`资料「${material.name}」不是 PDF，没有可以按页查看的页面图片`);
  }
  const document = isRecord(material.derivative.document) ? material.derivative.document : {};
  const rendered = (Array.isArray(document.renderedPages) ? document.renderedPages : [])
    .filter(isRecord)
    .map((entry) => ({ index: entry.index, file: entry.file, px: entry.px }))
    .filter(
      (entry): entry is { index: number; file: string; px: unknown } =>
        typeof entry.index === "number" &&
        Number.isSafeInteger(entry.index) &&
        entry.index >= 1 &&
        entry.index <= MATERIAL_PAGE_VIEW_MAX_PAGES &&
        entry.file === `page-${entry.index}.jpg`,
    )
    .sort((a, b) => a.index - b.index);
  if (!rendered.length) {
    const reason =
      typeof document.renderMessage === "string" && document.renderMessage
        ? document.renderMessage
        : "页面图片没有生成，看图模型无法查看页面";
    throw new MaterialPackError(`资料「${material.name}」没有页面图片：${reason}`);
  }
  const tiles = rendered.slice(0, OVERVIEW_PDF_MAX_PAGES).map((entry): OverviewTile => {
    const viewed = verifiedPageOf(material, entry.index);
    const px = isRecord(entry.px) ? entry.px : {};
    return {
      number: entry.index,
      materialId: material.id,
      page: entry.index,
      name: `${material.name} 第 ${entry.index} 页`,
      sha256: viewed.sha256,
      file: relativeFile(root, material, `page-${entry.index}.jpg`),
      ...sizeFields(positiveInt(px.width), positiveInt(px.height)),
    };
  });
  const pageCount = positiveInt(document.pageCount);
  return {
    kind: "pdf-pages",
    materialId: material.id,
    name: material.name,
    tiles,
    total: rendered.length,
    truncated: rendered.length > tiles.length,
    ...(pageCount ? { pageCount } : {}),
  };
}

const ORIENTATION_ZH: Readonly<Record<Orientation, string>> = {
  landscape: "横图",
  portrait: "竖图",
  square: "方图",
};

function sizeCell(tile: OverviewTile): string {
  return tile.width && tile.height ? `${tile.width}×${tile.height}` : "尺寸未知";
}

function orientationCell(tile: OverviewTile): string {
  return tile.orientation ? ORIENTATION_ZH[tile.orientation] : "未知";
}

/** The Chinese number → material table that goes with the mosaic. */
export function overviewDetail(plan: OverviewPlan): string {
  const left = plan.total - plan.tiles.length;
  if (plan.kind === "pdf-pages") {
    return [
      `PDF 页面总览：「${plan.name}」${plan.pageCount ? `共 ${plan.pageCount} 页，` : ""}已生成页面图片 ${plan.total} 页；下图是${plan.truncated ? `前 ${plan.tiles.length} 页` : "这些页面"}，编号就是页码，写在每格左上角的色块里。`,
      "页码 | 尺寸 | 朝向",
      ...plan.tiles.map((tile) => `${tile.number} | ${sizeCell(tile)} | ${orientationCell(tile)}`),
      ...(plan.truncated
        ? [`总览只显示前 ${plan.tiles.length} 页，其余 ${left} 页请用 view_material 带 page 参数按页查看。`]
        : []),
      "总览只用于挑页面；需要看清细节时用 view_material 的 page 参数单页查看，并用 record_material_notes 记下结论。",
    ].join("\n");
  }
  return [
    `图片总览：共 ${plan.total} 张图片（含 PPT 模板里的照片），按资料顺序排成一张拼图；编号就是每格左上角色块里的数字。`,
    "编号 | 资料名 | materialId | 尺寸 | 朝向",
    ...plan.tiles.map(
      (tile) =>
        `${tile.number} | ${tile.name} | ${tile.mediaId ? `${tile.materialId}（mediaId ${tile.mediaId}）` : tile.materialId} | ${sizeCell(tile)} | ${orientationCell(tile)}`,
    ),
    ...(plan.truncated ? [`总览只显示前 ${plan.tiles.length} 张，其余 ${left} 张请用 view_material 单独查看。`] : []),
    "先用总览挑选和归类；需要看清细节时再按 materialId（模板照片还要 mediaId）单张查看，并用 record_material_notes 记下每张图的结论。",
  ].join("\n");
}

/** The `view_material` result for an overview: the plan, to be composed by the Tool Host. */
export function overviewViewResult(plan: OverviewPlan): ToolExecution {
  return {
    name: "view_material",
    ok: true,
    summary:
      plan.kind === "all-images" ? `图片总览 ${plan.tiles.length} 张` : `${plan.name} 页面总览 ${plan.tiles.length} 页`,
    detail: overviewDetail(plan),
    payload: {
      materialId: plan.materialId,
      kind: plan.kind,
      name: plan.name,
      overviewPlan: plan,
    },
  };
}

function tileFact(tile: OverviewTile): MaterialOverviewTileFact {
  return {
    number: tile.number,
    materialId: tile.materialId,
    ...(tile.mediaId ? { mediaId: tile.mediaId } : {}),
    ...(tile.page ? { page: tile.page } : {}),
    sha256: tile.sha256,
  };
}

const CHANGED = "图片资料已变化，与刚才查看的总览不一致，请重新查看总览";

/**
 * Internal tool: the Tool Host reports the mosaic it composed. The tiles must
 * equal the plan derived from the project right now, so the fact can only
 * describe what the model actually received.
 */
export function recordMaterialOverviewResult(
  root: string,
  context: RunToolContext,
  args: Record<string, unknown>,
): ToolExecution {
  const kind = args.kind === "all-images" || args.kind === "pdf-pages" ? args.kind : undefined;
  if (!kind) throw new MaterialPackError("图片总览类型无效，请重新查看总览");
  const overviewSha256 = String(args.overviewSha256 ?? "");
  const width = positiveInt(args.width);
  const height = positiveInt(args.height);
  if (
    !/^[a-f0-9]{64}$/.test(overviewSha256) ||
    !width ||
    !height ||
    width > MAX_MOSAIC_EDGE ||
    height > MAX_MOSAIC_EDGE
  ) {
    throw new MaterialPackError("图片总览校验值或尺寸无效，请重新查看总览");
  }
  const plan =
    kind === "all-images" ? planAllImagesOverview(root) : planPdfPagesOverview(root, String(args.materialId ?? ""));
  const submitted = Array.isArray(args.tiles) ? args.tiles : [];
  const expected = plan.tiles.map(tileFact);
  const same =
    submitted.length === expected.length &&
    expected.every((tile, index) => {
      const item: unknown = submitted[index];
      return (
        isRecord(item) &&
        item.number === tile.number &&
        item.materialId === tile.materialId &&
        (item.mediaId ?? undefined) === tile.mediaId &&
        (item.page ?? undefined) === tile.page &&
        item.sha256 === tile.sha256
      );
    });
  if (!same) throw new MaterialPackError(CHANGED);
  const payload: Omit<MaterialOverviewFact, "type" | "factId" | "at"> = {
    overviewKind: kind,
    overviewSha256,
    width,
    height,
    materialIds: [...new Set(expected.map((tile) => tile.materialId))],
    tiles: expected,
    truncated: plan.truncated,
    contextEpochId: context.contextEpochId,
  };
  appendFact(root, {
    type: "material.overview-viewed",
    factId: factId("material.overview-viewed", payload),
    at: new Date().toISOString(),
    ...payload,
  });
  return {
    name: "_record_material_overview",
    ok: true,
    summary: "overview recorded",
    detail: `已记录${kind === "all-images" ? "全部图片" : "PDF 页面"}总览（${expected.length} 格）`,
    payload: { overviewSha256, materialIds: payload.materialIds },
  };
}
