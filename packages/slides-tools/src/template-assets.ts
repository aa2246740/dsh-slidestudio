import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { MATERIAL_MAX_LOGO_BYTES, saveMediaFile } from "@open-slidestudio/presentation-run";
import { inputSha256 } from "./material-input.js";
import { MaterialVerificationError } from "./material-errors.js";

export type TemplateAsset = Readonly<{
  mediaId: string;
  role: "template-photo" | "template-logo";
  variant: "original" | "grayscale";
  file: string;
  sha256: string;
  bytes: Buffer;
  primary?: boolean;
}>;

export type TemplateMedia = Omit<TemplateAsset, "bytes"> & { mediaSrc: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

const mismatch = (): never => {
  throw new MaterialVerificationError("模板媒体缺失或校验失败，请重新上传后再发送");
};

function safeFile(value: unknown): string {
  if (typeof value !== "string" || !/^(ppt\/media|photos)\/[^/\\\0]+$/.test(value) || value.includes(".."))
    return mismatch();
  return value;
}

/** Extract only declared raster assets from the already hash-verified original. */
export function prepareTemplateAssets(derivative: Record<string, unknown>, original: Buffer): readonly TemplateAsset[] {
  const template = record(derivative["deck-template"]);
  const media = records(template.media);
  const logos = records(template.logos).filter((logo) =>
    media.some(
      (entry) =>
        entry.id === logo.mediaId &&
        typeof entry.sha256 === "string" &&
        typeof entry.bytes === "number" &&
        entry.bytes <= MATERIAL_MAX_LOGO_BYTES,
    ),
  );
  const photos = records(template.photos);
  if (!logos.length && !photos.length) return [];
  const requested = new Set([
    ...logos.map((logo) => safeFile(media.find((entry) => entry.id === logo.mediaId)?.part)),
    ...photos.map((photo) => safeFile(photo.file)),
  ]);
  let files: ReturnType<typeof unzipSync>;
  try {
    let total = 0;
    files = unzipSync(original, {
      filter(entry) {
        if (!requested.has(entry.name)) return false;
        total += entry.originalSize;
        if (entry.originalSize > MATERIAL_MAX_LOGO_BYTES || total > 200 * 1024 * 1024) mismatch();
        return true;
      },
    });
  } catch {
    return mismatch();
  }
  const assets: TemplateAsset[] = [];
  const add = (
    mediaId: unknown,
    role: TemplateAsset["role"],
    variant: TemplateAsset["variant"],
    file: string,
    bytes: Uint8Array | undefined,
    expected?: unknown,
    primary = false,
  ) => {
    if (typeof mediaId !== "string" || !mediaId || !bytes?.length || bytes.length > MATERIAL_MAX_LOGO_BYTES) mismatch();
    const data = Buffer.from(bytes!);
    const sha256 = inputSha256(data);
    if (expected !== undefined && expected !== sha256) mismatch();
    assets.push({
      mediaId: String(mediaId),
      role,
      variant,
      file,
      sha256,
      bytes: data,
      ...(primary ? { primary: true } : {}),
    });
  };
  for (const logo of logos) {
    const entry = media.find((entry) => entry.id === logo.mediaId)!;
    const file = safeFile(entry.part);
    add(logo.mediaId, "template-logo", "original", file, files[file], entry.sha256, logo.primary === true);
  }
  for (const photo of photos) {
    const file = safeFile(photo.file);
    add(photo.mediaId, "template-photo", "original", file, files[file]);
    if (photo.processed === undefined) continue;
    const processed = record(photo.processed);
    const processedFile = safeFile(processed.file);
    const asset = records(record(template.templateDetail).assets).find((entry) => entry.file === processedFile);
    if (
      asset?.encoding !== "base64" ||
      typeof asset.content !== "string" ||
      !/^[a-f0-9]{64}$/.test(String(processed.sha256)) ||
      JSON.stringify(processed.ops) !== '["grayscale"]'
    )
      mismatch();
    add(
      `${String(photo.mediaId)}:grayscale`,
      "template-photo",
      "grayscale",
      processedFile,
      Buffer.from(String(asset!.content), "base64"),
      processed.sha256,
    );
  }
  return assets;
}

/**
 * Project media names for template assets use this key, not the material id: the id ends with
 * the uploaded file name, and layouts reference these media paths. The key is a one-way digest,
 * stable for one upload, and carries no source text.
 */
export function templateMediaKey(materialId: string): string {
  return createHash("sha256").update(materialId).digest("hex").slice(0, 16);
}

export function writeTemplateAssets(
  directory: string,
  projectRoot: string,
  materialId: string,
  assets: readonly TemplateAsset[],
): readonly TemplateMedia[] {
  const key = templateMediaKey(materialId);
  return assets.map(({ bytes, ...asset }, index) => {
    if (inputSha256(bytes) !== asset.sha256) mismatch();
    const file = path.join(directory, safeFile(asset.file));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mediaId = asset.role === "template-logo" && asset.primary ? `brand-${key}-logo` : `template-${key}-${index}`;
    fs.writeFileSync(file, bytes);
    const saved = saveMediaFile(projectRoot, mediaId, bytes, path.extname(asset.file).slice(1), {
      preserveId: true,
    });
    return { ...asset, mediaSrc: saved.src };
  });
}
