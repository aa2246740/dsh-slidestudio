/**
 * Offline / test painter. Not the product generate path.
 * Product generate is the agent clock: write_todo → write_page → render_page → review → compose.
 */
import { saveProject, type PptdProject } from "@open-slidestudio/pptd-v2";
import { briefToOutline, inferDeckIntent, resolveGenerateDesign, resolvePlaybookCategory } from "./compose-ir.js";
import { classifyExhibit, paintExhibit, type HostPageCopy } from "./exhibit-paint.js";
import { evidencePagesFromReference, maybePlaceImage, wantsPhoto } from "./host-media.js";
import type { ImagePort } from "./image-port.js";
import type { ImageSearchPort } from "./image-search-port.js";
import type { LlmPort } from "./llm-port.js";
import {
  DEFAULT_CATEGORY,
  DEFAULT_DESIGN_SYSTEM,
  loadPlaybook,
  type Palette,
  type PlaybookBundle,
} from "./playbook.js";
import { qaPaintedPage, qaScriptFidelity, repairPaintedPage } from "./produce-qa.js";
import { applySkillDeck, type SkillDeckInput, type SkillPageInput } from "./skill-pages.js";
import { thinkAboutBrief } from "./reason.js";
import type { AgentRunHooks } from "./agent-brain.js";
import type { ToolStep } from "./harness-types.js";
import type { PageRasterPort } from "./page-raster.js";
import { rasterToDataUrl, savePageRaster } from "./page-raster.js";

export type { HostPageCopy } from "./exhibit-paint.js";

export type HostBrainOptions = {
  skillRoot?: string;
  designSystemId?: string;
  categoryId?: string;
  llm?: LlmPort;
  referenceText?: string;
  image?: ImagePort;
  imageSearch?: ImageSearchPort;
  raster?: PageRasterPort;
  projectRoot?: string;
};

export type HostBrain = {
  kind: "host";
  playbook: PlaybookBundle;
  usedLlm: boolean;
  needsReview: string[];
  think: (brief: string) => ReturnType<typeof thinkAboutBrief>;
  compose: (brief: string, project: PptdProject) => Promise<void>;
  run: (hooks: AgentRunHooks) => Promise<void>;
};

const SKIP_PLACE = /生成|一份|做一份|帮我|攻略|旅游|旅行|行程|必去|地方|吃喝|玩乐|方面|10月|十月|去$|日本|PPT|ppt/;

