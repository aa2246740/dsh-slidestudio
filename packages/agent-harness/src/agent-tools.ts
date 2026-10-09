/**
 * Allowlisted generate tools. The model may only call these —
 * no shell, no iframe, no public web fetch.
 */
import fs from "node:fs";
import path from "node:path";
import type { PptdProject } from "@open-slidestudio/pptd-v2";
import {
  createEmptyProject,
  loadProject,
  saveProject,
  withProjectWriteLock,
  type Page,
} from "@open-slidestudio/pptd-v2";
import {
  composeBodyRules,
  extractReferenceLines,
  finalizeComposeDeck,
  inferDeckIntent,
  isNamedClassroomFact,
  type ComposeDeck,
} from "./compose-ir.js";
import { readDesignContract } from "./design-contract.js";
import type { ImagePort } from "./image-port.js";
import { createImagePort } from "./image-port.js";
import type { ImageSearchPort } from "./image-search-port.js";
import {
  isTodoExhibitKind,
  resolveTodoExhibits,
  reviewSkillPages,
  TODO_EXHIBIT_KINDS,
  type LayoutReview,
  type TodoExhibitKind,
} from "./layout-qa.js";
import type { LlmToolSpec } from "./llm-port.js";
import { listMedia, saveMediaFile } from "./media-store.js";
import {
  createPageRasterPort,
  rasterToDataUrl,
  savePageRaster,
  type PageRasterPort,
  type PageRasterResult,
} from "./page-raster.js";
import type { PlaybookBundle } from "./playbook.js";
import {
  applySkillDeck,
  assertSkillDeck,
  parseSkillDeck,
  parseSkillPage,
  skillToCompose,
  type SkillDeckInput,
  type SkillPageInput,
} from "./skill-pages.js";
import { missingOperatingFactsReason, reportFactIssues } from "./report-facts.js";

