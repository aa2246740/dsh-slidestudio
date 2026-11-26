/**
 * write_layout (masters-layouts §3.20). Defines the deck master or one layout as a whole
 * replacement. Pages never repeat this chrome: saveProject copies it into every page that uses the
 * layout, so the checks and the page counts for a changed layout are made here, once.
 */
import {
  chromeSha256,
  layoutSchemaIssues,
  loadProject,
  saveProject,
  withProjectWriteLock,
  type DeckLayout,
  type DeckMaster,
  type Page,
  type Presentation,
  type PptdElement,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import type { ToolExecution } from "./agent-tools.js";
import { stableSha256 } from "./hashing.js";
import { currentLayoutRevision, recordLayoutRevision, type LayoutScope } from "./layout-ledger.js";
import { layoutWriteRefusal } from "./layout-edit-scope.js";
import { definitionOf, savedDefinitionSha256 } from "./layout-saved.js";
import { pageGeometryIssues, SLIDE_HEIGHT, SLIDE_WIDTH, writePageColorIssues } from "./layout-qa.js";
import { sampleTextElementIds, sampleTextIndexForRoot } from "./layout-sample-text.js";
import { MaterialPackError } from "./material-pack.js";
import { projectPackColorContext } from "./pack-color-context.js";
import type { RunToolContext } from "./run-ledger.js";
import type { SkillPageInput } from "./skill-pages.js";
import { isExpandedTemplateElement } from "./template-component-expand.js";

const NAME = "write_layout";
const KIND_LABEL: Record<LayoutScope, string> = { master: "母版", layout: "版式" };
const GEOMETRY_LABEL: Readonly<Record<string, string>> = {
  overflow: "文字超出画布",
  overlap: "文字互相重叠",
  overlap_layout: "文字与继承的版式元素重叠",
  footer_zone: "文字进入页脚保留区，请设为页脚（layoutRole footer）",
  zero_area: "元素面积为零",
};

/** A layout-level finding. Only colour and schema refusals block a write; these are reported with it. */
export type LayoutQaIssue = { code: string; elementId?: string; detail: string };

function rejected(error: string, detail: string): ToolExecution {
  return {
    name: NAME,
    ok: false,
    summary: "版式未保存",
    detail,
    payload: { outcome: "rejected", error, detail },
  };
}

function isComponent(element: unknown): boolean {
  return (
    typeof element === "object" &&
    element !== null &&
    (element as { elementType?: unknown }).elementType === "component"
  );
}

function hasBounds(element: unknown): boolean {
  const bounds = (element as { bounds?: unknown } | null)?.bounds;
  return (
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every((value) => typeof value === "number" && Number.isFinite(value))
  );
}

/** The layout or master as a page-shaped value, so the page colour and geometry checks apply. */
function asSkillPage(definition: DeckMaster | DeckLayout): SkillPageInput {
  return {
    id: definition.id,
    elements: definition.elements,
    background: definition.background,
  } as unknown as SkillPageInput;
}

/** The deck as it would be after the write. A second master stays in the list so the singleton rule fires. */
function withDefinition(
  presentation: Presentation,
  scope: LayoutScope,
  definition: DeckMaster | DeckLayout,
): Presentation {
  if (scope === "master") {
    const masters = (presentation.masters ?? []).filter((item) => item.id !== definition.id);
    return { ...presentation, masters: [...masters, definition as DeckMaster] };
  }
  const layouts = presentation.layouts ?? [];
  const index = layouts.findIndex((item) => item.id === definition.id);
  const next =
    index < 0
      ? [...layouts, definition as DeckLayout]
      : layouts.map((item, position) => (position === index ? (definition as DeckLayout) : item));
  return { ...presentation, layouts: next };
}

/** Pages that show this master or layout. A master counts the pages of every layout that names it. */
function usesSurface(presentation: Presentation, page: Page, scope: LayoutScope, id: string): boolean {
  if (scope === "layout") return page.layoutId === id;
  const layout = presentation.layouts?.find((item) => item.id === page.layoutId);
  return layout?.masterId === id;
}

function chromeByPath(project: PptdProject): Map<string, string> {
  return new Map(project.pages.map((entry) => [entry.path, chromeSha256(project, entry.page)]));
}

function surfaceCounts(
  project: PptdProject,
  scope: LayoutScope,
  id: string,
  chromeBefore?: ReadonlyMap<string, string>,
): { pagesUsing: number; pagesNeedingRender: number } {
  let pagesUsing = 0;
  let pagesNeedingRender = 0;
  for (const entry of project.pages) {
    if (!usesSurface(project.presentation, entry.page, scope, id)) continue;
    pagesUsing += 1;
    if (chromeBefore && chromeBefore.get(entry.path) !== chromeSha256(project, entry.page)) {
      pagesNeedingRender += 1;
    }
  }
  return { pagesUsing, pagesNeedingRender };
}

/** Geometry findings on the layout's own elements. Text bounds are checked by pageGeometryIssues. */
function layoutQaIssues(definition: DeckMaster | DeckLayout): LayoutQaIssue[] {
  const elements = definition.elements as PptdElement[];
  const issues: LayoutQaIssue[] = [];
  for (const element of elements) {
    const [x, y, w, h] = element.bounds;
    const contentBox =
      element.elementType === "text" || element.elementType === "table" || element.elementType === "chart";
    if (
      !contentBox &&
      !isExpandedTemplateElement(element) &&
      (x < 0 || y < 0 || x + w > SLIDE_WIDTH || y + h > SLIDE_HEIGHT)
    ) {
      issues.push({
        code: "out_of_bounds",
        elementId: element.elementId,
        detail: `元素「${element.elementId}」超出 ${SLIDE_WIDTH}×${SLIDE_HEIGHT} 画布`,
      });
    }
  }
  for (const issue of pageGeometryIssues(asSkillPage(definition))) {
    issues.push({
      code: issue.code,
      detail: `${GEOMETRY_LABEL[issue.code] ?? issue.code}：${issue.message}`,
    });
  }
  return issues;
}

/**
 * Master and layout text is shared chrome, so it never repeats the template sample's titles, report
 * names, dates or figures (VAL-TPL-017). Pages are not checked here. A pack that no longer verifies
 * refuses the layout rather than skipping the check.
 */
function sampleWordingRefusal(
  root: string,
  scope: LayoutScope,
  definition: DeckMaster | DeckLayout,
): ToolExecution | undefined {
  let ids: string[];
  try {
    ids = sampleTextElementIds(definition.elements, sampleTextIndexForRoot(root));
  } catch (error) {
    const reason = error instanceof MaterialPackError ? error.message : "模板样例无法核对，请重新上传";
    return rejected("layout_sample_check", `${KIND_LABEL[scope]}「${definition.id}」未保存：${reason}`);
  }
  if (!ids.length) return undefined;
  return rejected(
    "layout_sample_text",
    `${KIND_LABEL[scope]}「${definition.id}」里的文字「${ids.join("」「")}」重复了模板样例中的标题、报告名称、日期或数值，本次未保存。母版和版式只放通用页眉页脚文字、页码字段或图形；样例文字只能放在页面内容中。`,
  );
}

function commit(
  root: string,
  context: RunToolContext,
  scope: LayoutScope,
  definition: DeckMaster | DeckLayout,
  expectedSha: string | undefined,
): ToolExecution {
  const project = loadProject(root);
  const candidate = withDefinition(project.presentation, scope, definition);
  const schema = layoutSchemaIssues(candidate)[0];
  if (schema) return rejected(schema.code, schema.detail);
  // Off-palette colour is refused once for the whole layout, exactly as write_page refuses it.
  const colour = writePageColorIssues(asSkillPage(definition), project.presentation.theme, {
    ...projectPackColorContext(root),
    tool: NAME,
  });
  if (colour.length) {
    const lines = colour.map((issue) => issue.message).join("\n");
    return rejected(
      colour[0]!.code,
      `${KIND_LABEL[scope]}「${definition.id}」里有颜色不在已采用的配色中，本次未保存：\n${lines}`,
    );
  }
  // Before the identical-revision check: a resent definition that still carries sample wording is refused too.
  const sample = sampleWordingRefusal(root, scope, definition);
  if (sample) return sample;
  const current = currentLayoutRevision(root, scope, definition.id);
  const savedSha256 = savedDefinitionSha256(project.presentation, scope, definition.id);
  // The saved layout is what the model edited, so its hash is the one to echo back. A version
  // restore leaves the ledger naming a newer revision than the file holds.
  if (expectedSha !== undefined && expectedSha !== (savedSha256 ?? "")) {
    return rejected("layout_stale", `${KIND_LABEL[scope]}「${definition.id}」已被修改，请先确认最新版本再保存`);
  }
  const layoutSha256 = stableSha256(definition);
  const layoutIssues = layoutQaIssues(definition);
  const withIssues = layoutIssues.length ? { layoutIssues } : {};
  const layoutName = definition.name;
  // The ledger can run ahead of the file: restoring a version rewinds the deck and leaves the ledger.
  if (current?.layoutSha256 === layoutSha256 && savedSha256 === layoutSha256) {
    const counts = surfaceCounts(project, scope, definition.id);
    return {
      name: NAME,
      ok: true,
      summary: `${KIND_LABEL[scope]}「${definition.id}」未变化`,
      detail: `${KIND_LABEL[scope]}「${layoutName}」与第 ${current.revision} 版相同，未重复保存。`,
      payload: {
        outcome: "skipped-identical",
        scope,
        layoutId: definition.id,
        layoutName,
        revision: current.revision,
        layoutSha256,
        ...counts,
        pagesNeedingRender: 0,
        ...withIssues,
      },
    };
  }
  const chromeBefore = chromeByPath(project);
  project.presentation = candidate;
  saveProject(project);
  const fact = recordLayoutRevision(root, context, {
    scope,
    layoutId: definition.id,
    layoutSha256,
    source: "agent",
  });
  const counts = surfaceCounts(project, scope, definition.id, chromeBefore);
  return {
    name: NAME,
    ok: true,
    summary: `${KIND_LABEL[scope]}「${definition.id}」第 ${fact.revision} 版`,
    detail:
      `已保存${KIND_LABEL[scope]}「${layoutName}」，第 ${fact.revision} 版。` +
      `影响 ${counts.pagesUsing} 页，其中 ${counts.pagesNeedingRender} 页需要重新渲染预览。`,
    payload: {
      outcome: "written",
      scope,
      layoutId: definition.id,
      layoutName,
      revision: fact.revision,
      layoutSha256,
      ...counts,
      ...withIssues,
    },
  };
}

/** Executes one write_layout call under the project write lock (reentrant with saveProject). */
export function writeLayoutExecution(
  root: string,
  context: RunToolContext,
  args: Record<string, unknown>,
): ToolExecution {
  const scope = args.scope === "master" || args.scope === "layout" ? args.scope : undefined;
  if (!scope) return rejected("layout_shape", "scope 只能是 master（母版）或 layout（版式）");
  const expectedSha = typeof args.expectedLayoutSha256 === "string" ? args.expectedLayoutSha256 : undefined;
  const id = String(args.id ?? "");
  const denied = layoutWriteRefusal(root, scope, id, expectedSha);
  if (denied) return rejected(denied.error, denied.detail);
  if (!Array.isArray(args.elements)) return rejected("layout_shape", "elements 必须是元素列表");
  if (args.elements.some(isComponent)) {
    return rejected(
      "layout_component_aspect",
      "版式里的模板组件（component）必须由 Host 在写入前展开成普通元素；请引用已读取并采用的模板组件，或改用文字、形状、图片或线条",
    );
  }
  if (!args.elements.every(hasBounds)) {
    return rejected("layout_shape", "每个元素需要 bounds: [x, y, 宽, 高]（画布 960×540）");
  }
  const definition = definitionOf(scope, args);
  return withProjectWriteLock(root, () => {
    // The lease may have lapsed while this write waited for the lock, so the grant is judged again.
    const lapsed = layoutWriteRefusal(root, scope, id, expectedSha);
    if (lapsed) return rejected(lapsed.error, lapsed.detail);
    return commit(root, context, scope, definition, expectedSha);
  });
}
