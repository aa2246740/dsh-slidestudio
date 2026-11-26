/**
 * Which elements are template-component paint. A component the Host expanded keeps the template's
 * own colours, so the pack palette check must not refuse them. An element is exempt only when it
 * is an expanded component element (a decoration whose id the expansion wrote: `tpl-…`, or a
 * layout or master copy of one) and its identity, the element type, its shape or geometry and its
 * paint (fill, border, shadow, crop shape and content), is identical to an element of a component
 * the user has adopted the template for. Paint alone is not enough: an ordinary element that
 * reuses a template colour stays under the palette rule. An attached but unadopted template grants
 * nothing, and neither does any template while a Hub style pack is in effect, since the pack owns
 * the palette. The test is stateless so it also holds when stored pages are re-checked.
 */
import type { PptdElement } from "@open-slidestudio/pptd-v2";
import { currentAdoptedSourceSelection } from "./design-adoption.js";
import { DEFAULT_TEMPLATE_ASPECTS, readDesignAspects, sourceDesignAspects } from "./design-aspects.js";
import { stableSha256 } from "./hashing.js";
import { ownElements } from "./layout-gates.js";
import { readMaterialsManifest, verifyMaterial } from "./material-pack.js";
import { selectedStylePackId } from "./style-pack-priority.js";
import { canonicalDesignSourceId } from "./theme-pack.js";
import { isExpandedTemplateElement } from "./template-component-expand.js";
import { componentAspects, loadTemplateKit } from "./template-kit.js";

/**
 * What expansion copies unchanged. The id, bounds, role, image source, SmartArt meta and group id
 * are rewritten per use, so they are not part of the identity.
 */
const IDENTITY_FIELDS = [
  "shapeName",
  "geometry",
  "points",
  "viewBox",
  "arrow",
  "fill",
  "border",
  "shadow",
  "cropShape",
  "content",
] as const;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function identityKey(record: Record<string, unknown>): string | undefined {
  if (typeof record.elementType !== "string") return undefined;
  const identity: Record<string, unknown> = { elementType: record.elementType };
  for (const field of IDENTITY_FIELDS) {
    if (record[field] !== undefined) identity[field] = record[field];
  }
  return stableSha256(JSON.parse(JSON.stringify(identity)));
}

function kitIdentityKeys(projectRoot: string): Set<string> {
  const keys = new Set<string>();
  try {
    if (selectedStylePackId(projectRoot)) return keys;
    const adopted = new Set(currentAdoptedSourceSelection(projectRoot).map((id) => canonicalDesignSourceId(id) ?? id));
    const declared = readDesignAspects(projectRoot);
    for (const entry of readMaterialsManifest(projectRoot)) {
      const sourceId = `material:${entry.id}`;
      if (entry.kind !== "deck-template" || !adopted.has(sourceId)) continue;
      try {
        const granted: readonly string[] = sourceDesignAspects(declared, sourceId, DEFAULT_TEMPLATE_ASPECTS);
        const kit = loadTemplateKit(verifyMaterial(projectRoot, entry.id).derivative);
        if (!kit) continue;
        for (const component of kit.components) {
          // The same adoption a component reference needs: every aspect the component draws on.
          if (!componentAspects(kit, component).every((aspect) => granted.includes(aspect))) {
            continue;
          }
          for (const element of component.elements) {
            const key = identityKey(element);
            if (key) keys.add(key);
          }
        }
      } catch {
        // A template that fails verification grants no exemption.
      }
    }
  } catch {
    // An unreadable manifest, runtime or receipt file grants none either.
    keys.clear();
  }
  return keys;
}

/** The predicate for one project; the kits are read once, on first use. */
export function templateComponentPaintCheck(projectRoot: string): (element: unknown) => boolean {
  let keys: Set<string> | undefined;
  return (element) => {
    const record = recordOf(element);
    if (!record || typeof record.elementId !== "string") return false;
    if (!isExpandedTemplateElement({ elementId: record.elementId, layoutRole: record.layoutRole })) {
      return false;
    }
    const key = identityKey(record);
    if (!key) return false;
    keys ??= kitIdentityKeys(projectRoot);
    return keys.has(key);
  };
}

/**
 * Whether a page is made of nothing but expanded template components. A component reference is a
 * request for the template's decoration that the model placed itself, so the page it stands on is
 * not empty even though it holds no text. One element the model drew by hand, or no own element at
 * all (a page that only inherits its layout's copies), keeps the page under the empty rule.
 */
export function holdsOnlyTemplateComponents(
  page: { elements: readonly PptdElement[] },
  projectRoot: string | undefined,
): boolean {
  if (!projectRoot) return false;
  const own = ownElements(page.elements);
  if (!own.length) return false;
  const isComponent = templateComponentPaintCheck(projectRoot);
  return own.every(isComponent);
}
