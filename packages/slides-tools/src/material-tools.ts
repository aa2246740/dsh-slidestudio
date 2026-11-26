/**
 * Uploaded-reference-material agent tools (`list_materials`, `read_material`,
 * `query_material`, `view_material`, `record_material_notes`). Extracted from tools.ts to keep
 * that module inside its legacy line budget.
 */
import { inspectProjectCapabilities, type OverviewPlan } from "@open-slidestudio/presentation-run";
import { inputSha256 } from "./material-input.js";
import { composeOrReuseOverview, OverviewSourceError } from "./image-overview-store.js";
import type { SlideContentBlock, SlideToolContext, SlideToolDefinition, SlideToolResult } from "./contract.js";
import { isImageCodecUnavailable, loadImageCodec } from "./image-codec.js";
import { present, receiptResult, result, slideTool, type SlideToolRuntimeDeps } from "./tool-kit.js";
import { visionUnavailableDetail } from "./vision-tools.js";

/**
 * `view_material` streams an image block to the selected model, so its gate is
 * that model's declared image input (`vision.modelAcceptsImages`, resolved
 * from the persisted provider `modelInputModalities`) — not the page-raster
 * runtime that `vision.mode`/`review_page` depend on. A model that accepts
 * images can view an uploaded picture even when no editor raster exists.
 */
export function materialAcceptsImageInput(projectRoot: string): boolean {
  return inspectProjectCapabilities(projectRoot).vision.modelAcceptsImages === true;
}

function listMaterialsTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "list_materials",
    readOnly: true,
    description:
      "List the user's uploaded reference materials (图片、表格、文档、PPT 模板) with recognized summaries and readable parts. PPT templates expose design, layouts, slides, tables and charts with UTF-8 byte sizes and chunk counts; smartart appears only when diagrams exist; kit appears only when the template has reusable decoration components. Images list palette; a PDF lists document and palette, its page-image count, and tables when table structure was reconstructed. A Word or Excel file lists charts when the file carries embedded charts. Call this first, then read every part you rely on through read_material before using its facts. Place user images via mediaSrc.",
    parameters: {},
    async execute(args, ctx) {
      return receiptResult(await present(deps, ctx, "list_materials", args));
    },
  });
}

function readMaterialTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "read_material",
    readOnly: true,
    description:
      "Read one part of an uploaded material by materialId. For PPT templates, design contains observed colors and actually used fonts; layouts gives descriptive position/use cues; slides returns per-slide text including SmartArt trees; tables and charts preserve extracted values; smartart returns per-diagram text summaries and exists only when present; kit lists the template's reusable components as material:<id>#<componentId> references with role, archetype, box and scopeHint (layout or page), which the Host expands where they are written into a page (or into a layout, in turns that edit layouts) once the template's decorations or photos use is declared and the whole kit part has been read. Template chunks are ≤12 KiB UTF-8, slides/charts/tables carry `## 第 N 页` headings, and chart types PPTD cannot draw are marked as unsupported. Documents return ordered markdown chunks (offset = chunk index, 0-based); a PDF's part tables returns its reconstructed tables as markdown per page (自动识别，可能有错位) or a Chinese empty note; tables return the header plus data rows in at most 12 KiB of UTF-8 text (offset = zero-based data row, limit ≤ 200, with absolute row indices). A window may return fewer rows than limit; when hasMore is true, continue with offset = rows.endIndex, not offset + limit. An oversized single row is explicitly marked and truncated = true; oversized headers may also be shortened. Any row of a large CSV/XLSX is reachable by its absolute offset; images return metadata and their measured palette (part palette), and a PDF's part palette merges its vector and page-pixel colours — read it before adopting that image or PDF for palette. Exact values only — never invent numbers or text that a part did not return.",
    parameters: {
      materialId: {
        type: "string",
        required: true,
        description: "Material id from list_materials",
      },
      part: {
        type: "string",
        description:
          "Optional part id from list_materials. PPT templates: design, layouts, slides, tables, charts, or smartart / kit when listed; images and PDFs: palette; PDFs also list tables when detected; Word and Excel list charts when the file carries embedded charts (cached values usable for a native write_page chart); other examples: sheet:明细, document, rows.",
      },
      offset: {
        type: "integer",
        description: "Chunk index (documents) or zero-based data row (tables); default 0",
      },
      limit: {
        type: "integer",
        description: "Max data rows (≤200); the 12 KiB UTF-8 bound may return fewer; ignored for documents",
      },
    },
    async execute(args, ctx) {
      return receiptResult(await present(deps, ctx, "read_material", args));
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function overviewPlanOf(payload: Record<string, unknown> | undefined): OverviewPlan | undefined {
  const plan = payload?.overviewPlan;
  return isRecord(plan) && Array.isArray(plan.tiles) ? (plan as unknown as OverviewPlan) : undefined;
}

/** The tile fields the model may see: no file paths, no source hashes. */
function publicTile(tile: OverviewPlan["tiles"][number]) {
  const { number, materialId, mediaId, page, name, width, height, orientation } = tile;
  return {
    number,
    materialId,
    ...(mediaId ? { mediaId } : {}),
    ...(page ? { page } : {}),
    name,
    ...(width && height ? { width, height } : {}),
    ...(orientation ? { orientation } : {}),
  };
}

const IMAGE_SINK_MISSING =
  "the selected model accepts image input but the DSH attachments service is not mounted; cannot send the material image to the selected model";

function jpegBlock(data: Uint8Array, name: string, size?: { width: number; height: number }): SlideContentBlock {
  return { type: "image", data, mediaType: "image/jpeg", name, ...(size ?? {}) };
}

function overviewDetail(detail: string, width: number, height: number, blank: readonly number[]): string {
  return [
    detail,
    `总览图 ${width}×${height}。`,
    blank.length ? `编号 ${blank.join("、")} 的图片无法解码，对应格子留空；请单独查看。` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function composeOverview(projectRoot: string, plan: OverviewPlan) {
  try {
    return { stored: await composeOrReuseOverview(projectRoot, plan) };
  } catch (error) {
    if (error instanceof OverviewSourceError || isImageCodecUnavailable(error)) {
      return {
        refusal: result({
          ok: false,
          summary: "图片总览无法生成",
          detail: error.message,
          ...(isImageCodecUnavailable(error) ? { payload: { error: "image_codec_unavailable" } } : {}),
        }),
      };
    }
    throw error;
  }
}

/**
 * Compose (or reuse) the numbered mosaic for a verified plan, record the fact
 * that the model received it, then hand the JPEG to the host as an image block.
 */
async function overviewViewResult(
  deps: SlideToolRuntimeDeps,
  ctx: SlideToolContext,
  receipt: Awaited<ReturnType<typeof present>>,
  plan: OverviewPlan,
): Promise<SlideToolResult> {
  if (ctx.acceptsImageContent === false) throw new Error(IMAGE_SINK_MISSING);
  const composed = await composeOverview(ctx.projectRoot, plan);
  if (!composed.stored) return composed.refusal;
  const { overview } = composed.stored;
  const recorded = await present(deps, ctx, "_record_material_overview", {
    kind: plan.kind,
    materialId: plan.materialId,
    overviewSha256: overview.sha256,
    width: overview.width,
    height: overview.height,
    tiles: plan.tiles.map(({ number, materialId, mediaId, page, sha256 }) => ({
      number,
      materialId,
      ...(mediaId ? { mediaId } : {}),
      ...(page ? { page } : {}),
      sha256,
    })),
  });
  if (!recorded.ok) {
    return result({ ok: false, summary: recorded.summary, detail: recorded.detail, payload: recorded.payload });
  }
  const blank = overview.tiles.filter((tile) => !tile.decoded).map((tile) => tile.number);
  const name = plan.kind === "all-images" ? "all-images.jpg" : "pdf-pages.jpg";
  return result(
    {
      ok: true,
      summary: receipt.summary,
      detail: overviewDetail(receipt.detail, overview.width, overview.height, blank),
      payload: {
        materialId: plan.materialId,
        kind: plan.kind,
        name: plan.name,
        overviewSha256: overview.sha256,
        width: overview.width,
        height: overview.height,
        overview: {
          kind: plan.kind,
          total: plan.total,
          shown: plan.tiles.length,
          truncated: plan.truncated,
          tiles: plan.tiles.map(publicTile),
        },
      },
    },
    [jpegBlock(overview.bytes, name, { width: overview.width, height: overview.height })],
  );
}

/** Normalize a deck-template photo to the model-facing JPEG; undefined when it cannot be decoded. */
async function normalizedTemplatePhoto(data: Buffer): Promise<Buffer | "codec-unavailable" | undefined> {
  try {
    const sharp = await loadImageCodec();
    return await sharp(data, { limitInputPixels: 50_000_000, failOn: "error" })
      .rotate()
      .resize(1568, 1568, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (error) {
    return isImageCodecUnavailable(error) ? "codec-unavailable" : undefined;
  }
}

function visionRefusal(name: "view_material" | "record_material_notes"): SlideToolResult {
  return result({
    ok: false,
    summary: `${name} unavailable`,
    detail: visionUnavailableDetail(name),
    payload: { error: "vision_unavailable" },
  });
}

async function singleImageResult(
  ctx: SlideToolContext,
  receipt: Awaited<ReturnType<typeof present>>,
  payload: Record<string, unknown>,
  base64: string,
): Promise<SlideToolResult> {
  if (ctx.acceptsImageContent === false) throw new Error(IMAGE_SINK_MISSING);
  let data: Buffer = Buffer.from(base64, "base64");
  if (payload.kind === "deck-template") {
    const normalized = await normalizedTemplatePhoto(data);
    if (normalized === "codec-unavailable") {
      return result({
        ok: false,
        summary: "模板照片无法查看",
        detail: "图片处理组件不可用，模板照片暂时无法转换；请改用 read_material 的文字信息",
        payload: { error: "image_codec_unavailable" },
      });
    }
    if (!normalized) {
      return result({ ok: false, summary: "模板照片无法查看", detail: "模板照片无法解码，请重新上传后再发送" });
    }
    data = normalized;
  }
  const rest = { ...payload };
  delete rest.imageBytesBase64;
  if (payload.kind === "deck-template") rest.normalizedSha256 = inputSha256(data);
  const name = `${String(payload.materialId ?? "material")}.jpg`;
  return result({ ok: true, summary: receipt.summary, detail: receipt.detail, payload: rest }, [
    jpegBlock(new Uint8Array(data), name),
  ]);
}

async function viewMaterial(deps: SlideToolRuntimeDeps, ctx: SlideToolContext, args: Record<string, unknown>) {
  // Defense in depth behind the allowlist: never send image blocks to a
  // model without declared image input.
  if (!materialAcceptsImageInput(ctx.projectRoot)) return visionRefusal("view_material");
  const receipt = await present(deps, ctx, "view_material", args);
  const payload = receipt.payload as Record<string, unknown> | undefined;
  const plan = overviewPlanOf(payload);
  if (receipt.ok && plan) return overviewViewResult(deps, ctx, receipt, plan);
  const base64 = typeof payload?.imageBytesBase64 === "string" ? payload.imageBytesBase64 : "";
  if (!receipt.ok || !base64 || !payload) {
    return result({ ok: receipt.ok, summary: receipt.summary, detail: receipt.detail, payload: receipt.payload });
  }
  return singleImageResult(ctx, receipt, payload, base64);
}

function viewMaterialTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "view_material",
    readOnly: true,
    description:
      'View uploaded visual material as one normalized JPEG image block (at most 1568 px). Shapes: {materialId} on an image; {materialId:"all-images"} for one numbered mosaic of every session image (template photos included) plus a table from number to material; {materialId} on a PDF for a numbered mosaic of up to 12 rendered pages; {materialId, page} for one PDF page (only the first 40 pages have images; list_materials lists the rendered pages); {materialId, mediaId} for a deck-template photo (the :grayscale id selects the desaturated copy). Only available when the selected model accepts image input (inspect_capabilities.vision.modelAcceptsImages); read_material covers text for every model. After looking, write the conclusion with record_material_notes.',
    parameters: {
      materialId: {
        type: "string",
        required: true,
        description:
          'Image, PDF or deck-template material id from list_materials, or "all-images" for the numbered overview of every image',
      },
      mediaId: {
        type: "string",
        description: "Template photo mediaId from list_materials; omit for standalone images",
      },
      page: {
        type: "integer",
        description: "PDF page number (1-based, at most 40 rendered pages); required to view a PDF page image",
      },
    },
    render: "vision",
    execute: (args, ctx) => viewMaterial(deps, ctx, args),
  });
}

function recordMaterialNotesTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  // No `required`/`enum` in the parameter spec on purpose: the Host validates
  // these in Chinese so a wrong value explains itself instead of failing in schema English.
  return slideTool(deps, {
    name: "record_material_notes",
    readOnly: false,
    description:
      'Record what you concluded from an image you viewed, so its picture can later be replaced by this text. Target: {materialId} for an image; {materialId, mediaId} for a deck-template photo; {materialId, page} for a PDF page. caption (required): one or two sentences about what the picture shows. suggestedUse (required): "page" (place it on a slide), "background", "logo", "style-reference" (only learn from its look) or "skip". Optional: focus [x, y] (0–1, the subject\'s position for cropping), layoutNotes, mood, fontClass ("sans"|"serif"|"kai"|"mono": a class, never a font name; the Host maps it to whitelisted fonts), readValues [{label, value, unit?, period?}] for numbers you read off the picture (shown to the user as unverified), reason. Only available when the selected model accepts image input.',
    parameters: {
      materialId: { type: "string", description: "Material id from list_materials" },
      mediaId: { type: "string", description: "Template photo mediaId (deck-template only)" },
      page: { type: "integer", description: "PDF page number (PDF only)" },
      caption: { type: "string", description: "What the picture shows (required)" },
      suggestedUse: {
        type: "string",
        description: 'One of "page", "background", "logo", "style-reference", "skip" (required)',
      },
      focus: { type: "array", items: { type: "number" }, description: "[x, y], each 0–1" },
      layoutNotes: { type: "string", description: "Composition: whitespace, alignment, grid" },
      mood: { type: "string", description: "Overall feeling of the picture" },
      fontClass: { type: "string", description: '"sans", "serif", "kai" or "mono"' },
      readValues: {
        type: "array",
        items: { type: "object", additionalProperties: true },
        description: "Numbers read from the picture: [{label, value, unit?, period?}]",
      },
      reason: { type: "string", description: "Why this suggestedUse" },
    },
    async execute(args, ctx) {
      if (!materialAcceptsImageInput(ctx.projectRoot)) return visionRefusal("record_material_notes");
      return receiptResult(await present(deps, ctx, "record_material_notes", args));
    },
  });
}

/**
 * The Host computes tables; the model never does arithmetic. Operators are enums validated in
 * Chinese by the domain hand, so the parameter spec stays open (no `enum`/`required`) and a wrong
 * value explains itself instead of failing in schema English.
 */
function queryMaterialTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  const objects = { type: "array", items: { type: "object", additionalProperties: true } } as const;
  return slideTool(deps, {
    name: "query_material",
    readOnly: true,
    description:
      'Compute exact numbers from an uploaded CSV/XLSX table (read-only, deterministic, no formulas). Pipeline: filter [{column, op: "="|"!="|">"|"<"|"in"|"contains", value}] → groupBy [columns] → measures [{op: sum|count|avg|min|max, column (omit for a plain count), as}] → derive [{as, op: share|yoy|mom|ratio|diff|unit, of, base?, factor?}] over measure/derive aliases (share = value / column total of all groups, yoy and mom = (of − base) / base, ratio = of / base, diff = of − base, unit = of × factor) → sort [{by, dir: asc|desc}] → limit (≤ 200). Column names must match the header exactly; part is "rows" for CSV or "sheet:<name>" for XLSX (required when the workbook has several sheets). Returns cols, rows, notes and a receipt (material and result hashes, row counts). An empty or zero base gives null plus a note, never a guess. Every computed number on a page (sums, shares, 同比, 环比, differences) must come from this tool; show values with at most two decimals and fractions (share, yoy, mom) as percentages. Never add up, average or divide table numbers yourself.',
    parameters: {
      materialId: {
        type: "string",
        required: true,
        description: "Table material id from list_materials",
      },
      part: {
        type: "string",
        description: 'CSV: "rows"; XLSX: "sheet:<name>" from list_materials',
      },
      filter: {
        ...objects,
        description: "Row filters, all must hold: {column, op, value}; in takes an array",
      },
      groupBy: {
        type: "array",
        items: { type: "string" },
        description: "Header names to group by",
      },
      measures: { ...objects, description: "Aggregates: {op, column?, as}; at least one" },
      derive: { ...objects, description: "Derived columns: {as, op, of, base?, factor?}" },
      sort: { ...objects, description: "Result order: {by: result column, dir}" },
      limit: { type: "integer", description: "Keep the first N result rows (≤ 200)" },
    },
    async execute(args, ctx) {
      return receiptResult(await present(deps, ctx, "query_material", args));
    },
  });
}

export function materialToolDefinitions(deps: SlideToolRuntimeDeps): SlideToolDefinition[] {
  return [
    listMaterialsTool(deps),
    readMaterialTool(deps),
    queryMaterialTool(deps),
    viewMaterialTool(deps),
    recordMaterialNotesTool(deps),
  ];
}
