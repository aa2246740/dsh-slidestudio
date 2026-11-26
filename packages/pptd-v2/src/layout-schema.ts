import { PptdError } from "./errors.js";
import type { Page, Presentation } from "./types.js";

/** Layout and master ids: a lowercase letter, then lowercase letters, digits or hyphens (32 at most). */
export const LAYOUT_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_LAYOUTS = 12;
export const MAX_LAYOUT_ELEMENTS = 40;
/** Prefixes of the copies saveProject writes: `mst-<masterId>-<elementId>` and `lyt-<layoutId>-<elementId>`. */
export const INHERITED_ID_PREFIXES = ["mst-", "lyt-"] as const;

const MAX_NAME_LENGTH = 24;
/** Characters that pptxgenjs would write unescaped into a layout or master name. */
const NAME_FORBIDDEN = /[<>&"']/;
const ELEMENT_TYPES = new Set(["text", "shape", "image", "line", "icon"]);
const FORBIDDEN_TYPES = new Set(["chart", "table"]);
/** A zero-padded page or page-count token such as `{page:02}`. */
const PADDED_TOKEN = /\{pages?:[^}]*\}/;

export type LayoutIssueCode =
  | "layout_shape"
  | "layout_master_singleton"
  | "layout_limit"
  | "layout_element_limit"
  | "layout_element_type"
  | "layout_animation"
  | "layout_id"
  | "layout_id_repeated"
  | "layout_element_id"
  | "layout_element_id_repeated"
  | "layout_name"
  | "layout_master_missing"
  | "inherited_id_collision"
  | "page_number_padding"
  | "text_field"
  | "reserved_element_id"
  | "layout_missing"
  | "duplicate_layout_element";

/** One rejected item. `detail` is the Chinese sentence shown to the user. */
export type LayoutIssue = { code: LayoutIssueCode; detail: string };

type Kind = "母版" | "版式";
type CopySource = { source: string; label: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list field of the presentation. A missing key is an empty list; a value that is not a list is a shape issue. */
function listOf(value: unknown, field: string, issues: LayoutIssue[]): unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  issues.push({ code: "layout_shape", detail: `${field} 必须是列表` });
  return [];
}

function idIssue(kind: Kind, id: unknown): LayoutIssue | undefined {
  if (typeof id === "string" && LAYOUT_ID_PATTERN.test(id)) return undefined;
  return {
    code: "layout_id",
    detail: `${kind} id「${String(id)}」不合法：只能用小写字母开头，后面是小写字母、数字或连字符，最多 32 个字符`,
  };
}

function nameIssue(kind: Kind, name: unknown): LayoutIssue | undefined {
  const text = typeof name === "string" ? name : "";
  const length = [...text.trim()].length;
  if (length >= 1 && length <= MAX_NAME_LENGTH && !NAME_FORBIDDEN.test(text)) return undefined;
  return {
    code: "layout_name",
    detail: `${kind}名称必须是 1 到 ${MAX_NAME_LENGTH} 个字符，且不能含 < > & " '`,
  };
}

function hasAnimation(definition: Record<string, unknown>): boolean {
  const { animations } = definition;
  return Array.isArray(animations) ? animations.length > 0 : animations !== undefined;
}

/** Charts, tables and SmartArt are page content. Other types outside the chrome list are refused too. */
function typeIssue(element: Record<string, unknown>): LayoutIssue | undefined {
  const type = String(element.elementType);
  const smartArt = element.smartArt !== undefined && element.smartArt !== null;
  if (FORBIDDEN_TYPES.has(type) || smartArt) {
    return { code: "layout_element_type", detail: "版式里不能放图表、表格或 SmartArt" };
  }
  if (!ELEMENT_TYPES.has(type)) {
    return { code: "layout_element_type", detail: "母版和版式只能放文字、形状、图片、线条和图标" };
  }
  return undefined;
}

const PADDING_ISSUE: LayoutIssue = {
  code: "page_number_padding",
  detail: "PowerPoint 的页码域不能补零",
};

