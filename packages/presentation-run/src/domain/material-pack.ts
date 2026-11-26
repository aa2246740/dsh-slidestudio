/**
 * Project materials (`_agent/materials/<id>/`) — receipt-verified paged reads
 * for the agent tools `list_materials`, `read_material` and `view_material`.
 *
 * Trust model: the manifest and receipt were written by the Tool Host at
 * materialization, but every read re-verifies the stored bytes against the
 * receipt and the derivative's own `materialId`/`source.sha256` — a tampered
 * file fails closed with a Chinese error and returns no content. Successful
 * reads are ledgered by the caller as `material.chunk-returned` facts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MATERIAL_MAX_ORIGINAL_BYTES } from "./material-limits.js";

export const MATERIALS_MANIFEST_REL = path.join("_agent", "materials", "manifest.json");

/** Maximum UTF-8 bytes per returned text chunk or table window, including table headers. */
export const MATERIAL_CHUNK_BYTES = 12 * 1024;
/** A single table window returns at most this many data rows. */
export const MATERIAL_TABLE_MAX_ROWS = 200;
export { MATERIAL_MAX_ORIGINAL_BYTES, MATERIAL_MAX_LOGO_BYTES } from "./material-limits.js";

export class MaterialPackError extends Error {
  override readonly name = "MaterialPackError";
}

export type MaterialKind = "text" | "table" | "document" | "deck-template" | "image";

export type MaterialManifestEntry = Readonly<{
  id: string;
  name: string;
  kind: MaterialKind;
  summaryZh: string;
  mediaSrc?: string;
  needsVision: boolean;
  parser: string;
  sha256: string;
  parts: readonly Record<string, unknown>[];
  media?: readonly Record<string, unknown>[];
  /** PDF pages whose page JPEG is materialized and verifiable (ascending, at most 40). */
  pageImages?: Readonly<{ pages: readonly number[] }>;
}>;

export type MaterialReceipt = Readonly<{
  id: string;
  name: string;
  kind: MaterialKind;
  parser: string;
  originalSha256: string;
  derivativeSha256: string;
  mediaSrc?: string;
  normalizedSha256?: string;
  /**
   * An SVG or AVIF is never written to the project: its converted PNG or JPEG stands in as the
   * original, and this is that file's hash (`originalSha256` stays the upload's hash for the
   * derivative check).
   */
  rasterSha256?: string;
  /**
   * A legacy upload is stored with its converted OOXML package beside the
   * original (`converted.<ext>`, M8): this is that file's hash, while
   * `originalSha256` still means the uploaded bytes.
   */
  convertedSha256?: string;
  designSourceMdSha256?: string;
  designSourceJsonSha256?: string;
  media?: readonly Record<string, unknown>[];
}>;

/** A verified material: manifest + receipt agree and the files re-hash. */
export type VerifiedMaterial = Readonly<{
  id: string;
  name: string;
  kind: MaterialKind;
  summaryZh: string;
  mediaSrc?: string;
  needsVision: boolean;
  parser: string;
  sha256: string;
  parts: readonly Record<string, unknown>[];
  directory: string;
  receipt: MaterialReceipt;
  derivative: Record<string, unknown>;
  originalBytes: Buffer;
  originalExtension: string;
  /** The verified converted package of a legacy upload; absent for plain uploads. */
  convertedBytes?: Buffer;
}>;

export type VerifiedDesignSource = Readonly<{
  markdown: string;
  json: Readonly<Record<string, unknown>>;
}>;

export type MaterialChunk = Readonly<{
  index: number;
  sha256: string;
  text: string;
  byteStart: number;
  byteEndExclusive: number;
  chunkCount: number;
}>;

export type MaterialReadResult = Readonly<{
  materialId: string;
  materialSha256: string;
  name: string;
  kind: MaterialKind;
  part: string;
  chunkIndex: number;
  chunkCount: number;
  chunkSha256: string;
  chars: number;
  pageRange?: Readonly<{ start: number; end: number }>;
  readChunks: number;
  allRead: boolean;
  rowsRead?: number;
  hasMore: boolean;
  /** Table text only: an oversized header or row was shortened with an explicit marker. */
  truncated?: boolean;
  /** Table reads only: absolute 1-based data-row window and total. */
  rows?: Readonly<{ startIndex: number; endIndex: number; total: number }>;
  text: string;
}>;

