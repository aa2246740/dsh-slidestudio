/**
 * Receipt-verified PDF page images for `view_material {materialId, page}`.
 *
 * The render queue (apps/native-web) writes `page-<n>.jpg` files and a
 * `renderedPages[{index,file,sha256,px}]` descriptor into the derivative. The
 * Tool Host copies both into `_agent/materials/<id>/` at materialization. A
 * page is returned only when the descriptor, the file name and the JPEG bytes
 * all agree; anything else fails closed with a Chinese reason.
 */
import fs from "node:fs";
import path from "node:path";
import { MaterialPackError, sha256Hex, verifyMaterial, type VerifiedMaterial } from "./material-pack.js";

/** Mirrors PDF_RENDER_CONFIG.maxPages in apps/native-web (DECISIONS #11). */
export const MATERIAL_PAGE_VIEW_MAX_PAGES = 40;
/** One 960 px JPEG page stays far below this bound; larger files are refused. */
export const MATERIAL_PAGE_MAX_BYTES = 4 * 1024 * 1024;

export type VerifiedMaterialPage = Readonly<{
  material: VerifiedMaterial;
  page: number;
  pageCount: number;
  bytes: Buffer;
  sha256: string;
}>;

const DEFAULT_RENDER_REASON = "页面图片没有生成，看图模型无法查看页面";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pageNumberFromArg(value: unknown): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const page = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(page)) {
    throw new MaterialPackError("页码无效：page 必须是从 1 开始的整数页码");
  }
  return page;
}

export function isPdfMaterial(material: Pick<VerifiedMaterial, "kind" | "parser">): boolean {
  return material.kind === "document" && !material.parser.startsWith("docx-ooxml-");
}

/** Return one PDF page JPEG whose descriptor, file name and bytes all verify. */
export function verifiedMaterialPage(projectRoot: string, materialId: string, pageArg: unknown): VerifiedMaterialPage {
  return verifiedPageOf(verifyMaterial(projectRoot, materialId), pageArg);
}

/** Same checks as `verifiedMaterialPage` for a material that is already verified. */
export function verifiedPageOf(material: VerifiedMaterial, pageArg: unknown): VerifiedMaterialPage {
  if (!isPdfMaterial(material)) {
    throw new MaterialPackError(`资料「${material.name}」不是 PDF，没有可以按页查看的页面图片`);
  }
  const page = pageNumberFromArg(pageArg);
  const document = isRecord(material.derivative.document) ? material.derivative.document : {};
  const pageCount = Number.isSafeInteger(document.pageCount) ? Number(document.pageCount) : 0;
  if (page < 1) {
    throw new MaterialPackError(`页码无效：第 ${page} 页不存在，页码从 1 开始`);
  }
  if (page > MATERIAL_PAGE_VIEW_MAX_PAGES) {
    throw new MaterialPackError(
      `只生成前 ${MATERIAL_PAGE_VIEW_MAX_PAGES} 页图片，第 ${page} 页没有图片；请改为查看 1–${MATERIAL_PAGE_VIEW_MAX_PAGES} 页`,
    );
  }
  if (page > pageCount) {
    throw new MaterialPackError(`页码超出范围：资料「${material.name}」共 ${pageCount} 页，第 ${page} 页不存在`);
  }
  const rendered = Array.isArray(document.renderedPages) ? document.renderedPages : [];
  const descriptor = rendered.find((entry) => isRecord(entry) && entry.index === page);
  if (!isRecord(descriptor) || descriptor.file !== `page-${page}.jpg` || typeof descriptor.sha256 !== "string") {
    const reason =
      typeof document.renderMessage === "string" && document.renderMessage
        ? document.renderMessage
        : DEFAULT_RENDER_REASON;
    throw new MaterialPackError(`资料「${material.name}」第 ${page} 页没有页面图片：${reason}`);
  }
  const file = path.join(material.directory, `page-${page}.jpg`);
  let bytes: Buffer;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MATERIAL_PAGE_MAX_BYTES) {
      throw new Error("unsafe page file");
    }
    bytes = fs.readFileSync(file);
  } catch {
    throw new MaterialPackError(`资料「${material.name}」第 ${page} 页图片缺失，请重新上传后再发送`);
  }
  const sha256 = sha256Hex(bytes);
  if (sha256 !== descriptor.sha256) {
    throw new MaterialPackError(`资料「${material.name}」第 ${page} 页图片已变化，请重新上传后再发送`);
  }
  return { material, page, pageCount, bytes, sha256 };
}
