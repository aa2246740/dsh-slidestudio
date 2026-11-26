import fs from "node:fs";
import path from "node:path";
import {
  MATERIAL_MAX_LOGO_BYTES,
  MATERIAL_MAX_ORIGINAL_BYTES,
  saveMediaFile,
  templateMaterialPartDescriptorsFromData,
} from "@open-slidestudio/presentation-run";
import { inputSha256, type EditorAttachment } from "./material-input.js";
import { materialPartsFor } from "./material-parts.js";
import { selectLogoCandidate, writeTemplateDesignSource } from "./template-design-source.js";
import { MaterialVerificationError } from "./material-errors.js";
export { materialPartsFor } from "./material-parts.js";
import { convertedTargetExtension, verifiedConvertedPackage, writeConvertedPackage } from "./material-converted.js";
import { verifiedRenderedPages, writeRenderedPages, type RenderedPageBytes } from "./material-pages.js";
import { prepareTemplateAssets, writeTemplateAssets, type TemplateAsset } from "./template-assets.js";
export { MaterialVerificationError } from "./material-errors.js";
export { renderedPageStoreFile, type RenderedPageBytes } from "./material-pages.js";

const DERIVATIVE_SCHEMA = "material-derivative/v1";

const fail = (message: string): never => {
  throw new MaterialVerificationError(message);
};

/**
 * The upload store shared with the sidecar: originals, derivatives and
 * receipts under `output/attachments/`. The host reads them straight from
 * disk after the owner-checked API read authorized the ids.
 */
export function attachmentsStoreDir(dataRootOrWorkspace: string): string {
  return path.resolve(dataRootOrWorkspace, "output", "attachments");
}

/** A store record whose bytes and receipts have all re-verified on disk. */
export type PreparedMaterial = Readonly<{
  attachment: EditorAttachment;
  originalBytes: Buffer;
  /** The verified OOXML package a legacy conversion produced; absent for plain uploads. */
  convertedBytes?: Buffer;
  derivativeBytes: Buffer;
  derivative: Record<string, unknown>;
  meta: Record<string, unknown>;
  logoBytes?: Buffer;
  /** An SVG or AVIF upload's converted raster: it is what the project receives, never the upload itself. */
  raster?: VerifiedRaster;
  templateAssets?: readonly TemplateAsset[];
  /** PDF page JPEGs whose bytes match their derivative descriptor (see `verifiedRenderedPages`). */
  renderedPages?: readonly RenderedPageBytes[];
}>;

function storePaths(dir: string, id: string) {
  return {
    original: path.join(dir, id),
    derivative: path.join(dir, `${id}.derivative.json`),
    logo: path.join(dir, `${id}.logo`),
    converted: path.join(dir, `${id}.converted`),
    metadata: path.join(dir, `${id}.meta.json`),
  };
}

