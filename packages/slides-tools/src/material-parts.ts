/**
 * The parts a `read_material` part filter can address, derived per kind from
 * the verified derivative: sheets for tables (plus embedded charts since
 * CAP-33), the document body for documents (plus reconstructed PDF tables and
 * Word charts), design/layout/text/chart parts for templates, the image
 * itself, and the inline text. Images list only their palette; a PDF lists it
 * beside its text part.
 */
import { hasValidTemplateKit, withPaletteParts } from "@open-slidestudio/presentation-run";
import type { MaterialPart } from "./material-input.js";
import type { PreparedMaterial } from "./material-store.js";

export function materialPartsFor(
  prepared: PreparedMaterial,
  templateParts?: readonly MaterialPart[],
): readonly MaterialPart[] {
  const { attachment, derivative } = prepared;
  return withPaletteParts(
    {
      kind: attachment.kind,
      parser: attachment.parser,
      name: attachment.name,
      derivative,
    },
    contentPartsFor(prepared, templateParts),
  );
}

type Rec = Record<string, unknown>;

function safeInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

function sheetPart(raw: unknown): MaterialPart {
  const sheet = raw as Rec;
  const name = String(sheet.name ?? "");
  return {
    part: `sheet:${name}`,
    label: `工作表「${name}」`,
    ...(sheet.hidden === true ? { hidden: true } : {}),
    ...(Number.isSafeInteger(sheet.rowCount) ? { rows: Number(sheet.rowCount) } : {}),
    ...(Number.isSafeInteger(sheet.colCount) ? { cols: Number(sheet.colCount) } : {}),
  };
}

function rowsPart(table: Rec | undefined): MaterialPart {
  const rows = safeInt(table?.rowCount);
  const cols = safeInt(table?.colCount);
  return {
    part: "rows",
    label: `${rows !== undefined ? rows.toLocaleString("zh-CN") : "?"} 行`,
    ...(rows !== undefined ? { rows } : {}),
    ...(cols !== undefined ? { cols } : {}),
  };
}

function chartsPart(count: number): MaterialPart {
  return { part: "charts", label: `图表 ${count} 个（数据可读取）`, charts: count };
}

function tableParts(derivative: Rec): readonly MaterialPart[] {
  const table = derivative.table as Rec | undefined;
  const sheets = Array.isArray(table?.sheets) ? table.sheets : undefined;
  const sheetParts = sheets?.length ? sheets.map(sheetPart) : [rowsPart(table)];
  // CAP-33: a workbook's embedded charts are their own readable part. Listed
  // only when the parse found at least one chart (empty list = 未识别到图表).
  const charts = Array.isArray(table?.charts) ? table.charts : [];
  return charts.length ? [...sheetParts, chartsPart(charts.length)] : sheetParts;
}

function documentBodyPart(doc: Rec | undefined): MaterialPart {
  if (typeof doc?.pageCount === "number" && Number.isSafeInteger(doc.pageCount)) {
    return { part: "document", label: `${doc.pageCount} 页`, pages: doc.pageCount };
  }
  const counts = doc?.counts as Rec | undefined;
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks.length : 0;
  const chars = Number(doc?.chars);
  return {
    part: "document",
    label: `${blocks} 个内容块`,
    blocks,
    ...(counts ? { counts: Object.keys(counts).length } : {}),
    ...(Number.isSafeInteger(chars) ? { chars } : {}),
  };
}

function documentParts(derivative: Rec, parser: unknown): readonly MaterialPart[] {
  const doc = derivative.document as Rec | undefined;
  const parts: MaterialPart[] = [documentBodyPart(doc)];
  // CAP-32: reconstructed PDF tables are their own readable part. Listed only
  // when the parse found at least one table (empty list = 「未识别到表格」).
  const tables = Array.isArray(doc?.tables) ? doc.tables : [];
  if (tables.length) {
    parts.push({ part: "tables", label: `表格 ${tables.length} 个（自动识别，可能有错位）`, tables: tables.length });
  }
  // CAP-33: a Word document's embedded charts are their own readable part,
  // listed only when the parse found at least one chart.
  const charts = Array.isArray(doc?.charts) ? doc.charts : [];
  if (charts.length && String(parser ?? "").startsWith("docx-ooxml-")) parts.push(chartsPart(charts.length));
  return parts;
}

function layoutCount(masters: readonly unknown[]): number {
  return masters.reduce<number>((sum, master) => {
    const layouts = (master as Rec).layouts;
    return sum + (Array.isArray(layouts) ? layouts.length : 0);
  }, 0);
}

function deckTemplateParts(derivative: Rec): readonly MaterialPart[] {
  const template = derivative["deck-template"] as Rec | undefined;
  const slides = Array.isArray(template?.slides) ? template.slides.length : 0;
  const layouts = layoutCount(Array.isArray(template?.masters) ? template.masters : []);
  const detail = template?.templateDetail as Rec | undefined;
  const parts: MaterialPart[] = [
    { part: "design", label: `PPT 模板 · ${slides} 页 · ${layouts} 个版式`, slides, layouts },
    { part: "layouts", label: "页面原型与版式线索" },
    { part: "slides", label: "逐页文字", slides },
    { part: "tables", label: "表格文字" },
    { part: "charts", label: "图表数据" },
  ];
  if (Array.isArray(detail?.smartArts) && detail.smartArts.length) {
    parts.push({ part: "smartart", label: "SmartArt 文字结构" });
  }
  if (hasValidTemplateKit(derivative)) parts.push({ part: "kit", label: "可复用模板组件" });
  return parts;
}

function imageParts(derivative: Rec): readonly MaterialPart[] {
  const image = derivative.image as Rec | undefined;
  const width = Number(image?.width);
  const height = Number(image?.height);
  const format = String(image?.format ?? "").toUpperCase();
  return [
    {
      part: "image",
      label: `${format || "图片"} ${width}×${height}`,
      ...(Number.isSafeInteger(width) ? { width } : {}),
      ...(Number.isSafeInteger(height) ? { height } : {}),
      ...(format ? { format } : {}),
    },
  ];
}

function contentPartsFor(prepared: PreparedMaterial, templateParts?: readonly MaterialPart[]): readonly MaterialPart[] {
  const { attachment, derivative } = prepared;
  switch (attachment.kind) {
    case "table":
      return tableParts(derivative);
    case "document":
      return documentParts(derivative, attachment.parser);
    case "deck-template":
      return templateParts ?? deckTemplateParts(derivative);
    case "image":
      return imageParts(derivative);
    default:
      return [
        {
          part: "text",
          label: `${attachment.chars ?? 0} 字`,
          ...(attachment.chars ? { chars: attachment.chars } : {}),
        },
      ];
  }
}
