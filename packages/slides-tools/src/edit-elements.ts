import {
  loadProject,
  ownPageBody,
  type CanonicalEditElementsArgs,
  type CanonicalWritePageArgs,
} from "@open-slidestudio/pptd-v2";
import {
  pageIdMatchesFile,
  pageRevisionSha256,
  persistPageKey,
  readActiveReviewGuard,
  reviewWriteTargets,
} from "@open-slidestudio/presentation-run";
import { inheritedReadonlyDetail } from "./write-page-layout.js";

type ActiveElementEditScope = Readonly<{
  pagePath: string;
  pageId: string;
  elementIds: readonly string[];
  expiresAt: number;
}>;

export type PreparedElementEdit =
  | { readonly ok: true; readonly page: CanonicalWritePageArgs }
  | {
      readonly ok: false;
      readonly outcome: {
        readonly outcome: "rejected";
        readonly error: string;
        readonly detail: string;
        readonly painted: false;
      };
    };

function reject(error: string, detail: string): PreparedElementEdit {
  return { ok: false, outcome: { outcome: "rejected", error, detail, painted: false } };
}

/** Resolve the exact per-page union from the editor's durable guard. */
export function activeElementEditScope(projectRoot: string, pageId?: string): ActiveElementEditScope | undefined {
  const guard = readActiveReviewGuard(projectRoot);
  const target = reviewWriteTargets(guard).find(
    ({ scope }) =>
      scope.kind === "elements" && (!pageId || persistPageKey(String(scope.pageId)) === persistPageKey(pageId)),
  );
  if (!target || !guard) return undefined;
  return {
    pagePath: target.pagePath,
    pageId: String(target.scope.pageId),
    elementIds: target.scope.elementIds as string[],
    expiresAt: typeof guard.expiresAt === "number" ? guard.expiresAt : Date.parse(String(guard.expiresAt)),
  };
}

/** Resolve one authoritative page and merge only the exact authorized element
 * set. The returned object is a complete write_page input; page metadata,
 * non-target elements, and array positions all come from disk. */
export function prepareElementEdit(projectRoot: string, args: CanonicalEditElementsArgs): PreparedElementEdit {
  const authorization = activeElementEditScope(projectRoot, args.pageId);
  if (!authorization) {
    return reject("ELEMENT_EDIT_SCOPE_REQUIRED", "edit_elements requires an active editor elements scope");
  }
  if (persistPageKey(args.pageId) !== persistPageKey(authorization.pageId)) {
    return reject("ELEMENT_EDIT_SCOPE_MISMATCH", `pageId ${args.pageId} is outside the authorized editor scope`);
  }

  let project;
  try {
    project = loadProject(projectRoot);
  } catch (error) {
    return reject("ELEMENT_EDIT_PAGE_READ_FAILED", error instanceof Error ? error.message : String(error));
  }
  const matches = project.pages.filter((loaded) => pageIdMatchesFile(args.pageId, loaded.path));
  if (matches.length !== 1) {
    return reject(
      matches.length === 0 ? "ELEMENT_EDIT_PAGE_NOT_FOUND" : "ELEMENT_EDIT_PAGE_AMBIGUOUS",
      matches.length === 0
        ? `no persisted PPTD v2 page matches ${args.pageId}`
        : `multiple persisted PPTD v2 pages match ${args.pageId}`,
    );
  }
  const loaded = matches[0]!;
  if (loaded.path !== authorization.pagePath) {
    return reject("ELEMENT_EDIT_SCOPE_MISMATCH", "the active editor scope targets a different page path");
  }

  // The merge base is the page's own body: copies of its layout are read-only, not elements to rewrite.
  const body = structuredClone(ownPageBody(loaded.page));
  const persistedId = persistPageKey(loaded.path);
  const actualSha256 = pageRevisionSha256(loaded.page, persistedId);
  if (args.expectedPageSha256.trim().toLowerCase() !== actualSha256) {
    return reject(
      "ELEMENT_EDIT_STALE_PAGE",
      `stale-page: expectedPageSha256 does not match the current persisted page ${args.pageId}; read_page again before editing`,
    );
  }
  const copy = loaded.page.elements.find(
    (element) => element.inherited !== undefined && authorization.elementIds.includes(element.elementId),
  );
  if (copy) {
    return reject("inherited_element_readonly", inheritedReadonlyDetail(project.presentation, copy));
  }

  const replacementIds = args.elements.map((element) => element.elementId);
  if (new Set(replacementIds).size !== replacementIds.length) {
    return reject("ELEMENT_EDIT_DUPLICATE_ID", "edit_elements requires unique elementIds");
  }
  const authorized = new Set(authorization.elementIds);
  const replacements = new Map(args.elements.map((element) => [element.elementId, structuredClone(element)]));
  const supplied = new Set(replacementIds);
  if (
    supplied.size !== authorized.size ||
    [...supplied].some((id) => !authorized.has(id)) ||
    [...authorized].some((id) => !supplied.has(id))
  ) {
    return reject(
      "ELEMENT_EDIT_SCOPE_MISMATCH",
      `edit_elements must replace exactly the authorized elementIds ${JSON.stringify([...authorized])}`,
    );
  }
  const currentIds = new Set(body.elements.map((element) => element.elementId));
  const missing = [...authorized].filter((id) => !currentIds.has(id));
  if (missing.length) {
    return reject("ELEMENT_EDIT_TARGET_MISSING", `authorized elementIds no longer exist: ${missing.join(", ")}`);
  }

  return {
    ok: true,
    page: {
      ...body,
      id: persistedId,
      elements: body.elements.map((element) => replacements.get(element.elementId) ?? element),
      expectedPageSha256: actualSha256,
    },
  };
}
