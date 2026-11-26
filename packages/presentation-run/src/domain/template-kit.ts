/**
 * The reusable-component kit that intake extracts from a PPTX template (architecture §3.21):
 * validated reading, the `material:<id>#<componentId>` reference syntax, and which design aspect
 * a component belongs to. Nothing here expands a component or touches a project; it only decides
 * what a verified derivative holds. A malformed component is skipped, never a reason to distrust
 * the rest of the kit, and an archetype that lists no components is a legal kit.
 */
import { createHash } from "node:crypto";
import type { DesignAspect } from "./design-aspects.js";

export const TEMPLATE_KIT_SCHEMA = "template-kit/v1";
export const TEMPLATE_KIT_VERSION = 4;
export const TEMPLATE_KIT_FILE = "template-kit.json";

type RecordValue = Record<string, unknown>;
export type KitBox = readonly [number, number, number, number];

export type KitElement = RecordValue & {
  elementId: string;
  elementType: string;
  bounds: KitBox;
};

export type KitComponent = Readonly<{
  id: string;
  archetype: string;
  role: "decoration" | "smartart";
  scopeHint: "layout" | "page";
  slides: readonly number[];
  box: KitBox;
  elements: readonly KitElement[];
  smartArt?: RecordValue;
}>;

export type KitAsset = Readonly<{
  file: string;
  kind: "original" | "derived";
  sha256: string;
  detail?: string;
}>;

export type LoadedTemplateKit = Readonly<{
  materialId: string;
  kitSha256: string;
  components: readonly KitComponent[];
  assets: readonly KitAsset[];
}>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function box(value: unknown): KitBox | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  if (!value.every((part) => typeof part === "number" && Number.isFinite(part))) return undefined;
  return value as unknown as KitBox;
}

const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function component(raw: unknown): KitComponent | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, role, scopeHint } = raw;
  if (typeof id !== "string" || !COMPONENT_ID.test(id)) return undefined;
  if (role !== "decoration" && role !== "smartart") return undefined;
  const componentBox = box(raw.box);
  if (!componentBox || !Array.isArray(raw.elements) || !raw.elements.length) return undefined;
  const elements: KitElement[] = [];
  for (const entry of raw.elements) {
    if (!isRecord(entry)) return undefined;
    const bounds = box(entry.bounds);
    if (typeof entry.elementId !== "string" || typeof entry.elementType !== "string" || !bounds) {
      return undefined;
    }
    elements.push({ ...entry, elementId: entry.elementId, elementType: entry.elementType, bounds });
  }
  return {
    id,
    archetype: typeof raw.archetype === "string" ? raw.archetype : "",
    role,
    scopeHint: scopeHint === "layout" ? "layout" : "page",
    slides: Array.isArray(raw.slides) ? raw.slides.filter((slide): slide is number => Number.isSafeInteger(slide)) : [],
    box: componentBox,
    elements,
    ...(isRecord(raw.smartArt) ? { smartArt: raw.smartArt } : {}),
  };
}

function asset(raw: unknown): KitAsset | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.file !== "string" || !/^[0-9a-f]{64}$/.test(String(raw.sha256))) return undefined;
  if (raw.kind !== "original" && raw.kind !== "derived") return undefined;
  return {
    file: raw.file,
    kind: raw.kind,
    sha256: String(raw.sha256),
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
  };
}

/** The exact bytes intake hashed for the kit pointer. */
function kitBytes(kit: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(kit, null, 2)}\n`);
}

/**
 * The embedded kit of a deck-template derivative, or undefined when none is current: the pointer,
 * its sha256 over the embedded kit, and the schema/version must all agree.
 */
export function loadTemplateKit(derivative: RecordValue): LoadedTemplateKit | undefined {
  const deck = derivative["deck-template"];
  if (!isRecord(deck) || !isRecord(deck.kit) || !isRecord(deck.templateKit)) return undefined;
  const { kit: pointer, templateKit: kit } = deck;
  if (pointer.file !== TEMPLATE_KIT_FILE || !/^[0-9a-f]{64}$/.test(String(pointer.sha256))) {
    return undefined;
  }
  if (kit.schema !== TEMPLATE_KIT_SCHEMA || kit.version !== TEMPLATE_KIT_VERSION) return undefined;
  const kitSha256 = createHash("sha256").update(kitBytes(kit)).digest("hex");
  if (kitSha256 !== pointer.sha256) return undefined;
  const materialId = typeof derivative.materialId === "string" ? derivative.materialId : "";
  const components = (Array.isArray(kit.components) ? kit.components : [])
    .map(component)
    .filter((entry): entry is KitComponent => entry !== undefined);
  const assets = (Array.isArray(kit.assets) ? kit.assets : [])
    .map(asset)
    .filter((entry): entry is KitAsset => entry !== undefined);
  return { materialId, kitSha256, components, assets };
}

export function hasValidTemplateKit(derivative: RecordValue): boolean {
  return loadTemplateKit(derivative) !== undefined;
}

export function componentRef(materialId: string, componentId: string): string {
  return `material:${materialId}#${componentId}`;
}

export function parseComponentRef(ref: unknown): { materialId: string; componentId: string } | undefined {
  if (typeof ref !== "string" || !ref.startsWith("material:")) return undefined;
  const hash = ref.lastIndexOf("#");
  const materialId = ref.slice("material:".length, hash < 0 ? undefined : hash);
  const componentId = hash < 0 ? "" : ref.slice(hash + 1);
  if (!materialId || !componentId || /\s/.test(componentId)) return undefined;
  return { materialId, componentId };
}

/**
 * The aspects a user must have adopted for the template before a component may be used. A derived
 * (photo-processed) kit image needs `photos`; shapes, lines, header logos and every other image are
 * decoration paint and need `decorations`. A mixed component needs both.
 */
export function componentAspects(
  kit: LoadedTemplateKit,
  entry: KitComponent,
): readonly Extract<DesignAspect, "decorations" | "photos">[] {
  const derived = new Set(kit.assets.filter((item) => item.kind === "derived").map((i) => i.file));
  const isPhoto = (element: KitElement) => element.elementType === "image" && derived.has(String(element.src));
  const aspects: Extract<DesignAspect, "decorations" | "photos">[] = [];
  if (entry.elements.some((element) => !isPhoto(element))) aspects.push("decorations");
  if (entry.elements.some(isPhoto)) aspects.push("photos");
  return aspects;
}
