import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { pageIdMatchesFile } from "@open-slidestudio/presentation-run";

/** True when a persisted PPTD page file matches `pageId`. */
export function yamlExistsForPage(projectRoot: string, pageId: string): boolean {
  try {
    if (!fs.existsSync(path.join(projectRoot, "deck.pptd"))) return false;
    const project = loadProject(projectRoot);
    if (project.pages.length === 0) return false;
    const needle = pageId.toLowerCase();
    return project.pages.some((loaded) => pageIdMatchesFile(needle, loaded.path));
  } catch {
    return false;
  }
}