export const GENERATE_TOOLS: LlmToolSpec[] = [
  {
    type: "function",
    function: {
      name: "think",
      description:
        "Record the audience, constraints, and what you will not invent. Call this first.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          detail: { type: "string" },
        },
        required: ["summary", "detail"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_playbook",
      description:
        "Read one playbook section. Do not guess the category rules — read them.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          section: {
            type: "string",
            enum: ["catalog", "skill", "images", "category", "guide", "design", "pptd"],
          },
        },
        required: ["section"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read uploaded reference attachments. Quote only; never invent beyond this text.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Optional substring filter" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "research",
      description:
        "Look up facts in attachments or record an honest gap. No public web. Never invent citations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_todo",
      description:
        "Write or replace the complete page outline. Do not default to 6 pages. A classroom lesson is usually 6 (cover→path→concept→remember→exhibit→takeaway). A 月报/复盘 follows the attachment: one job per exhibit, no padding. If the brief specifies a page count or page-by-page script, keep every specified page. Each item needs a note and the exact editable exhibits the later page must implement. Use none only when the page truly requests no exhibit; prose never substitutes for a requested chart, table, or diagram.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                note: { type: "string" },
                exhibits: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", enum: [...TODO_EXHIBIT_KINDS] },
                },
              },
              required: ["title", "note", "exhibits"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_image",
      description:
        "Optional. Query the configured image search port and write media/{id}.png. Only call this if the capability card says imageSearch=YES. No public-web scrape by the host. If the port is off or empty, you get kind=none — do not write src.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "File stem, e.g. cover or day1-sensoji" },
          query: { type: "string" },
        },
        required: ["id", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Optional. Create a file in project media/ only if YOU decided this page needs a bitmap AND the capability card says imageGenerate=YES (or you accept a labeled 占位). Returns src + width + height. Prefer search_image when that port is on. Skip when the page is text/shape/table/chart.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "File stem, e.g. cover or day1-sensoji" },
          prompt: { type: "string" },
          aspect: { type: "string", description: "16:9, 4:3, 1:1, or 3:4" },
        },
        required: ["id", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_page",
      description:
        "Write ONE COMPLETE page as PPTD in a single call. This replaces the whole page; it never appends elements. Every revision must resend the full elements[] array, with bounds/style/fill/line/alignment inside each owning element. After render_page returns layoutStatus=pass, move to the next todo page unless review_pages names it as failing or review_page/review_deck explicitly says revise. Official recipe vocab: header|list|box|circle|band|text, or cover-botanical|title-band|coral-rule|chapter|page-title|route-path|method-panels|two-column-45-55|demo-band|two-column-body|result-bar|next-action|footer-chrome. pageType cover|route|concept|method|demo|transfer. Invalid parse returns error. The host will not rewrite your elements.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: "string" },
          pageType: { type: "string" },
          notes: { type: "string" },
          background: { type: "object" },
          elements: { type: "array", minItems: 1 },
        },
        required: ["id", "elements"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_page",
      description:
        "Screenshot native #slide for ONE written page. Classroom decks must call this for every page the user will see (pageIndex 0..n-1). page-1.png alone is rejected. If Playwright/editor is down, kind=unavailable.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pageId: { type: "string" },
          pageIndex: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_pages",
      description:
        "Native structural QA (not Kimi export_images.py). Fails empty pages and unlabeled invented numbers. Does not require media. If you chose an image src, that file must exist. Call render_page first if you want to see the real #slide. If raster/vision is off, say you did not see the slide.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compose_deck",
      description:
        "Finalize the deck. Prefer pages already written with write_page, or send pages[] with elements. Images are optional. If you included src, the file must exist. Empty pages and unlabeled invented numbers are rejected. role+bullets without elements is an IR fallback.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          title: { type: "string" },
          pages: {
            type: "array",
            minItems: 5,
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                pageType: { type: "string" },
                role: {
                  type: "string",
                  enum: ["cover", "toc", "content", "evidence", "timeline", "matrix", "close"],
                },
                title: { type: "string" },
                notes: { type: "string" },
                elements: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      elementId: { type: "string" },
                      elementType: {
                        type: "string",
                        enum: ["text", "shape", "image", "table", "chart", "line", "icon"],
                      },
                      bounds: {
                        type: "array",
                        items: { type: "number" },
                        minItems: 4,
                        maxItems: 4,
                      },
                      content: { type: "object" },
                      shapeName: { type: "string" },
                      fill: {},
                      src: { type: "string" },
                      data: { type: "object" },
                      series: { type: "array" },
                      columnWidths: { type: "array" },
                      rows: { type: "array" },
                    },
                    required: ["elementType", "bounds"],
                  },
                },
                subtitle: { type: "string" },
                kicker: { type: "string" },
                chapter: { type: "string" },
                bullets: { type: "array", items: { type: "string" } },
                items: { type: "array", items: { type: "string" } },
                soWhat: { type: "string" },
                note: { type: "string" },
                chart: { type: "object" },
              },
              required: ["title"],
            },
          },
        },
        required: ["title"],
      },
    },
  },
];

export type AgentTodo = {
  pageId?: string;
  title: string;
  layoutFamily?: string;
  note?: string;
  /** Optional only for loading outlines created before the exhibit contract. */
  exhibits?: TodoExhibitKind[];
};

export type ResearchResult = {
  source: "attachment" | "classroom_common" | "intranet" | "none";
  citations: string[];
  facts: string[];
  note: string;
  gap?: string;
};

export function researchExecution(result: ResearchResult): ToolExecution {
  const detail = [
    `来源：${result.source}`,
    result.citations.length ? `引用：${result.citations.join("、")}` : "",
    result.note,
    result.gap ?? "",
    ...result.facts,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    name: "research",
    ok: true,
    summary: result.gap ? "缺口" : result.source,
    detail,
    payload: result,
  };
}

export type ToolExecution = {
  name: string;
  ok: boolean;
  summary: string;
  detail: string;
  payload: unknown;
};

export type AgentToolState = {
  brief: string;
  playbook: PlaybookBundle;
  referenceText?: string;
  todos: AgentTodo[];
  researchNotes: ResearchResult[];
  deck?: ComposeDeck;
  skillDeck?: SkillDeckInput;
  writtenPages?: SkillPageInput[];
  projectRoot?: string;
  image?: ImagePort;
  imageSearch?: ImageSearchPort;
  raster?: PageRasterPort;
  lastReview?: LayoutReview;
  lastRaster?: PageRasterResult & { pageId?: string; src?: string };
};

