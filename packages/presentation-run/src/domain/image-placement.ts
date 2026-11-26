/**
 * What happened to every uploaded image (CAP-12/31). Facts only: the pages on
 * disk say where an image is shown, the ledger says whether the model looked
 * at it, and the agent's own `materialUse` declaration says why it was left
 * out. Nothing here assigns an image to a page, and nothing blocks delivery.
 */
import { loadProject } from "@open-slidestudio/pptd-v2";
import type { ToolExecution } from "./agent-tools.js";
import { latestMaterialUse, quotedNames, type MaterialUseEntry, type MaterialUseKind } from "./material-use.js";
import { readMaterialsManifest, type MaterialManifestEntry } from "./material-pack.js";
import { persistPageKey } from "./page-identity.js";
import { parseCanonicalPagePlan } from "./page-plan.js";
import { readRunLedger, type RunLedgerV1 } from "./run-ledger.js";

export type ImageUse = MaterialUseKind | "unused";

/** One `images[]` entry of `delivery-provenance.v1.json`. */
export type DeliveryImage = Readonly<{
  materialId: string;
  name: string;
  /** Page ids (deck order) that show this image, as an element or as the page background. */
  placed: readonly string[];
  use: ImageUse;
  /** `vision` only when the model actually looked at the picture. */
  basis: "vision" | "filename";
  reason?: string;
}>;

/** The slice of the design section the dispositions need. */
export type ImageDesignInput = Readonly<{
  adoptedSourceIds: readonly string[];
  designAspects: readonly Readonly<{ source: string; aspects: readonly string[] }>[];
}>;

type Placement = { pages: string[]; backgroundOnly: boolean };

const STYLE_ASPECTS = new Set(["palette", "fonts", "layouts", "decorations"]);

const normalizeSrc = (src: string): string => src.trim().replace(/^\.?\//, "");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function imageSrcOf(value: unknown): string | undefined {
  return isRecord(value) && value.type === "image" && typeof value.src === "string"
    ? normalizeSrc(value.src)
    : undefined;
}

/** Media paths one page shows: the background image plus image elements and image fills. */
function pageMediaRefs(page: { background?: unknown; elements: readonly unknown[] }): {
  background: Set<string>;
  elements: Set<string>;
} {
  const background = new Set<string>();
  const elements = new Set<string>();
  const backgroundSrc = imageSrcOf(page.background);
  if (backgroundSrc) background.add(backgroundSrc);
  for (const element of page.elements) {
    if (!isRecord(element)) continue;
    if (element.elementType === "image" && typeof element.src === "string") {
      elements.add(normalizeSrc(element.src));
    }
    const fillSrc = imageSrcOf(element.fill);
    if (fillSrc) elements.add(fillSrc);
  }
  return { background, elements };
}

function imageMaterials(root: string): readonly MaterialManifestEntry[] {
  return readMaterialsManifest(root).filter((entry) => entry.kind === "image");
}

function placementsOf(root: string, images: readonly MaterialManifestEntry[]): ReadonlyMap<string, Placement> {
  const placements = new Map<string, Placement>();
  const bySrc = new Map(images.flatMap((image) => (image.mediaSrc ? [[normalizeSrc(image.mediaSrc), image.id]] : [])));
  if (!bySrc.size) return placements;
  for (const entry of loadProject(root).pages) {
    const pageId = persistPageKey(entry.path);
    const refs = pageMediaRefs(entry.page);
    for (const [src, id] of bySrc) {
      const onElement = refs.elements.has(src);
      if (!onElement && !refs.background.has(src)) continue;
      const placement = placements.get(id) ?? { pages: [], backgroundOnly: true };
      placement.pages.push(pageId);
      if (onElement) placement.backgroundOnly = false;
      placements.set(id, placement);
    }
  }
  return placements;
}

/** Images the model has looked at: an overview tile, a single view or recorded notes. */
function imagesSeen(ledger: RunLedgerV1): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const fact of ledger.facts) {
    if (fact.type === "material.overview-viewed") {
      for (const tile of fact.tiles) seen.add(tile.materialId);
    } else if (fact.type === "material.image-viewed" || fact.type === "material.notes-recorded") {
      seen.add(fact.materialId);
    }
  }
  return seen;
}