/**
 * `content.field` names a dynamic value. Only the page number exists, and it cannot be zero-padded.
 * Master and layout text (`strict`) refuses a padded token even without the field. A page's own text
 * is checked only when it names the field, so a literal token in an older page still saves.
 */
function textFieldIssues(element: Record<string, unknown>, strict: boolean): LayoutIssue[] {
  const content = element.content;
  if (!isRecord(content)) return [];
  const padded = typeof content.text === "string" && PADDED_TOKEN.test(content.text);
  if (content.field === undefined) return strict && padded ? [PADDING_ISSUE] : [];
  if (content.field !== "pageNumber") {
    return [
      {
        code: "text_field",
        detail: `文字域「${String(content.field)}」不认识，目前只支持页码域 pageNumber`,
      },
    ];
  }
  return padded ? [PADDING_ISSUE] : [];
}

function elementIssues(owner: string, elements: unknown, issues: LayoutIssue[]): void {
  if (!Array.isArray(elements)) {
    issues.push({ code: "layout_shape", detail: `${owner}的 elements 必须是列表` });
    return;
  }
  if (elements.length > MAX_LAYOUT_ELEMENTS) {
    issues.push({
      code: "layout_element_limit",
      detail: `每个母版或版式最多 ${MAX_LAYOUT_ELEMENTS} 个元素`,
    });
  }
  const seen = new Set<string>();
  for (const element of elements) {
    if (!isRecord(element)) {
      issues.push({ code: "layout_shape", detail: `${owner}的元素必须是对象` });
      continue;
    }
    const { elementId } = element;
    if (typeof elementId !== "string" || elementId === "") {
      issues.push({ code: "layout_element_id", detail: `${owner}里有元素缺少 elementId` });
    } else if (seen.has(elementId)) {
      issues.push({
        code: "layout_element_id_repeated",
        detail: `${owner}里的元素 id「${elementId}」重复`,
      });
    } else {
      seen.add(elementId);
    }
    const typeProblem = typeIssue(element);
    if (typeProblem) issues.push(typeProblem);
    issues.push(...textFieldIssues(element, true));
  }
}

function definitionIssues(kind: Kind, definition: Record<string, unknown>, issues: LayoutIssue[]): void {
  const idProblem = idIssue(kind, definition.id);
  if (idProblem) issues.push(idProblem);
  const nameProblem = nameIssue(kind, definition.name);
  if (nameProblem) issues.push(nameProblem);
  if (hasAnimation(definition)) {
    issues.push({ code: "layout_animation", detail: "版式和母版不能设置动画" });
  }
  elementIssues(`${kind}「${String(definition.id)}」`, definition.elements, issues);
}

/**
 * Records the ids that one definition's copies take. Two different sources that take the same id
 * are refused. The same source twice (a repeated layout id) is already reported as a repeat.
 */
function recordCopies(
  copies: Map<string, CopySource>,
  prefix: string,
  kind: Kind,
  definition: Record<string, unknown>,
  issues: LayoutIssue[],
): void {
  const { id, elements } = definition;
  if (typeof id !== "string" || !Array.isArray(elements)) return;
  for (const element of elements) {
    if (!isRecord(element) || typeof element.elementId !== "string") continue;
    const copyId = `${prefix}${id}-${element.elementId}`;
    const source = JSON.stringify([id, element.elementId]);
    const label = `${kind}「${id}」的元素「${element.elementId}」`;
    const seen = copies.get(copyId);
    if (!seen) {
      copies.set(copyId, { source, label });
    } else if (seen.source !== source) {
      issues.push({
        code: "inherited_id_collision",
        detail: `${seen.label}和${label}都会生成 id「${copyId}」，请改名`,
      });
    }
  }
}

/**
 * Deck-level rules for masters and layouts: counts, ids, names, element types, page-number
 * fields, and inherited-id collisions. Pages are checked by pageOwnershipIssues. Reading a dangling
 * `layoutId` is not an error here.
 */
