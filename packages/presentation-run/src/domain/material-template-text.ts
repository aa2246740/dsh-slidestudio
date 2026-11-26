/**
 * Read-only, deterministic renderings of receipt-verified PPTX template
 * details. This exposes reference facts, never source XML or imported pages.
 */
import {
  MATERIAL_CHUNK_BYTES,
  MaterialPackError,
  verifiedDesignSource,
  type VerifiedMaterial,
} from "./material-pack.js";
import { extractPeriodLabels } from "./material-periods.js";
import { loadTemplateKit } from "./template-kit.js";
import { templateKitChunks } from "./template-kit-text.js";

const TEMPLATE_PARTS = ["design", "layouts", "slides", "tables", "charts"] as const;
type TemplatePart = (typeof TEMPLATE_PARTS)[number] | "smartart" | "kit";
type RecordValue = Record<string, unknown>;

export type TemplateMaterialChunk = Readonly<{ text: string }>;
export type TemplateMaterialPart = Readonly<{
  part: TemplatePart;
  label: string;
  bytes: number;
  chunks: number;
}>;
export type TemplateMaterialPartDescriptorInput = Readonly<{
  name: string;
  derivative: Record<string, unknown>;
  designSourceMarkdown: string;
  designSourceJson: Readonly<Record<string, unknown>>;
}>;
type TemplateTextContext = TemplateMaterialPartDescriptorInput;

const PART_LABELS: Readonly<Record<TemplatePart, string>> = {
  design: "设计原语",
  layouts: "页面原型与版式线索",
  slides: "逐页文字",
  tables: "表格文字",
  charts: "图表数据",
  smartart: "SmartArt 文字结构",
  kit: "可复用模板组件",
};

const WARNED_PARTS = new Set<TemplatePart>(["slides", "charts", "smartart"]);
const WRAPPER_OPEN = "<untrusted_reference_material>";
const WRAPPER_CLOSE = "</untrusted_reference_material>";
const SLIDE_REFERENCE_WARNING = "仅作内容参考，不要把样例页当作页面导入";

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function content(value: string): string {
  // Prevent supplied text from ending the untrusted-material envelope.
  return value.replace(/<\/untrusted_reference_material/gi, "&lt;/untrusted_reference_material");
}

function slideNumber(row: RecordValue, fallback: number): number {
  const index = Number(row.index ?? row.slide);
  return Number.isSafeInteger(index) && index > 0 ? index : fallback;
}

function templateContext(material: VerifiedMaterial): TemplateTextContext {
  const source = verifiedDesignSource(material);
  return {
    name: material.name,
    derivative: material.derivative,
    designSourceMarkdown: source.markdown,
    designSourceJson: source.json,
  };
}

function templateRecords(derivative: Record<string, unknown>): {
  template: RecordValue;
  detail: RecordValue;
} {
  const template = isRecord(derivative["deck-template"]) ? derivative["deck-template"] : {};
  const detail = isRecord(template.templateDetail) ? template.templateDetail : {};
  return { template, detail };
}

function pageBox(value: unknown): string {
  const box = Array.isArray(value) ? value : isRecord(value) ? [value.x, value.y, value.w, value.h] : [];
  if (box.length !== 4 || !box.every((part) => typeof part === "number" && Number.isFinite(part))) {
    return "位置未记录";
  }
  return `左 ${percent(box[0])}、上 ${percent(box[1])}、宽 ${percent(box[2])}、高 ${percent(box[3])}`;
}

function percent(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? `${Number((number * 100).toFixed(2))}%` : "未知";
}

function pageWrapper(page: number, body: string, part: TemplatePart): string {
  const warning = WARNED_PARTS.has(part) ? `${SLIDE_REFERENCE_WARNING}\n\n` : "";
  return `${WRAPPER_OPEN}\n${warning}## 第 ${page} 页\n${body || "（没有可提取的文字）"}\n${WRAPPER_CLOSE}`;
}

function plainWrapper(body: string): string {
  return `${WRAPPER_OPEN}\n${body}\n${WRAPPER_CLOSE}`;
}

