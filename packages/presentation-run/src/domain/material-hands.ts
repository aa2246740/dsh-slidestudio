/**
 * Domain-side handlers for the material agent tools (`list_materials`,
 * `read_material`, `view_material`) dispatched from `runDomainHand`. Every
 * handler fails closed on verification errors (unknown id or tampered bytes →
 * a Chinese error with no content and no ledger receipt).
 */
import { readMaterialChunk } from "./material-content.js";
import {
  MaterialPackError,
  readMaterialsManifest,
  verifiedMaterialImage,
  verifyMaterial,
  type MaterialManifestEntry,
} from "./material-pack.js";
import { isPdfMaterial, verifiedMaterialPage } from "./material-pages.js";
import {
  ALL_IMAGES_ID,
  overviewViewResult,
  planAllImagesOverview,
  planPdfPagesOverview,
  recordMaterialOverviewResult,
} from "./material-overview.js";
import { recordMaterialNotesResult } from "./material-notes.js";
import { queryMaterialResult } from "./material-query-hand.js";
import { inspectProjectCapabilities } from "../capabilities.js";
import {
  appendFact,
  factId,
  readRunLedger,
  recordMaterialChunk,
  type MaterialChunkFact,
  type RunToolContext,
} from "./run-ledger.js";
import type { MaterialPageFact } from "./material-read-progress.js";
import { materialReadProgress } from "./material-read-progress.js";
import { materialStyleHints, styleHintDetail } from "./material-style-hints.js";
import { withPaletteParts } from "./palette-source.js";
import type { ToolExecution } from "./agent-tools.js";
import { verifiedTemplatePhoto } from "./template-photo.js";
import { templateMaterialPartDescriptors } from "./material-template-text.js";

export function listMaterialsResult(root: string): ToolExecution {
  const materials = readMaterialsManifest(root).map((entry) => {
    // Legacy material manifests may not have a known parser id. Verify the
    // record so the shared identity helpers can use the detected MIME before
    // the original extension (Word records too: they carry theme hints and
    // embedded charts since CAP-33).
    let styleHints: Readonly<Record<string, unknown>> | undefined;
    let material: ReturnType<typeof verifyMaterial> | undefined;
    if (entry.kind === "deck-template" || entry.kind === "image" || entry.kind === "document") {
      material = verifyMaterial(root, entry.id);
    }
    if (material) {
      styleHints = materialStyleHints(material);
    }
    const parts: readonly Record<string, unknown>[] =
      entry.kind === "deck-template"
        ? templateMaterialPartDescriptors(material ?? verifyMaterial(root, entry.id))
        : material
          ? withPaletteParts(material, entry.parts)
          : entry.parts;
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      summaryZh: entry.summaryZh,
      ...(entry.mediaSrc ? { mediaSrc: entry.mediaSrc } : {}),
      needsVision: entry.needsVision,
      parser: entry.parser,
      sha256: entry.sha256,
      parts,
      ...(entry.media ? { media: entry.media } : {}),
      ...(entry.pageImages ? { pageImages: entry.pageImages } : {}),
      ...(styleHints ? { styleHints } : {}),
      ...(entry.kind === "image" ? listedImageMetadata(material?.derivative.image) : {}),
    };
  });
  const vision = inspectProjectCapabilities(root).vision;
  // Page images are offered only when the selected model can take image input.
  // The PDF's own overview is the page view; all-images covers images only.
  const pageNote = (pageImages: MaterialManifestEntry["pageImages"], id: string) =>
    pageImages && vision.modelAcceptsImages === true
      ? ` | 页面图片 第 ${pageImages.pages.join("、")} 页，view_material 可按页查看（最多前 40 页）；采用它的配色前，先看页面总览 view_material {"materialId":"${id}"}`
      : "";
  // The note keys on the selected model's image input, not vision.mode: a
  // missing raster runtime does not stop the model from viewing an uploaded
  // image, and raster-ready text-only models still cannot see it.
  const textOnly = vision.modelAcceptsImages !== true;
  const pagesNote = (entry: { kind: string; parser: string; pageImages?: { pages: readonly number[] } }) => {
    if (!isPdfEntry(entry)) return "";
    const count = entry.pageImages?.pages.length ?? 0;
    if (!count) return " | 页面图不可用（只能读取文字和矢量颜色）";
    return ` | 页面图 ${count} 页${textOnly ? "（当前模型不能看图）" : ""}`;
  };
  const paletteNote = materials.some((entry) => entry.parts.some((part) => part.part === "palette"))
    ? '\n图片和 PDF（无目录风格包时可作配色来源）可作配色来源：用户要求按它的颜色设计时，先 read_material {"part":"palette"}，再在 commit_design 采用并声明 palette；只是放进页面不需要采用。'
    : "";
  const visionNote = [
    textOnly && materials.some((entry) => entry.needsVision)
      ? "\n当前模型不能看图，图片类资料只拿到配色、尺寸和朝向，看不到版式和气质；如需按画面风格设计，请换用支持看图的模型（例如 GLM-5.3-Flash）。把图片放到页面时仍可使用 mediaSrc，不需要看图。"
      : "",
    textOnly && materials.some(isPdfEntry) ? "\n当前模型不能看图，PDF 没有可用的页面图片，只能读取文字。" : "",
    !textOnly && imageCount(materials) >= 2
      ? '\n图片较多时，先用 view_material {"materialId":"all-images"} 看一张带编号的图片总览（只含图片资料，不含 PDF 页面），再按需单张查看；看完用 record_material_notes 记下每张图的结论。'
      : "",
  ].join("");
  const detail = materials.length
    ? `${materials
        .map(
          (entry) =>
            `${entry.name} | ${entry.kind} | ${entry.summaryZh}${entry.mediaSrc ? ` | media ${entry.mediaSrc}` : ""}${
              entry.parts.length
                ? ` | parts ${entry.parts
                    .map((part) => {
                      const id = String(part.part ?? "");
                      const label = String(part.label ?? "");
                      const bytes = Number(part.bytes);
                      const chunks = Number(part.chunks);
                      const size =
                        Number.isSafeInteger(bytes) && Number.isSafeInteger(chunks)
                          ? ` ${chunks} 段/${bytes.toLocaleString("zh-CN")} 字节`
                          : "";
                      return `${id}${label ? `（${label}）` : size}`;
                    })
                    .filter(Boolean)
                    .join("、")}`
                : ""
            }${
              entry.kind === "deck-template"
                ? ` | 用户要求配色、字体、Logo 或版式时，commit_design 的 adoptedSourceIds 必须包含 material:${entry.id}`
                : ""
            }${
              entry.styleHints
                ? ` | ${styleHintDetail(entry.styleHints, {
                    modelAcceptsImages: vision.modelAcceptsImages === true,
                  })}`
                : ""
            }${pagesNote(entry)}${pageNote(entry.pageImages, entry.id)}`,
        )
        .join("\n")}${paletteNote}${visionNote}`
    : `本次没有可用的上传资料。${visionNote}`;
  return {
    name: "list_materials",
    ok: true,
    summary: `${materials.length} uploaded materials`,
    detail,
    payload: { materials, visionMode: vision.mode },
  };
}

