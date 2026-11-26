/**
 * Test-only fixture: a deck that the real domain tools composed, followed by the facts a manual
 * editor layout edit leaves behind. No renderer, browser or model runs; a render is a synthetic
 * raster whose chrome hash is computed exactly as render_page does. Production code never imports
 * this module. The package exposes it through `@open-slidestudio/presentation-run/testkit`.
 */
import fs from "node:fs";
import path from "node:path";
import { chromeSha256, createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { recordLayoutRevision } from "./layout-ledger.js";
import { persistPageKey } from "./page-identity.js";
import {
  currentPageRevision,
  ensureRunLedger,
  readRunLedger,
  recordPageRevision,
  stableSha256,
  type DeckComposedFact,
} from "./run-ledger.js";
import { recordImagePrepared, recordRaster } from "./run-ledger-raster.js";

export const COMPOSED_DECK_CONTEXT = {
  commandId: "composed-deck-fixture",
  contextEpochId: "composed-deck-epoch",
} as const;

const MASTER = {
  scope: "master",
  id: "main",
  name: "母版",
  elements: [
    {
      elementId: "footer",
      elementType: "text",
      bounds: [80, 500, 600, 40],
      content: { text: "页脚", fontSize: 14 },
      layoutRole: "footer",
    },
  ],
};

function bodyLayout(header: string) {
  return {
    scope: "layout",
    id: "body",
    name: "正文",
    masterId: "main",
    elements: [
      {
        elementId: "header",
        elementType: "text",
        bounds: [80, 20, 600, 40],
        content: { text: header, fontSize: 20 },
      },
      {
        elementId: "logo",
        elementType: "image",
        bounds: [860, 20, 80, 40],
        src: "media/logo-a.png",
      },
    ],
  };
}

function pageInput(pageId: string, layoutId?: string, title = `第 ${pageId} 页标题`) {
  return {
    id: pageId,
    pageType: "content",
    notes: `${pageId} 完整备注`,
    ...(layoutId ? { layoutId } : {}),
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 120, 800, 70],
        content: { text: title, fontSize: 32 },
      },
      {
        elementId: "body",
        elementType: "text",
        bounds: [80, 220, 800, 160],
        content: { text: "明确负责人，核对输入信息，再记录交付结果。", fontSize: 24 },
      },
    ],
  };
}

/** One domain tool call in the fixture's context; throws when the real gate refuses it. */
export async function callFixtureTool(root: string, name: string, args: Record<string, unknown>) {
  const result = await runDomainHand(name, { ...args, __openSlideStudio: COMPOSED_DECK_CONTEXT }, root);
  if (!result.ok) throw new Error(`${name} refused: ${result.detail}`);
  return result;
}

/** An empty project with a run ledger that requires current rasters and a structural review. */
export function createComposedDeckProject(root: string, title = "版式合成"): void {
  createEmptyProject(root, { title });
  writeDomainRuntime(root, { brief: "制作带统一版式的汇报。" });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: true, structuralReviewRequired: true },
  });
  fs.mkdirSync(path.join(root, "media"), { recursive: true });
  fs.writeFileSync(path.join(root, "media", "logo-a.png"), Buffer.from("synthetic logo"));
}

function chromeOf(root: string, pageId: string): string {
  const project = loadProject(root);
  const entry = project.pages.find((item) => persistPageKey(item.path) === pageId);
  if (!entry) throw new Error(`page ${pageId} is not on disk`);
  return chromeSha256(project, entry.page);
}

/** Synthetic render of the page as it is now, including the chrome its layout shows. */
export function renderFixturePage(root: string, pageId: string): void {
  const revision = currentPageRevision(root, pageId);
  if (!revision) throw new Error(`page ${pageId} has no committed revision`);
  const chrome = chromeOf(root, pageId);
  recordRaster(root, revision, {
    bytes: Buffer.from(`offline raster ${pageId} ${revision.pageSha256} ${chrome}`),
    src: `_agent/rasters/${pageId}.png`,
    width: 960,
    height: 540,
    layoutStatus: "pass",
    layoutIssues: [],
    chromeSha256: chrome,
  });
}