/** Header + window of a table part returned by `readMaterialChunk`. */
export type TableWindow = Readonly<{
  part: string;
  header: readonly string[];
  rowCount: number;
  rows: readonly { readonly index: number; readonly cells: readonly unknown[] }[];
  truncated: boolean;
  text: string;
  /**
   * The header and the window's cell values only: no title, count line or row index.
   * Built from the parsed cells, so a cell holding blank lines or lines shaped like the
   * rendered table cannot move the boundary between source data and display metadata.
   */
  factText: string;
}>;

export type MaterialCapabilityEntry = Readonly<{
  id: string;
  name?: string;
  kind: MaterialKind;
  summaryZh: string;
  needsVision: boolean;
  viewable: boolean;
  mediaSrc?: string;
  parts?: readonly Record<string, unknown>[];
}>;

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const sha256 = sha256Hex;

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asKind(value: unknown): MaterialKind {
  return value === "text" || value === "table" || value === "document" || value === "deck-template" || value === "image"
    ? value
    : "text";
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Read the project material manifest. A missing or malformed manifest is an empty list. */
export function readMaterialsManifest(projectRoot: string): readonly MaterialManifestEntry[] {
  const file = path.join(projectRoot, MATERIALS_MANIFEST_REL);
  const parsed = readJsonFile(file);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.materials)) return [];
  const out: MaterialManifestEntry[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.materials) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || seen.has(id) || !isSafeMaterialId(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof raw.name === "string" ? raw.name : id,
      kind: asKind(raw.kind),
      summaryZh: typeof raw.summaryZh === "string" ? raw.summaryZh : "",
      ...(typeof raw.mediaSrc === "string" && raw.mediaSrc ? { mediaSrc: raw.mediaSrc } : {}),
      needsVision: raw.needsVision === true,
      parser: typeof raw.parser === "string" ? raw.parser : "",
      sha256: typeof raw.sha256 === "string" ? raw.sha256 : "",
      parts: Array.isArray(raw.parts) ? raw.parts.filter(isRecord) : [],
      ...(Array.isArray(raw.media) ? { media: raw.media.filter(isRecord) } : {}),
      ...pageImagesFromManifest(raw.pageImages),
    });
  }
  return out;
}

function pageImagesFromManifest(value: unknown): Partial<Pick<MaterialManifestEntry, "pageImages">> {
  if (!isRecord(value) || !Array.isArray(value.pages)) return {};
  const pages = value.pages.filter((page): page is number => Number.isSafeInteger(page) && (page as number) >= 1);
  return pages.length ? { pageImages: { pages } } : {};
}

function materialDir(projectRoot: string, id: string): string {
  return path.join(projectRoot, "_agent", "materials", id);
}

const INVALID_ID = "资料参数无效：materialId 不是本项目的资料";

/** Sidecar store ids embed the file name (CJK, dots) — only path separators matter. */
function isSafeMaterialId(id: string): boolean {
  return id.length > 0 && id.length <= 300 && !/[\/\\\0]/.test(id) && !id.includes("..");
}

function readReceipt(dir: string): MaterialReceipt | undefined {
  const raw = readJsonFile(path.join(dir, "receipt.json"));
  if (!raw) return undefined;
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  const parser = typeof raw.parser === "string" ? raw.parser : "";
  const originalSha256 = raw.originalSha256;
  const derivativeSha256 = raw.derivativeSha256;
  if (!id || !name || !parser || !isHash(originalSha256) || !isHash(derivativeSha256)) {
    return undefined;
  }
  return {
    id,
    name,
    kind: asKind(raw.kind),
    parser,
    originalSha256,
    derivativeSha256,
    ...(isHash(raw.convertedSha256) ? { convertedSha256: raw.convertedSha256 } : {}),
    ...(Array.isArray(raw.media) ? { media: raw.media.filter(isRecord) } : {}),
    ...(typeof raw.mediaSrc === "string" && raw.mediaSrc ? { mediaSrc: raw.mediaSrc } : {}),
    ...(isHash(raw.normalizedSha256) ? { normalizedSha256: raw.normalizedSha256 } : {}),
    ...(isHash(raw.rasterSha256) ? { rasterSha256: raw.rasterSha256 } : {}),
    ...(isHash(raw.designSourceMdSha256) ? { designSourceMdSha256: raw.designSourceMdSha256 } : {}),
    ...(isHash(raw.designSourceJsonSha256) ? { designSourceJsonSha256: raw.designSourceJsonSha256 } : {}),
  };
}

function originalFileName(dir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  return entries.find((entry) => /^original\.[A-Za-z0-9]{1,10}$/.test(entry));
}

