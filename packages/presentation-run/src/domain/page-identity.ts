import path from "node:path";
import { loadProject, type PptdProject } from "@open-slidestudio/pptd-v2";

/** One identity normalization owner. Filenames and historical hashes are not rewritten. */
export function persistPageKey(name: string): string {
  const base = name
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/\.page$/i, "")
    .toLowerCase();
  return base.replace(/^0+(\d)/, "$1");
}

export function persistPagePathFromId(pageId: string): string {
  const key = persistPageKey(pageId.trim());
  return key ? `pages/${key}.page` : "";
}

export function canonicalPageId(name: string): string {
  return persistPageKey(name);
}

export function canonicalPagePath(name: string): string {
  return persistPagePathFromId(name);
}

export type PlanPageValidation =
  | { readonly ok: true; readonly canonicalIds: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly conflicts: readonly Readonly<{ key: string; rawIds: readonly string[] }>[];
    };

export function validatePlanPageIds(pageIds: readonly string[]): PlanPageValidation {
  const byKey = new Map<string, string[]>();
  for (const raw of pageIds) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) {
      return {
        ok: false,
        reason: "plan contains empty page id",
        conflicts: [],
      };
    }
    const key = canonicalPageId(trimmed);
    if (!key) {
      return {
        ok: false,
        reason: `plan page id ${trimmed} produces empty canonical key`,
        conflicts: [],
      };
    }
    const list = byKey.get(key) ?? [];
    list.push(trimmed);
    byKey.set(key, list);
  }

  const conflicts: Array<{ key: string; rawIds: string[] }> = [];
  for (const [key, rawIds] of byKey.entries()) {
    if (rawIds.length > 1) {
      conflicts.push({ key, rawIds });
    }
  }

  if (conflicts.length > 0) {
    const details = conflicts.map((c) => `${c.key} (${c.rawIds.join(", ")})`).join("; ");
    return {
      ok: false,
      reason: `plan contains duplicate canonical page ids: ${details}`,
      conflicts,
    };
  }

  return {
    ok: true,
    canonicalIds: Array.from(byKey.keys()),
  };
}

export type ProjectIdentityResolution =
  | { readonly kind: "unreadable"; readonly detail: string }
  | {
      readonly kind: "resolved";
      readonly pages: ReadonlyMap<string, string>;
      readonly aliases: ReadonlyMap<string, string>;
    }
  | {
      readonly kind: "collision";
      readonly conflicts: readonly Readonly<{ key: string; paths: readonly string[] }>[];
    };

export function resolveProjectPageIdentities(projectOrRoot: PptdProject | string): ProjectIdentityResolution {
  let project: PptdProject;
  try {
    project = typeof projectOrRoot === "string" ? loadProject(projectOrRoot) : projectOrRoot;
  } catch (error) {
    return { kind: "unreadable", detail: error instanceof Error ? error.message : String(error) };
  }

  const byKey = new Map<string, string[]>();
  const aliases = new Map<string, string>();
  for (const pagePath of project.presentation.pages) {
    const normalizedPath = pagePath.replace(/\\/g, "/");
    const key = canonicalPageId(normalizedPath);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    if (!list.includes(normalizedPath)) {
      list.push(normalizedPath);
    }
    byKey.set(key, list);
    aliases.set(normalizedPath, key);
    aliases.set(path.basename(normalizedPath, ".page"), key);
  }

  const conflicts: Array<{ key: string; paths: string[] }> = [];
  const pages = new Map<string, string>();
  for (const [key, paths] of byKey.entries()) {
    if (paths.length > 1) {
      conflicts.push({ key, paths });
    } else {
      const single = paths[0];
      if (single) pages.set(key, single);
    }
  }

  if (conflicts.length > 0) {
    return { kind: "collision", conflicts };
  }

  return { kind: "resolved", pages, aliases };
}

export type ResolveMutationPathResult =
  | { readonly ok: true; readonly pagePath: string; readonly canonicalId: string }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly code: "PAGE_ID_COLLISION" | "PAGE_NOT_FOUND" | "PROJECT_UNREADABLE";
    };

export function resolvePagePathForMutation(
  projectOrRoot: PptdProject | string,
  targetId: string,
): ResolveMutationPathResult {
  const canonicalId = canonicalPageId(targetId);
  if (!canonicalId) {
    return {
      ok: false,
      reason: `invalid target page id: ${targetId}`,
      code: "PAGE_NOT_FOUND",
    };
  }
  const identity = resolveProjectPageIdentities(projectOrRoot);
  if (identity.kind === "unreadable") return { ok: false, code: "PROJECT_UNREADABLE", reason: identity.detail };
  if (identity.kind === "collision") {
    const conflict = identity.conflicts.find((c) => c.key === canonicalId);
    return {
      ok: false,
      reason: conflict
        ? `cannot mutate page ${targetId}: conflicting paths exist for canonical id ${canonicalId} (${conflict.paths.join(", ")})`
        : `project has ambiguous page identity collisions: ${identity.conflicts.map((c) => c.key).join(", ")}`,
      code: "PAGE_ID_COLLISION",
    };
  }

  const existing = identity.pages.get(canonicalId);
  if (existing) {
    return {
      ok: true,
      pagePath: existing,
      canonicalId,
    };
  }

  return {
    ok: true,
    pagePath: canonicalPagePath(canonicalId),
    canonicalId,
  };
}
