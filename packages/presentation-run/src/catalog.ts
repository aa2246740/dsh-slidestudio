import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyOpenKimiPack, resolveOpenKimiPresetDesignSourceId } from "./domain/openkimi-source-pack.js";
import { resolveOpenKimiVisualRoot, verifyOpenKimiVisualPack } from "./domain/openkimi-visual-pack.js";

// Frozen reference-catalog size. Changing the vendored skill means changing this
// number on purpose: the desktop export scripts (export_pptx.py, export_images.py,
// export_host.html) were removed because this product owns the editor and export.
export const EXPECTED_SOURCE_FILES = 73;
export const EXPECTED_VISUAL_FILES = 44;

export type CatalogSource = {
  readonly sourceId: string;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly fileSha256: string;
  readonly family?: string;
  readonly kind: "source" | "visual";
  readonly designSystemId?: string;
  readonly chunks?: readonly { readonly chunkIndex: number }[];
};

export type ReferenceCatalog = {
  readonly sourceFiles: number;
  readonly visualFiles: number;
  readonly sources: readonly CatalogSource[];
  readonly visuals: readonly CatalogSource[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function resolveRepoRoot(start = process.cwd()): string {
  const envRoot = process.env.OPEN_SLIDESTUDIO_ROOT?.trim();
  const candidates = envRoot ? [envRoot] : [];
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i += 1) {
    candidates.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const marker = path.join("packages", "agent-harness", "reference", "openkimi-source-manifest.v1.json");
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, marker))) return path.resolve(candidate);
  }
  throw new Error(`Open SlideStudio repo root not found (looked for ${marker})`);
}

function sourceManifestPath(repoRoot: string): string {
  return path.join(repoRoot, "packages", "agent-harness", "reference", "openkimi-source-manifest.v1.json");
}

function visualManifestPath(repoRoot: string): string {
  return path.join(repoRoot, "packages", "agent-harness", "reference", "openkimi-visual-manifest.v1.json");
}

function familyOf(relativePath: string, designSystemId?: string): string | undefined {
  const fromId = designSystemId?.split("/")[0];
  if (fromId) return fromId;
  const parts = relativePath.split("/");
  if (parts[0] === "reference" && parts[1] === "design_system") return parts[2];
  if (parts[0] === "reference" && parts[1] === "slides_categories") return "categories";
  return undefined;
}

export function loadReferenceCatalog(repoRoot = resolveRepoRoot()): ReferenceCatalog {
  const sourceRaw = JSON.parse(fs.readFileSync(sourceManifestPath(repoRoot), "utf8")) as {
    files: Array<Record<string, unknown>>;
  };
  const visualRaw = JSON.parse(fs.readFileSync(visualManifestPath(repoRoot), "utf8")) as {
    files: Array<Record<string, unknown>>;
  };
  const sources: CatalogSource[] = sourceRaw.files.map((file) => {
    const relativePath = String(file.relativePath ?? "");
    const chunks = Array.isArray(file.chunks)
      ? file.chunks.map((chunk) => {
          const rec = asRecord(chunk);
          return { chunkIndex: Number(rec?.index ?? 0) };
        })
      : [];
    return {
      sourceId: String(file.sourceId ?? ""),
      relativePath,
      byteLength: Number(file.byteLength ?? 0),
      fileSha256: String(file.sha256 ?? ""),
      family: familyOf(relativePath),
      kind: "source" as const,
      chunks,
    };
  });
  const visuals: CatalogSource[] = visualRaw.files.map((file) => {
    const designSystemId = String(file.designSystemId ?? "");
    return {
      sourceId: String(file.sourceId ?? ""),
      relativePath: String(file.relativePath ?? ""),
      byteLength: Number(file.byteLength ?? 0),
      fileSha256: String(file.sha256 ?? ""),
      family: familyOf(String(file.relativePath ?? ""), designSystemId),
      kind: "visual" as const,
      designSystemId,
    };
  });
  if (sources.length !== EXPECTED_SOURCE_FILES) {
    throw new Error(`OpenKimi source catalog expected ${EXPECTED_SOURCE_FILES}, got ${sources.length}`);
  }
  if (visuals.length !== EXPECTED_VISUAL_FILES) {
    throw new Error(`OpenKimi visual catalog expected ${EXPECTED_VISUAL_FILES}, got ${visuals.length}`);
  }
  return {
    sourceFiles: sources.length,
    visualFiles: visuals.length,
    sources,
    visuals,
  };
}

