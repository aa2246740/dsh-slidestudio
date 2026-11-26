/**
 * The saved page as the Host's reference point: its hash, and what a whole-page write took away
 * from it during an editor turn. The run ledger is not asked, because a version restore rewinds the
 * page files and leaves the ledger naming a newer revision.
 */
import { loadProject, ownPageBody } from "@open-slidestudio/pptd-v2";
import {
  pageIdMatchesFile,
  pageRevisionSha256,
  persistPageKey,
  readActiveReviewGuard,
} from "@open-slidestudio/presentation-run";
import { activeElementEditScope } from "./edit-elements.js";

type Json = Record<string, unknown>;

const MAX_ELEMENTS = 6;
const MAX_FIELDS = 5;

const isPlain = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The one saved page file `pageId` names, or undefined when none or several match. */
function savedPage(projectRoot: string, pageId: string) {
  const requested = pageId.trim();
  if (!requested) return undefined;
  try {
    const matches = loadProject(projectRoot).pages.filter((loaded) => pageIdMatchesFile(requested, loaded.path));
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

/** The revision hash of the page file on disk, or undefined when there is no such file. */
export function savedPageSha256(projectRoot: string, pageId: string): string | undefined {
  const loaded = savedPage(projectRoot, pageId);
  return loaded ? pageRevisionSha256(loaded.page, persistPageKey(loaded.path)) : undefined;
}

const savedPageBody = (projectRoot: string, pageId: string): Json | undefined => {
  const loaded = savedPage(projectRoot, pageId);
  return loaded ? (JSON.parse(JSON.stringify(ownPageBody(loaded.page))) as Json) : undefined;
};

/** The page as it is saved before an editor turn's write, or undefined outside an editor turn. */
export function editTurnPageBaseline(projectRoot: string, pageId: string): Json | undefined {
  return readActiveReviewGuard(projectRoot) ? savedPageBody(projectRoot, pageId) : undefined;
}

/** Paths the saved value has and the kept value lacks, one level of nesting at a time. */
function droppedPaths(saved: unknown, kept: unknown, prefix: string, out: string[]): void {
  if (Array.isArray(saved)) {
    // Arrays of one length are compared item by item (gradient stops); a new length is an edit.
    if (Array.isArray(kept) && kept.length === saved.length) {
      saved.forEach((item, index) => droppedPaths(item, kept[index], `${prefix}[${index}]`, out));
    }
    return;
  }
  if (!isPlain(saved) || !isPlain(kept)) return;
  // A fill that became another kind of fill is a different thing, not the same one with gaps.
  if (typeof saved.type === "string" && saved.type !== kept.type) return;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (kept[key] === undefined) out.push(path);
    else droppedPaths(value, kept[key], path, out);
  }
}

/**
 * A non-blocking Chinese note naming the elements that kept their id through an editor turn's
 * whole-page write and lost optional fields the saved element had. The page is saved as sent; the
 * Host never puts the fields back. edit_elements is named only in a turn that offers it: a page or
 * deck lock does not, and the advice must not point at a tool the model lacks.
 */
export function droppedFieldsHint(projectRoot: string, pageId: string, baseline: Json | undefined): string | undefined {
  if (!baseline) return undefined;
  const after = savedPageBody(projectRoot, pageId);
  const before = Array.isArray(baseline.elements) ? (baseline.elements as unknown[]) : [];
  const now = new Map(
    (Array.isArray(after?.elements) ? (after.elements as unknown[]) : [])
      .filter(isPlain)
      .map((element) => [element.elementId, element]),
  );
  const rows: string[] = [];
  for (const saved of before) {
    if (!isPlain(saved) || typeof saved.elementId !== "string") continue;
    const kept = now.get(saved.elementId);
    if (!kept || kept.elementType !== saved.elementType) continue;
    const paths: string[] = [];
    droppedPaths(saved, kept, "", paths);
    if (!paths.length) continue;
    const more = paths.length > MAX_FIELDS ? `等 ${paths.length} 项` : "";
    rows.push(`${saved.elementId}（${paths.slice(0, MAX_FIELDS).join("、")}${more}）`);
  }
  if (!rows.length) return undefined;
  const others = rows.length > MAX_ELEMENTS ? `；另有 ${rows.length - MAX_ELEMENTS} 个元素也缺少可选字段` : "";
  const advice = activeElementEditScope(projectRoot)
    ? "请带上这些字段重新写入，或改用 edit_elements 只改要改的属性"
    : "请带上这些字段重新写入整页";
  return (
    `页面 ${pageId}：这次整页写入已按发送的内容保存，但已保存元素的下列可选字段没有带上，已被去掉：` +
    `${rows.slice(0, MAX_ELEMENTS).join("；")}${others}。如果不是有意去掉，${advice}。`
  );
}
