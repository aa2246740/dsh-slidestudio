import fs from "node:fs";
import path from "node:path";
import { chromeSha256, loadProject, type PptdProject } from "@open-slidestudio/pptd-v2";
import { persistPageKey } from "./page-identity.js";

/**
 * The deck as it is on disk, or undefined when there is no readable deck. An unreadable deck is
 * reported by the YAML gate; chrome checks then simply have nothing to compare against.
 */
export function diskProject(root: string): PptdProject | undefined {
  if (!fs.existsSync(path.join(root, "deck.pptd"))) return undefined;
  try {
    return loadProject(root);
  } catch {
    return undefined;
  }
}

/**
 * Chrome fingerprint (the master and layout copies a page shows) per persisted page id. A page
 * without a usable layout reads "none". Layout edits change this value, not the page revision.
 */
export function pageChromes(project: PptdProject | undefined): Map<string, string> {
  const chromes = new Map<string, string>();
  if (!project) return chromes;
  try {
    for (const entry of project.pages) {
      chromes.set(persistPageKey(entry.path), chromeSha256(project, entry.page));
    }
  } catch {
    // A page the fingerprint cannot read is unknown, not stale: the YAML gate reports it.
    return new Map();
  }
  return chromes;
}

/** The chrome a page shows on disk right now, recorded with each rendered raster. */
export function pageChromeOnDisk(root: string, pageId: string): string {
  return pageChromes(diskProject(root)).get(pageId) ?? "none";
}

/**
 * The chrome of the pages that show a layout, by page id. Pages without one are left out, so a
 * deck without layouts has no chrome record and its compose hash does not change.
 */
export function layoutChromes(chromes: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(
    [...chromes].filter(([, chrome]) => chrome !== "none").sort(([left], [right]) => left.localeCompare(right)),
  );
}