function readStoreFile(
  dir: string,
  file: string,
  name: string,
  tooLarge?: string,
  maxBytes = MATERIAL_MAX_ORIGINAL_BYTES,
): Buffer {
  const resolved = path.resolve(file);
  const root = path.resolve(dir);
  if (!resolved.startsWith(root + path.sep)) {
    fail(`资料「${name}」超出上传存储边界，请重新上传后再发送`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    return fail(`资料「${name}」在上传库中不完整或已被删除，请重新上传后再发送`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`资料「${name}」在上传库中不完整或已被删除，请重新上传后再发送`);
  }
  if (stat.size > maxBytes) {
    fail(tooLarge ?? `资料「${name}」超过可读取上限，请重新上传后再发送`);
  }
  return fs.readFileSync(resolved);
}

/** Parsers whose upload never reaches a project: a PNG or JPEG converted at intake stands in for it. */
const RASTER_PARSER_IDS: ReadonlySet<string> = new Set(["svg-raster-v1", "avif-raster-v1"]);

type VerifiedRaster = Readonly<{ bytes: Buffer; extension: ".png" | ".jpg" }>;

const RASTER_EXTENSIONS: Readonly<Record<string, VerifiedRaster["extension"]>> = {
  png: ".png",
  jpeg: ".jpg",
};

/**
 * The raster an SVG or AVIF upload was converted to, re-hashed against the derivative. A record
 * without a verifiable raster fails closed instead of falling back to the upload.
 */
function verifiedRaster(derivative: Record<string, unknown>, name: string): VerifiedRaster {
  const image = derivative.image as Record<string, unknown> | undefined;
  const raster = image?.raster as Record<string, unknown> | undefined;
  const extension = typeof raster?.format === "string" ? RASTER_EXTENSIONS[raster.format] : undefined;
  if (extension && typeof raster?.data === "string" && raster.data) {
    const bytes = Buffer.from(raster.data, "base64");
    if (inputSha256(bytes) === raster.sha256) return { bytes, extension };
  }
  return fail(`资料「${name}」转换后的图片副本缺失或校验失败，请重新上传后再发送`);
}

const LOGO_MISMATCH = "模板 Logo 字节缺失或校验失败，请重新上传后再发送";
const LOGO_TOO_LARGE = "模板 Logo 超过可读取上限，请重新上传后再发送";

function verifiedLogoBytes(
  attachmentsDir: string,
  logoPath: string,
  name: string,
  derivative: Record<string, unknown>,
): Buffer | undefined {
  const deck = derivative["deck-template"];
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) return undefined;
  const selected = selectLogoCandidate(deck as Record<string, unknown>);
  if (selected.status === "absent") return undefined;
  if (selected.status !== "ready") {
    throw new MaterialVerificationError(`资料「${name}」的${LOGO_MISMATCH}`);
  }
  if (!fs.existsSync(logoPath)) {
    throw new MaterialVerificationError(`资料「${name}」的${LOGO_MISMATCH}`);
  }
  const candidate = selected.candidate;
  const bytes = readStoreFile(
    attachmentsDir,
    logoPath,
    name,
    `资料「${name}」的${LOGO_TOO_LARGE}`,
    MATERIAL_MAX_LOGO_BYTES,
  );
  if (bytes.length !== candidate.bytes || inputSha256(bytes) !== candidate.sha256) {
    fail(`资料「${name}」的${LOGO_MISMATCH}`);
  }
  return bytes;
}

type StorePaths = ReturnType<typeof storePaths>;

/** The store meta and original bytes must match the resolved receipt exactly. */
function verifiedStoreRecord(
  attachmentsDir: string,
  attachment: EditorAttachment,
  files: StorePaths,
  principal?: string,
): { meta: Record<string, unknown>; originalBytes: Buffer } {
  const name = attachment.name;
  if (!fs.existsSync(files.metadata)) {
    fail(`资料「${name}」在上传库中不存在或已被删除，请重新上传后再发送`);
  }
  const meta = JSON.parse(readStoreFile(attachmentsDir, files.metadata, name).toString("utf8")) as Record<
    string,
    unknown
  >;
  if (meta.id !== attachment.id || meta.storeId !== attachment.storeId) {
    fail(`资料「${name}」不属于当前附件库，请重新上传后再发送`);
  }
  if (principal && meta.ownerId !== principal) fail(`资料「${name}」的归属信息已变化，请重新上传后再发送`);
  if (meta.originalSha256 !== attachment.originalSha256 || meta.derivativeSha256 !== attachment.derivativeSha256) {
    fail(`资料「${name}」的校验信息已变化，请重新上传后再发送`);
  }
  const originalBytes = readStoreFile(attachmentsDir, files.original, name);
  if (originalBytes.length !== meta.size || inputSha256(originalBytes) !== attachment.originalSha256) {
    fail(`资料「${name}」原文件已变化，请重新上传后再发送`);
  }
  return { meta, originalBytes };
}