function isPdfEntry(entry: { kind: string; parser: string }): boolean {
  return entry.kind === "document" && !entry.parser.startsWith("docx-ooxml-");
}

function imageCount(materials: readonly { kind: string; media?: readonly Record<string, unknown>[] }[]): number {
  return materials.reduce(
    (sum, entry) =>
      sum +
      (entry.kind === "image"
        ? 1
        : (entry.media ?? []).filter((item) => item.role === "template-photo" && item.variant !== "grayscale").length),
    0,
  );
}

function listedImageMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const imageMetadata = Object.fromEntries(
    ["orientation", "logoLike", "screenshotLike", "takenAt"]
      .filter((key) => typeof value[key] === (key.endsWith("Like") ? "boolean" : "string"))
      .map((key) => [key, value[key]]),
  );
  return {
    ...(Object.keys(imageMetadata).length ? { imageMetadata } : {}),
    ...(isRecord(value.styleProfile) ? { styleProfile: value.styleProfile } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readMaterialResult(
  root: string,
  context: RunToolContext,
  args: Record<string, unknown>,
): ToolExecution {
  const materialId = String(args.materialId ?? "").trim();
  const material = verifyMaterial(root, materialId);
  const offset = Number(args.offset);
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  // Same model rule as list_materials: only a model that accepts images is told it can view a picture.
  const modelAcceptsImages = inspectProjectCapabilities(root).vision.modelAcceptsImages === true;
  const chunk = readMaterialChunk({
    material,
    ...(typeof args.part === "string" && args.part.trim() ? { part: args.part } : {}),
    ...(Number.isSafeInteger(offset) && offset >= 0 ? { offset } : {}),
    ...(limit !== undefined && Number.isSafeInteger(limit) ? { limit } : {}),
    modelAcceptsImages,
  });
  const { read, nextOffset } = materialReadProgress(
    material,
    chunk,
    (readRunLedger(root)?.facts ?? []).filter(
      (fact): fact is MaterialChunkFact => fact.type === "material.chunk-returned",
    ),
    { modelAcceptsImages },
  );
  recordMaterialChunk(root, context, {
    materialId: read.materialId,
    materialSha256: read.materialSha256,
    part: read.part,
    chunkIndex: read.chunkIndex,
    chunkSha256: read.chunkSha256,
    chunkCount: read.chunkCount,
    ...(read.rows ? { rowStart: read.rows.startIndex, rowEnd: read.rows.endIndex, rowTotal: read.rows.total } : {}),
  });
  const windowNote = read.rows
    ? `rows ${read.rows.startIndex}-${read.rows.endIndex} of ${read.rows.total}`
    : `chunk ${read.chunkIndex + 1}/${read.chunkCount}`;
  return {
    name: "read_material",
    ok: true,
    summary: `${read.name} ${read.part} ${windowNote}`,
    detail: [
      `资料「${read.name}」(${read.kind})`,
      `part ${read.part} ${windowNote} sha256 ${read.chunkSha256}`,
      read.rows
        ? read.allRead
          ? `已读完全部 ${read.rows.total} 行`
          : `已读 ${read.rowsRead}/${read.rows.total} 行；还有更多内容：offset 取 ${nextOffset} 继续读取`
        : read.allRead
          ? `已读完全部 ${read.chunkCount} 段`
          : `已读 ${read.readChunks}/${read.chunkCount} 段；还有更多内容：offset 取 ${nextOffset} 继续读取`,
      "正文见 payload.text",
    ].join("\n"),
    payload: { ...read },
  };
}

function recordMaterialPage(
  root: string,
  context: RunToolContext,
  input: Omit<MaterialPageFact, "type" | "factId" | "at" | "contextEpochId">,
): void {
  const payload = { ...input, contextEpochId: context.contextEpochId };
  appendFact(root, {
    type: "material.page-viewed",
    factId: factId("material.page-viewed", payload),
    at: new Date().toISOString(),
    ...payload,
  });
}

function recordMaterialImageViewed(
  root: string,
  context: RunToolContext,
  material: { id: string; sha256: string },
): void {
  const payload = {
    materialId: material.id,
    materialSha256: material.sha256,
    contextEpochId: context.contextEpochId,
  };
  appendFact(root, {
    type: "material.image-viewed",
    factId: factId("material.image-viewed", payload),
    at: new Date().toISOString(),
    ...payload,
  });
}

export function viewMaterialResult(
  root: string,
  context: RunToolContext,
  args: Record<string, unknown>,
): ToolExecution {
  const materialId = String(args.materialId ?? "").trim();
  if (materialId === ALL_IMAGES_ID) {
    if ((args.page !== undefined && args.page !== null) || args.mediaId) {
      throw new MaterialPackError("all-images 总览不需要 page 或 mediaId；要看单张图片请改用它的 materialId");
    }
    return overviewViewResult(planAllImagesOverview(root));
  }
  if (args.page !== undefined && args.page !== null) {
    const viewed = verifiedMaterialPage(root, materialId, args.page);
    const { material, page } = viewed;
    recordMaterialPage(root, context, {
      materialId: material.id,
      materialSha256: material.sha256,
      page,
      pageSha256: viewed.sha256,
    });
    return {
      name: "view_material",
      ok: true,
      summary: `${material.name} 第 ${page} 页`,
      detail: `资料「${material.name}」第 ${page} / ${viewed.pageCount} 页的页面图片已作为图像返回`,
      payload: {
        materialId: material.id,
        materialSha256: material.sha256,
        name: material.name,
        kind: material.kind,
        page,
        pageCount: viewed.pageCount,
        imageBytesBase64: viewed.bytes.toString("base64"),
        imageSha256: viewed.sha256,
      },
    };
  }
  const material = verifyMaterial(root, materialId);
  if (isPdfMaterial(material)) return overviewViewResult(planPdfPagesOverview(root, materialId));
  const photo = material.kind === "deck-template" ? verifiedTemplatePhoto(material, args.mediaId) : undefined;
  const { bytes } = photo ?? verifiedMaterialImage(root, materialId);
  if (material.kind === "image") recordMaterialImageViewed(root, context, material);
  return {
    name: "view_material",
    ok: true,
    summary: `${material.name} image`,
    detail: `资料「${material.name}」的图片内容已作为图像返回`,
    payload: {
      materialId: material.id,
      materialSha256: material.sha256,
      name: material.name,
      kind: material.kind,
      imageBytesBase64: bytes.toString("base64"),
      normalizedSha256: material.receipt.normalizedSha256,
      ...(photo ? { mediaId: photo.mediaId, mediaSrc: photo.mediaSrc, imageSha256: photo.sha256 } : {}),
    },
  };
}

/** Tool names `materialToolResult` answers; `_record_material_overview` is Host-internal. */
export const MATERIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_materials",
  "read_material",
  "view_material",
  "record_material_notes",
  "query_material",
  "_record_material_overview",
]);

/** Dispatch one material tool inside the strict (ledgered) run; undefined for other tools. */
export function materialToolResult(
  root: string,
  name: string,
  context: RunToolContext,
  args: Record<string, unknown>,
): ToolExecution | undefined {
  switch (name) {
    case "list_materials":
      return listMaterialsResult(root);
    case "read_material":
      return readMaterialResult(root, context, args);
    case "view_material":
      return viewMaterialResult(root, context, args);
    case "record_material_notes":
      return recordMaterialNotesResult(root, context, args);
    case "query_material":
      return queryMaterialResult(root, context, args);
    case "_record_material_overview":
      return recordMaterialOverviewResult(root, context, args);
    default:
      return undefined;
  }
}