function writtenPages(state: AgentToolState): SkillPageInput[] {
  if (!state.writtenPages) state.writtenPages = [];
  return state.writtenPages;
}

function scopedPageKey(id: string): string {
  const key = id.trim().replace(/\\/g, "/").split("/").pop()!.replace(/\.page$/i, "");
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`invalid page id: ${id}`);
  return key;
}

function scopedPagePath(state: AgentToolState, page: SkillPageInput): string {
  const key = scopedPageKey(page.id);
  const historicalIndex = writtenPages(state).findIndex((item) => item.id === page.id);
  const role =
    (page.pageType || "page").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 24) || "page";
  // The legacy skill writer uses ordinal paths (01_cover.page). Keep that
  // stable for existing projects, while accepting id-shaped paths for newer
  // projects. Either way only this page is touched.
  return historicalIndex >= 0
    ? `pages/${String(historicalIndex + 1).padStart(2, "0")}_${role}.page`
    : `pages/${key}.page`;
}

function scopedPersistedPage(page: SkillPageInput): Page {
  return {
    pageType: page.pageType,
    notes: page.notes,
    background: page.background,
    elements: page.elements,
  };
}

/**
 * The deck title a live run should carry: the cover page's own headline once the
 * agent has written one. Falling back to the raw brief is fine for a brand-new
 * project, but re-stamping it on every later page would leave the editor and the
 * exported PPTX titled after the prompt.
 */
function deckTitleFromCover(project: PptdProject): string {
  const coverPage = project.pages[0]?.page as { elements?: unknown } | undefined;
  const elements = Array.isArray(coverPage?.elements)
    ? coverPage!.elements as Array<Record<string, unknown>>
    : [];
  const headline = elements.find((element) => element?.elementId === "title")
    ?? elements.find((element) => element?.elementType === "text");
  const content = headline?.content as { text?: unknown } | undefined;
  return typeof content?.text === "string" ? content.text.trim() : "";
}

/** A scoped write merges only the current page and never replays stale state. */
export function persistWrittenPages(
  state: AgentToolState,
  pageScope?: readonly SkillPageInput[],
): void {
  if (!state.projectRoot) return;
  const pages = pageScope ? [...pageScope] : writtenPages(state);
  if (!pages.length && !pageScope) return;
  withProjectWriteLock(state.projectRoot, () => {
    const title = state.skillDeck?.title || state.brief.slice(0, 40) || "生成中";
    const hasPptd = fs.existsSync(state.projectRoot!) && fs.readdirSync(state.projectRoot!).some((name) => name.endsWith(".pptd"));
    const project = hasPptd
      ? loadProject(state.projectRoot!)
      : createEmptyProject(state.projectRoot!, { title });
    if (pageScope) {
      // The cover headline only exists once this write is merged, so the title is
      // decided after the loop; remember how the project was named before it.
      const explicitTitle = String(state.skillDeck?.title || "").trim();
      const currentTitle = String(project.presentation.title || "").trim();
      const briefPrefix = state.brief.slice(0, 40);
      for (const page of pages) {
        const key = scopedPageKey(page.id);
        const rel = scopedPagePath(state, page);
        const index = project.pages.findIndex((item) => {
          const itemPath = item.path.replace(/\\/g, "/").toLowerCase();
          return itemPath === rel.toLowerCase() || itemPath === `pages/${key}.page`.toLowerCase();
        });
        const next = { path: index >= 0 ? project.pages[index]!.path : rel, page: scopedPersistedPage(page) };
        if (index >= 0) project.pages[index] = next;
        else project.pages.push(next);
      }
      project.presentation.pages = project.pages.map((page) => page.path);
      const coverTitle = deckTitleFromCover(project);
      // Precedence: an explicitly authored deck title, then the cover's own
      // headline, then a title already on the project. The raw prompt only ever
      // names a brand-new project.
      const keepCurrent = Boolean(currentTitle)
        && currentTitle !== briefPrefix
        && currentTitle !== title
        && currentTitle !== coverTitle;
      project.presentation.title = explicitTitle || coverTitle || (keepCurrent ? currentTitle : title);
    } else {
      applySkillDeck(
        project,
        { title, pages },
        state.playbook.designSystemId ? state.playbook.palette : undefined,
      );
    }
    saveProject(project);
  });
}