/** Images adopted as a design source for their look; a palette source needs no page. */
function adoptedStyleImages(design: ImageDesignInput): ReadonlySet<string> {
  const adopted = new Set<string>();
  for (const sourceId of design.adoptedSourceIds) {
    const id = sourceId.replace(/^(?:(?:openkimi|openkimi-preview):)?material:/, "");
    const aspects = design.designAspects
      .filter((row) => row.source.replace(/^(?:(?:openkimi|openkimi-preview):)?material:/, "") === id)
      .flatMap((row) => row.aspects);
    if (!aspects.length || aspects.some((aspect) => STYLE_ASPECTS.has(aspect))) adopted.add(id);
  }
  return adopted;
}

/** One entry per uploaded image, in upload order. */
export function imageDispositions(
  root: string,
  ledger: RunLedgerV1,
  design: ImageDesignInput,
): readonly DeliveryImage[] {
  const images = imageMaterials(root);
  if (!images.length) return [];
  const placements = placementsOf(root, images);
  const declared = new Map(latestMaterialUse(ledger).map((entry) => [entry.materialId, entry]));
  const seen = imagesSeen(ledger);
  const styleSources = adoptedStyleImages(design);
  return images.map((image): DeliveryImage => {
    const basis = seen.has(image.id) ? "vision" : "filename";
    const base = { materialId: image.id, name: image.name, basis } as const;
    const placement = placements.get(image.id);
    const entry: MaterialUseEntry | undefined = declared.get(image.id);
    if (placement?.pages.length) {
      const asDeclared = entry && (entry.use === "placed" || entry.use === "background" || entry.use === "logo");
      const use: ImageUse = asDeclared ? entry.use : placement.backgroundOnly ? "background" : "placed";
      return { ...base, placed: placement.pages, use };
    }
    if (entry?.use === "excluded" || entry?.use === "style-reference") {
      return {
        ...base,
        placed: [],
        use: entry.use,
        ...(entry.reason ? { reason: entry.reason } : {}),
      };
    }
    if (!entry && styleSources.has(image.id)) {
      return { ...base, placed: [], use: "style-reference" };
    }
    return { ...base, placed: [], use: "unused" };
  });
}

/** The compose hint for images that are neither on a page nor explained. */
export function unusedImageWarnings(images: readonly DeliveryImage[]): readonly string[] {
  const names = images.filter((image) => image.use === "unused").map((image) => image.name);
  if (!names.length) return [];
  return [
    `图片${quotedNames(names)}没有用在任何页面，也没有说明原因。请在交付说明里告诉用户它为什么没用上；这条提示不阻止交付。`,
  ];
}

/** Hints for pages that planned an image but do not show it yet. Never throws. */
function plannedImageHints(root: string): string[] {
  try {
    const todo = readRunLedger(root)
      ?.facts.filter((fact) => fact.type === "todo.committed")
      .at(-1);
    const plan = parseCanonicalPagePlan((todo as { pagePlan?: unknown } | undefined)?.pagePlan);
    if (!plan.some((page) => page.materials?.length)) return [];
    const images = new Map(imageMaterials(root).map((image) => [image.id, image]));
    const pages = new Map(loadProject(root).pages.map((entry) => [persistPageKey(entry.path), entry.page] as const));
    return plan.flatMap((planned, index) => {
      const page = pages.get(planned.pageId);
      if (!page || !planned.materials?.length) return [];
      const refs = pageMediaRefs(page);
      const missing = planned.materials.flatMap((id) => {
        const image = images.get(id);
        if (!image?.mediaSrc) return [];
        const src = normalizeSrc(image.mediaSrc);
        return refs.elements.has(src) || refs.background.has(src) ? [] : [image.name];
      });
      if (!missing.length) return [];
      return [
        `第 ${index + 1} 页（${planned.title}）计划放入图片${quotedNames(missing)}，但页面里还没有${
          missing.length > 1 ? "这些图片" : "这张图片"
        }；这条提示不阻止检查通过。`,
      ];
    });
  } catch {
    return [];
  }
}

/** Attach the planned-but-missing image hints to a `review_pages` result. */
export function withImagePlanHints(root: string, name: string, result: ToolExecution): ToolExecution {
  if (name !== "review_pages") return result;
  const hints = plannedImageHints(root);
  if (!hints.length) return result;
  const payload = isRecord(result.payload) ? result.payload : {};
  return {
    ...result,
    detail: [result.detail, ...hints].filter(Boolean).join("\n"),
    payload: { ...payload, hints },
  };
}
