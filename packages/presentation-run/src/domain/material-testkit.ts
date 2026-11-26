/**
 * Test-only builders for materialized project fixtures (`_agent/materials/<id>/`),
 * written the way `writeSessionMaterials` lays them out so the receipt-verifying
 * readers run against realistic directories.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const fixtureSha256 = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value).digest("hex");

export function tempProject(prefix = "oss-material-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, "_agent", "materials"), { recursive: true });
  return root;
}

export type MaterialFixture = {
  id: string;
  name: string;
  kind: "text" | "table" | "document" | "deck-template" | "image";
  parser: string;
  originalBytes: Buffer;
  derivative?: Record<string, unknown>;
  needsVision?: boolean;
  normalizedBytes?: Buffer;
  /** Project-relative media copy an image material is placed through (`media/…`). */
  mediaSrc?: string;
  pageImages?: { pages: number[] };
  /** Manifest part descriptors, as materialization writes them. */
  parts?: Record<string, unknown>[];
  /** Receipt/manifest media entries (template photos and logos). */
  media?: Record<string, unknown>[];
  /** Extra files below the material directory (page JPEGs, template photos). */
  files?: Record<string, Buffer>;
  /** Extra files below the project root (the `media/` copies of template photos). */
  projectFiles?: Record<string, Buffer>;
};

/** Write one materialized record and append it to the manifest in call order. */
export function writeMaterialFixture(projectRoot: string, options: MaterialFixture): void {
  const dir = path.join(projectRoot, "_agent", "materials", options.id);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(options.name).toLowerCase() || ".bin";
  fs.writeFileSync(path.join(dir, `original${ext}`), options.originalBytes);
  const derivative = {
    schema: "material-derivative/v1",
    materialId: options.id,
    kind: options.kind,
    source: {
      name: options.name,
      bytes: options.originalBytes.length,
      sha256: fixtureSha256(options.originalBytes),
      extension: ext,
    },
    parser: { id: options.parser, engine: "test" },
    status: "ok",
    truncated: { applied: false },
    warnings: [],
    summary: { zh: `${options.name} 摘要` },
    ...options.derivative,
  };
  const derivativeBytes = Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "derivative.json"), derivativeBytes);
  let normalizedSha256: string | undefined;
  if (options.normalizedBytes) {
    fs.writeFileSync(path.join(dir, "normalized.jpg"), options.normalizedBytes);
    normalizedSha256 = fixtureSha256(options.normalizedBytes);
  }
  for (const [relative, bytes] of Object.entries(options.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), bytes);
  }
  for (const [relative, bytes] of Object.entries(options.projectFiles ?? {})) {
    fs.mkdirSync(path.dirname(path.join(projectRoot, relative)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, relative), bytes);
  }
  const receipt = {
    version: 1,
    id: options.id,
    name: options.name,
    kind: options.kind,
    parser: options.parser,
    originalSha256: fixtureSha256(options.originalBytes),
    derivativeSha256: fixtureSha256(derivativeBytes),
    originalBytes: options.originalBytes.length,
    ...(normalizedSha256 ? { normalizedSha256 } : {}),
    ...(options.mediaSrc ? { mediaSrc: options.mediaSrc } : {}),
    ...(options.media ? { media: options.media } : {}),
    materializedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  const manifestFile = path.join(projectRoot, "_agent", "materials", "manifest.json");
  let materials: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      materials?: Record<string, unknown>[];
    };
    materials = parsed.materials ?? [];
  } catch {
    // first material
  }
  const entry = {
    id: options.id,
    name: options.name,
    kind: options.kind,
    summaryZh: `${options.name} 摘要`,
    ...(options.mediaSrc ? { mediaSrc: options.mediaSrc } : {}),
    needsVision: options.needsVision === true,
    parser: options.parser,
    sha256: fixtureSha256(options.originalBytes),
    parts: options.parts ?? [],
    ...(options.media ? { media: options.media } : {}),
    ...(options.pageImages ? { pageImages: options.pageImages } : {}),
  };
  const index = materials.findIndex((item) => item.id === options.id);
  if (index >= 0) materials[index] = entry;
  else materials.push(entry);
  fs.writeFileSync(manifestFile, `${JSON.stringify({ version: 1, materials }, null, 2)}\n`);
}

/** A fake JPEG: the readers under test only hash and copy these bytes. */
export function fakeJpeg(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed), Buffer.from([0xff, 0xd9])]);
}

/** A minimal valid PNG header (IHDR only) so size sniffing sees real dimensions. */
export function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

export function imageFixture(
  id: string,
  name: string,
  width: number,
  height: number,
  extra: Partial<MaterialFixture> = {},
): MaterialFixture {
  const normalized = fakeJpeg(id);
  return {
    id,
    name,
    kind: "image",
    parser: "image-sharp-v1",
    originalBytes: Buffer.from(`original-${id}`),
    needsVision: true,
    normalizedBytes: normalized,
    derivative: {
      image: {
        width,
        height,
        orientation: width === height ? "square" : width > height ? "landscape" : "portrait",
      },
    },
    ...extra,
  };
}
