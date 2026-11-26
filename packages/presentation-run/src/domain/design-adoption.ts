import fs from "node:fs";
import path from "node:path";
import {
  canonicalFontName,
  isSlideFont,
  loadProject,
  saveProject,
  withProjectWriteLock,
  type Theme,
} from "@open-slidestudio/pptd-v2";
import { writeJsonAtomic } from "./atomic-file.js";
import { listSourceReceipts, recordSourceReceipt } from "../receipts.js";
import { EDITOR_AUTHORITY_LOST_DETAIL, editorTurnAuthorityLost } from "./editor-turn-authority.js";
import { MaterialPackError, readMaterialsManifest, verifiedDesignSource, verifyMaterial } from "./material-pack.js";
import { PALETTE_THEME_SLOTS, paletteKind, paletteThemeAccents } from "./palette-source.js";
import { canonicalDesignSourceId, canonicalizeAdoptedSourceIds } from "./theme-pack.js";
import type { UserColor } from "./user-colors.js";
import { defaultTemplateAspects, sourceDesignAspects, type DesignAspects } from "./design-aspects.js";

const RUNTIME_REL = path.join("_agent", "runtime.json");

function adoptedMaterialIds(sourceIds: readonly string[]): string[] {
  const ids: string[] = [];
  for (const raw of sourceIds) {
    const canonical = canonicalDesignSourceId(raw);
    if (!canonical) continue;
    const id = canonical.slice("material:".length);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * Latest ordered adoption selection, already canonical.
 * Undefined when this project has never stored one. Receipt order is not a selection.
 */
export function readAdoptedSourceSelection(root: string): string[] | undefined {
  const runtimePath = path.join(root, RUNTIME_REL);
  if (!fs.existsSync(runtimePath)) return undefined;
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(runtime, "adoptedSourceIds")) return undefined;
  const raw = Array.isArray(runtime.adoptedSourceIds) ? runtime.adoptedSourceIds : [];
  return canonicalizeAdoptedSourceIds(raw.filter((value): value is string => typeof value === "string"));
}

export function carriedAdoptedSourceIds(args: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(args, "adoptedSourceIds") ||
    Object.prototype.hasOwnProperty.call(args, "adopt")
  );
}

/**
 * Plan updates that omit adoptedSourceIds reuse the stored selection.
 * Projects saved before that field existed still have only the receipt audit trail.
 */
export function currentAdoptedSourceSelection(root: string): string[] {
  const selection = readAdoptedSourceSelection(root);
  if (selection !== undefined) return selection;
  return listSourceReceipts(root)
    .filter((row) => row.state === "adopted" || row.state === "executed")
    .map((row) => row.sourceId);
}

function persistAdoptedSourceSelection(
  root: string,
  sourceIds: readonly string[],
  designAspects: DesignAspects,
  userColors?: readonly UserColor[],
): void {
  const runtimePath = path.join(root, RUNTIME_REL);
  let runtime: Record<string, unknown> = {};
  if (fs.existsSync(runtimePath)) {
    runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as Record<string, unknown>;
  }
  // An omitted declaration keeps the saved one; an empty list removes the key, as if never declared.
  const { userColors: saved, ...rest } = runtime;
  const colors = userColors ?? (Array.isArray(saved) ? saved : []);
  writeJsonAtomic(runtimePath, {
    ...rest,
    adoptedSourceIds: canonicalizeAdoptedSourceIds(sourceIds),
    designAspects,
    ...(colors.length ? { userColors: colors } : {}),
  });
}

/** Persist design-source adoption without changing the attached-material list. */
export function recordUserDesignAdoption(root: string, sourceIds: readonly string[]): void {
  const adoptedIds = adoptedMaterialIds(sourceIds);
  if (!adoptedIds.length) return;

  const runtimePath = path.join(root, RUNTIME_REL);
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as Record<string, unknown>;
  const priorIds = Array.isArray(runtime.designMaterialIds)
    ? runtime.designMaterialIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const attachedTemplates = readMaterialsManifest(root)
    .filter((entry) => entry.kind === "deck-template")
    .map((entry) => entry.id);
  writeJsonAtomic(runtimePath, {
    ...runtime,
    designDirection: "user-design",
    designMaterialIds: [...new Set([...priorIds, ...attachedTemplates, ...adoptedIds])],
  });
}

/** ECMA-376 clrScheme child order. Values are copied, never invented. */
const SCHEME_COLOR_KEYS = [
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hexColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^#?([0-9A-Fa-f]{6})$/.exec(value.trim());
  return match?.[1] ? `#${match[1].toUpperCase()}` : undefined;
}

