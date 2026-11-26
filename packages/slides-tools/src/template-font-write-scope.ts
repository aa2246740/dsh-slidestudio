import { isDeepStrictEqual } from "node:util";
import { loadProject } from "@open-slidestudio/pptd-v2";
import {
  pageIdMatchesFile,
  readActiveReviewGuard,
  reviewWriteTargetForPage,
  type TemplateFontPolicy,
} from "@open-slidestudio/presentation-run";
import { normalizeTemplatePageFonts } from "./template-font-policy.js";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function currentPage(projectRoot: string, pageId: string): RecordValue | undefined {
  try {
    const loaded = loadProject(projectRoot).pages.find((page) => pageIdMatchesFile(pageId, page.path));
    return loaded?.page as unknown as RecordValue | undefined;
  } catch {
    return undefined;
  }
}

function normalizeSelectedElements(
  args: RecordValue,
  policy: TemplateFontPolicy | undefined,
  elementIds: ReadonlySet<string>,
  includeTheme: boolean,
): ReturnType<typeof normalizeTemplatePageFonts> {
  const elements = Array.isArray(args.elements)
    ? args.elements.filter((element) => {
        const id = asRecord(element)?.elementId;
        return typeof id === "string" && elementIds.has(id);
      })
    : [];
  if (!elements.length && !includeTheme) return [];
  const selected: RecordValue = { ...args, elements };
  if (!includeTheme) delete selected.theme;
  return normalizeTemplatePageFonts(selected, policy);
}

/**
 * Apply adopted-template font normalization only to authored or authorized
 * content. Editor element scopes are exact; page scopes include changed/new
 * elements, so background-only edits leave every existing font untouched.
 */
export function normalizeScopedTemplateFonts(
  args: RecordValue,
  policy: TemplateFontPolicy | undefined,
  projectRoot: string,
): ReturnType<typeof normalizeTemplatePageFonts> {
  const guard = readActiveReviewGuard(projectRoot);
  if (!guard) return normalizeTemplatePageFonts(args, policy);
  const pageId = String(args.id ?? args.pageId ?? "").trim();
  const target = reviewWriteTargetForPage(guard, pageId);
  if (!target) return [];

  if (target.scope.kind === "elements") {
    const elementIds = Array.isArray(target.scope.elementIds)
      ? target.scope.elementIds.filter((id): id is string => typeof id === "string")
      : [];
    return normalizeSelectedElements(args, policy, new Set(elementIds), false);
  }

  const savedPage = currentPage(projectRoot, pageId);
  if (!savedPage) return normalizeTemplatePageFonts(args, policy);
  const savedElements = new Map(
    (Array.isArray(savedPage.elements) ? savedPage.elements : [])
      .map(asRecord)
      .filter((element): element is RecordValue => Boolean(element))
      .map((element) => [String(element.elementId ?? ""), element]),
  );
  const changedIds = new Set<string>();
  for (const element of Array.isArray(args.elements) ? args.elements : []) {
    const record = asRecord(element);
    if (!record || typeof record.elementId !== "string") continue;
    const previous = savedElements.get(record.elementId);
    if (!previous || !isDeepStrictEqual(previous, record)) changedIds.add(record.elementId);
  }
  const includeTheme =
    Object.prototype.hasOwnProperty.call(args, "theme") && !isDeepStrictEqual(args.theme, savedPage.theme);
  return normalizeSelectedElements(args, policy, changedIds, includeTheme);
}
