/**
 * Targeted element patches for `patch_page_elements`. The patch is applied to the
 * page's own canonical PPTD v2 body read from disk; the result is one complete
 * write_page input that goes through the same canonical write path (no second IR).
 */
import { loadProject, ownPageBody, type CanonicalWritePageArgs } from "@open-slidestudio/pptd-v2";
import { pageIdMatchesFile, pageRevisionSha256, persistPageKey } from "@open-slidestudio/presentation-run";
import { inheritedReadonlyDetail } from "./write-page-layout.js";

export const PATCH_PAGE_ELEMENTS_TOOL_NAME = "patch_page_elements";

/** One targeted change to one existing element. */
export type PageElementPatch = {
  readonly elementId: string;
  readonly bounds?: readonly number[];
  readonly text?: string;
  readonly fontSize?: number;
  readonly color?: string;
  readonly style?: string;
  readonly fill?: string;
  readonly border?: { readonly color?: string; readonly width?: number };
  readonly remove?: boolean;
  readonly index?: number;
};

export type PatchPageElementsArgs = {
  readonly pageId: string;
  readonly expectedPageSha256: string;
  readonly patches: readonly PageElementPatch[];
};

export type PreparedPagePatch =
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

const str = { type: "string" } as const;
const num = { type: "number" } as const;

/** The provider-facing schema; kept deliberately small (the budget test caps the whole tool at 2 KB). */
export const PATCH_PAGE_ELEMENTS_SCHEMA = {
  type: "object",
  properties: {
    pageId: str,
    expectedPageSha256: str,
    patches: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          elementId: str,
          bounds: { type: "array", items: num, minItems: 4, maxItems: 4 },
          text: str,
          fontSize: num,
          color: str,
          style: str,
          fill: str,
          border: { type: "object", additionalProperties: false, properties: { color: str, width: num } },
          remove: { type: "boolean" },
          index: { type: "integer" },
        },
        required: ["elementId"],
      },
    },
  },
  required: ["pageId", "expectedPageSha256", "patches"],
  additionalProperties: false,
} as const;

export const PATCH_PAGE_ELEMENTS_DESCRIPTION =
  "Small targeted fix to an existing page without resending it. Each patch names an existing own elementId and sets only bounds [x,y,w,h], text, fontSize, color or style (text elements), fill (solid hex) or border {color,width} (shape/line), remove:true, or index (new z-order position). Pass the page's latest pageSha256 as expectedPageSha256. The Host merges into the saved page and runs the full write_page checks, ledger and render; layout copies are read-only. Use write_page for new pages or broad rewrites.";

const FIELDS = ["bounds", "text", "fontSize", "color", "style", "fill", "border", "index"] as const;
const TEXT_FIELDS = ["text", "fontSize", "color", "style"] as const;
const FILL_TYPES = new Set(["shape", "icon"]);
const BORDER_TYPES = new Set(["shape", "line"]);

type Element = CanonicalWritePageArgs["elements"][number] & Record<string, unknown>;

