/**
 * `record_material_notes`: the vision model writes down what it concluded from
 * an image, a template photo or a PDF page. The Host validates the target and
 * the vocabulary, stores the notes beside the project, and records a ledger
 * fact with their digest. Once the notes exist, later requests may replace the
 * image block with the caption (see the context projection in
 * vendor/dsh-llm-pi-ai); the Host never invents or edits what the model wrote.
 */
import fs from "node:fs";
import path from "node:path";
import { withProjectWriteLock } from "@open-slidestudio/pptd-v2";
import type { ToolExecution } from "./agent-tools.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { stableSha256 } from "./hashing.js";
import { MaterialPackError, verifyMaterial } from "./material-pack.js";
import { ALL_IMAGES_ID } from "./material-overview.js";
import { isPdfMaterial, verifiedPageOf } from "./material-pages.js";
import { verifiedTemplatePhoto } from "./template-photo.js";
import { appendFact, factId, readRunLedger, type RunToolContext } from "./run-ledger.js";

export const MATERIAL_NOTE_USES = ["page", "background", "logo", "style-reference", "skip"] as const;
export type MaterialNoteUse = (typeof MATERIAL_NOTE_USES)[number];

/**
 * Fixed font-class table. A class never becomes a guessed font name: each
 * entry lists only faces from the slide font whitelist (pptd-v2 font-policy).
 */
export const FONT_CLASS_FONTS = {
  sans: { ea: ["微软雅黑"], latin: ["Arial"] },
  serif: { ea: ["宋体"], latin: ["Times New Roman", "Georgia"] },
  kai: { ea: ["楷体"], latin: [] },
  mono: { ea: [], latin: ["Courier New"] },
} as const;
export type FontClass = keyof typeof FONT_CLASS_FONTS;

const USE_LABELS: Readonly<Record<MaterialNoteUse, string>> = {
  page: "放进页面",
  background: "做背景",
  logo: "作 Logo",
  "style-reference": "只作风格参考",
  skip: "不使用",
};

export type MaterialReadValue = Readonly<{
  label: string;
  value: string;
  unit?: string;
  period?: string;
}>;

export type MaterialNotes = Readonly<{
  caption: string;
  suggestedUse: MaterialNoteUse;
  focus?: readonly [number, number];
  layoutNotes?: string;
  mood?: string;
  fontClass?: FontClass;
  readValues?: readonly MaterialReadValue[];
  reason?: string;
}>;

export type StoredMaterialNotes = Readonly<{
  key: string;
  materialId: string;
  materialSha256: string;
  mediaId?: string;
  page?: number;
  notes: MaterialNotes;
  notesSha256: string;
  contextEpochId: string;
  recordedAt: string;
}>;

const NOTES_FILE = path.join("_agent", "material-notes.v1.json");
const TEXT_LIMIT = 300;
const READ_VALUE_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

function optionalText(args: Record<string, unknown>, field: string): string | undefined {
  const raw = args[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new MaterialPackError(`${field} 必须是文字`);
  const text = raw.trim();
  if (!text) return undefined;
  if (codePoints(text) > TEXT_LIMIT) {
    throw new MaterialPackError(`${field} 过长（最多 ${TEXT_LIMIT} 字），请精简后再记录`);
  }
  return text;
}

function parseFocus(raw: unknown): readonly [number, number] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const ok =
    Array.isArray(raw) &&
    raw.length === 2 &&
    raw.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
  if (!ok) {
    throw new MaterialPackError("focus 无效：应为 [x, y]，x、y 是 0–1 之间的比例（左上角是 0,0）");
  }
  return [(raw as number[])[0]!, (raw as number[])[1]!];
}

function parseReadValues(raw: unknown): readonly MaterialReadValue[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > READ_VALUE_LIMIT) {
    throw new MaterialPackError(`readValues 无效：应为最多 ${READ_VALUE_LIMIT} 项的数组`);
  }
  return raw.map((item, index) => {
    const row = isRecord(item) ? item : {};
    const text = (field: string, limit: number): string | undefined => {
      const value = row[field];
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      if (typeof value !== "string" || !value.trim()) return undefined;
      if (codePoints(value.trim()) > limit) {
        throw new MaterialPackError(`readValues[${index}].${field} 过长`);
      }
      return value.trim();
    };
    const label = text("label", 80);
    const value = text("value", 80);
    if (!label || !value) {
      throw new MaterialPackError(`readValues[${index}] 无效：label 和 value 都不能为空`);
    }
    const unit = text("unit", 20);
    const period = text("period", 40);
    return { label, value, ...(unit ? { unit } : {}), ...(period ? { period } : {}) };
  });
}

function parseNotes(args: Record<string, unknown>): MaterialNotes {
  const caption = optionalText(args, "caption");
  if (!caption) throw new MaterialPackError("缺少 caption：用一两句话写下你在这张图里看到的画面");
  const use = typeof args.suggestedUse === "string" ? args.suggestedUse.trim() : "";
  if (!(MATERIAL_NOTE_USES as readonly string[]).includes(use)) {
    throw new MaterialPackError(`suggestedUse 无效：「${use || "（空）"}」；可选 ${MATERIAL_NOTE_USES.join("、")}`);
  }
  const fontClassRaw = args.fontClass;
  let fontClass: FontClass | undefined;
  if (fontClassRaw !== undefined && fontClassRaw !== null && fontClassRaw !== "") {
    if (typeof fontClassRaw !== "string" || !Object.hasOwn(FONT_CLASS_FONTS, fontClassRaw)) {
      throw new MaterialPackError(
        `fontClass 无效：「${String(fontClassRaw)}」；只能选 ${Object.keys(FONT_CLASS_FONTS).join("、")}（按固定表对应到可用字体，不要写具体字体名）`,
      );
    }
    fontClass = fontClassRaw as FontClass;
  }
  const focus = parseFocus(args.focus);
  const layoutNotes = optionalText(args, "layoutNotes");
  const mood = optionalText(args, "mood");
  const reason = optionalText(args, "reason");
  const readValues = parseReadValues(args.readValues);
  return {
    caption,
    suggestedUse: use as MaterialNoteUse,
    ...(focus ? { focus } : {}),
    ...(layoutNotes ? { layoutNotes } : {}),
    ...(mood ? { mood } : {}),
    ...(fontClass ? { fontClass } : {}),
    ...(readValues?.length ? { readValues } : {}),
    ...(reason ? { reason } : {}),
  };
}

