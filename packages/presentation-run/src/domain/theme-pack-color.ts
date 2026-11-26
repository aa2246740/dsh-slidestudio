import {
  DEFAULT_TEMPLATE_ASPECTS,
  readDesignAspects,
  sourceDesignAspects,
  type DesignAspect,
} from "./design-aspects.js";
import { MaterialPackError, verifiedDesignSource, verifyMaterial } from "./material-pack.js";
import { nonAdoptableMaterialMessage } from "./material-style-hints.js";
import { modelPolicyExtraPaletteHexes } from "./model-policy-profile.js";
import { paletteSourcePackHexes } from "./palette-source.js";
import { userPaletteWithVariants } from "./palette-variants.js";
import { selectedStylePackId } from "./style-pack-priority.js";
import {
  catalogPackPaletteHexes,
  extractColorPaletteHexes,
  type PackColorWriteContext,
  chosenThemePacksFrom,
} from "./theme-pack.js";
import { userColorPalette } from "./user-colors.js";

function jsonPalette(source: Readonly<Record<string, unknown>>): Set<string> {
  const themeColors = source.themeColors;
  const out = new Set<string>();
  if (themeColors && typeof themeColors === "object" && !Array.isArray(themeColors)) {
    for (const value of Object.values(themeColors as Record<string, unknown>)) {
      if (typeof value === "string" && /^#[0-9A-F]{6}$/i.test(value)) out.add(value.toUpperCase());
    }
  }
  const observedColors = Array.isArray(source.observedColors) ? source.observedColors : [];
  for (const observed of observedColors) {
    const hex =
      typeof observed === "string"
        ? observed
        : observed && typeof observed === "object" && !Array.isArray(observed)
          ? (observed as Record<string, unknown>).hex
          : undefined;
    if (typeof hex === "string" && /^#[0-9A-F]{6}$/i.test(hex)) out.add(hex.toUpperCase());
  }
  return out;
}

function sameHexes(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((hex) => right.has(hex));
}

function designSourcePaletteError(
  designSources: readonly string[],
  projectRoot: string | undefined,
  adoptedPackHexes: Set<string>,
): string | undefined {
  if (!designSources.length) return undefined;
  if (!projectRoot) return "无法验证项目中的已采用的设计源回执，请重新上传后再试";
  for (const sourceId of designSources) {
    const materialId = sourceId.slice("material:".length);
    try {
      const material = verifyMaterial(projectRoot, materialId);
      const palette = paletteSourcePackHexes(material);
      if (palette) {
        for (const hex of palette) adoptedPackHexes.add(hex);
        continue;
      }
      if (material.kind !== "deck-template") {
        throw new MaterialPackError(nonAdoptableMaterialMessage(material));
      }
      const source = verifiedDesignSource(material);
      const markdownHexes = new Set(extractColorPaletteHexes(source.markdown).map((hex) => hex.toUpperCase()));
      const jsonHexes = jsonPalette(source.json);
      if (!markdownHexes.size || !sameHexes(markdownHexes, jsonHexes)) {
        throw new MaterialPackError(`资料「${material.name}」设计源色板与回执数据不一致，请重新上传后再发送`);
      }
      for (const hex of userPaletteWithVariants(markdownHexes)) adoptedPackHexes.add(hex);
    } catch (error) {
      return (
        `已采用的设计源「${sourceId}」无法通过回执校验：` +
        `${error instanceof Error ? error.message : "资料校验失败"}。请重新上传后再试`
      );
    }
  }
  return undefined;
}

function unadoptedCatalogHexes(
  catalog: ReadonlyMap<string, ReadonlySet<string>>,
  adopted: readonly string[],
  adoptedPackHexes: ReadonlySet<string>,
): Set<string> {
  const otherPackHexes = new Set<string>();
  const adoptedSet = new Set(adopted);
  for (const [id, hexes] of catalog) {
    if (adoptedSet.has(id)) continue;
    for (const hex of hexes) {
      if (!adoptedPackHexes.has(hex)) otherPackHexes.add(hex);
    }
  }
  return otherPackHexes;
}

/**
 * Build the palette from adopted catalog packs and receipt-verified user
 * design sources. A user palette receives the documented deterministic
 * 20/40/60% white tints and black shades.
 */
export function packColorWriteContext(sourceIds: readonly string[], projectRoot?: string): PackColorWriteContext {
  const chosen = chosenThemePacksFrom({ adoptedSourceIds: sourceIds });
  const adopted = [...new Set(chosen.filter((row) => row.family !== "user").map((row) => row.id))];
  const runtimeAspects = projectRoot ? readDesignAspects(projectRoot) : undefined;
  const designSources = [...new Set(chosen.filter((row) => row.family === "user").map((row) => row.id))].filter(
    (id) => {
      if (projectRoot && selectedStylePackId(projectRoot)) return false;
      let fallback: readonly DesignAspect[] = projectRoot ? [] : DEFAULT_TEMPLATE_ASPECTS;
      if (projectRoot) {
        try {
          if (verifyMaterial(projectRoot, id.slice("material:".length)).kind === "deck-template") {
            fallback = DEFAULT_TEMPLATE_ASPECTS;
          }
        } catch {
          // Keep an invalid selection in the validation path below; it grants no color.
          fallback = DEFAULT_TEMPLATE_ASPECTS;
        }
      }
      return sourceDesignAspects(runtimeAspects, id, fallback).includes("palette");
    },
  );
  if (!adopted.length && !designSources.length) return {};
  const catalog = catalogPackPaletteHexes();
  const adoptedPackHexes = new Set<string>();
  for (const id of adopted) {
    const hexes = catalog.get(id);
    if (!hexes) continue;
    for (const hex of hexes) adoptedPackHexes.add(hex);
  }
  // Palette hexes come only from the adopted ids passed in, never from
  // other deck-template materials that happen to be attached.
  const materialError = designSourcePaletteError(designSources, projectRoot, adoptedPackHexes);
  // User colours widen an existing restriction; they never create one.
  if (projectRoot && adoptedPackHexes.size) {
    for (const hex of userColorPalette(projectRoot)) adoptedPackHexes.add(hex);
  }
  // Permissive model policy only widens a palette that is already adopted.
  if (adoptedPackHexes.size) {
    for (const hex of modelPolicyExtraPaletteHexes()) adoptedPackHexes.add(hex);
  }
  if (!adoptedPackHexes.size && !materialError) return {};
  const otherPackHexes = unadoptedCatalogHexes(catalog, adopted, adoptedPackHexes);
  return {
    adoptedPackId: designSources.length ? "已采用的设计源" : adopted[0],
    adoptedPackHexes: adoptedPackHexes.size ? adoptedPackHexes : undefined,
    otherPackHexes: otherPackHexes.size ? otherPackHexes : undefined,
    ...(designSources.length ? { adoptedDesignSourceIds: designSources } : {}),
    ...(materialError ? { materialError } : {}),
    ...(projectRoot ? { templateKitRoot: projectRoot } : {}),
  };
}