/** Split text on UTF-8 boundaries, leaving room for the stable wrapper and heading. */
function splitUtf8(textValue: string, maxBytes: number): string[] {
  if (!textValue) return [""];
  const bytes = Buffer.from(textValue, "utf8");
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    if (end < bytes.length) {
      while (end > start && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
    }
    if (end === start) throw new MaterialPackError("模板资料无法按 UTF-8 字符边界分段");
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return chunks;
}

function packPageSections(
  sections: readonly { page: number; body: string }[],
  part: TemplatePart,
): TemplateMaterialChunk[] {
  const pieces: string[] = [];
  for (const section of sections) {
    const prefixBytes = Buffer.byteLength(
      `${WRAPPER_OPEN}\n${WARNED_PARTS.has(part) ? `${SLIDE_REFERENCE_WARNING}\n\n` : ""}## 第 ${section.page} 页\n`,
      "utf8",
    );
    const suffixBytes = Buffer.byteLength(`\n${WRAPPER_CLOSE}`, "utf8");
    const maxBodyBytes = MATERIAL_CHUNK_BYTES - prefixBytes - suffixBytes;
    for (const bodyPart of splitUtf8(section.body, maxBodyBytes)) {
      const chunk = pageWrapper(section.page, bodyPart, part);
      if (Buffer.byteLength(chunk, "utf8") > MATERIAL_CHUNK_BYTES) {
        throw new MaterialPackError("模板资料分段超过 UTF-8 字节上限");
      }
      pieces.push(chunk);
    }
  }
  if (!pieces.length) {
    const warning = WARNED_PARTS.has(part) ? `${SLIDE_REFERENCE_WARNING}\n` : "";
    pieces.push(plainWrapper(`${warning}未发现可读取的${PART_LABELS[part]}。`));
  }
  const chunks: TemplateMaterialChunk[] = [];
  let current = "";
  for (const piece of pieces) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (Buffer.byteLength(candidate, "utf8") > MATERIAL_CHUNK_BYTES && current) {
      chunks.push({ text: current });
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push({ text: current });
  return chunks;
}

function plainPartChunks(body: string): TemplateMaterialChunk[] {
  const prefixBytes = Buffer.byteLength(`${WRAPPER_OPEN}\n`, "utf8");
  const suffixBytes = Buffer.byteLength(`\n${WRAPPER_CLOSE}`, "utf8");
  const parts = splitUtf8(body, MATERIAL_CHUNK_BYTES - prefixBytes - suffixBytes);
  return parts.map((part) => ({ text: plainWrapper(part) }));
}

function slidesPart(context: TemplateTextContext): TemplateMaterialChunk[] {
  const { template, detail } = templateRecords(context.derivative);
  const slides = records(detail.slides).length ? records(detail.slides) : records(template.slides);
  const sections = slides.map((slide, index) => ({
    page: slideNumber(slide, index + 1),
    body: [
      text(slide.title) ? `标题：${content(text(slide.title))}` : "",
      text(slide.text) ? `正文：\n${content(text(slide.text))}` : "",
      text(slide.tableText) ? `表格文字：\n${content(text(slide.tableText))}` : "",
      text(slide.notes) ? `备注：\n${content(text(slide.notes))}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  }));
  return packPageSections(sections, "slides");
}

function tableCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return content(String(value));
  if (isRecord(value)) return content(text(value.text) || text(value.value));
  return "";
}

function tablesPart(context: TemplateTextContext): TemplateMaterialChunk[] {
  const { detail } = templateRecords(context.derivative);
  const grouped = new Map<number, string[]>();
  for (const [index, table] of records(detail.tables).entries()) {
    const page = slideNumber(table, index + 1);
    const rows = Array.isArray(table.rows) ? table.rows : [];
    const renderedRows = rows.filter(Array.isArray).map((row) => (row as unknown[]).map(tableCell).join("\t"));
    const title = text(table.id) ? `表格 ${content(text(table.id))}` : `表格 ${index + 1}`;
    const lines = [title, ...renderedRows].join("\n");
    const existing = grouped.get(page) ?? [];
    existing.push(lines);
    grouped.set(page, existing);
  }
  return packPageSections(
    [...grouped].map(([page, bodies]) => ({ page, body: bodies.join("\n\n") })),
    "tables",
  );
}

const CHART_TYPE_ZH: Readonly<Record<string, string>> = {
  area: "面积图",
  bar: "柱状图",
  doughnut: "环形图",
  line: "折线图",
  pie: "饼图",
  radar: "雷达图",
  scatter: "散点图",
  combination: "组合图",
};

/** Template chart types PPTD draws and exports; stacked bars are bar charts with a grouping. */
const SUPPORTED_TEMPLATE_CHART_TYPES = new Set([
  "area",
  "bar",
  "combination",
  "doughnut",
  "line",
  "pie",
  "radar",
  "scatter",
]);

function unsupportedChartNotes(chart: RecordValue): string[] {
  const type = text(chart.type) || "unknown";
  if (SUPPORTED_TEMPLATE_CHART_TYPES.has(type)) return [];
  return [`兼容性：PPTD 暂不支持此图表类型（${type}）；如改用其他图表，交付说明需披露替代。`];
}

function chartsPart(context: TemplateTextContext): TemplateMaterialChunk[] {
  const { template, detail } = templateRecords(context.derivative);
  const slides = records(detail.slides).length ? records(detail.slides) : records(template.slides);
  const grouped = new Map<number, string[]>();
  for (const [index, chart] of records(detail.charts).entries()) {
    const page = slideNumber(chart, index + 1);
    const slide = slides.find((item, slideIndex) => slideNumber(item, slideIndex + 1) === page);
    const periods = extractPeriodLabels(
      [
        slide?.title,
        slide?.text,
        slide?.notes,
        chart.title,
        ...records(chart.series).flatMap((series) => (Array.isArray(series.categories) ? series.categories : [])),
      ]
        .filter((value) => typeof value === "string")
        .join("\n"),
    );
    const type = text(chart.type) || "unknown";
    const grouping = text(chart.grouping);
    const lines = [
      `图表 ${index + 1} · ${content(CHART_TYPE_ZH[type] ?? type)}${grouping ? ` · ${content(grouping)}` : ""}`,
      `图表标识：${content(text(chart.id) || `chart-${index + 1}`)}`,
      `来源页标题：${content(text(slide?.title)) || "未记录"}`,
      `图表标题：${content(text(chart.title)) || "未记录"}`,
      `源页期间：${periods.length ? content(periods.join("、")) : "未声明，请先读取 slides 核对，不能推定为本期"}`,
      "复用口径：类别、顺序、期间、单位必须与数值一起保留；未提供本期数据时，不能把原数标成本期。若另用非模板数据，须有真实来源或获准的新示意数值，并用 provenance 的 basis/materials/quoted/note 准确声明。",
      ...unsupportedChartNotes(chart).map((note) => `- ${note}`),
      ...records(chart.series).map((series, seriesIndex) => {
        const name = text(series.name) || `系列 ${seriesIndex + 1}`;
        return `- 系列「${content(name)}」：类别 ${content(JSON.stringify(series.categories ?? []))}；数值 ${content(JSON.stringify(series.values ?? []))}；数值格式 ${content(text(series.numFmt) || "未声明")}`;
      }),
    ];
    const existing = grouped.get(page) ?? [];
    existing.push(lines.join("\n"));
    grouped.set(page, existing);
  }
  return packPageSections(
    [...grouped].map(([page, bodies]) => ({ page, body: bodies.join("\n\n") })),
    "charts",
  );
}

function nodeLines(nodes: unknown, depth = 0): string[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const label = text(raw.text);
    const line = label ? [`${"  ".repeat(Math.min(depth, 8))}- ${content(label)}`] : [];
    return [...line, ...nodeLines(raw.children, depth + 1)];
  });
}

function smartArtPart(context: TemplateTextContext): TemplateMaterialChunk[] {
  const { detail } = templateRecords(context.derivative);
  const diagrams = records(detail.smartArts);
  const grouped = new Map<number, string[]>();
  for (const diagram of diagrams) {
    const page = slideNumber(diagram, 1);
    const id = text(diagram.id) || "未命名";
    const layout = text(diagram.layout) || text(isRecord(diagram.layout) ? diagram.layout.family : "");
    const cache = text(diagram.cache);
    const box = pageBox(diagram.box);
    const title = text(diagram.name) ? `「${content(text(diagram.name))}」` : "";
    const summary = `SmartArt ${content(id)}${title} · ${content(layout || "其他")} · ${Number(diagram.nodeCount) || 0} 项 · 框 ${box}`;
    const tree = nodeLines(diagram.nodes).join("\n");
    const component = cache === "drawing" ? `组件 id：smartart.${content(id)}` : "没有缓存图形，只能读取文字";
    const existing = grouped.get(page) ?? [];
    existing.push([summary, component, tree].filter(Boolean).join("\n"));
    grouped.set(page, existing);
  }
  return packPageSections(
    [...grouped].map(([page, bodies]) => ({ page, body: bodies.join("\n\n") })),
    "smartart",
  );
}

function templatePartChunks(context: TemplateTextContext, part: TemplatePart): TemplateMaterialChunk[] {
  switch (part) {
    case "design":
      return [];
    case "layouts":
      return plainPartChunks(renderLayouts(context));
    case "slides":
      return slidesPart(context);
    case "tables":
      return tablesPart(context);
    case "charts":
      return chartsPart(context);
    case "smartart":
      return smartArtPart(context);
    case "kit": {
      const kit = loadTemplateKit(context.derivative);
      return kit ? templateKitChunks(kit).map((text) => ({ text })) : [];
    }
  }
}

function renderLayouts(context: TemplateTextContext): string {
  const { template, detail } = templateRecords(context.derivative);
  const archetypes = records(detail.archetypes).length ? records(detail.archetypes) : records(template.archetypes);
  const layouts = records(context.designSourceJson.layouts);
  const lines = ["页面原型（仅为位置与用途描述，不是可导入版式）："];
  for (const archetype of archetypes) {
    const slideList = Array.isArray(archetype.slides)
      ? archetype.slides.map((slide) => content(String(slide))).join("、")
      : "";
    lines.push(
      `- ${content(text(archetype.id) || "原型")} · ${content(text(archetype.kind) || "未分类")} · 第 ${slideList || "未知"} 页`,
    );
    for (const slot of records(archetype.slots)) {
      lines.push(`  - ${content(text(slot.role) || "内容区")}：${pageBox(slot.box)}`);
    }
  }
  lines.push("", "模板占位符位置（百分比，仅作参考）：");
  for (const layout of layouts) {
    lines.push(`- ${content(text(layout.name) || "未命名版式")}（${content(text(layout.type) || "custom")}）`);
    for (const placeholder of records(layout.placeholders)) {
      lines.push(`  - ${content(text(placeholder.type) || "placeholder")}：${pageBox(placeholder.box)}`);
    }
    for (const decoration of records(layout.decorations)) {
      const kind = text(decoration.kind) === "line" ? "线（line）" : "形状（shape）";
      lines.push(`  - 装饰${kind}：${pageBox(decoration.box)}`);
    }
  }
  if (!archetypes.length && !layouts.length) lines.push("- 未发现页面原型或占位符。");
  return lines.join("\n");
}

function availableParts(context: TemplateTextContext): TemplatePart[] {
  // A theme file has colours and fonts and nothing to read page by page.
  if (isRecord(context.derivative.parser) && context.derivative.parser.id === "thmx-theme-v1") {
    return ["design"];
  }
  const { detail } = templateRecords(context.derivative);
  const parts: TemplatePart[] = [...TEMPLATE_PARTS];
  if (records(detail.smartArts).length) parts.push("smartart");
  if (loadTemplateKit(context.derivative)) parts.push("kit");
  return parts;
}

function assertAvailablePart(context: TemplateTextContext, part: string): asserts part is TemplatePart {
  const available = availableParts(context);
  if (available.includes(part as TemplatePart)) return;
  const missing = part === "smartart" ? "SmartArt " : "";
  throw new MaterialPackError(
    `资料「${context.name}」没有 ${missing}part「${part}」；可用 part：${available.join("、")}`,
  );
}

function rawChunks(textValue: string): TemplateMaterialChunk[] {
  const bytes = Buffer.from(textValue, "utf8");
  if (!bytes.length) return [];
  return splitUtf8(textValue, MATERIAL_CHUNK_BYTES).map((chunk) => ({ text: chunk }));
}

function partDescriptors(context: TemplateTextContext): readonly TemplateMaterialPart[] {
  return availableParts(context).map((part) => {
    const chunks = part === "design" ? rawChunks(context.designSourceMarkdown) : templatePartChunks(context, part);
    const bytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, "utf8"), 0);
    return {
      part,
      label: `${PART_LABELS[part]} · ${chunks.length} 段 · ${bytes.toLocaleString("zh-CN")} 字节`,
      bytes,
      chunks: chunks.length,
    };
  });
}

/** Available parts and the exact UTF-8 size/chunk count exposed by read_material. */
export function templateMaterialPartDescriptors(material: VerifiedMaterial): readonly TemplateMaterialPart[] {
  return partDescriptors(templateContext(material));
}

/** Same descriptors for a just-written source whose intake receipt is already verified. */
export function templateMaterialPartDescriptorsFromData(
  input: TemplateMaterialPartDescriptorInput,
): readonly TemplateMaterialPart[] {
  return partDescriptors(input);
}

/** Deterministic complete rendering for a template part. */
export function templateMaterialPartText(material: VerifiedMaterial, part: string): string {
  const context = templateContext(material);
  assertAvailablePart(context, part);
  if (part === "design") return context.designSourceMarkdown;
  const chunks = templatePartChunks(context, part);
  return chunks.map((chunk) => chunk.text).join("\n\n");
}

/** Chunks for a template part, with stable boundaries and bounded UTF-8 sizes. */
export function templateMaterialChunks(material: VerifiedMaterial, part: string): readonly TemplateMaterialChunk[] {
  const context = templateContext(material);
  assertAvailablePart(context, part);
  if (part === "design") return rawChunks(context.designSourceMarkdown);
  return templatePartChunks(context, part);
}