function mappedPair(
  fonts: Record<string, unknown>,
  role: "major" | "minor",
): { latin: string; ea: string } | undefined {
  const mapped = record(record(fonts[role]).mapped);
  const latin = typeof mapped.latin === "string" ? mapped.latin.trim() : "";
  const ea = typeof mapped.ea === "string" ? mapped.ea.trim() : "";
  if (!isSlideFont(latin) || !isSlideFont(ea)) return undefined;
  return { latin: canonicalFontName(latin), ea: canonicalFontName(ea) };
}

/**
 * When templates are attached and this commit adopts none of them, name each
 * one so the agent can still choose. The hint does not refuse the commit.
 */
export function unadoptedTemplateHint(root: string, adoptedSourceIds: readonly string[]): string | undefined {
  const templates = readMaterialsManifest(root).filter((entry) => entry.kind === "deck-template");
  if (!templates.length) return undefined;
  const adopted = new Set(
    adoptedSourceIds
      .map((sourceId) => canonicalDesignSourceId(sourceId))
      .filter((sourceId): sourceId is string => Boolean(sourceId)),
  );
  if (templates.some((entry) => adopted.has(`material:${entry.id}`))) return undefined;
  const named = templates.map((entry) => `「${entry.name}」（material:${entry.id}）`).join("、");
  return (
    `项目里有 PPT 设计源尚未采用：${named}。` +
    "请按用户原话分别决定：要用它的配色、字体、Logo 或版式，就把对应的 material:<id> 写入 adoptedSourceIds；" +
    "designAspects 按来源只声明用户需要的用途；只取内容或数据时，读完对应 slides/charts/tables 后声明 content/data，不采用视觉用途。此提示不阻止本次提交。"
  );
}

type AdoptionCommit = { error?: string; hint?: string; adoptedSourceIds: string[] };

/**
 * Copy scheme color tokens and already-mapped font pairs from adopted
 * design sources onto the deck. The first adopted source wins each theme key.
 * This is the source file's data, not a host palette choice. Returns a Chinese
 * error when a verified source cannot be read; a project without a deck yet
 * is left untouched.
 */
/** Seed the deck, record adoption, and return the non-blocking template hint. */
export function commitAdoptedDesignSources(
  root: string,
  adopted: readonly string[],
  toolCallId: string,
  designAspects: DesignAspects = [],
  userColors?: readonly UserColor[],
): AdoptionCommit {
  // One critical section for the whole adoption. The editor authority is judged under the lock before
  // any of its writes (theme, runtime record, receipts), so a lease lost while this call waited
  // refuses all of them.
  return withProjectWriteLock(root, (): AdoptionCommit => {
    if (editorTurnAuthorityLost(root)) {
      return { error: EDITOR_AUTHORITY_LOST_DETAIL, adoptedSourceIds: [] };
    }
    const materialSources = adopted.filter((sourceId) => sourceId.startsWith("material:"));
    if (materialSources.length) {
      const error = seedAdoptedDesignTheme(root, materialSources, designAspects);
      if (error) return { error, adoptedSourceIds: [] };
      recordUserDesignAdoption(root, materialSources);
    }
    const ids = adopted.length ? [...adopted] : ["agent-self-directed-plan"];
    for (const sourceId of ids) {
      recordSourceReceipt(root, { sourceId, state: "adopted", toolCallId });
    }
    // Receipts keep their first-seen order as an audit trail. The selection is this call's order.
    persistAdoptedSourceSelection(root, adopted, designAspects, userColors);
    const hint = unadoptedTemplateHint(root, adopted);
    return { adoptedSourceIds: ids, ...(hint ? { hint } : {}) };
  });
}

type ThemeSeed = Readonly<{
  colors: Record<string, string>;
  major?: { latin: string; ea: string };
  minor?: { latin: string; ea: string };
  paletteAdopted: boolean;
}>;

/** What adopting these sources would put into the theme, or undefined when it puts nothing. */
function absorbDeckTemplateTheme(
  material: ReturnType<typeof verifyMaterial>,
  designAspects: DesignAspects,
  id: string,
  colors: Record<string, string>,
  major: { latin: string; ea: string } | undefined,
  minor: { latin: string; ea: string } | undefined,
): {
  major: { latin: string; ea: string } | undefined;
  minor: { latin: string; ea: string } | undefined;
} {
  const aspects = sourceDesignAspects(designAspects, `material:${id}`, defaultTemplateAspects(material));
  const source = verifiedDesignSource(material);
  const json = record(source.json);
  const palette = record(json.themeColors);
  const alias = record(json.colors);
  for (const key of aspects.includes("palette") ? SCHEME_COLOR_KEYS : []) {
    if (colors[key]) continue;
    const hex = hexColor(palette[key] ?? alias[key]);
    if (hex) colors[key] = hex;
  }
  const declared = record(json.sourceFonts);
  const fonts = Object.keys(declared).length ? declared : record(json.fonts);
  const nextMajor = mappedPair(fonts, "major");
  const nextMinor = mappedPair(fonts, "minor");
  return {
    major: aspects.includes("fonts") && !major && nextMajor ? nextMajor : major,
    minor: aspects.includes("fonts") && !minor && nextMinor ? nextMinor : minor,
  };
}