export function extractPlaces(brief: string): string[] {
  const chunks = brief
    .split(/[、，,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const chunk of chunks) {
    const afterColon = chunk.split(/[:：]/).pop()?.trim() || chunk;
    const token = afterColon.replace(/的$/, "").trim();
    if (token.length < 2 || token.length > 10) continue;
    if (SKIP_PLACE.test(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out.slice(0, 8);
}

import { parsePagedScript } from "./host-produce-script.js";
export { parsePagedScript };

function pagedScriptFromInputs(brief: string, referenceText?: string): HostPageCopy[] {
  const fromBrief = parsePagedScript(brief);
  if (fromBrief.length >= 3) return fromBrief;
  const extra = (referenceText || "").trim();
  if (!extra) return fromBrief;
  const fromRef = parsePagedScript(extra);
  if (fromRef.length >= 3) return fromRef;
  const fromBoth = parsePagedScript(`${brief}\n${extra}`);
  return fromBoth.length >= 3 ? fromBoth : fromBrief;
}

export function outlineFromBrief(brief: string, referenceText?: string): HostPageCopy[] {
  const scripted = pagedScriptFromInputs(brief, referenceText);
  if (scripted.length >= 3) return scripted;
  const intent = inferDeckIntent(brief);
  const { title } = briefToOutline(brief);
  let pages: HostPageCopy[] = [];
  if (intent === "travel") {
    const places = extractPlaces(brief);
    const days = places.length ? places : ["第一天", "第二天", "第三天"];
    pages = [
      {
        id: "cover",
        pageType: "cover",
        title: title.slice(0, 24),
        kicker: "10月",
        lines: [`${days.join(" · ")}`],
        exhibit: "cover",
      },
      ...days.map((place, i) => ({
        id: `day-${i + 1}`,
        pageType: "content",
        title: place,
        kicker: `0${i + 2}  ·  停留`,
        lines: [`围绕${place}安排动线，避免回头路`, "预约与开放时间标占位", "正餐与交通卡标占位"],
        exhibit: "content" as const,
      })),
      {
        id: "close",
        pageType: "close",
        title: "出发前",
        kicker: "清单",
        lines: ["证件与交通卡", "预约门票标占位", "退税与天气标占位"],
        exhibit: "close",
      },
    ];
  } else if (intent === "teach") {
    pages = [
      {
        id: "cover",
        pageType: "cover",
        title,
        kicker: "讲一讲",
        lines: ["一页一件事"],
        exhibit: "cover",
      },
      {
        id: "route",
        pageType: "route",
        title: "路径",
        kicker: "02",
        lines: ["先看见", "再记住", "再会用"],
        exhibit: "path",
      },
      {
        id: "concept",
        pageType: "concept",
        title: "它是什么",
        kicker: "03",
        lines: [title],
        exhibit: "content",
      },
      {
        id: "method",
        pageType: "method",
        title: "怎么做",
        kicker: "04",
        lines: ["条件写清楚"],
        exhibit: "content",
      },
      {
        id: "demo",
        pageType: "demo",
        title: "看一遍",
        kicker: "05",
        lines: ["一个例子"],
        exhibit: "content",
      },
      {
        id: "transfer",
        pageType: "transfer",
        title: "你来试",
        kicker: "06",
        lines: ["离开课堂也能做"],
        exhibit: "close",
      },
    ];
  } else {
    const claims = briefToOutline(brief).claims.slice(0, 4);
    pages = [
      {
        id: "cover",
        pageType: "cover",
        title,
        kicker: "判断",
        lines: claims.slice(0, 1),
        exhibit: "cover",
      },
      ...claims.map((c, i) => ({
        id: `p-${i + 1}`,
        pageType: "content",
        title: c.slice(0, 22),
        kicker: `0${i + 2}`,
        lines: [c, "缺数据标占位"],
        exhibit: "content" as const,
      })),
      {
        id: "close",
        pageType: "close",
        title: "下一步",
        kicker: "收束",
        lines: ["核对占位后再外传"],
        exhibit: "close",
      },
    ];
  }
  const evidence = evidencePagesFromReference(referenceText || "");
  if (evidence.length && pages.length <= 6) {
    const close = pages[pages.length - 1]!;
    pages = [...pages.slice(0, -1), ...evidence, close];
  }
  return pages;
}

function asCopy(raw: unknown, fallback: HostPageCopy): HostPageCopy {
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : fallback.title;
  const kicker = typeof o.kicker === "string" && o.kicker.trim() ? o.kicker.trim() : fallback.kicker;
  const lines = Array.isArray(o.lines)
    ? o.lines.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 8)
    : fallback.lines;
  return { ...fallback, title, kicker, lines: lines.length ? lines : fallback.lines };
}

function paintDeck(brief: string, pages: HostPageCopy[], pal: Palette): SkillDeckInput {
  return {
    title: pages[0]?.title || brief.slice(0, 24),
    pages: pages.map((p, i) => paintExhibit(p, pal, i, pages)),
  };
}

async function withTimeout<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("host produce copy timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function playbookForHostBrief(brief: string, opts: HostBrainOptions): PlaybookBundle {
  const categoryId = resolvePlaybookCategory(brief, opts.categoryId);
  const designSystemId = resolveGenerateDesign(brief, opts.designSystemId ?? DEFAULT_DESIGN_SYSTEM, categoryId);
  return loadPlaybook({
    skillRoot: opts.skillRoot,
    designSystemId,
    categoryId,
  });
}

function isScripted(outline: HostPageCopy[]): boolean {
  return (
    outline.length >= 3 &&
    outline.every((p) => (p.body && p.body.length > 40) || p.lines.length >= 2) &&
    (outline.length >= 8 || outline.some((p) => Boolean(p.body)))
  );
}

/**
 * @deprecated Development/test fixture only. The normal product path must use
 * `createPiBrain` and must fail closed instead of accepting host-painted pages.
 */
export function createHostBrain(opts: HostBrainOptions): HostBrain {
  let playbook = loadPlaybook({
    skillRoot: opts.skillRoot,
    designSystemId: opts.designSystemId ?? DEFAULT_DESIGN_SYSTEM,
    categoryId: opts.categoryId ?? DEFAULT_CATEGORY,
  });

  const needsReview: string[] = [];

  const apply = (brief: string, project: PptdProject, pages: SkillPageInput[]) => {
    playbook = playbookForHostBrief(brief, opts);
    applySkillDeck(
      project,
      {
        title: project.presentation.title || brief.slice(0, 24),
        pages,
      },
      playbook.palette,
    );
    const firstTitle = pages[0]?.elements.find((e) => e.elementId === "title");
    if (firstTitle && firstTitle.elementType === "text") {
      const content = "content" in firstTitle ? firstTitle.content : undefined;
      const t =
        content && typeof content === "object" && content && "text" in content
          ? String((content as { text?: string }).text || "")
          : "";
      if (t) project.presentation.title = t;
    }
  };

  const fillOnePage = async (
    brief: string,
    page: HostPageCopy,
    index: number,
    total: number,
    scripted: boolean,
  ): Promise<HostPageCopy> => {
    if (scripted || !opts.llm?.completeJson) return page;
    if (page.body && page.body.length > 40) return page;
    try {
      const raw = await withTimeout(
        12_000,
        opts.llm.completeJson(
          "Fill ONE slide. Return JSON { title, kicker, lines: string[2..6] }. Same language as the brief. No invented prices or ratings. 占位 for missing facts.",
          `Deck context (do not add pages):\n${brief.slice(0, 700)}\n\nThis page ${index + 1}/${total}: ${page.title}\nExisting: ${page.lines.join(" | ")}`,
        ),
      );
      return asCopy(raw, page);
    } catch {
      return page;
    }
  };

  const producePages = async (
    brief: string,
    outline: HostPageCopy[],
    project: PptdProject,
    hooks?: AgentRunHooks,
  ): Promise<SkillPageInput[]> => {
    const scripted = isScripted(outline) || pagedScriptFromInputs(brief, opts.referenceText).length >= 3;
    const intent = inferDeckIntent(brief);
    playbook = playbookForHostBrief(brief, opts);
    const painted: SkillPageInput[] = [];
    const root = opts.projectRoot || project.rootDir;
    for (let i = 0; i < outline.length; i++) {
      const base = outline[i]!;
      const writeStep: ToolStep = {
        tool: "write_page",
        label: "Write Page",
        status: "running",
        summary: `${i + 1} / ${outline.length} · ${base.title}`,
        detail: `${classifyExhibit(base, i, outline.length)}  ${base.title}`,
      };
      hooks?.emit(writeStep);
      const copy = await fillOnePage(brief, base, i, outline.length, scripted);
      let imageSrc: string | undefined;
      if (wantsPhoto(copy, intent) && (opts.image || opts.imageSearch) && root) {
        imageSrc = await maybePlaceImage(copy.title, {
          projectRoot: root,
          search: opts.imageSearch,
          generate: opts.image,
        });
      }
      let page = paintExhibit(copy, playbook.palette, i, outline, { imageSrc });
      if (qaPaintedPage(page).length) page = repairPaintedPage(page);
      painted.push(page);
      apply(brief, project, painted);
      if (root) {
        try {
          saveProject(project);
        } catch {
          /* applySkillDeck already wrote skill-deck.json */
        }
      }
      writeStep.status = "completed";
      writeStep.summary = `${i + 1} / ${outline.length} · ${copy.title}`;
      writeStep.detail = page.elements.map((e) => e.elementType).join(" ");
      hooks?.emitUpdate(writeStep);
      if (opts.raster?.available && root) {
        const renderStep: ToolStep = {
          tool: "render_page",
          label: "Render Page",
          status: "running",
          summary: `${i + 1} / ${outline.length}`,
        };
        hooks?.emit(renderStep);
        try {
          const shot = await withTimeout(8_000, opts.raster.render({ projectRoot: root, pageIndex: i }));
          if (shot.bytes) savePageRaster(root, `page-${String(i + 1).padStart(2, "0")}`, shot.bytes);
          const visionOn =
            process.env.SLIDESTUDIO_LLM_IMAGE !== "0" && Boolean(opts.llm?.completeJsonWithImages) && shot.bytes;
          if (visionOn && shot.bytes) {
            try {
              const fix = await withTimeout(
                12_000,
                opts.llm!.completeJsonWithImages!(
                  "QA one slide screenshot. JSON { ok: boolean, issues: string[] }. Do not invent numbers. Do not rewrite the deck.",
                  `Page ${i + 1}: ${copy.title}`,
                  [{ url: rasterToDataUrl(shot.bytes) }],
                ),
              );
              const rec = fix && typeof fix === "object" ? (fix as { ok?: boolean }) : {};
              if (rec.ok === false) needsReview.push(copy.id);
            } catch {
              needsReview.push(copy.id);
            }
          }
          renderStep.status = "completed";
          renderStep.detail = shot.kind;
          hooks?.emitUpdate(renderStep);
        } catch {
          renderStep.status = "completed";
          renderStep.summary = `${i + 1} / ${outline.length} · skipped`;
          renderStep.detail = "raster unavailable";
          hooks?.emitUpdate(renderStep);
        }
      }
    }
    return painted;
  };

  const brain: HostBrain = {
    kind: "host",
    playbook,
    usedLlm: false,
    needsReview,
    think(brief) {
      return thinkAboutBrief(brief, opts.referenceText);
    },
    async compose(brief, project) {
      const outline = outlineFromBrief(brief, opts.referenceText);
      playbook = playbookForHostBrief(brief, opts);
      brain.usedLlm = Boolean(opts.llm);
      applySkillDeck(project, paintDeck(brief, outline, playbook.palette), playbook.palette);
    },
    async run(hooks) {
      const brief = hooks.brief;
      needsReview.length = 0;
      const think = thinkAboutBrief(brief, opts.referenceText);
      hooks.emit({
        tool: "think",
        label: "Think",
        status: "completed",
        summary: think.summary,
        detail: think.detail,
      });
      const outline = outlineFromBrief(brief, opts.referenceText);
      hooks.emit({
        tool: "write_todo",
        label: "Write Todo",
        status: "completed",
        summary: `${outline.length} 页`,
        detail: outline
          .map((p, i) => `${String(i + 1).padStart(2, "0")}  ${classifyExhibit(p, i, outline.length)}  ${p.title}`)
          .join("\n"),
      });
      brain.usedLlm = Boolean(opts.llm) && pagedScriptFromInputs(brief, opts.referenceText).length < 3;
      const painted = await producePages(brief, outline, hooks.project, hooks);
      const fidelity = qaScriptFidelity(painted, outline);
      const structural = painted.flatMap((p) => qaPaintedPage(p));
      const issues = [...fidelity, ...structural];
      if (issues.length) needsReview.push(...issues.map((i) => i.pageId));
      hooks.emit({
        tool: "review_pages",
        label: "Review Pages",
        status: "completed",
        summary: issues.length ? `${issues.length} 项需复核` : `${painted.length} 页通过`,
        detail: issues.length ? issues.map((i) => `${i.pageId}  ${i.code}  ${i.message}`).join("\n") : "structural ok",
      });
      hooks.emit({
        tool: "compose_deck",
        label: "Compose Deck",
        status: "completed",
        summary: `${painted.length} 页 · host`,
        detail: outline.map((p, i) => `${String(i + 1).padStart(2, "0")}  ${p.title}`).join("\n"),
      });
    },
  };
  return brain;
}
