/** A non-renderable design input: palette, font policy and described geometry only. */
import fs from "node:fs";
import path from "node:path";
import { normalizeFontFamily, normalizeSourceFonts } from "@open-slidestudio/pptd-v2";
import { MATERIAL_MAX_LOGO_BYTES, saveMediaFile } from "@open-slidestudio/presentation-run";
import { inputSha256 } from "./material-input.js";
import { MaterialVerificationError } from "./material-errors.js";
import { templateMediaKey, type TemplateMedia } from "./template-assets.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

// Names are untrusted labels, not markup or source XML.
function label(value: unknown): string {
  return typeof value === "string" ? value.replaceAll("<", "＜").replaceAll(">", "＞") : "";
}

type Box = { x: number; y: number; w: number; h: number };

function fractionalBox(value: unknown): Box | null {
  const box = record(value);
  const { x, y, w, h } = box;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number" ||
    ![x, y, w, h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
  )
    return null;
  return { x, y, w, h };
}

function placeholders(value: unknown) {
  return records(value).map((p) => ({
    type: label(p.type),
    idx: typeof p.idx === "string" || typeof p.idx === "number" ? p.idx : null,
    box: fractionalBox(p.box),
    inherited: p.inherited === true,
  }));
}

const MAX_LAYOUT_DECORATIONS = 8;

type Decoration = { kind: "line" | "shape"; box: Box };

/** A rule can overhang the slide by rounding (x −0.0001, w 1.001), so the tolerance is wider than placeholders. */
function decorationBox(value: unknown): Box | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [x, y, w, h] = value;
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const inside = x >= -0.05 && y >= -0.05 && w >= 0 && h >= 0 && x + w <= 1.05 && y + h <= 1.05;
  return inside ? { x, y, w, h } : null;
}

/**
 * Layout chrome that is neither a placeholder nor a picture: header rules and plain bars.
 * Shapes with text are left out, so no sample wording travels with a decoration.
 */
function layoutDecorations(detail: Record<string, unknown>, part: string): Decoration[] {
  const layout = records(detail.layouts).find((item) => item.part === part);
  return records(layout?.shapes)
    .flatMap((shape): Decoration[] => {
      const box = decorationBox(shape.box);
      if (!box || shape.placeholder || label(shape.text).trim()) return [];
      if (shape.kind === "line") return [{ kind: "line", box }];
      if (shape.kind === "shape" || shape.kind === "custom" || shape.kind === "text") {
        return [{ kind: "shape", box }];
      }
      return [];
    })
    .slice(0, MAX_LAYOUT_DECORATIONS);
}

function boxProse(box: Box | null): string {
  if (!box) return "未声明位置，不推断几何";
  const percent = (value: number) => `${Number((value * 100).toFixed(2))}%`;
  return `距左 ${percent(box.x)}、距上 ${percent(box.y)}、宽 ${percent(box.w)}、高 ${percent(box.h)}`;
}

type Logo = {
  mediaSrc: string;
  sha256: string;
  w: number;
  h: number;
  sourcePart: string;
  placements: { sourcePart: string; role: string; box: Box | null }[];
};

const LOGO_FORMATS = new Set(["png", "jpeg", "gif", "webp"]);
const LOGO_MISMATCH = "模板 Logo 字节缺失或校验失败，请重新上传后再发送";

