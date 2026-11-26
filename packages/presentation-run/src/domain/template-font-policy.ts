import { normalizeFontFamily, type FontPair } from "@open-slidestudio/pptd-v2";
import { currentAdoptedSourceSelection } from "./design-adoption.js";
import { readDesignAspects, sourceDesignAspects } from "./design-aspects.js";
import { MaterialPackError, verifiedDesignSource, verifyMaterial } from "./material-pack.js";
import { selectedStylePackId } from "./style-pack-priority.js";

export type TemplateFontPolicy = Readonly<{
  sourceId: string;
  pair: FontPair;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mappedPair(value: unknown): FontPair | undefined {
  const mapped = record(value);
  if (typeof mapped.latin !== "string" || typeof mapped.ea !== "string") return undefined;
  const normalized = normalizeFontFamily({ latin: mapped.latin, ea: mapped.ea });
  if (normalized.note || typeof normalized.fontFamily === "string") return undefined;
  return normalized.fontFamily;
}

/**
 * Resolve the first adopted template that the Agent explicitly selected for
 * fonts. The pair comes only from receipt-verified design metadata.
 */
export function adoptedTemplateFontPolicy(root: string): TemplateFontPolicy | undefined {
  if (selectedStylePackId(root)) return undefined;
  const selection = currentAdoptedSourceSelection(root);
  const declarations = readDesignAspects(root);
  for (const sourceId of selection) {
    if (!sourceId.startsWith("material:")) continue;
    const materialId = sourceId.slice("material:".length);
    // Only a source declared for fonts is verified here; a palette-only image keeps its own
    // pack_color receipt refusal instead of a font-policy message.
    if (!sourceDesignAspects(declarations, sourceId).includes("fonts")) continue;
    const material = verifyMaterial(root, materialId);
    if (material.kind !== "deck-template") continue;

    let design: Record<string, unknown>;
    try {
      design = verifiedDesignSource(material).json;
    } catch {
      throw new MaterialPackError("已采用的设计源字体信息无法通过回执校验，请重新上传后再试");
    }
    const usedFonts = Array.isArray(design.fontsUsed) ? design.fontsUsed : [];
    const usedPair = usedFonts.length ? mappedPair(record(usedFonts[0]).mapped) : undefined;
    if (usedFonts.length && !usedPair) {
      throw new MaterialPackError("已采用的设计源缺少有效的映射字体，请重新上传后再试");
    }
    if (usedPair) return { sourceId, pair: usedPair };

    const sourceFonts = record(design.sourceFonts);
    const mappedFonts = Object.keys(sourceFonts).length ? sourceFonts : record(design.fonts);
    const pair = mappedPair(record(mappedFonts.major).mapped) ?? mappedPair(record(mappedFonts.minor).mapped);
    if (!pair) {
      throw new MaterialPackError("已采用的设计源缺少有效的主题字体映射，请重新上传后再试");
    }
    return { sourceId, pair };
  }
  return undefined;
}
