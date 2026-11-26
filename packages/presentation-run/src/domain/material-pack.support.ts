import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const sha256 = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");

export function writeMaterial(
  projectRoot: string,
  options: {
    id: string;
    name: string;
    kind: "text" | "table" | "document" | "deck-template" | "image";
    parser: string;
    originalBytes: Buffer;
    derivative: Record<string, unknown>;
    summaryZh?: string;
    needsVision?: boolean;
    mediaSrc?: string;
    parts?: Record<string, unknown>[];
    normalizedBytes?: Buffer;
    pageImages?: { pages: number[] };
    /** The converted OOXML package of a legacy upload (M8) and its target extension. */
    convertedBytes?: Buffer;
    convertedTo?: string;
  },
): { derivativeBytes: Buffer; receipt: Record<string, unknown> } {
  const dir = path.join(projectRoot, "_agent", "materials", options.id);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(options.name).toLowerCase() || ".bin";
  fs.writeFileSync(path.join(dir, `original${ext}`), options.originalBytes);
  if (options.convertedBytes) {
    fs.writeFileSync(path.join(dir, `converted${options.convertedTo ?? ".pptx"}`), options.convertedBytes);
  }
  const derivative = {
    schema: "material-derivative/v1",
    materialId: options.id,
    kind: options.kind,
    source: {
      name: options.name,
      bytes: options.originalBytes.length,
      sha256: sha256(options.originalBytes),
      extension: ext,
    },
    parser: { id: options.parser, engine: "test" },
    status: "ok",
    truncated: { applied: false },
    warnings: [],
    summary: { zh: options.summaryZh ?? `${options.name} 摘要` },
    ...options.derivative,
  };
  const derivativeBytes = Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "derivative.json"), derivativeBytes);
  let normalizedSha256: string | undefined;
  if (options.normalizedBytes) {
    fs.writeFileSync(path.join(dir, "normalized.jpg"), options.normalizedBytes);
    normalizedSha256 = sha256(options.normalizedBytes);
  }
  const receipt = {
    version: 1,
    id: options.id,
    name: options.name,
    kind: options.kind,
    parser: options.parser,
    originalSha256: sha256(options.originalBytes),
    derivativeSha256: sha256(derivativeBytes),
    originalBytes: options.originalBytes.length,
    ...(options.convertedBytes ? { convertedSha256: sha256(options.convertedBytes) } : {}),
    ...(options.mediaSrc ? { mediaSrc: options.mediaSrc } : {}),
    ...(normalizedSha256 ? { normalizedSha256 } : {}),
    materializedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  // Merge-write like writeSessionMaterials: replace-by-id, keep other entries.
  const manifestFile = path.join(projectRoot, "_agent", "materials", "manifest.json");
  const existing = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
        materials?: unknown[];
      };
      return Array.isArray(parsed.materials) ? parsed.materials : [];
    } catch {
      return [];
    }
  })();
  const entry = {
    id: options.id,
    name: options.name,
    kind: options.kind,
    summaryZh: options.summaryZh ?? `${options.name} 摘要`,
    ...(options.mediaSrc ? { mediaSrc: options.mediaSrc } : {}),
    needsVision: options.needsVision === true,
    parser: options.parser,
    sha256: sha256(options.originalBytes),
    parts: options.parts ?? [],
    ...(options.pageImages ? { pageImages: options.pageImages } : {}),
  };
  const manifest = {
    version: 1,
    materials: [
      ...existing.filter(
        (item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).id !== options.id,
      ),
      entry,
    ],
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { derivativeBytes, receipt };
}

export function csvMaterial(
  id: string,
  name: string,
  rowCount: number,
): {
  originalBytes: Buffer;
  derivative: Record<string, unknown>;
} {
  const lines = ["序号,地区,金额"];
  const fixed = new Map<number, string>([
    [1, "1,华东,1203.17"],
    [2, "2,华南,987.42"],
    [12345, "12345,华东,98765.43"],
  ]);
  for (let i = 1; i <= rowCount; i += 1) {
    lines.push(fixed.get(i) ?? `${i},地区${i % 10},${(i * 7.13).toFixed(2)}`);
  }
  const text = lines.join("\n");
  const originalBytes = Buffer.from(text, "utf8");
  const preview = lines.slice(1, 201).map((line) => line.split(","));
  return {
    originalBytes,
    derivative: {
      table: {
        encoding: "UTF-8",
        delimiter: ",",
        rowCount,
        colCount: 3,
        chars: Array.from(text).length,
        headerRow: ["序号", "地区", "金额"],
        columns: [
          { header: "序号", inferredType: "number" },
          { header: "地区", inferredType: "text" },
          { header: "金额", inferredType: "number" },
        ],
        rows: preview,
      },
    },
  };
}

export function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oss-material-pack-"));
}