function reject(error: string, detail: string): PreparedPagePatch {
  return { ok: false, outcome: { outcome: "rejected", error, detail, painted: false } };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function patchFieldIssues(patch: PageElementPatch, at: string): string[] {
  const issues: string[] = [];
  const changes = FIELDS.filter((field) => patch[field] !== undefined);
  if (patch.remove === true && changes.length) issues.push(`${at}: remove cannot be combined with other fields`);
  if (patch.remove !== true && !changes.length) issues.push(`${at}: set at least one field to change`);
  if (patch.bounds !== undefined && (patch.bounds.length !== 4 || !patch.bounds.every(isFiniteNumber))) {
    issues.push(`${at}.bounds must be [x,y,w,h] numbers`);
  } else if (patch.bounds && (patch.bounds[2]! <= 0 || patch.bounds[3]! <= 0)) {
    issues.push(`${at}.bounds width and height must be positive`);
  }
  if (patch.fontSize !== undefined && !(isFiniteNumber(patch.fontSize) && patch.fontSize > 0)) {
    issues.push(`${at}.fontSize must be a positive number`);
  }
  if (patch.border?.width !== undefined && !(isFiniteNumber(patch.border.width) && patch.border.width > 0)) {
    issues.push(`${at}.border.width must be a positive number`);
  }
  if (patch.index !== undefined && !(Number.isInteger(patch.index) && patch.index >= 0)) {
    issues.push(`${at}.index must be a non-negative integer`);
  }
  return issues;
}

/** Pure argument checks a host can run before resolving the project. */
export function pagePatchIssues(args: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (typeof args.pageId !== "string" || !args.pageId.trim()) issues.push("pageId must be a non-empty string");
  if (typeof args.expectedPageSha256 !== "string" || !args.expectedPageSha256.trim()) {
    issues.push("expectedPageSha256 must be the page's latest pageSha256");
  }
  if (!Array.isArray(args.patches) || args.patches.length === 0)
    return [...issues, "patches must be a non-empty array"];
  const seen = new Set<string>();
  args.patches.forEach((raw: unknown, index) => {
    const at = `patches[${index}]`;
    const patch = raw as PageElementPatch;
    if (!patch || typeof patch !== "object" || typeof patch.elementId !== "string" || !patch.elementId.trim()) {
      issues.push(`${at}.elementId must be a non-empty string`);
      return;
    }
    if (seen.has(patch.elementId)) issues.push(`${at}: elementId ${patch.elementId} is patched twice`);
    seen.add(patch.elementId);
    issues.push(...patchFieldIssues(patch, at));
  });
  return issues;
}

function targetIssue(element: Element, patch: PageElementPatch): string | undefined {
  const type = String(element.elementType);
  const textField = TEXT_FIELDS.find((field) => patch[field] !== undefined);
  const hasContentObject =
    element.content !== null && typeof element.content === "object" && !Array.isArray(element.content);
  if (textField && (type !== "text" || !hasContentObject)) {
    return `${patch.elementId} is ${type}; ${textField} applies to text elements only`;
  }
  if (patch.fill !== undefined && !FILL_TYPES.has(type))
    return `${patch.elementId} is ${type}; fill applies to shape/icon`;
  if (patch.border !== undefined && !BORDER_TYPES.has(type)) {
    return `${patch.elementId} is ${type}; border applies to shape/line`;
  }
  return undefined;
}

function patchedElement(element: Element, patch: PageElementPatch): Element {
  const next = structuredClone(element);
  if (patch.bounds) next.bounds = [...patch.bounds] as Element["bounds"];
  const content = (next as { content?: Record<string, unknown> }).content;
  if (content) {
    for (const field of TEXT_FIELDS) if (patch[field] !== undefined) content[field] = patch[field];
  }
  if (patch.fill !== undefined) next.fill = { type: "solid", color: patch.fill };
  if (patch.border !== undefined) next.border = { ...((next.border as object | undefined) ?? {}), ...patch.border };
  return next;
}

function applyPatches(elements: Element[], patches: readonly PageElementPatch[]): Element[] | string {
  const byId = new Map(elements.map((element) => [element.elementId, element]));
  for (const patch of patches) {
    const element = byId.get(patch.elementId);
    if (!element) return `elementId ${patch.elementId} is not an own element of this page`;
    const issue = targetIssue(element, patch);
    if (issue) return issue;
  }
  const removed = new Set(patches.filter((patch) => patch.remove === true).map((patch) => patch.elementId));
  const patchOf = new Map(patches.map((patch) => [patch.elementId, patch]));
  const next = elements
    .filter((element) => !removed.has(element.elementId))
    .map((element) =>
      patchOf.has(element.elementId) ? patchedElement(element, patchOf.get(element.elementId)!) : element,
    );
  for (const patch of patches) {
    if (patch.index === undefined) continue;
    const from = next.findIndex((element) => element.elementId === patch.elementId);
    if (patch.index >= next.length) return `index ${patch.index} for ${patch.elementId} exceeds ${next.length - 1}`;
    const [moved] = next.splice(from, 1);
    next.splice(patch.index, 0, moved!);
  }
  return next;
}

type LoadedTarget = { readonly body: ReturnType<typeof ownPageBody>; readonly id: string; readonly sha256: string };

function loadTarget(projectRoot: string, args: PatchPageElementsArgs): LoadedTarget | PreparedPagePatch {
  let project;
  try {
    project = loadProject(projectRoot);
  } catch (error) {
    return reject("PAGE_PATCH_READ_FAILED", error instanceof Error ? error.message : String(error));
  }
  const matches = project.pages.filter((loaded) => pageIdMatchesFile(args.pageId, loaded.path));
  if (matches.length !== 1) {
    return matches.length === 0
      ? reject("PAGE_PATCH_PAGE_NOT_FOUND", `no persisted PPTD v2 page matches ${args.pageId}; use write_page`)
      : reject("PAGE_PATCH_PAGE_AMBIGUOUS", `multiple persisted PPTD v2 pages match ${args.pageId}`);
  }
  const loaded = matches[0]!;
  const id = persistPageKey(loaded.path);
  const sha256 = pageRevisionSha256(loaded.page, id);
  if (args.expectedPageSha256.trim().toLowerCase() !== sha256) {
    return reject(
      "PAGE_PATCH_STALE_PAGE",
      `stale-page: expectedPageSha256 does not match page ${args.pageId}; call read_page and patch again`,
    );
  }
  const ids = new Set(args.patches.map((patch) => patch.elementId));
  const copy = loaded.page.elements.find((element) => element.inherited !== undefined && ids.has(element.elementId));
  if (copy) return reject("inherited_element_readonly", inheritedReadonlyDetail(project.presentation, copy));
  return { body: structuredClone(ownPageBody(loaded.page)), id, sha256 };
}

/**
 * Resolve the authoritative page and apply the patches to its own body. The
 * returned page is a complete write_page input with the current hash pinned.
 */
export function preparePagePatch(projectRoot: string, args: PatchPageElementsArgs): PreparedPagePatch {
  const issues = pagePatchIssues(args as unknown as Record<string, unknown>);
  if (issues.length) return reject("PAGE_PATCH_INVALID", issues.join("; "));
  const target = loadTarget(projectRoot, args);
  if ("ok" in target) return target;
  const elements = applyPatches(target.body.elements as Element[], args.patches);
  if (typeof elements === "string") return reject("PAGE_PATCH_TARGET_INVALID", elements);
  return {
    ok: true,
    page: { ...target.body, id: target.id, elements, expectedPageSha256: target.sha256 } as CanonicalWritePageArgs,
  };
}