function researchHadGap(state: AgentToolState): boolean {
  return state.researchNotes.some((n) => Boolean(n.gap) || n.source === "none");
}

function isClassroomBrief(brief: string): boolean {
  return inferDeckIntent(brief) === "teach";
}

function mergedTodoExhibits(
  todo: AgentTodo,
  index: number,
  brief: string,
): TodoExhibitKind[] {
  return resolveTodoExhibits(todo, index, brief);
}

function reviewCurrent(
  state: AgentToolState,
  pages: SkillPageInput[],
  mode: "compose" | "strict" = "strict",
): LayoutReview {
  const classroom = isClassroomBrief(state.brief);
  const tasteContract = state.projectRoot
    ? readDesignContract(state.projectRoot)
    : undefined;
  const review = reviewSkillPages(pages, {
    projectRoot: state.projectRoot,
    researchHadGap: researchHadGap(state),
    todos: state.todos.map((todo, index) => ({
      ...todo,
      exhibits: mergedTodoExhibits(todo, index, state.brief),
    })),
    mode: classroom && mode === "compose" ? "compose" : classroom ? "strict" : mode,
    courseware:
      state.playbook.designSystemId === "academic/paper-white-courseware" &&
      isClassroomBrief(state.brief),
    requireExplicitChartColors: Boolean(tasteContract),
    tasteGates: Boolean(tasteContract),
  });
  const extras = reportFactIssues(state.brief, pages, state.referenceText);
  if (extras.length) {
    review.issues.push(...extras);
    review.ok = false;
  }
  state.lastReview = review;
  return review;
}

function refuseIfNoReportFacts(
  name: string,
  state: AgentToolState,
): ReturnType<typeof executeGenerateTool> | undefined {
  const reason = missingOperatingFactsReason(state.brief, state.referenceText);
  if (!reason) return undefined;
  return {
    name,
    ok: false,
    summary: "要数据",
    detail: reason,
    payload: { error: "need_data" },
  };
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim() || "{}";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try {
        return asRecord(JSON.parse(fence[1]!.trim()));
      } catch {
        return {};
      }
    }
    return {};
  }
}

function playbookSection(bundle: PlaybookBundle, section: string): string {
  switch (section) {
    case "skill":
      return bundle.skillExcerpt;
    case "images": {
      const start = bundle.skillExcerpt.indexOf("##### Images and Visual Materials");
      const host = bundle.skillExcerpt.slice(0, bundle.skillExcerpt.indexOf("\n\n"));
      const images =
        start >= 0
          ? bundle.skillExcerpt.slice(start, bundle.skillExcerpt.indexOf("##### Content", start))
          : "";
      return [host, images.trim()].filter(Boolean).join("\n\n");
    }
    case "pptd":
      return bundle.pptdExcerpt;
    case "category":
      return bundle.categoryMarkdown;
    case "guide":
      return bundle.categoryGuideExcerpt;
    case "design":
      return `design_system: ${bundle.designSystemId}\n\n${bundle.designMarkdown.slice(0, 2000)}`;
    case "recipes":
      return bundle.recipesMarkdown;
    case "catalog":
      return JSON.stringify(
        {
          categoryId: bundle.categoryId,
          designSystemId: bundle.designSystemId,
          sections: ["skill", "images", "pptd", "category", "guide", "design", "recipes"],
          note: "Read recipes before write_page. Media is optional. search_image / generate_image only if those ports are YES. Otherwise official no-image layouts.",
        },
        null,
        2,
      );
    default:
      return "Unknown section. Use catalog, skill, images, pptd, category, guide, design, or recipes.";
  }
}

function filterLines(lines: string[], query?: string): string[] {
  const q = query?.trim();
  if (!q) return lines;
  const tokens = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  return lines.filter((line) => {
    const low = line.toLowerCase();
    return low.includes(q.toLowerCase()) || tokens.some((t) => low.includes(t));
  });
}