type NotesTarget = Readonly<{
  materialId: string;
  materialSha256: string;
  name: string;
  mediaId?: string;
  page?: number;
}>;

/** Only things a vision model can actually have looked at are valid targets. */
function resolveTarget(root: string, args: Record<string, unknown>): NotesTarget {
  const materialId = typeof args.materialId === "string" ? args.materialId.trim() : "";
  if (!materialId) {
    throw new MaterialPackError("缺少 materialId：请从 list_materials 返回的资料里选择要记录的图片");
  }
  if (materialId === ALL_IMAGES_ID) {
    throw new MaterialPackError(
      "all-images 是总览，不能整体记录说明；请逐张图片调用 record_material_notes，并带上各自的 materialId",
    );
  }
  const material = verifyMaterial(root, materialId);
  const base = { materialId: material.id, materialSha256: material.sha256, name: material.name };
  const hasPage = args.page !== undefined && args.page !== null;
  const mediaId = typeof args.mediaId === "string" ? args.mediaId.trim() : "";
  if (isPdfMaterial(material)) {
    if (!hasPage) {
      throw new MaterialPackError(
        `资料「${material.name}」是 PDF，请用 page 指定要记录的页面（只有已生成页面图片的页可以记录）`,
      );
    }
    const viewed = verifiedPageOf(material, args.page);
    return { ...base, page: viewed.page };
  }
  if (material.kind === "deck-template") {
    if (!mediaId) {
      throw new MaterialPackError(
        `资料「${material.name}」是 PPT 模板，请用 mediaId 指定要记录的模板照片（见 list_materials）`,
      );
    }
    verifiedTemplatePhoto(material, mediaId);
    return { ...base, mediaId };
  }
  if (material.kind !== "image") {
    throw new MaterialPackError(`资料「${material.name}」不是图片，无法记录看图说明`);
  }
  if (hasPage || mediaId) {
    throw new MaterialPackError(`资料「${material.name}」是单张图片，不需要 mediaId 或 page`);
  }
  return base;
}

function targetKey(target: Pick<NotesTarget, "materialId" | "mediaId" | "page">): string {
  return `${target.materialId}|${target.mediaId ?? ""}|${target.page ?? ""}`;
}

export function readMaterialNotes(root: string): readonly StoredMaterialNotes[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, NOTES_FILE), "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.notes)) return [];
    return parsed.notes.filter(isRecord) as unknown as StoredMaterialNotes[];
  } catch {
    return [];
  }
}

function describeTarget(target: NotesTarget): string {
  if (target.page) return `「${target.name}」第 ${target.page} 页`;
  if (target.mediaId) return `「${target.name}」的模板照片`;
  return `「${target.name}」`;
}

export function recordMaterialNotesResult(
  root: string,
  context: RunToolContext,
  args: Record<string, unknown>,
): ToolExecution {
  if (!readRunLedger(root)) throw new Error("run ledger is not initialized");
  const target = resolveTarget(root, args);
  const notes = parseNotes(args);
  const notesSha256 = stableSha256(notes);
  const key = targetKey(target);
  const recordedAt = new Date().toISOString();
  const entry: StoredMaterialNotes = {
    key,
    materialId: target.materialId,
    materialSha256: target.materialSha256,
    ...(target.mediaId ? { mediaId: target.mediaId } : {}),
    ...(target.page ? { page: target.page } : {}),
    notes,
    notesSha256,
    contextEpochId: context.contextEpochId,
    recordedAt,
  };
  withProjectWriteLock(root, () => {
    const others = readMaterialNotes(root).filter((item) => item.key !== key);
    writeJsonAtomic(path.join(root, NOTES_FILE), { version: 1, notes: [...others, entry] });
  });
  const identity = {
    materialId: target.materialId,
    ...(target.mediaId ? { mediaId: target.mediaId } : {}),
    ...(target.page ? { page: target.page } : {}),
    notesSha256,
  };
  const factPayload = { ...identity, contextEpochId: context.contextEpochId };
  appendFact(root, {
    type: "material.notes-recorded",
    factId: factId("material.notes-recorded", factPayload),
    at: recordedAt,
    ...factPayload,
  });
  const suggestedFonts = notes.fontClass ? FONT_CLASS_FONTS[notes.fontClass] : undefined;
  return {
    name: "record_material_notes",
    ok: true,
    summary: `已记录 ${target.name} 的看图说明`,
    detail: [
      `已记录${describeTarget(target)}的看图说明（建议用途：${USE_LABELS[notes.suggestedUse]}）。`,
      suggestedFonts
        ? `字体类别 ${notes.fontClass} 对应可用字体：${[...suggestedFonts.ea, ...suggestedFonts.latin].join("、")}。`
        : "",
      "之后的请求里，这张图片的画面会换成文字结论；需要重新看细节时可再次 view_material。",
    ]
      .filter(Boolean)
      .join("\n"),
    payload: {
      ...identity,
      suggestedUse: notes.suggestedUse,
      ...(suggestedFonts ? { fontClass: notes.fontClass, suggestedFonts } : {}),
    },
  };
}
