/**
 * Palette sources: images, logos, screenshots and (in Freestyle) PDFs expose the
 * colours measured at upload as a `palette` part. The Host only reports what the
 * receipt-verified derivative holds; it never picks or invents a colour.
 */
import { MaterialPackError, type VerifiedMaterial } from "./material-pack.js";
import { isPdfMaterial } from "./material-style-hints.js";
import { hexVariants, USER_DESIGN_TINT_SHADE_PERCENTAGES, userPaletteWithVariants } from "./palette-variants.js";

export const PALETTE_PART = "palette";
/** Theme scheme slots a palette source can fill, in order. */
export const PALETTE_THEME_SLOTS = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"] as const;
/** Page-pixel accents closer than this (RGB distance) to a vector accent add no new theme slot. */
const NEAR_DUPLICATE_DISTANCE = 40;

export type PaletteMaterial = Pick<VerifiedMaterial, "kind" | "parser" | "name" | "derivative"> &
  Partial<Pick<VerifiedMaterial, "originalExtension" | "mediaSrc">>;

type BlockSource = "image-pixels" | "pdf-vector-ops" | "pdf-page-pixels";
export type PaletteBlock = Readonly<{
  source: BlockSource;
  accents: readonly Readonly<{ hex: string; share?: number }>[];
  neutrals: readonly string[];
  background?: string;
  pairs: readonly Readonly<{ fg: string; bg: string; ratio: number }>[];
  pagesScanned?: number;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^#([0-9A-Fa-f]{6})$/.exec(value.trim());
  return match?.[1] ? `#${match[1].toUpperCase()}` : undefined;
}

function hexList(value: unknown, limit: number): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const hex = cleanHex(typeof item === "string" ? item : record(item).hex);
    if (hex && !out.includes(hex)) out.push(hex);
    if (out.length >= limit) break;
  }
  return out;
}

function blockOf(profile: unknown, expected: BlockSource): PaletteBlock | undefined {
  const value = record(profile);
  if (value.schema !== "style-profile/v1" || value.source !== expected) return undefined;
  const accents: { hex: string; share?: number }[] = [];
  for (const item of Array.isArray(value.accentColors) ? value.accentColors : []) {
    const color = record(item);
    const hex = cleanHex(color.hex);
    if (!hex || accents.some((entry) => entry.hex === hex)) continue;
    const share = typeof color.share === "number" && color.share >= 0 && color.share <= 1 ? color.share : undefined;
    accents.push(share === undefined ? { hex } : { hex, share });
    if (accents.length >= 10) break;
  }
  const pairs = (Array.isArray(value.contrastPairs) ? value.contrastPairs : []).flatMap((item) => {
    const pair = record(item);
    const fg = cleanHex(pair.fg);
    const bg = cleanHex(pair.bg);
    return fg && bg && typeof pair.ratio === "number" ? [{ fg, bg, ratio: pair.ratio }] : [];
  });
  const background = cleanHex(value.background);
  return {
    source: expected,
    accents,
    neutrals: hexList(value.neutralColors, 12),
    ...(background ? { background } : {}),
    pairs: pairs.slice(0, 5),
    ...(typeof value.pagesScanned === "number" ? { pagesScanned: value.pagesScanned } : {}),
  };
}

export function paletteKind(material: PaletteMaterial): "image" | "pdf" | undefined {
  if (material.kind === "image") return "image";
  return isPdfMaterial(material) ? "pdf" : undefined;
}

/** Measured colour blocks in reading order: vector colours before page-pixel colours. */
export function paletteBlocks(material: PaletteMaterial): readonly PaletteBlock[] {
  const kind = paletteKind(material);
  if (kind === "image") {
    const block = blockOf(record(material.derivative.image).styleProfile, "image-pixels");
    return block ? [block] : [];
  }
  if (kind !== "pdf") return [];
  const profile = record(record(material.derivative.document).styleProfile);
  const vector = blockOf(profile, "pdf-vector-ops");
  const pixels = blockOf(profile.pagePixels ?? profile, "pdf-page-pixels");
  return [vector, pixels].filter((block): block is PaletteBlock => Boolean(block));
}

function distance(left: string, right: string): number {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  return Math.hypot(
    channel(left, 1) - channel(right, 1),
    channel(left, 3) - channel(right, 3),
    channel(left, 5) - channel(right, 5),
  );
}