export function runResearch(query: string, brief: string, referenceText?: string): ResearchResult {
  const refs = extractReferenceLines(referenceText);
  const hits = filterLines(refs.lines, query);
  if (hits.length) {
    return {
      source: "attachment",
      citations: refs.names,
      facts: hits.slice(0, 8),
      note: "只引用附件原文，不是网络检索。",
    };
  }
  if (refs.lines.length) {
    return {
      source: "attachment",
      citations: refs.names,
      facts: refs.lines.slice(0, 5),
      note: "查询无精确命中，退回附件摘录。",
    };
  }
  if (isNamedClassroomFact(`${brief} ${query}`)) {
    return {
      source: "classroom_common",
      citations: [],
      facts: [
        "直角对着的边叫斜边，另外两边叫直角边。",
        "勾股关系：两直角边的平方和等于斜边的平方。3、4、5 是课堂练习数，不是统计。",
      ],
      note: "课堂常识，不是出处，不是调查数据。",
    };
  }
  return {
    source: "none",
    citations: [],
    facts: [],
    note: "没有可引用的来源。",
    gap: "没有可引用的来源。页上必须标占位，禁止编造机构名、网址或精确统计。",
  };
}

export function executeGenerateTool(
  name: string,
  args: Record<string, unknown>,
  state: AgentToolState,
): ToolExecution {
  if (name === "think") {
    const summary = String(args.summary ?? "").trim() || "思考";
    const detail = String(args.detail ?? "").trim();
    if (!detail) {
      return {
        name,
        ok: false,
        summary: "think.detail required",
        detail: "think.detail required",
        payload: { error: "detail required" },
      };
    }
    return { name, ok: true, summary, detail, payload: { summary, detail } };
  }

  if (name === "read_playbook") {
    const section = String(args.section ?? "catalog").trim() || "catalog";
    const text = playbookSection(state.playbook, section);
    return {
      name,
      ok: true,
      summary: section,
      detail: text,
      payload: { section, text },
    };
  }

  if (name === "read_file") {
    const refs = extractReferenceLines(state.referenceText);
    if (!refs.names.length && !refs.lines.length) {
      const payload = { names: [], lines: [], note: "没有上传参考资料。" };
      return {
        name,
        ok: true,
        summary: "无附件",
        detail: payload.note,
        payload,
      };
    }
    const query = typeof args.query === "string" ? args.query : undefined;
    const lines = filterLines(refs.lines, query).slice(0, 20);
    const detail = [`来源：${refs.names.join("、") || "未命名"}`, ...lines].join("\n");
    return {
      name,
      ok: true,
      summary: `${refs.names.length} 份`,
      detail,
      payload: { names: refs.names, lines, query: query ?? null },
    };
  }

  if (name === "research") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return {
        name,
        ok: false,
        summary: "query required",
        detail: "research.query required",
        payload: { error: "query required" },
      };
    }
    const result = runResearch(query, state.brief, state.referenceText);
    state.researchNotes.push(result);
    return researchExecution(result);
  }

  if (name === "write_todo") {
    const blocked = refuseIfNoReportFacts(name, state);
    if (blocked) return blocked;
    const raw = Array.isArray(args.items) ? args.items : [];
    const items: AgentTodo[] = [];
    for (const [index, item] of raw.entries()) {
      if (!item || typeof item !== "object") continue;
      const title = String((item as { title?: unknown }).title ?? "").trim();
      if (!title) continue;
      const note = String((item as { note?: unknown }).note ?? "").trim();
      const pageId = String((item as { pageId?: unknown }).pageId ?? "").trim();
      const layoutFamily = String(
        (item as { layoutFamily?: unknown }).layoutFamily ?? "",
      ).trim();
      const supplied = Array.isArray((item as { exhibits?: unknown }).exhibits)
        ? (item as { exhibits: unknown[] }).exhibits.filter(isTodoExhibitKind)
        : [];
      const todo = {
        ...(pageId ? { pageId } : {}),
        title,
        ...(layoutFamily ? { layoutFamily } : {}),
        ...(note ? { note } : {}),
        exhibits: supplied,
      };
      items.push({
        ...todo,
        exhibits: mergedTodoExhibits(todo, index, state.brief),
      });
    }
    if (items.length < 2) {
      return {
        name,
        ok: false,
        summary: "need ≥2 pages",
        detail: "write_todo.items must have at least 2 page titles",
        payload: { error: "need at least 2 items" },
      };
    }
    state.todos = items;
    const detail = items
      .map(
        (it, i) =>
          `${it.pageId ?? String(i + 1).padStart(2, "0")}  ${it.title}${it.layoutFamily ? `  <${it.layoutFamily}>` : ""}  [${it.exhibits?.join(", ") ?? "none"}]${it.note ? `  · ${it.note}` : ""}`,
      )
      .join("\n");
    return {
      name,
      ok: true,
      summary: `${items.length} 页`,
      detail,
      payload: { items },
    };
  }

  if (name === "write_page") {
    const blocked = refuseIfNoReportFacts(name, state);
    if (blocked) return blocked;
    const parsed = parseSkillPage(args, writtenPages(state).length);
    if (!parsed) {
      return {
        name,
        ok: false,
        summary: "invalid page",
        detail: `write_page needs official vocab: cover-botanical|title-band|coral-rule|chapter|page-title|route-path|method-panels|two-column-45-55|demo-band|two-column-body|result-bar|next-action|footer-chrome, or header|list|box|circle|band|text with position/bounds. keys=${Object.keys(args).join(",")}`,
        payload: { error: "invalid page" },
      };
    }
    const page = parsed;
    const list = writtenPages(state);
    const idx = list.findIndex((p) => p.id === page.id);
    if (idx >= 0) list[idx] = page;
    else list.push(page);
    const kinds = [...new Set(page.elements.map((el) => el.elementType))].join("+");
    persistWrittenPages(state, [page]);
    return {
      name,
      ok: true,
      summary: `${page.id} · ${page.elements.length} el`,
      detail: `${page.id}  ${page.pageType ?? "page"}  ${kinds}\n${list.length} pages on disk\nwrite_page kept agent elements; host did not restamp`,
      payload: { page, pageCount: list.length, applied: false, painted: false, restamped: false },
    };
  }

  if (name === "review_pages") {
    const pages =
      writtenPages(state).length
        ? writtenPages(state)
        : state.skillDeck?.pages ?? [];
    if (pages.length < 2) {
      return {
        name,
        ok: false,
        summary: "need pages",
        detail: "write_page or compose_deck first",
        payload: { error: "need pages" },
      };
    }
    const review = reviewCurrent(state, pages, "compose");
    const ok = review.ok;
    const rasterNote = state.lastRaster
      ? `last render_page: ${state.lastRaster.kind} ${state.lastRaster.src ?? ""} — ${state.lastRaster.note}`
      : "no render_page yet — you have not seen the native #slide";
    return {
      name,
      ok,
      summary: ok ? `${pages.length} 页通过` : `${review.issues.length} 个问题`,
      detail: ok
        ? `${rasterNote}\nstructural QA only unless render_page returned native-slide.\n${review.pages.map((p) => `${p.id} cover=${p.coverage.toFixed(2)} exhibit=${p.exhibit ?? "none"}`).join("\n")}`
        : review.issues.map((i) => `${i.pageId}: ${i.message}`).join("\n"),
      payload: { ...review, lastRaster: state.lastRaster ?? null },
    };
  }

  if (name === "compose_deck") {
    const blocked = refuseIfNoReportFacts(name, state);
    if (blocked) return blocked;
    const rules = composeBodyRules(state.brief, state.playbook.categoryId);
    try {
      const buffered = writtenPages(state);
      const incoming = parseSkillDeck(args);
      const skill =
        incoming ??
        (buffered.length
          ? {
              title: String(args.title ?? state.skillDeck?.title ?? "未命名演示"),
              pages: buffered,
            }
          : null);
      if (skill) {
        const todoN = state.todos?.length ?? 0;
        const writtenN = skill.pages.length;
        if (todoN >= 3 && writtenN < todoN) {
          return {
            name,
            ok: false,
            summary: `还差 ${todoN - writtenN} 页`,
            detail: `write_todo has ${todoN} pages; write_page landed ${writtenN}. Keep calling write_page. The host will not paint the rest.`,
            payload: {
              error: "compose_before_todo_done",
              todo: todoN,
              written: writtenN,
            },
          };
        }
        assertSkillDeck(skill, { minPages: rules.minPages });
        const review = reviewCurrent(state, skill.pages, "compose");
        const reportBlocks = review.issues.filter(
          (i) =>
            i.code === "unnamed_gap" ||
            i.code === "missing_column" ||
            i.code === "missing_locked_fact" ||
            i.code === "missing_requested_exhibit",
        );
        if (reportBlocks.length) {
          return {
            name,
            ok: false,
            summary: "report facts QA failed",
            detail: reportBlocks.map((i) => `${i.pageId}: ${i.message}`).join("\n"),
            payload: { error: "report facts QA failed", review },
          };
        }
        if (!review.ok && writtenPages(state).length < 2 && !isClassroomBrief(state.brief)) {
          return {
            name,
            ok: false,
            summary: "layout QA failed",
            detail: review.issues.map((i) => `${i.pageId}: ${i.message}`).join("\n"),
            payload: { error: "layout QA failed", review },
          };
        }
        state.skillDeck = skill;
        state.deck = skillToCompose(skill);
        const detail = skill.pages
          .map((p, i) => {
            const kinds = [...new Set(p.elements.map((el) => el.elementType))].join("+");
            return `${String(i + 1).padStart(2, "0")}  ${p.pageType ?? "page"}  ${p.id}  · ${p.elements.length} el (${kinds})`;
          })
          .join("\n");
        return {
          name,
          ok: true,
          summary: `${skill.pages.length} 页 PPTD`,
          detail,
          payload: skill,
        };
      }
      const deck = finalizeComposeDeck(args, state.todos, rules);
      state.skillDeck = undefined;
      state.deck = deck;
      const detail = deck.pages
        .map((p, i) => {
          const n = (p.bullets?.length ?? 0) + (p.items?.length ?? 0);
          const extra = p.chart ? "  · chart" : n ? `  · ${n} 条` : "";
          return `${String(i + 1).padStart(2, "0")}  ${p.role}  ${p.title}${extra}`;
        })
        .join("\n");
      return {
        name,
        ok: true,
        summary: `${deck.pages.length} 页 · IR fallback`,
        detail: `role+bullets only — skill did not write PPTD elements.\n${detail}`,
        payload: deck,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        name,
        ok: false,
        summary: "invalid compose",
        detail: msg,
        payload: { error: msg },
      };
    }
  }

  return {
    name,
    ok: false,
    summary: "unknown tool",
    detail: `Tool not allowed: ${name}`,
    payload: { error: `unknown tool: ${name}` },
  };
}

