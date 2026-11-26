/**
 * The pack-colour sources of a project's writes. write_page, write_layout, the run ledger's
 * structure check and the agent tools all build their allowed palette from one list: the design
 * pack (when one is chosen) plus every adopted material source in the receipt. packColorWriteContext
 * then verifies each material against receipt.json, so one adoption grants one allowed set.
 */
import { currentAdoptedSourceSelection } from "./design-adoption.js";
import { effectiveCatalogPackId } from "./design-authority.js";
import { packColorWriteContext, type PackColorWriteContext } from "./theme-pack.js";

/**
 * The catalog pack that may grant palette now: the current authority when it
 * names one, else the original Hub pack. A material authority grants through
 * its adopted receipt instead, so it names no catalog id here.
 */
export function runtimeDesignSystemId(projectRoot: string): string | undefined {
  return effectiveCatalogPackId(projectRoot);
}

/**
 * The sources that may grant palette. A corrupt receipt file throws, so a caller that must report
 * it (the run ledger) can; a caller that fails closed catches it.
 */
export function packColorSourceIds(projectRoot: string | undefined, designSystemId: string | undefined): string[] {
  return [
    ...(designSystemId ? [designSystemId] : []),
    ...(projectRoot ? currentAdoptedSourceSelection(projectRoot) : []),
  ];
}

/**
 * The context of write_page and write_layout. An unreadable runtime or receipt file grants no
 * adopted palette (fail closed); the design pack, when present, still applies.
 */
export function projectPackColorContext(projectRoot: string): PackColorWriteContext {
  const designSystemId = runtimeDesignSystemId(projectRoot);
  let sourceIds = designSystemId ? [designSystemId] : [];
  try {
    sourceIds = packColorSourceIds(projectRoot, designSystemId);
  } catch {
    /* a corrupt receipt file grants no adopted palette */
  }
  return packColorWriteContext(sourceIds, projectRoot);
}
