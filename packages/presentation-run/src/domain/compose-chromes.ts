/**
 * The chrome fingerprint recorded by a compose, extended with the project's
 * current style authority. A deck composed under an older decision therefore
 * stops counting as composed after the user changes it, while page revisions,
 * renders and geometry checks stay valid and are not discarded.
 */
import type { PptdProject } from "@open-slidestudio/pptd-v2";
import { readDesignAuthority } from "./design-authority.js";
import { stableSha256 } from "./hashing.js";
import { layoutChromes, pageChromes } from "./page-chrome.js";

function designAuthorityChrome(root: string): Record<string, string> {
  const reading = readDesignAuthority(root);
  if (reading.kind !== "valid") return {};
  return { designAuthority: stableSha256(reading.authority) };
}

export function composePageChromes(project: PptdProject | undefined, root: string): Record<string, string> {
  return { ...layoutChromes(pageChromes(project)), ...designAuthorityChrome(root) };
}

export function composeLayoutChromes(chromes: ReadonlyMap<string, string>, root: string): Record<string, string> {
  return { ...layoutChromes(chromes), ...designAuthorityChrome(root) };
}