export function toolStepMeta(name: string): { tool: string; label: string } {
  switch (name) {
    case "think":
      return { tool: "think", label: "Think" };
    case "read_playbook":
    case "read_file":
      return { tool: "read_file", label: "Read" };
    case "research":
      return { tool: "research", label: "Research" };
    case "write_todo":
      return { tool: "write_todo", label: "Write Todo" };
    case "compose_deck":
      return { tool: "compose_deck", label: "Compose Deck" };
    case "generate_image":
      return { tool: "generate_image", label: "Image" };
    case "search_image":
      return { tool: "search_image", label: "Search Image" };
    case "write_page":
      return { tool: "write_page", label: "Write Page" };
    case "render_page":
      return { tool: "render_page", label: "Render" };
    case "review_pages":
      return { tool: "review_pages", label: "Review" };
    default:
      return { tool: name, label: name };
  }
}

export async function executeGenerateToolAsync(
  name: string,
  args: Record<string, unknown>,
  state: AgentToolState,
): Promise<ToolExecution> {
  if (name === "generate_image") {
    const id = String(args.id ?? "").trim();
    const prompt = String(args.prompt ?? "").trim();
    if (!id || !prompt) {
      return {
        name,
        ok: false,
        summary: "id+prompt required",
        detail: "generate_image needs id and prompt",
        payload: { error: "id and prompt required" },
      };
    }
    if (!state.projectRoot) {
      return {
        name,
        ok: false,
        summary: "no project",
        detail: "generate_image needs a project root to write media/",
        payload: { error: "no projectRoot" },
      };
    }
    const port = state.image ?? createImagePort({ enabled: false });
    const image = await port.generate(prompt, typeof args.aspect === "string" ? args.aspect : undefined);
    const saved = saveMediaFile(state.projectRoot, id, image.bytes, "png");
    return {
      name,
      ok: true,
      summary: `${saved.src} · ${image.kind}`,
      detail: [
        `src: ${saved.src}`,
        `size: ${image.width}×${image.height}`,
        `kind: ${image.kind}`,
        image.note,
        `media: ${listMedia(state.projectRoot).join(", ")}`,
      ].join("\n"),
      payload: {
        src: saved.src,
        width: image.width,
        height: image.height,
        kind: image.kind,
        note: image.note,
      },
    };
  }
  if (name === "search_image") {
    const id = String(args.id ?? "").trim();
    const query = String(args.query ?? "").trim();
    if (!id || !query) {
      return {
        name,
        ok: false,
        summary: "id+query required",
        detail: "search_image needs id and query",
        payload: { error: "id and query required" },
      };
    }
    if (!state.imageSearch) {
      return {
        name,
        ok: true,
        summary: "no search port",
        detail: "imageSearch is not configured — do not write src. Design without a bitmap.",
        payload: { kind: "none", note: "no image search port" },
      };
    }
    const hit = await state.imageSearch.search(query);
    if ("kind" in hit && hit.kind === "none") {
      return {
        name,
        ok: true,
        summary: "no image",
        detail: hit.note,
        payload: { kind: "none", note: hit.note },
      };
    }
    if (!state.projectRoot) {
      return {
        name,
        ok: false,
        summary: "no project",
        detail: "search_image needs a project root to write media/",
        payload: { error: "no projectRoot" },
      };
    }
    const found = hit as { bytes: Buffer; mime: string; width?: number; height?: number; attribution?: string; note: string };
    const ext = found.mime === "image/jpeg" ? "jpg" : found.mime === "image/webp" ? "webp" : "png";
    const saved = saveMediaFile(state.projectRoot, id, found.bytes, ext);
    return {
      name,
      ok: true,
      summary: `${saved.src} · search`,
      detail: [
        `src: ${saved.src}`,
        found.width && found.height ? `size: ${found.width}×${found.height}` : "",
        found.note,
        `media: ${listMedia(state.projectRoot).join(", ")}`,
      ]
        .filter(Boolean)
        .join("\n"),
      payload: {
        src: saved.src,
        width: found.width,
        height: found.height,
        kind: "search",
        note: found.note,
        attribution: found.attribution,
      },
    };
  }
  if (name === "render_page") {
    const pages = writtenPages(state);
    if (!pages.length) {
      return {
        name,
        ok: false,
        summary: "need pages",
        detail: "write_page first",
        payload: { error: "need pages" },
      };
    }
    let index = typeof args.pageIndex === "number" ? Math.floor(args.pageIndex) : -1;
    const pageId = String(args.pageId ?? "").trim();
    if (index < 0 && pageId) {
      index = pages.findIndex((p) => p.id === pageId);
    }
    if (index < 0) index = pages.length - 1;
    if (index < 0 || index >= pages.length) {
      return {
        name,
        ok: false,
        summary: "bad page",
        detail: "render_page pageId / pageIndex not found",
        payload: { error: "page not found" },
      };
    }
    const port = state.raster ?? createPageRasterPort();
    const shot = await port.render({
      projectRoot: state.projectRoot ?? "",
      pageIndex: index,
    });
    let src: string | undefined;
    let dataUrl: string | undefined;
    if (shot.kind === "native-slide" && shot.bytes && state.projectRoot) {
      const saved = savePageRaster(state.projectRoot, pages[index]!.id, shot.bytes);
      src = saved.src;
      dataUrl = rasterToDataUrl(shot.bytes);
    }
    state.lastRaster = { ...shot, pageId: pages[index]!.id, src };
    return {
      name,
      ok: shot.kind === "native-slide",
      summary:
        shot.kind === "native-slide"
          ? `${pages[index]!.id} · native #slide`
          : "did not see the slide",
      detail: [shot.note, src ? `src: ${src}` : "", `page: ${pages[index]!.id}`]
        .filter(Boolean)
        .join("\n"),
      payload: {
        pageId: pages[index]!.id,
        pageIndex: index,
        src,
        width: shot.width,
        height: shot.height,
        kind: shot.kind,
        note: shot.note,
        dataUrl,
        layout: shot.layout,
      },
    };
  }
  return executeGenerateTool(name, args, state);
}