/** Accents in theme order. A second source adds an accent only when it is visibly different. */
export function paletteThemeAccents(material: PaletteMaterial): readonly string[] {
  const chosen: string[] = [];
  paletteBlocks(material).forEach((block, index) => {
    for (const { hex } of block.accents) {
      if (chosen.length >= PALETTE_THEME_SLOTS.length) return;
      if (chosen.includes(hex)) continue;
      if (index > 0 && chosen.some((known) => distance(known, hex) < NEAR_DUPLICATE_DISTANCE)) continue;
      chosen.push(hex);
    }
  });
  return chosen;
}

/** Every colour the palette part prints, before tints and shades. Undefined for other kinds. */
export function paletteSourceHexes(material: PaletteMaterial): Set<string> | undefined {
  if (!paletteKind(material)) return undefined;
  const hexes = new Set<string>();
  for (const block of paletteBlocks(material)) {
    for (const { hex } of block.accents) hexes.add(hex);
    for (const hex of block.neutrals) hexes.add(hex);
    if (block.background) hexes.add(block.background);
  }
  return hexes;
}

export function paletteUnavailableReason(material: PaletteMaterial): string | undefined {
  const kind = paletteKind(material);
  if (!kind || paletteBlocks(material).some((block) => block.accents.length)) return undefined;
  return kind === "image"
    ? `图片「${material.name}」没有提取到可用的强调色（可能是纯黑白、灰度或颜色过于分散的图片），不能作为配色来源；要把它放进页面，请直接用 mediaSrc。`
    : `PDF「${material.name}」没有提取到可用的强调色（矢量图形和页面图片里都没有取到），不能作为配色来源；仍可读取它的文字。`;
}

/** pack_color palette of an adopted source: printed colours plus the documented tints and shades. */
export function paletteSourcePackHexes(material: PaletteMaterial): Set<string> | undefined {
  const base = paletteSourceHexes(material);
  if (!base) return undefined;
  const reason = paletteUnavailableReason(material);
  if (reason) throw new MaterialPackError(reason);
  return userPaletteWithVariants(base);
}

function percent(share: number | undefined): string {
  return share === undefined ? "" : ` · ${Math.round(share * 1000) / 10}%`;
}

function accentLines(block: PaletteBlock): string[] {
  const lines = block.accents.map((accent, index) => `${index + 1}. ${accent.hex}${percent(accent.share)}`);
  return [
    ...(lines.length ? lines : ["（没有提取到强调色）"]),
    ...(block.neutrals.length ? [`中性色：${block.neutrals.join("、")}`] : []),
    ...(block.background ? [`背景色：${block.background}`] : []),
    ...block.pairs.map((pair) => `对比搭配：${pair.fg} 在 ${pair.bg} 上，对比度 ${pair.ratio}`),
  ];
}

const BLOCK_TITLE: Record<BlockSource, string> = {
  "image-pixels": "图片像素里的颜色",
  "pdf-vector-ops": "矢量图形里的颜色",
  "pdf-page-pixels": "页面图片里的颜色",
};

function variantLines(material: PaletteMaterial): string[] {
  const blocks = paletteBlocks(material);
  const accents = blocks.flatMap((block) => block.accents.map((entry) => entry.hex));
  const lines = [...new Set(accents)].map((hex) => {
    const { tints, shades } = hexVariants(hex);
    return `${hex} 浅 ${tints.join(" ")}｜深 ${shades.join(" ")}`;
  });
  // A palette without a near-black still has dark text colours: the black mixes of its neutrals.
  const neutrals = blocks.flatMap((block) => [...block.neutrals, ...(block.background ? [block.background] : [])]);
  const darkNeutrals = [...new Set(neutrals.flatMap((hex) => hexVariants(hex).shades))].sort(
    (left, right) => channelSum(left) - channelSum(right),
  );
  return lines.length
    ? [
        `强调色的浅色/深色变体（与白色、黑色按 ${USER_DESIGN_TINT_SHADE_PERCENTAGES.join("%、")}% 混合）：`,
        ...lines,
        ...(darkNeutrals.length ? [`中性色和背景色的深色变体（可作正文色）：${darkNeutrals.join(" ")}`] : []),
      ]
    : [];
}

