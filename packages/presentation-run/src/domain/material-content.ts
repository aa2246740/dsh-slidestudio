/**
 * Deterministic text/table renderings of verified project materials for the
 * `read_material` agent tool. Documents, texts, deck templates and image
 * metadata render to markdown and chunk at ~12 KiB UTF-8-safe boundaries;
 * tables return a header plus a bounded window of data rows with absolute
 * 1-based indices so any row of a large sheet is exactly reachable.
 */
import { MATERIAL_CHUNK_BYTES, MATERIAL_TABLE_MAX_ROWS, MaterialPackError, sha256Hex } from "./material-pack.js";
import type { MaterialReadResult, VerifiedMaterial } from "./material-pack.js";
import { csvAllRows, defaultTablePart, parseDelimitedText, tableWindow } from "./material-table-window.js";
import { pdfTablesPartText, PDF_TABLES_PART } from "./material-pdf-tables.js";
import { officeChartsPartText, officeChartsSupported, OFFICE_CHARTS_PART } from "./material-office-charts.js";
import { templateMaterialChunks, templateMaterialPartText } from "./material-template-text.js";
import { PALETTE_PART, paletteKind, palettePartText, paletteSectionLines } from "./palette-source.js";

export { csvAllRows, defaultTablePart, parseDelimitedText, tableWindow };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Model-dependent wording in a rendered part. Omitting it gives the text-only
 * variant, so a caller that does not know the model never names view_material.
 * The chunk sha256 covers this wording: a reader and its verifier must pass the
 * same value for the same model.
 */
export type MaterialRenderOptions = Readonly<{ modelAcceptsImages?: boolean }>;

// ---------------------------------------------------------------------------
// Text renderings. Deterministic, UTF-8 — byte-exact between calls so chunk
// sha256s are stable.
// ---------------------------------------------------------------------------

function renderText(material: VerifiedMaterial): string {
  const text = isRecord(material.derivative.text) ? material.derivative.text : undefined;
  return typeof text?.text === "string" ? text.text : "";
}