/** The derivative must re-hash and carry a receipt that names this material and parser. */
function verifiedDerivative(
  attachmentsDir: string,
  attachment: EditorAttachment,
  files: StorePaths,
): { derivativeBytes: Buffer; derivative: Record<string, unknown> } {
  const name = attachment.name;
  const derivativeBytes = readStoreFile(
    attachmentsDir,
    files.derivative,
    name,
    `资料「${name}」解析结果过大，无法作为设计源使用`,
  );
  if (inputSha256(derivativeBytes) !== attachment.derivativeSha256) {
    fail(`资料「${name}」解析结果已变化，请重新上传后再发送`);
  }
  let derivative: Record<string, unknown>;
  try {
    derivative = JSON.parse(derivativeBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    return fail(`资料「${name}」解析凭据无效，请重新上传后再发送`);
  }
  const source = derivative.source as Record<string, unknown> | undefined;
  const parser = derivative.parser as Record<string, unknown> | undefined;
  const statusOk = derivative.status === "ok" || derivative.status === "partial";
  if (
    derivative.schema !== DERIVATIVE_SCHEMA ||
    derivative.materialId !== attachment.id ||
    source?.sha256 !== attachment.originalSha256 ||
    parser?.id !== attachment.parser ||
    !statusOk
  ) {
    fail(`资料「${name}」解析凭据无效，请重新上传后再发送`);
  }
  return { derivativeBytes, derivative };
}

/**
 * Re-verify every receipt on disk before anything is written into a project:
 * the store meta must match the resolved record, and both file hashes must
 * match the receipt. A tampered original or derivative fails the whole set
 * with a Chinese re-upload reason, so nothing is partially materialized.
 */
export function prepareSessionMaterials(
  attachmentsDir: string,
  attachments: readonly EditorAttachment[],
  principal?: string,
): PreparedMaterial[] {
  return attachments.map((attachment) => {
    const id = attachment.id;
    const name = attachment.name;
    const files = storePaths(attachmentsDir, id);
    const { meta, originalBytes } = verifiedStoreRecord(attachmentsDir, attachment, files, principal);
    const { derivativeBytes, derivative } = verifiedDerivative(attachmentsDir, attachment, files);
    const parser = derivative.parser as Record<string, unknown> | undefined;
    // A legacy conversion is verified as one pair before anything is extracted:
    // the converted package must re-hash against the derivative's conversion
    // receipt, and tampering either file fails the whole record.
    const convertedBytes = verifiedConvertedPackage({
      file: files.converted,
      name,
      meta,
      derivative,
      read: (file) => readStoreFile(attachmentsDir, file, name),
    });
    const logoBytes = verifiedLogoBytes(attachmentsDir, files.logo, name, derivative);
    const raster =
      attachment.kind === "image" && RASTER_PARSER_IDS.has(String(parser?.id))
        ? verifiedRaster(derivative, name)
        : undefined;
    // Media, logos and template photos live in the package the derivative
    // describes: the converted one for a legacy upload, otherwise the upload.
    const templateAssets =
      attachment.kind === "deck-template" ? prepareTemplateAssets(derivative, convertedBytes ?? originalBytes) : [];
    const renderedPages =
      attachment.kind === "document"
        ? verifiedRenderedPages(attachmentsDir, id, derivative, (file) => readStoreFile(attachmentsDir, file, name))
        : [];
    return {
      attachment,
      originalBytes,
      derivativeBytes,
      derivative,
      meta,
      ...(convertedBytes ? { convertedBytes } : {}),
      ...(logoBytes ? { logoBytes } : {}),
      ...(raster ? { raster } : {}),
      ...(templateAssets.length ? { templateAssets } : {}),
      ...(renderedPages.length ? { renderedPages } : {}),
    };
  });
}

function materialExtension(prepared: PreparedMaterial): string {
  const source = prepared.derivative.source as Record<string, unknown> | undefined;
  const fromDerivative = typeof source?.extension === "string" ? source.extension.toLowerCase() : "";
  const fromName = path.extname(prepared.attachment.name).toLowerCase();
  const candidate = fromDerivative || fromName;
  return /^\.[a-z0-9]{1,10}$/.test(candidate) ? candidate : ".bin";
}

export type MaterialsManifest = Readonly<{
  version: 1;
  materials: readonly Record<string, unknown>[];
}>;

export function readMaterialsManifest(projectRoot: string): MaterialsManifest {
  const file = path.join(projectRoot, "_agent", "materials", "manifest.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const materials = Array.isArray(parsed.materials) ? parsed.materials : [];
    return { version: 1, materials };
  } catch {
    return { version: 1, materials: [] };
  }
}

/**
 * Copy verified store records into the project's `_agent/materials/<id>/`
 * with originals, derivatives, receipts and (for images) a media/ copy plus
 * the normalized JPEG for vision. Merges entries into the project manifest,
 * replacing an existing entry for the same id (turn re-materialization).
 */
/** Write the image's project media copy and its verified normalized JPEG. */
type ImageMedia = { readonly mediaSrc?: string; readonly normalizedSha256?: string };

function writeImageMedia(
  projectRoot: string,
  dir: string,
  item: PreparedMaterial,
  projectBytes: Buffer,
  ext: string,
): ImageMedia {
  const saved = saveMediaFile(
    projectRoot,
    `material-${item.attachment.id.slice(0, 8)}`,
    projectBytes,
    ext.replace(/^\./, "") || "png",
  );
  const image = item.derivative.image as Record<string, unknown> | undefined;
  const normalized = image?.normalized as Record<string, unknown> | undefined;
  if (typeof normalized?.data !== "string" || !normalized.data) return { mediaSrc: saved.src };
  const normalizedBytes = Buffer.from(normalized.data, "base64");
  const hash = inputSha256(normalizedBytes);
  if (normalized.sha256 !== hash) return { mediaSrc: saved.src };
  fs.writeFileSync(path.join(dir, "normalized.jpg"), normalizedBytes);
  return { mediaSrc: saved.src, normalizedSha256: hash };
}

function templatePartsFrom(dir: string, item: PreparedMaterial) {
  return templateMaterialPartDescriptorsFromData({
    name: item.attachment.name,
    derivative: item.derivative,
    designSourceMarkdown: fs.readFileSync(path.join(dir, "design-source.md"), "utf8"),
    designSourceJson: JSON.parse(fs.readFileSync(path.join(dir, "design-source.json"), "utf8")) as Record<
      string,
      unknown
    >,
  });
}

function materialReceipt(
  item: PreparedMaterial,
  image: ImageMedia,
  media: readonly unknown[],
  designHashes: Record<string, unknown>,
): Record<string, unknown> {
  const { attachment, meta } = item;
  return {
    version: 1,
    id: attachment.id,
    name: attachment.name,
    kind: attachment.kind,
    parser: attachment.parser,
    ownerId: typeof meta.ownerId === "string" ? meta.ownerId : undefined,
    originalSha256: attachment.originalSha256,
    derivativeSha256: attachment.derivativeSha256,
    originalBytes: item.originalBytes.length,
    ...(item.convertedBytes ? { convertedSha256: inputSha256(item.convertedBytes) } : {}),
    ...(item.raster ? { rasterSha256: inputSha256(item.raster.bytes) } : {}),
    ...(image.mediaSrc ? { mediaSrc: image.mediaSrc } : {}),
    ...(image.normalizedSha256 ? { normalizedSha256: image.normalizedSha256 } : {}),
    ...(media.length ? { media } : {}),
    ...designHashes,
    materializedAt: new Date().toISOString(),
  };
}

/** Write the project's original (or converted raster), derivative and converted package. */
function writeMaterialFiles(dir: string, item: PreparedMaterial): { projectBytes: Buffer; ext: string } {
  fs.mkdirSync(dir, { recursive: true });
  // What the project holds as the "original": for an SVG or AVIF, only its converted raster.
  const projectBytes = item.raster?.bytes ?? item.originalBytes;
  const ext = item.raster?.extension ?? materialExtension(item);
  fs.writeFileSync(path.join(dir, `original${ext}`), projectBytes);
  fs.writeFileSync(path.join(dir, "derivative.json"), item.derivativeBytes);
  // A legacy upload keeps its converted OOXML package beside the original:
  // the pair is one material and every later read re-verifies both hashes.
  if (item.convertedBytes) {
    writeConvertedPackage(dir, item.convertedBytes, convertedTargetExtension(item.derivative) ?? "");
  }
  return { projectBytes, ext };
}

/** A document's rendered page images, written beside it and listed in the manifest. */
function documentPageImages(dir: string, item: PreparedMaterial): { pages: number[] } | undefined {
  if (item.attachment.kind !== "document") return undefined;
  const pages = item.renderedPages ?? [];
  writeRenderedPages(dir, pages);
  return pages.length ? { pages: pages.map((page) => page.index).sort((a, b) => a - b) } : undefined;
}

type MaterializedOne = { readonly entry: Record<string, unknown>; readonly attachment: EditorAttachment };

function materializeOne(projectRoot: string, materialsRoot: string, item: PreparedMaterial): MaterializedOne {
  const { attachment, derivative, logoBytes } = item;
  const dir = path.join(materialsRoot, attachment.id);
  const { projectBytes, ext } = writeMaterialFiles(dir, item);
  const imageMedia: ImageMedia =
    attachment.kind === "image" ? writeImageMedia(projectRoot, dir, item, projectBytes, ext) : {};
  const pageImages = documentPageImages(dir, item);
  const media = writeTemplateAssets(dir, projectRoot, attachment.id, item.templateAssets ?? []);
  const designSource =
    attachment.kind === "deck-template"
      ? writeTemplateDesignSource(dir, derivative, projectRoot, attachment.id, logoBytes, media)
      : undefined;
  const parts = materialPartsFor(item, designSource ? templatePartsFrom(dir, item) : undefined);
  const designHashes = designSource ?? {};
  const mediaSrc = designSource?.mediaSrc ?? imageMedia.mediaSrc;
  const receipt = materialReceipt(
    item,
    { mediaSrc, normalizedSha256: imageMedia.normalizedSha256 },
    media,
    designHashes,
  );
  fs.writeFileSync(path.join(dir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  const entry = {
    id: attachment.id,
    name: attachment.name,
    kind: attachment.kind,
    summaryZh: attachment.summaryZh,
    ...(mediaSrc ? { mediaSrc } : {}),
    needsVision: attachment.needsVision || media.some((row) => row.role === "template-photo"),
    parser: attachment.parser,
    sha256: attachment.originalSha256,
    parts,
    ...(media.length ? { media } : {}),
    ...(pageImages ? { pageImages } : {}),
  };
  return { entry, attachment: { ...attachment, ...designHashes, ...(mediaSrc ? { mediaSrc } : {}), parts } };
}

export function writeSessionMaterials(
  projectRoot: string,
  prepared: readonly PreparedMaterial[],
): readonly EditorAttachment[] {
  const materialsRoot = path.join(projectRoot, "_agent", "materials");
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of readMaterialsManifest(projectRoot).materials) {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const materialized: EditorAttachment[] = [];
  for (const item of prepared) {
    const one = materializeOne(projectRoot, materialsRoot, item);
    byId.set(item.attachment.id, one.entry);
    materialized.push(one.attachment);
  }
  if (prepared.length) {
    fs.mkdirSync(materialsRoot, { recursive: true });
    const manifest = { version: 1, materials: [...byId.values()] };
    fs.writeFileSync(path.join(materialsRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return materialized;
}

/**
 * Verify the selected store records against their on-disk receipts.
 * `dataRootOrWorkspace` is the directory that owns `output/attachments/`;
 * `principal` re-checks the receipt owner.
 */
export function verifySessionMaterials(
  dataRootOrWorkspace: string,
  attachments: readonly EditorAttachment[],
  principal?: string,
): PreparedMaterial[] {
  return prepareSessionMaterials(attachmentsStoreDir(dataRootOrWorkspace), attachments, principal);
}

/**
 * Verify the selected store records and copy them into a project in one
 * step. `dataRootOrWorkspace` is the directory that owns
 * `output/attachments/`; `principal` re-checks the receipt owner.
 */
export function materializeSessionAttachments(
  projectRoot: string,
  dataRootOrWorkspace: string,
  attachments: readonly EditorAttachment[],
  principal?: string,
): readonly EditorAttachment[] {
  if (!attachments.length) return attachments;
  return writeSessionMaterials(
    projectRoot,
    prepareSessionMaterials(attachmentsStoreDir(dataRootOrWorkspace), attachments, principal),
  );
}