export function layoutSchemaIssues(presentation: Presentation): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const masters = listOf(presentation.masters, "masters", issues);
  const layouts = listOf(presentation.layouts, "layouts", issues);
  if (masters.length > 1) {
    issues.push({ code: "layout_master_singleton", detail: "本轮只支持一个母版" });
  }
  if (layouts.length > MAX_LAYOUTS) {
    issues.push({ code: "layout_limit", detail: `版式最多 ${MAX_LAYOUTS} 个` });
  }

  const copies = new Map<string, CopySource>();
  const masterIds = new Set<string>();
  for (const master of masters) {
    if (!isRecord(master)) {
      issues.push({ code: "layout_shape", detail: "母版必须是对象" });
      continue;
    }
    definitionIssues("母版", master, issues);
    if (typeof master.id === "string") masterIds.add(master.id);
    recordCopies(copies, "mst-", "母版", master, issues);
  }

  const layoutIds = new Set<string>();
  for (const layout of layouts) {
    if (!isRecord(layout)) {
      issues.push({ code: "layout_shape", detail: "版式必须是对象" });
      continue;
    }
    definitionIssues("版式", layout, issues);
    if (typeof layout.id === "string") {
      if (layoutIds.has(layout.id)) {
        issues.push({ code: "layout_id_repeated", detail: `版式 id「${layout.id}」重复` });
      }
      layoutIds.add(layout.id);
    }
    const masterKnown = typeof layout.masterId === "string" && masterIds.has(layout.masterId);
    if (layout.masterId !== undefined && !masterKnown) {
      issues.push({
        code: "layout_master_missing",
        detail: `版式「${String(layout.id)}」引用的母版「${String(layout.masterId)}」不存在`,
      });
    }
    recordCopies(copies, "lyt-", "版式", layout, issues);
  }
  return issues;
}

/**
 * Rules for one page's own content: no own id may use the inherited prefixes once the deck has
 * masters or layouts, and page-number fields must be well formed. Copies (elements carrying
 * `inherited`) are skipped.
 */
export function pageOwnershipIssues(presentation: Presentation, page: Page): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const hasLayoutParts = [presentation.masters, presentation.layouts].some(
    (list) => Array.isArray(list) && list.length > 0,
  );
  for (const element of page.elements) {
    if (element.inherited !== undefined) continue;
    const { elementId } = element;
    if (
      hasLayoutParts &&
      typeof elementId === "string" &&
      INHERITED_ID_PREFIXES.some((prefix) => elementId.startsWith(prefix))
    ) {
      issues.push({
        code: "reserved_element_id",
        detail: `元素 id「${elementId}」不能以 mst- 或 lyt- 开头，这些前缀留给母版和版式的继承副本`,
      });
    }
    issues.push(...textFieldIssues(element as unknown as Record<string, unknown>, false));
  }
  return issues;
}

/** A page's `layoutId` must name a layout that exists. Write paths refuse a page that fails this. */
export function layoutReferenceIssues(presentation: Presentation, page: Page): LayoutIssue[] {
  const { layoutId } = page;
  if (layoutId === undefined) return [];
  const exists = (presentation.layouts ?? []).some((layout) => layout.id === layoutId);
  if (exists) return [];
  return [{ code: "layout_missing", detail: `版式 ${layoutId} 不存在，请先定义该版式或改用已有版式` }];
}

/** Throws a PptdError carrying the first deck-level Chinese reason. */
export function assertLayoutSchema(presentation: Presentation, file?: string): void {
  const first = layoutSchemaIssues(presentation)[0];
  if (first) throw new PptdError(file ? `${file}: ${first.detail}` : first.detail);
}

/** Throws a PptdError carrying the first page-level Chinese reason. */
export function assertPageOwnership(presentation: Presentation, page: Page, file?: string): void {
  const first = pageOwnershipIssues(presentation, page)[0];
  if (first) throw new PptdError(file ? `${file}: ${first.detail}` : first.detail);
}