function renderDocument(material: VerifiedMaterial): string {
  const doc = isRecord(material.derivative.document) ? material.derivative.document : undefined;
  if (!doc) return "";
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : undefined;
  if (!blocks) {
    // pdf-unpdf-v1: per-page extracted text.
    const pages = Array.isArray(doc.pages) ? doc.pages : [];
    return pages
      .map((raw) => {
        const page = isRecord(raw) ? raw : {};
        const index = Number(page.index) || 0;
        const text = typeof page.text === "string" ? page.text : "";
        // 「主要是图片」 only when an embedded image covers the page (DECISIONS #13);
        // a low-text page without an image is 「几乎没有文字」; an undetected page
        // (beyond the first 40, or detection failed) keeps the neutral wording.
        const lowTextNote =
          page.lowText !== true
            ? ""
            : page.hasImage === true
              ? "（本页主要是图片，未识别文字（不做 OCR）；内容未知，不要猜测）"
              : page.hasImage === false
                ? "（本页几乎没有文字，未做 OCR；内容未知，不要猜测）"
                : "（本页几乎没有可提取的文字，可能是整页图片；未做 OCR，内容未知，不要猜测）";
        const content = [text, lowTextNote].filter(Boolean).join("\n\n");
        return `## 第 ${index} 页\n\n${content}`;
      })
      .join("\n\n");
  }
  // docx-ooxml-v1: ordered blocks → markdown.
  return blocks
    .map((raw) => {
      const block = isRecord(raw) ? raw : {};
      const type = String(block.type ?? "");
      const text = typeof block.text === "string" ? block.text : "";
      if (type === "heading") {
        const level = Math.min(Math.max(Number(block.level) || 1, 1), 6);
        return `${"#".repeat(level)} ${text}`;
      }
      if (type === "listItem") return `- ${text}`;
      if (type === "table") {
        const rows = Array.isArray(block.rows) ? block.rows : [];
        return rows
          .map((row) => {
            const cells = Array.isArray(row) ? row : [];
            return `| ${cells
              .map((cell) =>
                typeof cell === "string" ? cell : isRecord(cell) && typeof cell.text === "string" ? cell.text : "",
              )
              .join(" | ")} |`;
          })
          .join("\n");
      }
      if (type === "image") {
        const part = typeof block.part === "string" ? block.part : "";
        return `[图片${part ? `：${part}` : ""}]`;
      }
      return text;
    })
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function renderImage(material: VerifiedMaterial, options: MaterialRenderOptions): string {
  const image = isRecord(material.derivative.image) ? material.derivative.image : undefined;
  const palette = Array.isArray(image?.palette) ? image.palette.join("、") : "";
  const type = image?.logoLike === true ? "Logo（透明底小图）" : image?.screenshotLike === true ? "截图" : "";
  const header = [
    `# 图片资料「${material.name}」`,
    `- 格式：${String(image?.format ?? "").toUpperCase() || "?"}`,
    `- 尺寸：${Number(image?.width) || "?"}×${Number(image?.height) || "?"}`,
    type ? `- 类型：${type}` : "",
    image?.dominant ? `- 主色：${image.dominant}` : "",
    palette ? `- 色板：${palette}` : "",
    material.mediaSrc ? `- 已放入项目媒体：${material.mediaSrc}` : "",
    options.modelAcceptsImages === true
      ? "- 画面内容：调用 view_material 查看（需要模型支持看图）；write_page 可用 mediaSrc 直接放到页面"
      : "- 画面内容：当前模型不能看图，无法查看画面；只知道颜色、尺寸和朝向等元信息。write_page 仍可用 mediaSrc 放到页面",
  ].filter(Boolean);
  return [...header, "", "## 配色（palette）", ...paletteSectionLines(material)].join("\n");
}

/** The deterministic text rendering for one material part. */
export function materialPartText(
  material: VerifiedMaterial,
  part?: string,
  options: MaterialRenderOptions = {},
): string {
  switch (material.kind) {
    case "text":
      return renderText(material);
    case "document":
      if (part?.trim() === PALETTE_PART) {
        if (paletteKind(material) !== "pdf") {
          throw new MaterialPackError(`资料「${material.name}」不是图片或 PDF，没有 palette 分段；可用 part：document`);
        }
        return palettePartText(material);
      }
      if (part?.trim() === PDF_TABLES_PART) {
        return pdfTablesPartText(material);
      }
      if (part?.trim() === OFFICE_CHARTS_PART) {
        // CAP-33: a Word document's embedded chart data. Only a docx parser
        // carries charts; a PDF is refused with its own readable parts.
        if (!officeChartsSupported(material)) {
          throw new MaterialPackError(`资料「${material.name}」不是 Word 文档，没有 charts 分段；可用 part：document`);
        }
        return officeChartsPartText(material);
      }
      return renderDocument(material);
    case "deck-template":
      return templateMaterialPartText(material, part?.trim() || "design");
    case "image":
      return renderImage(material, options);
    case "table": {
      const requested = part?.trim() || defaultTablePart(material);
      if (requested === OFFICE_CHARTS_PART) {
        // CAP-33: an Excel workbook's embedded chart data; a CSV has none.
        if (!officeChartsSupported(material)) {
          throw new MaterialPackError(
            `资料「${material.name}」不是 Excel 工作簿，没有 charts 分段；可用 part：${defaultTablePart(material)}`,
          );
        }
        return officeChartsPartText(material);
      }
      return tableWindow(material, requested, 0, MATERIAL_TABLE_MAX_ROWS).text;
    }
  }
}

// ---------------------------------------------------------------------------
// Chunked reads.
// ---------------------------------------------------------------------------

function chunkUtf8(text: string, chunkBytes: number): readonly { bytes: Buffer; start: number }[] {
  const bytes = Buffer.from(text, "utf8");
  if (!bytes.length) return [];
  const chunks: { bytes: Buffer; start: number }[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + chunkBytes, bytes.length);
    if (end < bytes.length) {
      while (end > start && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
      if (end === start) {
        throw new MaterialPackError("material rendering cannot chunk at UTF-8 boundaries");
      }
    }
    chunks.push({ bytes: Buffer.from(bytes.subarray(start, end)), start });
    start = end;
  }
  return chunks;
}

/** A table part is read as row windows; only its charts part chunks like a document. */
export function isTableWindowPart(material: VerifiedMaterial, part?: string): boolean {
  return material.kind === "table" && part?.trim() !== OFFICE_CHARTS_PART;
}

export function materialChunkCount(
  material: VerifiedMaterial,
  part?: string,
  options: MaterialRenderOptions = {},
): number {
  // A table's charts part renders like a document part and chunks the same way;
  // only the row-window parts stay single-chunk.
  if (isTableWindowPart(material, part)) return 1;
  if (material.kind === "deck-template") {
    return templateMaterialChunks(material, part?.trim() || "design").length;
  }
  return chunkUtf8(materialPartText(material, part, options), MATERIAL_CHUNK_BYTES).length;
}

function pdfPageRange(text: string, start: number, end: number) {
  let first: number | undefined;
  let last: number | undefined;
  for (const heading of text.matchAll(/^## 第 (\d+) 页$/gm)) {
    const position = Buffer.byteLength(text.slice(0, heading.index), "utf8");
    if (position >= end) break;
    const page = Number(heading[1]);
    if (position <= start || first === undefined) first = page;
    last = page;
  }
  return first === undefined || last === undefined ? undefined : { start: first, end: last };
}

/**
 * Read one chunk of a material part. `read_material` uses `offset`/`limit`
 * for tables (data-row window) and `offset` as the chunk index for documents,
 * texts, images and deck templates.
 */
export function readMaterialChunk(input: MaterialChunkInput): MaterialReadResult {
  return readMaterialChunkWithFacts(input).read;
}

type MaterialChunkInput = {
  readonly material: VerifiedMaterial;
  readonly part?: string;
  readonly offset?: number;
  readonly limit?: number;
} & MaterialRenderOptions;

/**
 * The same read as `readMaterialChunk`, plus `factText` for table row windows: the cell
 * values of the exact window the returned receipt hash covers. Other kinds have none and
 * their `read.text` is the source text.
 */
export function readMaterialChunkWithFacts(input: MaterialChunkInput): {
  readonly read: MaterialReadResult;
  readonly factText?: string;
} {
  const { material } = input;
  if (isTableWindowPart(material, input.part)) {
    const part = input.part?.trim() || defaultTablePart(material);
    const window = tableWindow(material, part, input.offset ?? 0, input.limit ?? MATERIAL_TABLE_MAX_ROWS);
    const bytes = Buffer.from(window.text, "utf8");
    const start = window.rows.length ? window.rows[0]!.index : 0;
    const end = window.rows.length ? window.rows[window.rows.length - 1]!.index : 0;
    return {
      read: {
        materialId: material.id,
        materialSha256: material.sha256,
        name: material.name,
        kind: material.kind,
        part,
        chunkIndex: 0,
        chunkCount: 1,
        chunkSha256: sha256Hex(bytes),
        chars: Array.from(window.text).length,
        readChunks: 1,
        rowsRead: window.rows.length,
        allRead: window.rows.length === window.rowCount,
        hasMore: end < window.rowCount,
        truncated: window.truncated,
        rows: { startIndex: start, endIndex: end, total: window.rowCount },
        text: window.text,
      },
      factText: window.factText,
    };
  }
  // An image has one part; its earlier id `image` stays readable and counts as the palette read.
  const part = material.kind === "image" ? PALETTE_PART : input.part?.trim() || defaultPartFor(material);
  const isTemplate = material.kind === "deck-template";
  const templateChunks = isTemplate ? templateMaterialChunks(material, part) : undefined;
  const text = templateChunks
    ? templateChunks.map((chunk) => chunk.text).join("\n\n")
    : materialPartText(material, part === defaultPartFor(material) ? undefined : part, {
        modelAcceptsImages: input.modelAcceptsImages,
      });
  const chunks = templateChunks
    ? templateChunks.map((chunk) => ({
        bytes: Buffer.from(chunk.text, "utf8"),
        start: 0,
      }))
    : chunkUtf8(text, MATERIAL_CHUNK_BYTES);
  const index = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? input.offset! : 0;
  const chunk = chunks[index];
  if (!chunk) {
    if (!chunks.length) {
      return {
        read: {
          materialId: material.id,
          materialSha256: material.sha256,
          name: material.name,
          kind: material.kind,
          part,
          chunkIndex: 0,
          chunkCount: 0,
          chunkSha256: sha256Hex(Buffer.alloc(0)),
          chars: 0,
          readChunks: 0,
          allRead: true,
          hasMore: false,
          text: "",
        },
      };
    }
    throw new MaterialPackError(
      `资料「${material.name}」没有第 ${index} 个分段；共 ${chunks.length} 段，offset 取 0–${chunks.length - 1}`,
    );
  }
  return {
    read: {
      materialId: material.id,
      materialSha256: material.sha256,
      name: material.name,
      kind: material.kind,
      part,
      chunkIndex: index,
      chunkCount: chunks.length,
      chunkSha256: sha256Hex(chunk.bytes),
      chars: Array.from(chunk.bytes.toString("utf8")).length,
      ...(material.parser?.startsWith("pdf-unpdf-")
        ? { pageRange: pdfPageRange(text, chunk.start, chunk.start + chunk.bytes.length) }
        : {}),
      readChunks: 1,
      allRead: chunks.length === 1,
      hasMore: index < chunks.length - 1,
      text: chunk.bytes.toString("utf8"),
    },
  };
}

function defaultPartFor(material: VerifiedMaterial): string {
  switch (material.kind) {
    case "table":
      return defaultTablePart(material);
    case "document":
      return "document";
    case "deck-template":
      return "design";
    case "image":
      return PALETTE_PART;
    default:
      return "text";
  }
}
