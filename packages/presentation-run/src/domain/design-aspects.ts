/** Agent-declared uses of each source. Never inferred from the brief. */
import fs from "node:fs";
import path from "node:path";
import { canonicalDesignSourceId } from "./theme-pack.js";
import { verifyMaterial, type VerifiedMaterial } from "./material-pack.js";
import { attachmentStylePriorityRefusal, selectedStylePackId } from "./style-pack-priority.js";

export const DESIGN_ASPECTS = [
  "palette",
  "fonts",
  "logo",
  "layouts",
  "decorations",
  "photos",
  "content",
  "data",
] as const;
export type DesignAspect = (typeof DESIGN_ASPECTS)[number];
export type DesignAspectDeclaration = Readonly<{
  source: string;
  aspects: readonly DesignAspect[];
}>;
export type DesignAspects = readonly DesignAspectDeclaration[];
export const DEFAULT_TEMPLATE_ASPECTS: readonly DesignAspect[] = ["palette", "fonts", "logo"];
/** A `.thmx` theme file carries a colour scheme and two fonts, so nothing else can be adopted from it. */
const THEME_FILE_ASPECTS: readonly DesignAspect[] = ["palette", "fonts"];
const THEME_FILE_PARSER = "thmx-theme-v1";

export function isThemeFile(material: Pick<VerifiedMaterial, "parser">): boolean {
  return material.parser === THEME_FILE_PARSER;
}

/** What selecting a template without any declaration adopts from it. */
export function defaultTemplateAspects(material: Pick<VerifiedMaterial, "parser">): readonly DesignAspect[] {
  return isThemeFile(material) ? THEME_FILE_ASPECTS : DEFAULT_TEMPLATE_ASPECTS;
}

const VISUAL_ASPECTS = new Set<DesignAspect>(["palette", "fonts", "logo", "layouts", "decorations", "photos"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeAspects(value: unknown): readonly DesignAspect[] {
  if (!Array.isArray(value) || value.some((aspect) => !DESIGN_ASPECTS.includes(aspect))) {
    throw new Error(`用途无效，可用用途：${DESIGN_ASPECTS.join("、")}`);
  }
  return [...new Set(value)] as DesignAspect[];
}

function rowsFromValue(value: unknown): Array<{ source: string; aspects: unknown }> {
  if (Array.isArray(value)) {
    if (!value.length) return [];
    if (value.every((item) => typeof item === "string")) {
      throw new Error("designAspects 必须按来源声明，请使用 [{source, aspects}]");
    }
    return value.map((item) => {
      const row = record(item);
      if (typeof row.source !== "string" || !Array.isArray(row.aspects)) {
        throw new Error("designAspects 每项必须包含字符串 source 和 aspects 数组");
      }
      return { source: row.source, aspects: row.aspects };
    });
  }
  if (value && typeof value === "object") {
    return Object.entries(record(value)).map(([source, aspects]) => ({ source, aspects }));
  }
  if (value === undefined) return [];
  throw new Error("designAspects 必须是按来源声明的数组");
}

type DesignAspectSource = Pick<VerifiedMaterial, "kind" | "parser" | "name"> &
  Partial<Pick<VerifiedMaterial, "derivative" | "originalExtension">>;

function isPdf(material: DesignAspectSource): boolean {
  if (material.kind !== "document") return false;
  if (material.parser.startsWith("pdf-unpdf-")) return true;
  if (material.parser.startsWith("docx-ooxml-")) return false;
  const source = record(record(material.derivative).source);
  const mime = typeof source.detectedMime === "string" ? source.detectedMime : "";
  if (mime) return mime === "application/pdf";
  return material.originalExtension === ".pdf";
}

function allowedAspects(material: DesignAspectSource, hasStylePack: boolean): readonly DesignAspect[] {
  switch (material.kind) {
    case "deck-template":
      return isThemeFile(material) ? THEME_FILE_ASPECTS : DESIGN_ASPECTS;
    case "image":
      return ["palette"];
    case "document":
      return isPdf(material)
        ? hasStylePack
          ? ["content", "data"]
          : ["palette", "content", "data"]
        : ["content", "data"];
    case "table":
      return ["data"];
    case "text":
      return ["content", "data"];
  }
}

function aspectLabel(aspect: DesignAspect): string {
  switch (aspect) {
    case "palette":
      return "配色";
    case "fonts":
      return "字体";
    case "logo":
      return "Logo";
    case "layouts":
      return "版式";
    case "decorations":
      return "装饰";
    case "photos":
      return "照片";
    case "content":
      return "内容";
    case "data":
      return "数据";
  }
}

export function designAspectRefusal(
  material: DesignAspectSource,
  aspects: readonly DesignAspect[],
  hasStylePack = false,
): string | undefined {
  const allowed = allowedAspects(material, hasStylePack);
  const rejected = aspects.find((aspect) => !allowed.includes(aspect));
  if (!rejected) return undefined;
  if (material.kind === "image") {
    return `图片「${material.name}」只能作为配色来源（palette），不能用于 ${rejected}`;
  }
  if (isPdf(material) && rejected === "palette" && hasStylePack) {
    return `PDF「${material.name}」在当前目录风格限制下不能作为配色来源（palette）；若用户明确要求，请先声明 designAuthority: material:<id>，再由该决定采用它的配色。`;
  }
  if (isThemeFile(material)) {
    return `主题文件「${material.name}」只提供配色和字体（palette、fonts），不支持「${aspectLabel(rejected)}（${rejected}）」用途`;
  }
  const sourceKind = isPdf(material)
    ? "PDF"
    : material.kind === "deck-template"
      ? "PPT 模板"
      : material.kind === "document"
        ? "文档"
        : material.kind === "table"
          ? "表格"
          : "文本";
  const available = allowed.length ? allowed.join("、") : "无";
  const referenceOnly =
    isPdf(material) && (rejected === "layouts" || rejected === "decorations")
      ? "；PDF 的版式和装饰只作参考，不能采用"
      : "";
  // CAP-33: a Word theme is a hint, never an adoptable palette.
  const wordClue =
    !isPdf(material) && material.kind === "document" && rejected === "palette"
      ? "；Word 主题色只作风格线索，不作为设计来源"
      : "";
  return `${sourceKind}「${material.name}」不支持「${aspectLabel(rejected)}（${rejected}）」用途，可用用途：${available}${referenceOnly}${wordClue}`;
}

export function readDesignAspects(root: string): unknown {
  const file = path.join(root, "_agent", "runtime.json");
  if (!fs.existsSync(file)) return undefined;
  const value = record(JSON.parse(fs.readFileSync(file, "utf8"))).designAspects;
  if (value !== undefined && value !== null && typeof value !== "object") {
    throw new Error("保存的设计用途无效，请重新提交 designAspects");
  }
  return value;
}

/** The prior map shape remains readable for projects created before this parameter was standardized. */
export function sourceDesignAspects(
  value: unknown,
  sourceId: string,
  fallback: readonly DesignAspect[] = [],
): readonly DesignAspect[] {
  const source = canonicalDesignSourceId(sourceId) ?? sourceId;
  let raw: unknown;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      raw = value;
    } else {
      const row = value.map(record).find((entry) => canonicalDesignSourceId(String(entry.source ?? "")) === source);
      raw = row?.aspects;
    }
  } else {
    raw = Object.entries(record(value)).find(([id]) => (canonicalDesignSourceId(id) ?? id) === source)?.[1];
  }
  if (raw === undefined) return fallback;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (aspect): aspect is DesignAspect => typeof aspect === "string" && DESIGN_ASPECTS.includes(aspect as DesignAspect),
  );
}