function channelSum(hex: string): number {
  return (
    Number.parseInt(hex.slice(1, 3), 16) + Number.parseInt(hex.slice(3, 5), 16) + Number.parseInt(hex.slice(5, 7), 16)
  );
}

/** The palette part body for an adoptable image or PDF (no title line). */
export function paletteSectionLines(material: PaletteMaterial): string[] {
  const blocks = paletteBlocks(material);
  const kind = paletteKind(material);
  const lines: string[] = [];
  if (kind === "pdf") {
    const vector = blocks.find((block) => block.source === "pdf-vector-ops");
    const pixels = blocks.find((block) => block.source === "pdf-page-pixels");
    lines.push(
      "色板来源：矢量图形（PDF 绘图指令里写明的色值）和页面图片（渲染页面后对像素聚类）。",
      pixels
        ? `页面图片：已扫描前 ${pixels.pagesScanned ?? "若干"} 页。`
        : "页面图片：未取到页面图片里的颜色（没有生成页面图片），下面只有矢量图形里的颜色。",
    );
    for (const block of [vector, pixels]) {
      if (block) lines.push("", `## ${BLOCK_TITLE[block.source]}`, ...accentLines(block));
    }
    if (!vector) lines.push("", "## 矢量图形里的颜色", "（没有取到矢量图形里的强调色）");
  } else if (blocks[0]) {
    lines.push("色板来源：图片像素（对画面做确定性聚类，不是模型看图的结论）。", "", ...accentLines(blocks[0]));
  } else {
    lines.push("没有提取到色板（这份资料没有可用的颜色统计）。");
  }
  if (blocks.some((block) => block.accents.length)) {
    lines.push(
      "",
      ...variantLines(material),
      `可用颜色：以上强调色、中性色、背景色，以及它们与白色、黑色按 ${USER_DESIGN_TINT_SHADE_PERCENTAGES.join("%、")}% 混合出的变体；write_page 会拒绝其他颜色。`,
    );
  }
  return lines;
}

/** Full `palette` part text for a PDF; images prepend their own header lines. */
export function palettePartText(material: PaletteMaterial): string {
  const title =
    paletteKind(material) === "pdf"
      ? `# PDF「${material.name}」的配色（无目录风格包时可作配色来源；字体、版式、装饰只作参考）`
      : `# 图片资料「${material.name}」的配色`;
  return [title, ...paletteSectionLines(material)].join("\n");
}

export type PaletteMaterialPart = Readonly<{
  part: typeof PALETTE_PART;
  label: string;
  width?: number;
  height?: number;
  format?: string;
}>;

/** `list_materials` descriptor for the palette part. */
export function paletteMaterialPart(material: PaletteMaterial): PaletteMaterialPart | undefined {
  const kind = paletteKind(material);
  if (!kind) return undefined;
  const blocks = paletteBlocks(material);
  const count = new Set(blocks.flatMap((block) => block.accents.map((entry) => entry.hex))).size;
  const sources = blocks.some((block) => block.source === "pdf-page-pixels")
    ? "矢量图形 + 页面图片"
    : kind === "pdf"
      ? "只有矢量图形"
      : "图片像素";
  const image = record(material.derivative.image);
  const width = Number(image.width);
  const height = Number(image.height);
  const format = typeof image.format === "string" ? image.format.toUpperCase() : "";
  return {
    part: PALETTE_PART,
    label: `配色 · ${sources} · ${count ? `${count} 种强调色` : "没有强调色"}`,
    ...(kind === "image" && Number.isSafeInteger(width) ? { width } : {}),
    ...(kind === "image" && Number.isSafeInteger(height) ? { height } : {}),
    ...(kind === "image" && format ? { format } : {}),
  };
}

/** Parts as listed to the agent: images list only `palette`; PDFs add it beside their text part. */
export function withPaletteParts<T extends Record<string, unknown>>(
  material: PaletteMaterial,
  parts: readonly T[],
): readonly (T | PaletteMaterialPart)[] {
  const palette = paletteMaterialPart(material);
  if (!palette) return parts;
  if (paletteKind(material) === "image") return [palette];
  return [...parts.filter((part) => part.part !== PALETTE_PART), palette];
}