/** Synthetic render + prepared-image receipt, returning the deliveryToken for `_mark_image_emitted` tests. */
export function prepareFixturePageImage(
  root: string,
  pageId: string,
  context: { readonly commandId: string; readonly contextEpochId: string },
): string {
  const revision = currentPageRevision(root, pageId);
  if (!revision) throw new Error(`page ${pageId} has no committed revision`);
  const chrome = chromeOf(root, pageId);
  const recorded = recordRaster(root, revision, {
    bytes: Buffer.from(`offline raster ${pageId} ${revision.pageSha256} ${chrome}`),
    src: `_agent/rasters/${pageId}.png`,
    width: 960,
    height: 540,
    layoutStatus: "pass",
    layoutIssues: [],
    chromeSha256: chrome,
  });
  recordImagePrepared(root, context, recorded.fact, recorded.deliveryToken);
  return recorded.deliveryToken;
}

export type ComposedDeck = Readonly<{
  /** Every page id in plan order. The first and last use no layout; the rest use `body`. */
  pageIds: readonly string[];
  bodyPageIds: readonly string[];
  /** The `deck.composed` fact the real compose_deck call appended. */
  composed: DeckComposedFact;
}>;

/**
 * Plans, writes, renders, reviews and composes a deck of `pageCount` pages through the real tools.
 * The cover and the last page show no layout, like a deck whose body pages share one layout.
 */
export async function composeFixtureDeck(root: string, pageCount = 4): Promise<ComposedDeck> {
  const pageIds = Array.from({ length: pageCount }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);
  const bodyPageIds = pageIds.slice(1, -1);
  await callFixtureTool(root, "write_layout", MASTER);
  await callFixtureTool(root, "write_layout", bodyLayout("旧页眉"));
  await callFixtureTool(root, "write_todo", {
    items: pageIds.map((pageId) => ({
      pageId,
      title: `标题 ${pageId}`,
      layoutFamily: "content",
      exhibits: ["none"],
      ...(bodyPageIds.includes(pageId) ? { layoutId: "body" } : {}),
    })),
  });
  for (const pageId of pageIds) {
    await callFixtureTool(root, "write_page", pageInput(pageId, bodyPageIds.includes(pageId) ? "body" : undefined));
  }
  for (const pageId of pageIds) renderFixturePage(root, pageId);
  await callFixtureTool(root, "review_pages", {});
  await callFixtureTool(root, "compose_deck", { title: "版式合成" });
  const composed = [...(readRunLedger(root)?.facts ?? [])]
    .reverse()
    .find((fact): fact is DeckComposedFact => fact.type === "deck.composed");
  if (!composed) throw new Error("compose_deck recorded no deck.composed fact");
  return { pageIds, bodyPageIds, composed };
}

type TextLike = { elementId: string; content?: { text?: string } };

/** The fixture only edits text elements; the element union has no common `content` field. */
function textElements(elements: readonly unknown[] | undefined): TextLike[] {
  return (elements ?? []) as TextLike[];
}

/** The Agent's own layout change (`write_layout`), which records `source:"agent"`. */
export async function editBodyLayoutAsAgent(root: string, header = "智能页眉"): Promise<void> {
  await callFixtureTool(root, "write_layout", bodyLayout(header));
}

/** Later page work: the page's own content changes and a new page revision is committed. */
export function changePageContent(root: string, pageId: string): void {
  const project = loadProject(root);
  const entry = project.pages.find((item) => persistPageKey(item.path) === pageId);
  if (!entry) throw new Error(`page ${pageId} is not on disk`);
  const title = textElements(entry.page.elements).find((item) => item.elementId === "title");
  if (!title?.content) throw new Error(`page ${pageId} has no title`);
  title.content.text = "页面内容已被改写";
  saveProject(project);
  recordPageRevision(root, COMPOSED_DECK_CONTEXT, pageId, entry.page);
}

/**
 * What the editor leaves when the user changes the body layout by hand: the layout on disk changes
 * and one `layout.revision-committed {source:"editor"}` follows. No page revision, review or
 * composition is recorded, so the earlier composition no longer matches the layout chrome.
 */
export function editBodyLayoutAsEditor(root: string, header = "手动页眉"): void {
  const project = loadProject(root);
  const layout = project.presentation.layouts?.find((item) => item.id === "body");
  if (!layout) throw new Error("the fixture deck has no body layout");
  const edited = JSON.parse(JSON.stringify(layout)) as typeof layout;
  const headerElement = textElements(edited.elements).find((item) => item.elementId === "header");
  if (!headerElement?.content) throw new Error("the body layout has no header text");
  headerElement.content.text = header;
  project.presentation = {
    ...project.presentation,
    layouts: project.presentation.layouts?.map((item) => (item.id === "body" ? edited : item)),
  };
  saveProject(project);
  recordLayoutRevision(root, COMPOSED_DECK_CONTEXT, {
    scope: "layout",
    layoutId: "body",
    layoutSha256: stableSha256(edited),
    source: "editor",
  });
}
