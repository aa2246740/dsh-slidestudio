/**
 * Pure-JS `material-derivative/v1` builders for the formats `import_material`
 * accepts: UTF-8 text (`.txt`, `.md`, `.json`), delimited tables (`.csv`,
 * `.tsv`) and PNG/JPEG images. The output is a slides-tools `PreparedMaterial`,
 * so `writeSessionMaterials` lays it out exactly like an editor upload and the
 * presentation-run readers (`verifyMaterial`, `read_material`, `view_material`)
 * re-verify it unchanged. No image codec is loaded: an image's normalized copy
 * is the verified original bytes.
 */
import crypto from "node:crypto";
import path from "node:path";
import { MATERIAL_MAX_ORIGINAL_BYTES, parseDelimitedText } from "@open-slidestudio/presentation-run";
import type { PreparedMaterial } from "@open-slidestudio/slides-tools";

const DERIVATIVE_SCHEMA = "material-derivative/v1";
const TABLE_PREVIEW_ROWS = 200;
/** An image's derivative embeds its normalized copy as base64; keep the JSON under the read cap. */
export const MCP_IMAGE_MAX_BYTES = Math.floor(MATERIAL_MAX_ORIGINAL_BYTES * 0.7);

type Format =
  | { readonly kind: "text"; readonly parser: string; readonly json?: boolean }
  | { readonly kind: "table"; readonly parser: "csv-v1"; readonly delimiter: string }
  | { readonly kind: "image"; readonly parser: string; readonly format: "png" | "jpeg" };

export const IMPORT_FORMATS: Readonly<Record<string, Format>> = {
  ".txt": { kind: "text", parser: "mcp-text-utf8-v1" },
  ".md": { kind: "text", parser: "mcp-text-utf8-v1" },
  ".json": { kind: "text", parser: "mcp-json-utf8-v1", json: true },
  ".csv": { kind: "table", parser: "csv-v1", delimiter: "," },
  ".tsv": { kind: "table", parser: "csv-v1", delimiter: "\t" },
  ".png": { kind: "image", parser: "mcp-image-v1", format: "png" },
  ".jpg": { kind: "image", parser: "mcp-image-v1", format: "jpeg" },
  ".jpeg": { kind: "image", parser: "mcp-image-v1", format: "jpeg" },
};

export class MaterialFormatError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MaterialFormatError";
    this.code = code;
  }
}

const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");

function decodeUtf8(bytes: Buffer): { text: string; bom: boolean } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes), bom };
  } catch {
    throw new MaterialFormatError("invalid_utf8", "the file is not valid UTF-8 text");
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = bytes.readUInt16BE(offset + 2);
    if (isSofMarker(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function orientation(width: number, height: number): string {
  return width === height ? "square" : width > height ? "landscape" : "portrait";
}

type Body = { readonly derivative: Record<string, unknown>; readonly summaryZh: string; readonly chars?: number };

function textBody(bytes: Buffer, format: Extract<Format, { kind: "text" }>): Body {
  const { text } = decodeUtf8(bytes);
  if (format.json) {
    try {
      JSON.parse(text);
    } catch {
      throw new MaterialFormatError("invalid_json", "the .json file does not parse as JSON");
    }
  }
  const chars = Array.from(text).length;
  return { derivative: { text: { text, chars } }, summaryZh: `文本资料，${chars} 字`, chars };
}

function tableBody(bytes: Buffer, format: Extract<Format, { kind: "table" }>): Body {
  const { text, bom } = decodeUtf8(bytes);
  const rows = parseDelimitedText(text, format.delimiter);
  while (rows.length && rows[rows.length - 1]?.every((cell) => cell === "")) rows.pop();
  if (!rows.length) throw new MaterialFormatError("empty_table", "the table has no header row");
  const headerRow = rows[0] ?? [];
  const dataRows = rows.slice(1);
  const colCount = Math.max(headerRow.length, ...dataRows.map((row) => row.length));
  return {
    derivative: {
      table: {
        encoding: bom ? "UTF-8 BOM" : "UTF-8",
        delimiter: format.delimiter,
        headerRow,
        rowCount: dataRows.length,
        colCount,
        rows: dataRows.slice(0, TABLE_PREVIEW_ROWS),
      },
    },
    summaryZh: `表格资料，${dataRows.length} 行 × ${colCount} 列`,
  };
}

function imageBody(bytes: Buffer, format: Extract<Format, { kind: "image" }>): Body {
  if (bytes.length > MCP_IMAGE_MAX_BYTES) {
    throw new MaterialFormatError("import_file_too_large", `images are limited to ${MCP_IMAGE_MAX_BYTES} bytes`);
  }
  const size = format.format === "png" ? pngSize(bytes) : jpegSize(bytes);
  if (!size || size.width <= 0 || size.height <= 0) {
    throw new MaterialFormatError("invalid_image", `the file is not a readable ${format.format.toUpperCase()} image`);
  }
  return {
    derivative: {
      image: {
        format: format.format,
        width: size.width,
        height: size.height,
        orientation: orientation(size.width, size.height),
        normalized: { data: bytes.toString("base64"), sha256: sha256(bytes), format: format.format },
      },
    },
    summaryZh: `图片 ${size.width}×${size.height}`,
  };
}

function bodyFor(bytes: Buffer, format: Format): Body {
  if (format.kind === "text") return textBody(bytes, format);
  if (format.kind === "table") return tableBody(bytes, format);
  return imageBody(bytes, format);
}

/** A display name without directory parts; falls back to the source file name. */
export function materialName(requested: unknown, sourcePath: string): string {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const cleaned = raw.replace(/[\\/\0]/g, "_").slice(0, 200);
  return cleaned || path.basename(sourcePath);
}

/** Build the verified material record for one imported file. */
export function prepareImportedMaterial(input: {
  readonly bytes: Buffer;
  readonly extension: string;
  readonly name: string;
  readonly ownerId: string;
}): PreparedMaterial {
  const format = IMPORT_FORMATS[input.extension];
  if (!format) throw new MaterialFormatError("unsupported_material_format", `unsupported format ${input.extension}`);
  const originalSha256 = sha256(input.bytes);
  const id = `mcp-${originalSha256.slice(0, 16)}`;
  const body = bodyFor(input.bytes, format);
  const derivative: Record<string, unknown> = {
    schema: DERIVATIVE_SCHEMA,
    materialId: id,
    kind: format.kind,
    source: { name: input.name, bytes: input.bytes.length, sha256: originalSha256, extension: input.extension },
    parser: { id: format.parser, engine: "slides-mcp" },
    status: "ok",
    truncated: { applied: false },
    warnings: [],
    summary: { zh: body.summaryZh },
    ...body.derivative,
  };
  const derivativeBytes = Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");
  return {
    attachment: {
      id,
      name: input.name,
      kind: format.kind,
      parser: format.parser,
      summaryZh: body.summaryZh,
      needsVision: format.kind === "image",
      bytes: input.bytes.length,
      storeId: "slides-mcp-import",
      originalSha256,
      derivativeSha256: sha256(derivativeBytes),
      ...(body.chars !== undefined ? { chars: body.chars } : {}),
    },
    originalBytes: input.bytes,
    derivativeBytes,
    derivative,
    meta: { id, storeId: "slides-mcp-import", ownerId: input.ownerId, size: input.bytes.length },
  };
}
