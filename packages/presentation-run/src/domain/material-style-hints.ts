import type { VerifiedMaterial } from "./material-pack.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type DocumentIdentity = Pick<VerifiedMaterial, "kind" | "parser" | "derivative"> &
  Partial<Pick<VerifiedMaterial, "originalExtension">>;

/** The derivative's signature-detected MIME, or "" when the record predates it. */
function detectedMime(material: DocumentIdentity): string {
  const source = material.derivative.source;
  return isRecord(source) && typeof source.detectedMime === "string" ? source.detectedMime : "";
}

/**
 * The verified parser id decides the file identity; the upload name's
 * extension is only a fallback for unknown legacy records that carry neither
 * a parser id nor a detected MIME (a renamed PDF must never become a Word
 * file, and a renamed Word file must never become a PDF).
 */
export function isPdfMaterial(material: DocumentIdentity): boolean {
  if (material.kind !== "document") return false;
  if (material.parser.startsWith("pdf-unpdf-")) return true;
  if (material.parser.startsWith("docx-ooxml-")) return false;
  const mime = detectedMime(material);
  if (mime) return mime === "application/pdf";
  return material.originalExtension === ".pdf";
}

/** Only receipt-verified PDF vector statistics are exposed as M2 style hints. */
export function pdfStyleHints(material: VerifiedMaterial): Readonly<Record<string, unknown>> | undefined {
  if (!isPdfMaterial(material)) return undefined;
  const document = material.derivative.document;
  const profile = isRecord(document) ? document.styleProfile : undefined;
  return isRecord(profile) && profile.schema === "style-profile/v1" && profile.source === "pdf-vector-ops"
    ? profile
    : undefined;
}

/** Word identity: a docx parser always wins over the upload name, like isPdfMaterial. */
export function isDocxMaterial(material: DocumentIdentity): boolean {
  return material.kind === "document" && material.parser.startsWith("docx-ooxml-");
}

/**
 * Only the receipt-verified Word theme projection (CAP-33) is exposed as
 * clue-only hints. They are never adoptable: design-aspects refuses visual
 * aspects for Word sources.
 */
export function docxStyleHints(material: VerifiedMaterial): Readonly<Record<string, unknown>> | undefined {
  if (!isDocxMaterial(material)) return undefined;
  const document = material.derivative.document;
  const profile = isRecord(document) ? document.styleProfile : undefined;
  return isRecord(profile) && profile.schema === "style-profile/v1" && profile.source === "docx-theme"
    ? profile
    : undefined;
}

/** The hints a listed material carries: PDF vector statistics or Word theme clues. */
export function materialStyleHints(material: VerifiedMaterial): Readonly<Record<string, unknown>> | undefined {
  return pdfStyleHints(material) ?? docxStyleHints(material);
}

function hintHexes(profile: Readonly<Record<string, unknown>> | undefined): string[] {
  const colors = profile?.accentColors;
  if (!Array.isArray(colors)) return [];
  return colors
    .filter(isRecord)
    .map((color) => color.hex)
    .filter((hex): hex is string => typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex));
}

/**
 * The vector-ops hints are not a design source. Page pictures are seen only by
 * an image-input model, so the "unseen pages" note is limited to text-only models.
 */
export function pdfStyleHintDetail(
  profile: Readonly<Record<string, unknown>>,
  options: { readonly modelAcceptsImages?: boolean } = {},
): string {
  const fonts = Array.isArray(profile.fonts)
    ? profile.fonts.filter(isRecord).flatMap((font) => {
        if (typeof font.source !== "string" || !isRecord(font.mapped)) return [];
        const { latin, ea } = font.mapped;
        return typeof latin === "string" && typeof ea === "string" ? [`${font.source} → ${latin} / ${ea}`] : [];
      })
    : [];
  return [
    "风格线索（来自 PDF 的矢量图形和文字统计；不是设计源，只有声明 palette 并通过回执校验后才写入主题）",
    `配色：${hintHexes(profile).join("、") || "未提取到强调色"}`,
    `字体：${fonts.join("、") || "未提取到字体"}`,
    ...(options.modelAcceptsImages === true ? [] : ["你没有看到页面画面。"]),
  ].join("；");
}

/**
 * The Word theme detail names exactly what a docx-theme profile may hint and
 * states that none of it can be adopted or declared as palette.
 */
export function docxStyleHintDetail(profile: Readonly<Record<string, unknown>>): string {
  const fonts = Array.isArray(profile.fonts)
    ? profile.fonts.filter(isRecord).flatMap((font) => {
        if (typeof font.source !== "string" || !isRecord(font.mapped)) return [];
        const { latin, ea } = font.mapped;
        return typeof latin === "string" && typeof ea === "string" ? [`${font.source} → ${latin} / ${ea}`] : [];
      })
    : [];
  return [
    "风格线索（来自 Word 文档的主题色和标题字体；只作线索，不作为设计来源，不能声明 palette）",
    `配色：${hintHexes(profile).join("、") || "未提取到主题色"}`,
    `字体：${fonts.join("、") || "未提取到字体"}`,
  ].join("；");
}

/** The list-material detail wording for whichever hints a material carries. */
export function styleHintDetail(
  profile: Readonly<Record<string, unknown>>,
  options: { readonly modelAcceptsImages?: boolean } = {},
): string {
  return profile.source === "docx-theme" ? docxStyleHintDetail(profile) : pdfStyleHintDetail(profile, options);
}

/** Shared refusal keeps planning and palette enforcement equally explicit. */
export function nonAdoptableMaterialMessage(material: VerifiedMaterial): string {
  const pdf = isPdfMaterial(material);
  const hexes = pdf ? hintHexes(pdfStyleHints(material)) : [];
  return [
    `资料「${material.name}」${pdf ? "是 PDF，" : ""}不是 PPT 设计源。`,
    "这份资料没有被采用为设计源；不要说复刻、还原或沿用了它的版式和配色。",
    ...(pdf
      ? [
          `PDF 风格线索：${hexes.join("、") || "未提取到强调色"}；只作线索，不是设计源，只有声明 palette 并通过回执校验后才写入主题。`,
        ]
      : []),
    "如需使用原文件的风格，请上传原始 PPTX。",
  ].join("");
}
