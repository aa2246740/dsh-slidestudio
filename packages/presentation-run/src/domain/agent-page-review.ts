import type { AgentToolState } from "./agent-tools.js";
import { inferDeckIntent } from "./compose-ir.js";
import { reviewSkillPages, type LayoutReview } from "./layout-qa.js";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { persistPageKey } from "./page-identity.js";
import { reportFactIssues } from "./report-facts.js";
import { inspectRunLedger } from "./run-ledger.js";
import type { SkillPageInput } from "./skill-pages.js";
import { resolveTodoExhibitContract, type TodoExhibitContract } from "./todo-exhibits.js";

/** Disk SSOT → review input shared by structural and single-page reviews. */
export function diskSkillPages(state: AgentToolState): SkillPageInput[] {
  if (!state.projectRoot) return [];
  return loadProject(state.projectRoot).pages.map((entry) => ({
    id: persistPageKey(entry.path),
    pageType: entry.page.pageType,
    notes: entry.page.notes,
    background: entry.page.background,
    animations: entry.page.animations,
    elements: entry.page.elements,
  }));
}

/** Resolve each persisted page to the exact plan contract used by review_pages. */
export function pageExhibitContracts(state: AgentToolState, pages: readonly SkillPageInput[]): TodoExhibitContract[] {
  const contracts = state.todos.map((todo, index) => resolveTodoExhibitContract(todo, index, state.brief));
  const legacy = state.todos.every((todo) => todo.pageId === undefined);
  const byId = new Map(
    state.todos.flatMap((todo, index) =>
      todo.pageId === undefined ? [] : [[persistPageKey(todo.pageId), contracts[index]!] as const],
    ),
  );
  // Disk order is write order until compose. Only wholly id-less historical
  // plans can use position; a missing ID in a modern plan must not borrow one.
  return pages.map(
    (page, index) =>
      (legacy ? contracts[index] : byId.get(persistPageKey(page.id))) ?? {
        title: "",
        exhibits: ["none"],
      },
  );
}

export function reviewCurrent(
  state: AgentToolState,
  pages: SkillPageInput[],
  mode: "compose" | "strict" = "strict",
): LayoutReview {
  const classroom = inferDeckIntent(state.brief) === "teach";
  const review = reviewSkillPages(pages, {
    projectRoot: state.projectRoot,
    researchHadGap: state.researchNotes.some((note) => Boolean(note.gap) || note.source === "none"),
    todos: pageExhibitContracts(state, pages),
    mode: classroom && mode === "compose" ? "compose" : classroom ? "strict" : mode,
    courseware: state.playbook.designSystemId === "academic/paper-white-courseware" && classroom,
  });
  const extras = reportFactIssues(state.brief, pages, state.referenceText);
  if (extras.length) {
    review.issues.push(...extras);
    review.ok = false;
  }
  state.lastReview = review;
  return review;
}

/**
 * Summarize raster readiness for `review_pages`: prefer the in-session render when
 * present, otherwise fall back to current-revision disk raster facts so a cold-started
 * or switched model does not re-render pages that already passed layout QA on disk.
 */
export function reviewRasterNote(state: AgentToolState): {
  readonly note: string;
  readonly allCurrentOnDisk: boolean;
} {
  if (state.lastRaster) {
    return {
      note: `last render_page: ${state.lastRaster.kind} ${state.lastRaster.src ?? ""} — ${state.lastRaster.note}`,
      allCurrentOnDisk: false,
    };
  }
  if (state.projectRoot) {
    const inspection = inspectRunLedger(state.projectRoot);
    const total = inspection.pages.length;
    if (total > 0) {
      const rendered = inspection.pages.filter((page) => page.raster);
      if (rendered.length > 0) {
        const passed = rendered.filter((page) => page.layout === "pass").length;
        const failed = rendered.filter((page) => page.layout === "fail").length;
        const summary = `${passed} layout pass${failed ? `, ${failed} layout fail` : ""}`;
        if (rendered.length === total) {
          return {
            note: `disk rasters current: ${rendered.length}/${total} pages rendered (${summary}); no re-render needed unless you edit a page.`,
            allCurrentOnDisk: failed === 0,
          };
        }
        const missing = inspection.pages
          .filter((page) => !page.raster)
          .map((page) => page.pageId)
          .join(", ");
        return {
          note: `disk rasters: ${rendered.length}/${total} pages current (${summary}); missing render_page: ${missing}`,
          allCurrentOnDisk: false,
        };
      }
    }
  }
  return { note: "no render_page yet — you have not seen the native #slide", allCurrentOnDisk: false };
}