function adoptedThemeSeed(
  root: string,
  sourceIds: readonly string[],
  designAspects: DesignAspects,
): ThemeSeed | undefined {
  const materialIds = adoptedMaterialIds(sourceIds);
  if (!materialIds.length) return undefined;
  const colors: Record<string, string> = {};
  let major: { latin: string; ea: string } | undefined;
  let minor: { latin: string; ea: string } | undefined;
  let paletteAdopted = false;
  for (const id of materialIds) {
    const material = verifyMaterial(root, id);
    if (paletteKind(material)) {
      // Image and PDF palettes fill accent slots with measured colours, first source first.
      const declared = sourceDesignAspects(designAspects, `material:${id}`);
      if (!declared.includes("palette")) continue;
      const accents = paletteThemeAccents(material);
      PALETTE_THEME_SLOTS.forEach((key, index) => {
        const hex = accents[index];
        if (hex && !colors[key]) colors[key] = hex;
      });
      if (accents.length) paletteAdopted = true;
      continue;
    }
    if (material.kind !== "deck-template") continue;
    ({ major, minor } = absorbDeckTemplateTheme(material, designAspects, id, colors, major, minor));
  }
  if (!Object.keys(colors).length && !major && !minor) return undefined;
  return { colors, major, minor, paletteAdopted };
}

function seededTheme(current: Theme | undefined, seed: ThemeSeed): Theme {
  const theme: Theme = current ?? {};
  const nextColors = { ...(theme.colors ?? {}) };
  for (const key of SCHEME_COLOR_KEYS) {
    if (seed.colors[key]) nextColors[key] = seed.colors[key];
  }
  // Unstyled lines fall back to `primary`. The adopted first accent takes its
  // place so that no product default colour reaches the exported slides.
  if (seed.colors.accent1) nextColors.primary = seed.colors.accent1;
  const textStyles = { ...(theme.textStyles ?? {}) };
  if (seed.major) {
    textStyles.schemeMajor = { ...record(textStyles.schemeMajor), fontFamily: seed.major };
  }
  if (seed.minor) {
    textStyles.schemeMinor = { ...record(textStyles.schemeMinor), fontFamily: seed.minor };
  }
  const nextTheme: Theme = { ...theme, colors: nextColors, textStyles };
  // Neutral table and chart chrome belongs to palette-adopted decks only. Decks without
  // the flag keep the legacy greys, so their exports stay byte-identical.
  if (seed.paletteAdopted) nextTheme.neutralChrome = true;
  return nextTheme;
}

/**
 * Whether adopting these sources would change the deck theme. A source that is already
 * reflected in the theme, or has nothing to seed, changes nothing. An unreadable source
 * reports its error text.
 */
export function adoptionThemeEffect(
  root: string,
  sourceIds: readonly string[],
  designAspects: DesignAspects = [],
): { changes: boolean; error?: string } {
  try {
    const seed = adoptedThemeSeed(root, sourceIds, designAspects);
    if (!seed || !fs.existsSync(path.join(root, "deck.pptd"))) return { changes: false };
    const current = loadProject(root).presentation.theme;
    return {
      changes: JSON.stringify(seededTheme(current, seed)) !== JSON.stringify(current ?? {}),
    };
  } catch (error) {
    if (error instanceof MaterialPackError) return { changes: false, error: error.message };
    throw error;
  }
}

export function seedAdoptedDesignTheme(
  root: string,
  sourceIds: readonly string[],
  designAspects: DesignAspects = [],
): string | undefined {
  try {
    const seed = adoptedThemeSeed(root, sourceIds, designAspects);
    if (!seed || !fs.existsSync(path.join(root, "deck.pptd"))) return undefined;
    return withProjectWriteLock(root, (): string | undefined => {
      // The theme is saved only while the editor authority still holds under this lock.
      if (editorTurnAuthorityLost(root)) return EDITOR_AUTHORITY_LOST_DETAIL;
      const project = loadProject(root);
      project.presentation.theme = seededTheme(project.presentation.theme, seed);
      saveProject(project);
      return undefined;
    });
  } catch (error) {
    if (error instanceof MaterialPackError) return error.message;
    throw error;
  }
}