function convertedFileName(dir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  return entries.find((entry) => /^converted\.[A-Za-z0-9]{1,10}$/.test(entry));
}

function readFileBytes(file: string, maxBytes: number): Buffer | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return undefined;
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

/**
 * Load a material and re-verify every layer: manifest id → receipt →
 * derivative schema/self-declared hashes → original file bytes. Any
 * disagreement throws `MaterialPackError` with a Chinese re-upload reason.
 */
export function verifyMaterial(projectRoot: string, materialId: string): VerifiedMaterial {
  const id = typeof materialId === "string" ? materialId.trim() : "";
  if (!id || !isSafeMaterialId(id)) {
    throw new MaterialPackError(INVALID_ID);
  }
  const entry = readMaterialsManifest(projectRoot).find((item) => item.id === id);
  if (!entry) {
    throw new MaterialPackError(`资料不存在：${id}；请先用 list_materials 查看本次可用的资料`);
  }
  const dir = materialDir(projectRoot, id);
  const receipt = readReceipt(dir);
  if (!receipt || receipt.id !== id) {
    throw new MaterialPackError(`资料「${entry.name}」的回执无效，请重新上传后再发送`);
  }
  const derivativePath = path.join(dir, "derivative.json");
  const __split10946 = () => {
    try {
      const stat = fs.lstatSync(derivativePath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > MATERIAL_MAX_ORIGINAL_BYTES) {
        throw new MaterialPackError(`资料「${entry.name}」解析结果过大，无法作为设计源使用`);
      }
    } catch (error) {
      if (error instanceof MaterialPackError) throw error;
    }
  };
  __split10946();

  const derivativeBytes = readFileBytes(derivativePath, MATERIAL_MAX_ORIGINAL_BYTES);
  if (!derivativeBytes || sha256(derivativeBytes) !== receipt.derivativeSha256) {
    throw new MaterialPackError(`资料「${entry.name}」解析结果已变化，请重新上传后再发送`);
  }
  const derivative = (() => {
    try {
      const parsed = JSON.parse(derivativeBytes.toString("utf8")) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  })();
  if (!derivative) {
    throw new MaterialPackError(`资料「${entry.name}」解析凭据无效，请重新上传后再发送`);
  }
  const source = isRecord(derivative.source) ? derivative.source : undefined;
  const parser = isRecord(derivative.parser) ? derivative.parser : undefined;
  const __split11970 = () => {
    if (
      derivative.schema !== "material-derivative/v1" ||
      derivative.materialId !== id ||
      source?.sha256 !== receipt.originalSha256 ||
      parser?.id !== receipt.parser ||
      (derivative.status !== "ok" && derivative.status !== "partial")
    ) {
      throw new MaterialPackError(`资料「${entry.name}」解析凭据无效，请重新上传后再发送`);
    }
  };
  __split11970();

  const fileName = originalFileName(dir);
  if (!fileName) {
    throw new MaterialPackError(`资料「${entry.name}」原文件缺失，请重新上传后再发送`);
  }
  const originalBytes = readFileBytes(path.join(dir, fileName), MATERIAL_MAX_ORIGINAL_BYTES);
  if (!originalBytes || sha256(originalBytes) !== (receipt.rasterSha256 ?? receipt.originalSha256)) {
    throw new MaterialPackError(`资料「${entry.name}」原文件已变化，请重新上传后再发送`);
  }
  // A legacy conversion is one material stored as a pair: the converted
  // package must re-hash against the receipt and agree with the derivative's
  // own conversion receipt, and tampering either file fails the whole read.
  let convertedBytes: Buffer | undefined;
  const __split12987 = () => {
    if (receipt.convertedSha256) {
      const convertedName = convertedFileName(dir);
      const converted = convertedName
        ? readFileBytes(path.join(dir, convertedName), MATERIAL_MAX_ORIGINAL_BYTES)
        : undefined;
      if (!converted || sha256(converted) !== receipt.convertedSha256) {
        throw new MaterialPackError(`资料「${entry.name}」转换结果已变化，请重新上传后再发送`);
      }
      const conversion = isRecord(derivative.conversion) ? derivative.conversion : undefined;
      if (conversion?.convertedSha256 !== receipt.convertedSha256) {
        throw new MaterialPackError(`资料「${entry.name}」解析凭据无效，请重新上传后再发送`);
      }
      convertedBytes = converted;
    }
  };
  __split12987();

  return {
    id,
    name: entry.name,
    kind: entry.kind,
    summaryZh: entry.summaryZh,
    ...(entry.mediaSrc ? { mediaSrc: entry.mediaSrc } : {}),
    needsVision: entry.needsVision,
    parser: entry.parser,
    sha256: receipt.originalSha256,
    parts: entry.parts,
    directory: dir,
    receipt,
    derivative,
    originalBytes,
    originalExtension: fileName.slice("original".length),
    ...(convertedBytes ? { convertedBytes } : {}),
  };
}

/**
 * The OOXML package a template read should open: for a legacy upload the
 * derivative describes the converted package, so every package extraction
 * (logo, media, template photos, kit components) opens `convertedBytes`,
 * and only a plain upload falls back to the original.
 */
export function packageBytesOf(material: Pick<VerifiedMaterial, "originalBytes" | "convertedBytes">): Buffer {
  return material.convertedBytes ?? material.originalBytes;
}

/**
 * The project materials exposed through inspect_capabilities. `viewable`
 * means the selected model accepts image input (view_material would be
 * offered); it is independent of the page-raster runtime.
 */
export function materialCapabilityEntries(
  projectRoot: string,
  modelAcceptsImages: boolean,
): readonly MaterialCapabilityEntry[] {
  return readMaterialsManifest(projectRoot).map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    summaryZh: entry.summaryZh,
    needsVision: entry.needsVision,
    viewable:
      modelAcceptsImages &&
      (entry.kind === "image" ||
        entry.media?.some((item) => item.role === "template-photo") === true ||
        (entry.pageImages?.pages.length ?? 0) > 0),
    ...(entry.mediaSrc ? { mediaSrc: entry.mediaSrc } : {}),
    parts: entry.parts,
  }));
}