export function filterCatalog(
  catalog: ReferenceCatalog,
  query: { family?: string; kind?: "source" | "visual"; tag?: string } = {},
): ReferenceCatalog {
  const family = query.family?.trim().toLowerCase();
  const tag = query.tag?.trim().toLowerCase();
  const match = (row: CatalogSource) => {
    if (query.kind && row.kind !== query.kind) return false;
    if (family && (row.family ?? "").toLowerCase() !== family) return false;
    if (tag) {
      const hay = `${row.sourceId} ${row.relativePath} ${row.designSystemId ?? ""}`.toLowerCase();
      if (!hay.includes(tag)) return false;
    }
    return true;
  };
  const sources = query.kind === "visual" ? [] : catalog.sources.filter(match);
  const visuals = query.kind === "source" ? [] : catalog.visuals.filter(match);
  return {
    sourceFiles: sources.length,
    visualFiles: visuals.length,
    sources,
    visuals,
  };
}

export type CatalogFormat = {
  readonly kind: "Slides";
  readonly layout: "16:9" | "4:3";
};

export type CatalogPreview = {
  readonly sourceId: string;
  readonly hash: string;
  readonly url: string;
  readonly order: number;
};

export type CatalogStyle = {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly designSourceId: string;
  readonly designHash: string;
  readonly previews: readonly CatalogPreview[];
};

export type CatalogDto = {
  readonly version: 1;
  readonly hash: string;
  readonly formats: readonly CatalogFormat[];
  readonly styles: readonly CatalogStyle[];
};

export function buildCatalogDto(repoRoot = resolveRepoRoot()): CatalogDto {
  const sourcePack = verifyOpenKimiPack(repoRoot);
  const visualPack = verifyOpenKimiVisualPack(repoRoot);
  const formats: readonly CatalogFormat[] = [
    { kind: "Slides", layout: "16:9" },
    { kind: "Slides", layout: "4:3" },
  ];
  const styles: CatalogStyle[] = visualPack.manifest.files.map((visual) => {
    const id = visual.designSystemId;
    const designSourceId = resolveOpenKimiPresetDesignSourceId(sourcePack, id);
    const source = sourcePack.entriesById.get(designSourceId);
    if (!source) throw new Error(`missing exact design source for ${id}`);
    return {
      id,
      label: id,
      category: id.split("/")[0]!,
      designSourceId,
      designHash: source.sha256,
      previews: [
        {
          sourceId: visual.sourceId,
          hash: visual.sha256,
          url: `/slides/catalog/previews/${encodeURIComponent(visual.sourceId)}`,
          order: 0,
        },
      ],
    };
  });

  styles.sort((a, b) => a.id.localeCompare(b.id));

  const canonicalPayload = JSON.stringify({ version: 1, formats, styles });
  const hash = crypto.createHash("sha256").update(canonicalPayload).digest("hex");

  return {
    version: 1,
    hash,
    formats,
    styles,
  };
}

export function resolveCatalogPreviewFile(
  sourceId: string,
  repoRoot = resolveRepoRoot(),
): {
  filePath: string;
  bytes: Buffer;
  mediaType: string;
  byteLength: number;
  sha256: string;
} | null {
  const visualRaw = JSON.parse(fs.readFileSync(visualManifestPath(repoRoot), "utf8")) as {
    files: Array<{
      sourceId: string;
      relativePath: string;
      byteLength: number;
      sha256: string;
      mediaType: string;
    }>;
  };
  const matches = visualRaw.files.filter((file) => file.sourceId === sourceId);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error("ambiguous catalog preview source");
  const entry = matches[0]!;
  const root = resolveOpenKimiVisualRoot(repoRoot);
  const filePath = path.resolve(root, entry.relativePath);
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("preview path is outside the visual pack");
  const stat = fs.lstatSync(filePath);
  const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(filePath));
  if (!stat.isFile() || stat.isSymbolicLink() || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("preview must be a regular file in the visual pack");
  }
  const bytes = fs.readFileSync(filePath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== entry.sha256 || bytes.length !== entry.byteLength || entry.mediaType !== "image/jpeg") {
    throw new Error("catalog preview no longer matches its manifest");
  }
  return { filePath, bytes, mediaType: entry.mediaType, byteLength: bytes.length, sha256 };
}
