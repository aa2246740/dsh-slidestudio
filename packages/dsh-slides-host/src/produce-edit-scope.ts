import { readActiveReviewGuard } from "@open-slidestudio/presentation-run";

function guardRecord(projectRoot: string): Record<string, unknown> | undefined {
  const scope = readActiveReviewGuard(projectRoot)?.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return undefined;
  return scope as Record<string, unknown>;
}

/** True while the active lock is a metaOnly page lock (deck fields only). */
export function metaOnlyEditScope(projectRoot: string): boolean {
  return guardRecord(projectRoot)?.metaOnly === true;
}

/** Fields the active lock whitelists for deck-level metadata writes. */
export function editableMetaScope(projectRoot: string): ReadonlySet<"title" | "theme"> {
  const rec = guardRecord(projectRoot);
  if (!rec) return new Set();
  return new Set(
    (Array.isArray(rec.editableMeta) ? rec.editableMeta : [])
      .map((field) => String(field ?? "").trim())
      .filter((field): field is "title" | "theme" => field === "title" || field === "theme"),
  );
}

/**
 * A full-rewrite lock (kind "deck" + rewrite) authorizes replacing the deck:
 * write_todo commits a new plan, write_page covers every baseline page plus
 * new ids, and delete_pages/reorder_pages settle the manifest to match.
 */
export function rewriteEditScope(projectRoot: string): boolean {
  const rec = guardRecord(projectRoot);
  return rec?.kind === "deck" && rec.rewrite === true && rec.structureOnly !== true;
}

/**
 * A page-list edit lock (kind "deck" + structureOnly) authorizes page-list
 * changes: adds at insertIndex, removals from deletablePageIds, whitelisted
 * rewrites via editablePageIds. It is the only scope under which write_page
 * may create a page that is absent from the committed plan.
 */
export function structuralEditScope(
  projectRoot: string,
): { insertIndex?: number; deletablePageIds: ReadonlySet<string>; reorderPageIds: readonly string[] } | undefined {
  const rec = guardRecord(projectRoot);
  if (!rec || rec.kind !== "deck" || rec.structureOnly !== true) return undefined;
  const insertIndex = Number(rec.insertIndex);
  const deletablePageIds = new Set(
    (Array.isArray(rec.deletablePageIds) ? rec.deletablePageIds : [])
      .map((id) => String(id ?? "").trim())
      .filter((id) => id.length > 0),
  );
  return {
    insertIndex: Number.isSafeInteger(insertIndex) && insertIndex >= 0 ? insertIndex : undefined,
    deletablePageIds,
    reorderPageIds: (Array.isArray(rec.reorderPageIds) ? rec.reorderPageIds : [])
      .map((id) => String(id ?? "").trim())
      .filter((id) => id.length > 0),
  };
}