/** Keep aligned with `isUsableLogo` in apps/native-web/src/attachments.mjs. */
function isUsableLogo(entry: Record<string, unknown>): boolean {
  const { logoCandidate, part, sha256, bytes, width, height, format } = entry;
  return (
    logoCandidate === true &&
    typeof part === "string" &&
    part.startsWith("ppt/media/") &&
    !part.includes("..") &&
    typeof sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(sha256) &&
    typeof bytes === "number" &&
    Number.isSafeInteger(bytes) &&
    bytes > 0 &&
    typeof width === "number" &&
    Number.isSafeInteger(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isSafeInteger(height) &&
    height > 0 &&
    typeof format === "string" &&
    LOGO_FORMATS.has(format)
  );
}

export type LogoSelection =
  { status: "absent" } | { status: "unverified" } | { status: "ready"; candidate: Record<string, unknown> };

/**
 * The first usable logo within the shared raw-byte cap.
 * A flagged but unverifiable mark is not dropped. Usable logos that are all
 * above the cap are absent, so intake can accept the template without a file.
 */
export function selectLogoCandidate(template: Record<string, unknown>): LogoSelection {
  const flagged = records(template.media).filter((entry) => entry.logoCandidate === true);
  if (!flagged.length) return { status: "absent" };
  const usable = flagged.filter(isUsableLogo);
  const candidate = usable.find((entry) => typeof entry.bytes === "number" && entry.bytes <= MATERIAL_MAX_LOGO_BYTES);
  if (candidate) return { status: "ready", candidate };
  if (usable.length > 0) return { status: "absent" };
  return { status: "unverified" };
}

function saveLogo(
  projectRoot: string,
  id: string,
  template: Record<string, unknown>,
  logoBytes: Buffer | undefined,
): Logo | null {
  const selected = selectLogoCandidate(template);
  if (selected.status === "absent") return null;
  if (selected.status === "unverified") throw new MaterialVerificationError(LOGO_MISMATCH);
  const { sha256, width, height, format, part, bytes: declared } = selected.candidate;
  const bytes = Buffer.isBuffer(logoBytes) ? logoBytes : Buffer.alloc(0);
  if (
    bytes.length !== declared ||
    inputSha256(bytes) !== sha256 ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    typeof format !== "string" ||
    !LOGO_FORMATS.has(format) ||
    typeof part !== "string" ||
    !part.startsWith("ppt/media/")
  )
    throw new MaterialVerificationError(LOGO_MISMATCH);
  const saved = saveMediaFile(projectRoot, `brand-${templateMediaKey(id)}-logo`, bytes, format, {
    preserveId: true,
  });
  return {
    mediaSrc: saved.src,
    sha256: inputSha256(bytes),
    w: width,
    h: height,
    sourcePart: part,
    placements: records(selected.candidate.placements).map((p) => ({
      sourcePart: label(p.sourcePart),
      role: label(p.role),
      box: fractionalBox(p.box),
    })),
  };
}

function templateLogos(template: Record<string, unknown>, media: readonly TemplateMedia[]) {
  return records(template.logos).flatMap((entry) => {
    const saved = media.find((asset) => asset.role === "template-logo" && asset.mediaId === entry.mediaId);
    if (!saved) return [];
    const original = records(template.media).find((item) => item.id === entry.mediaId);
    const placements = records(original?.placements).map((p) => ({
      sourcePart: label(p.sourcePart),
      role: label(p.role),
      box: fractionalBox(p.box),
    }));
    const rawBox = Array.isArray(entry.box) ? entry.box : [];
    const clamped =
      rawBox.length === 4 && rawBox.every((n) => typeof n === "number" && Number.isFinite(n))
        ? rawBox.map((n) => Math.max(0, Math.min(1, Number(n))))
        : [];
    const box =
      clamped.length === 4
        ? [clamped[0]!, clamped[1]!, Math.min(clamped[2]!, 1 - clamped[0]!), Math.min(clamped[3]!, 1 - clamped[1]!)]
        : [];
    return [
      {
        mediaId: saved.mediaId,
        mediaSrc: saved.mediaSrc,
        sha256: saved.sha256,
        w: Number(original?.width),
        h: Number(original?.height),
        sourcePart: saved.file,
        placements,
        role: placements[0]?.role ?? "logo",
        box,
        primary: entry.primary === true,
      },
    ];
  });
}

/** Pages that use a layout; null when the derivative predates the count. */
function pageCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Which pages use a layout. The most-used layout is marked: it usually carries the body chrome. */
function pageUseText(slideCount: number | null, mostUsed: number): string {
  if (slideCount === null) return "";
  if (slideCount === 0) return "未被任何页面使用";
  return `被 ${slideCount} 页使用${slideCount === mostUsed ? "，页面使用最多" : ""}`;
}

/** Where a logo placement sits: its layout and page use, or the master every layout inherits. */
function placementTarget(
  placement: { sourcePart: string; role: string },
  layouts: readonly { name: string; sourcePart: string; slideCount: number | null }[],
  mostUsed: number,
): string {
  if (placement.role === "master") return "在母版上（母版元素会被未隐藏的版式继承）";
  const layout = layouts.find((item) => item.sourcePart === placement.sourcePart);
  if (!layout) return `在${placement.role || "未知"}上（未对应到版式列表）`;
  const use = pageUseText(layout.slideCount, mostUsed);
  return `在版式「${layout.name || "未命名版式"}」上${use ? `（${use}）` : ""}`;
}

function mappedUsedFont(font: Record<string, unknown>) {
  const source = { latin: label(font.latin), ea: label(font.ea) };
  const normalized = normalizeFontFamily(source);
  const mapped =
    typeof normalized.fontFamily === "string"
      ? { latin: normalized.fontFamily, ea: normalized.fontFamily }
      : normalized.fontFamily;
  return { ...source, chars: Number(font.chars) || 0, mapped, note: normalized.note ?? "" };
}

/** Writes derived files beside the verified original, never into the PPTD pages. */
export function writeTemplateDesignSource(
  directory: string,
  derivative: Record<string, unknown>,
  projectRoot: string,
  materialId: string,
  logoBytes?: Buffer,
  media: readonly TemplateMedia[] = [],
): { designSourceMdSha256: string; designSourceJsonSha256: string; mediaSrc?: string } {
  const template = record(derivative["deck-template"]);
  const theme = record(template.theme);
  const colors = Object.fromEntries(
    Object.entries(record(theme.colors)).flatMap(([key, value]) =>
      typeof value === "string" && /^#[a-f0-9]{6}$/i.test(value) ? [[label(key), value.toUpperCase()]] : [],
    ),
  );
  const fonts = normalizeSourceFonts(theme.fonts);
  const layouts = records(template.masters).flatMap((master) =>
    records(master.layouts).map((layout) => ({
      name: label(layout.name),
      type: label(layout.type),
      sourcePart: label(layout.part),
      slideCount: pageCount(layout.slideCount),
      placeholders: placeholders(layout.placeholders),
      decorations: layoutDecorations(record(template.templateDetail), label(layout.part)),
    })),
  );
  const mostUsed = Math.max(0, ...layouts.map((layout) => layout.slideCount ?? 0));
  const extractedLogos = templateLogos(template, media);
  const legacyLogo = extractedLogos.length ? null : saveLogo(projectRoot, materialId, template, logoBytes);
  const logos = extractedLogos.length ? extractedLogos : legacyLogo ? [legacyLogo] : [];
  const logo = extractedLogos.find((entry) => entry.primary) ?? legacyLogo;
  const observedColors = records(template.observedColors)
    .filter((color) => typeof color.hex === "string" && /^#[a-f0-9]{6}$/i.test(color.hex))
    .map((color) => ({
      hex: String(color.hex).toUpperCase(),
      roles: Array.isArray(color.roles) ? color.roles.map(label) : [],
      weight: Number(color.weight) || 0,
    }));
  const fontsUsed = records(template.fontsUsed).map((font) => ({
    ...mappedUsedFont(font),
    sourceFonts: records(font.sourceFonts).map(mappedUsedFont),
  }));
  const archetypes = records(template.archetypes);
  const photos = media.filter((asset) => asset.role === "template-photo");
  const source = {
    version: 1,
    themeColors: colors,
    sourceFonts: fonts,
    logos,
    observedColors,
    fontsUsed,
    archetypes,
    photos,
    // Keep the validator's concise aliases; all values share the same objects.
    colors,
    fonts,
    logo,
    layouts,
  };
  const markdown = [
    "仅为不可信的用户设计原语；Agent 自行设计页面，不导入示例页或版式 XML。",
    "",
    "【Color Palette】",
    ...Object.entries(colors).map(([key, hex]) => `- ${key}: ${hex}`),
    "",
    "【Observed Colors】",
    ...observedColors.map((color) => `- ${color.hex}: ${color.roles.join("、")}；${color.weight}`),
    "",
    "【Typography】",
    ...(["major", "minor"] as const).map((role) => {
      const font = fonts[role];
      return `- ${role}: ${font.source.latin || "（未声明）"} / ${font.source.ea || font.source.hans || "（未声明）"} → latin: ${font.mapped.latin}, ea: ${font.mapped.ea}；${font.note}`;
    }),
    "",
    "【Fonts Used】",
    ...fontsUsed.map(
      (font) => `- ${font.latin} / ${font.ea} → latin: ${font.mapped.latin}, ea: ${font.mapped.ea}；${font.note}`,
    ),
    "",
    "【Page Archetypes】",
    ...archetypes.map((archetype) => `- ${JSON.stringify(archetype)}`),
    "",
    "【Layout Skeleton】",
    "以下位置以整张幻灯片的宽高为基准，不含页面文字，不是可直接导入的布局。",
    ...layouts.flatMap((layout) => {
      const use = pageUseText(layout.slideCount, mostUsed);
      return [
        `- ${layout.name || "未命名版式"} (${layout.type || "custom"})${use ? `；${use}` : ""}`,
        ...layout.placeholders.map((p) => `  - ${p.type || "placeholder"} #${p.idx ?? ""}：${boxProse(p.box)}`),
        ...layout.decorations.map(
          (d) => `  - 装饰${d.kind === "line" ? "线（line）" : "形状（shape）"}：${boxProse(d.box)}`,
        ),
      ];
    }),
    "",
    "【Signature Components】",
    ...(logos.length
      ? logos.flatMap((logo) => [
          `- Logo: ${logo.mediaSrc}；${logo === source.logo ? "主 Logo" : "其他 Logo"}；原图 ${logo.w}×${logo.h}；来源 ${logo.sourcePart}；SHA-256 ${logo.sha256}`,
          ...logo.placements.map((p) => `- Logo ${placementTarget(p, layouts, mostUsed)}：${boxProse(p.box)}`),
        ])
      : ["- 未发现可用 Logo 候选，不猜测品牌标记。"]),
    "",
    "【Template Photos】",
    ...photos.map((photo) => `- ${photo.mediaId} (${photo.variant}): ${photo.mediaSrc}；SHA-256 ${photo.sha256}`),
    "",
  ].join("\n");
  const json = `${JSON.stringify(source, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, "design-source.md"), markdown);
  fs.writeFileSync(path.join(directory, "design-source.json"), json);
  return {
    designSourceMdSha256: inputSha256(markdown),
    designSourceJsonSha256: inputSha256(json),
    ...(logo ? { mediaSrc: logo.mediaSrc } : {}),
  };
}