/** Template reads never fall back to sample-slide text, including old incomplete records. */
export function verifiedDesignSource(material: VerifiedMaterial): VerifiedDesignSource {
  const read = (name: string, expected: string | undefined): Buffer => {
    const bytes = readFileBytes(path.join(material.directory, name), MATERIAL_MAX_ORIGINAL_BYTES);
    if (!expected || !bytes || sha256(bytes) !== expected) {
      throw new MaterialPackError(`资料「${material.name}」设计源缺失或已变化，请重新上传后再发送`);
    }
    return bytes;
  };
  const jsonBytes = read("design-source.json", material.receipt.designSourceJsonSha256);
  let json: unknown;
  try {
    json = JSON.parse(jsonBytes.toString("utf8")) as unknown;
  } catch {
    throw new MaterialPackError(`资料「${material.name}」设计源 JSON 无法解析，请重新上传后再发送`);
  }
  if (!isRecord(json)) {
    throw new MaterialPackError(`资料「${material.name}」设计源 JSON 无效，请重新上传后再发送`);
  }
  // Project v1 receipts remain byte-identical; normalize only the read projection.
  if (!Array.isArray(json.logos) && isRecord(json.logo)) {
    const primary = { ...json.logo, primary: true };
    json = { ...json, logo: primary, logos: [primary] };
  }
  return {
    markdown: read("design-source.md", material.receipt.designSourceMdSha256).toString("utf8"),
    json: json as Record<string, unknown>,
  };
}

export function verifiedDesignSourceText(material: VerifiedMaterial): string {
  return verifiedDesignSource(material).markdown;
}

/**
 * The normalized JPEG the host streams to a vision model via
 * `ctx.attachments.saveImage`. Re-hashes against the receipt — a replaced or
 * tampered file fails closed.
 */
export function verifiedMaterialImage(
  projectRoot: string,
  materialId: string,
): { material: VerifiedMaterial; bytes: Buffer; sha256: string } {
  const material = verifyMaterial(projectRoot, materialId);
  if (material.kind !== "image") {
    throw new MaterialPackError(`资料「${material.name}」不是图片，无法查看画面内容`);
  }
  const file = path.join(material.directory, "normalized.jpg");
  const expected = material.receipt.normalizedSha256;
  if (!expected) {
    throw new MaterialPackError(`资料「${material.name}」缺少规范化图片副本，请重新上传后再发送`);
  }
  const bytes = readFileBytes(file, MATERIAL_MAX_ORIGINAL_BYTES);
  if (!bytes || sha256(bytes) !== expected) {
    throw new MaterialPackError(`资料「${material.name}」规范化图片已变化，请重新上传后再发送`);
  }
  return { material, bytes, sha256: expected };
}