export function resolveDesignAspects(
  root: string,
  selected: readonly string[],
  requested: unknown,
  designSystemId?: string,
): DesignAspects {
  const packId = selectedStylePackId(root, designSystemId);
  const rows = rowsFromValue(requested);
  const result: DesignAspectDeclaration[] = [];
  const seen = new Set<string>();
  const adopted = new Set(selected.map((id) => canonicalDesignSourceId(id) ?? id));
  for (const row of rows) {
    const id = canonicalDesignSourceId(row.source);
    if (!id) throw new Error(`无法声明设计用途：设计源「${row.source}」编号无效`);
    if (seen.has(id)) throw new Error(`设计源「${row.source}」重复声明用途，请合并后重试`);
    seen.add(id);
    const aspects = normalizeAspects(row.aspects);
    let material: VerifiedMaterial;
    try {
      material = verifyMaterial(root, id.slice("material:".length));
    } catch {
      // Let the source preflight produce the canonical Chinese receipt and alias-aware id.
      result.push({ source: id, aspects });
      continue;
    }
    const refusal =
      attachmentStylePriorityRefusal(packId, material.name, aspects) ??
      designAspectRefusal(material, aspects, Boolean(packId));
    if (refusal) throw new Error(refusal);
    if (aspects.some((aspect) => VISUAL_ASPECTS.has(aspect)) && !adopted.has(id)) {
      throw new Error(`采用「${material.name}」的视觉用途前，请将 ${id} 加入 adoptedSourceIds`);
    }
    result.push({ source: id, aspects });
  }
  for (const rawId of selected) {
    const id = canonicalDesignSourceId(rawId);
    if (!id || seen.has(id)) continue;
    let material: VerifiedMaterial;
    try {
      material = verifyMaterial(root, id.slice("material:".length));
    } catch {
      // The source preflight reports invalid or missing material ids.
      continue;
    }
    if (material.kind !== "deck-template") continue;
    const defaults = defaultTemplateAspects(material);
    const refusal = attachmentStylePriorityRefusal(packId, material.name, defaults);
    if (refusal) throw new Error(refusal);
    seen.add(id);
    result.push({ source: id, aspects: defaults });
  }
  return result;
}

export function paletteSourceIds(ids: readonly string[], aspects: DesignAspects): string[] {
  return ids.filter((id) => {
    const source = canonicalDesignSourceId(id);
    return source ? sourceDesignAspects(aspects, source).includes("palette") : true;
  });
}

/** Omission retains known declarations, even when the ordered visual selection changes. */
export function resolvePlanningDesignAspects(
  root: string,
  selected: readonly string[],
  args: Record<string, unknown>,
  designSystemId?: string,
): DesignAspects {
  if (Object.prototype.hasOwnProperty.call(args, "designAspects")) {
    return resolveDesignAspects(root, selected, args.designAspects, designSystemId);
  }
  const previous = readDesignAspects(root);
  const carried: Array<{ source: string; aspects: readonly DesignAspect[] }> = [];
  for (const row of rowsFromValue(previous)) {
    const id = canonicalDesignSourceId(row.source);
    if (!id) continue;
    const aspects = normalizeAspects(row.aspects);
    const retained = selected.some((selectedId) => canonicalDesignSourceId(selectedId) === id)
      ? aspects
      : aspects.filter((aspect) => aspect === "content" || aspect === "data");
    if (retained.length) carried.push({ source: id, aspects: retained });
  }
  return resolveDesignAspects(root, selected, carried, designSystemId);
}
