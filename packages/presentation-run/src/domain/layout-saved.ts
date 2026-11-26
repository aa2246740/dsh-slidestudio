/**
 * What a master or layout is in the saved deck, as against what the run ledger last committed. A
 * version restore rewinds the deck files and never the ledger, so the ledger can name a newer
 * revision than the file holds. Every check that asks whether a layout is current, and every hash
 * the model is told to echo back, reads the saved definition.
 */
import { loadProject, type DeckLayout, type DeckMaster, type Presentation } from "@open-slidestudio/pptd-v2";
import { stableSha256 } from "./hashing.js";
import type { LayoutScope } from "./layout-ledger.js";

const MASTER_KEYS = ["id", "name", "background", "elements"] as const;
const LAYOUT_KEYS = [
  "id",
  "name",
  "masterId",
  "showMasterElements",
  "background",
  "elements",
  "slots",
  "archetype",
] as const;

/** The fields of a master or layout that its hash covers; any other key of `args` is ignored. */
export function definitionOf(scope: LayoutScope, args: Record<string, unknown>): DeckMaster | DeckLayout {
  const keys = scope === "master" ? MASTER_KEYS : LAYOUT_KEYS;
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) picked[key] = args[key];
  }
  return picked as unknown as DeckMaster | DeckLayout;
}

/** The hash of the saved master or layout, or undefined when the deck has none with that id. */
export function savedDefinitionSha256(presentation: Presentation, scope: LayoutScope, id: string): string | undefined {
  const saved = (scope === "master" ? presentation.masters : presentation.layouts)?.find((item) => item.id === id);
  return saved ? stableSha256(definitionOf(scope, { ...saved })) : undefined;
}

/**
 * The hash write_layout accepts as `expectedLayoutSha256` for a master or layout, and the one the
 * editor turn shows the model beside the definition it must edit. Empty when the deck has none.
 */
export function savedLayoutSha256(root: string, scope: LayoutScope, layoutId: string): string {
  return savedDefinitionSha256(loadProject(root).presentation, scope, layoutId) ?? "";
}
