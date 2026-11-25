import path from "node:path";
import type JSZip from "jszip";
import {
  PAGE_COUNT_TOKEN,
  sanitizeDeckColors,
  type ColorFallback,
  type Fill,
  type Page,
  type PptdElement,
  type PptdProject,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import { slideNumberRuns } from "./export-slide-number.js";

/*
 * Masters and layouts in the export (M5b, CAP-36). PptxGenJS writes every master and layout as an
 * empty part, so each one is drawn on a carrier slide: the master on a carrier bound to the default
 * layout, each layout on a carrier bound to its layout through `defineSlideMaster` and
 * `addSlide({ masterName })`. After the slide-level patches have run, `transplantLayouts` moves the
 * carrier's background and shapes into its layout or master part, renumbers the picture ids, and
 * removes the carrier slides and their notes. Every byte comes from the PPTD model.
 */

const MASTER_PART = "ppt/slideMasters/slideMaster1.xml";
const DEFAULT_LAYOUT_PART = "ppt/slideLayouts/slideLayout1.xml";
const WHITE: Fill = { type: "solid", color: "#FFFFFF" };

/** A degradation the layout export adds to the report. Its slide index is the carrier's. */
export type LayoutNote = { slideIndex: number; elementId?: string; kind: string; reason: string };

/** One carrier slide: the master's or a layout's content, drawn as a page would be. */
export type LayoutCarrier = {
  kind: "master" | "layout";
  /** 0-based index of the carrier slide. Carriers follow the pages in the package. */
  slideIndex: number;
  /** The master's or the layout's ID, which the element copies on the pages name as their owner. */
  ownerId: string;
  /** The layout's ID. Undefined for the master. */
  layoutId?: string;
  /** The name written on the target part: the master's or the layout's display name. */
  name: string;
  background?: Fill;
  elements: PptdElement[];
  /** A layout that hides the master's elements is written with showMasterSp="0". */
  hideMaster: boolean;
};

export type LayoutExport = {
  carriers: LayoutCarrier[];
  pageCount: number;
  /** Pages without a layout use the default layout, which hides the master when it has elements. */
  hideMasterOnDefault: boolean;
  /** Each is reported once, on the carrier it belongs to, so its slide index is the carrier's. */
  notes: LayoutNote[];
  /** The copies that a layout or master cannot hold: each page draws its own copy of them. */
  pageDrawnCopies: ReadonlySet<string>;
};

/** The PptxGenJS master name of a layout. The layout ID is unique and XML-safe, so the key is too. */
export function layoutMasterName(layoutId: string): string {
  return `layout-${layoutId}`;
}

/**
 * The carriers for this project, or undefined when it has no master and no layout. Such a project
 * leaves the export exactly as it was before masters and layouts existed. Carrier colours are
 * resolved as page colours are, so a refused stored colour is written as its fallback, and it is
 * reported once, on the carrier, rather than on every page that copies the element.
 */
export function layoutExportOf(project: PptdProject): LayoutExport | undefined {
  const { presentation } = project;
  const master = presentation.masters?.[0];
  const layouts = presentation.layouts ?? [];
  if (!master && layouts.length === 0) return undefined;
  const pageCount = project.pages.length;
  const drafts: Omit<LayoutCarrier, "slideIndex">[] = [];
  if (master) {
    drafts.push({
      kind: "master",
      ownerId: master.id,
      name: master.name,
      background: master.background,
      elements: master.elements,
      hideMaster: false,
    });
  }
  for (const layout of layouts) {
    const reachesMaster = master !== undefined && layout.masterId === master.id;
    drafts.push({
      kind: "layout",
      ownerId: layout.id,
      layoutId: layout.id,
      name: layout.name,
      // PowerPoint hands a layout without its own background the master's. A layout that does not
      // reach the master shows white in the model, so it gets white explicitly.
      background: layout.background ?? (reachesMaster || !master?.background ? undefined : WHITE),
      elements: layout.elements,
      // A layout that reaches no master has no master copies on its pages, so it hides the master.
      hideMaster: layout.showMasterElements === false || !reachesMaster,
    });
  }
  const colors = sanitizeDeckColors(
    drafts.map(({ elements, background }) => ({ elements, background })),
    presentation.theme,
  );
  const labels = drafts.map((draft) => (draft.kind === "master" ? `母版「${draft.name}」` : `版式「${draft.name}」`));
  const notes: LayoutNote[] = colors.fallbacks.map((fallback) => ({
    slideIndex: pageCount + fallback.pageIndex,
    ...(fallback.elementId === undefined ? {} : { elementId: fallback.elementId }),
    kind: "color-fallback",
    reason: `${labels[fallback.pageIndex]!}的颜色无法解析，已改用继承或默认颜色导出`,
  }));
  const pageDrawnCopies = new Set<string>();
  const carriers = drafts.map((draft, index): LayoutCarrier => {
    const slideIndex = pageCount + index;
    const label = labels[index]!;
    const clean = colors.pages[index]!;
    const elements = clean.elements.filter((element) => {
      if (!isPageOnly(element)) return true;
      pageDrawnCopies.add(copyKey(draft.kind === "master" ? "master" : "layout", draft.ownerId, element.elementId));
      notes.push({
        slideIndex,
        elementId: element.elementId,
        kind: "layout-unsupported-element",
        reason: `${label}不能包含图表、表格或 SmartArt，该元素已改为逐页绘制`,
      });
      return false;
    });
    for (const element of elements) {
      if (element.elementType !== "text") continue;
      if (!(element as TextElement).content.text.includes(PAGE_COUNT_TOKEN)) continue;
      notes.push({
        slideIndex,
        elementId: element.elementId,
        kind: "static-page-count",
        reason: `${label}中的 ${PAGE_COUNT_TOKEN} 导出为固定的 ${pageCount} 页；PowerPoint 没有总页数域，之后增减页面需要重新导出`,
      });
    }
    return { ...draft, slideIndex, background: clean.background, elements };
  });
  return {
    carriers,
    pageCount,
    hideMasterOnDefault: (master?.elements.length ?? 0) > 0,
    notes,
    pageDrawnCopies,
  };
}

/**
 * The elements a page draws: its own elements, and the copies of layout or master elements that a
 * layout cannot hold. The other copies are drawn once, on their carrier.
 */
export function pageElementsToDraw(page: Page, layoutExport: LayoutExport | undefined): PptdElement[] {
  return page.elements.filter((element) => {
    if (element.inherited === undefined) return true;
    const { scope, ownerId, elementId } = element.inherited;
    return layoutExport?.pageDrawnCopies.has(copyKey(scope, ownerId, elementId)) ?? false;
  });
}

/**
 * The page colour fallbacks that belong to a page's own content. A copy of a layout or master
 * element, and an inherited background, are reported once on their carrier instead.
 */
export function ownColorFallbacks(pages: PptdProject["pages"], fallbacks: readonly ColorFallback[]): ColorFallback[] {
  return fallbacks.filter(({ pageIndex, elementId }) => {
    const page = pages[pageIndex]?.page;
    if (!page) return true;
    if (elementId === undefined) return page.backgroundInherited !== true;
    return page.elements.find((element) => element.elementId === elementId)?.inherited === undefined;
  });
}

/** The master name a page binds to, or undefined when the page has no layout or its layout is missing. */
export function pageMasterName(presentation: PptdProject["presentation"], page: Page): string | undefined {
  const id = page.layoutId;
  if (id === undefined) return undefined;
  return (presentation.layouts ?? []).some((layout) => layout.id === id) ? layoutMasterName(id) : undefined;
}

/**
 * Moves every carrier into its layout or master, then removes the carriers from the package. Call
 * it after the slide-level patches have run on the carrier slides, and before the package
 * timestamps are pinned.
 */
export async function transplantLayouts(zip: JSZip, layoutExport: LayoutExport): Promise<void> {
  for (const carrier of layoutExport.carriers) {
    await placeCarrier(zip, carrier, layoutExport.pageCount);
  }
  if (layoutExport.hideMasterOnDefault) {
    await editPart(zip, DEFAULT_LAYOUT_PART, showMasterOff);
  }
  await removeCarriers(zip, layoutExport);
}

function isPageOnly(element: PptdElement): boolean {
  return (
    element.elementType === "chart" ||
    element.elementType === "table" ||
    (element.smartArt !== undefined && element.smartArt !== null)
  );
}

function copyKey(scope: string, ownerId: string, elementId: string): string {
  return `${scope}:${ownerId}:${elementId}`;
}

async function placeCarrier(zip: JSZip, carrier: LayoutCarrier, pageCount: number): Promise<void> {
  const slidePart = `ppt/slides/slide${carrier.slideIndex + 1}.xml`;
  const slideXml = await readPart(zip, slidePart);
  const slideRels = parseRelationships(await readPart(zip, relsPartOf(slidePart)));
  const part = carrier.kind === "master" ? MASTER_PART : layoutPartOf(slideRels);
  const cSldOpen = carrier.kind === "master" ? "<p:cSld>" : `<p:cSld name="${layoutMasterName(carrier.ownerId)}">`;
  const targetXml = await readPart(zip, part);
  if (!targetXml.includes(cSldOpen) || !targetXml.includes("</p:grpSpPr>")) {
    throw new Error(`native exporter: ${part} is not the target of the carrier for ${carrier.name}`);
  }
  const targetRelsPart = relsPartOf(part);
  const targetRelsXml = await readPart(zip, targetRelsPart);
  const relocated = relocator(slideRels, parseRelationships(targetRelsXml));
  const background = relocated.rewrite(backgroundOf(slideXml));
  const shapes = slideNumberRuns(relocated.rewrite(shapeTreeOf(slideXml)), pageCount);
  let next = targetXml.replace(cSldOpen, () => `<p:cSld name="${xmlAttribute(carrier.name)}">${background}`);
  next = next.replace("</p:grpSpPr>", () => `</p:grpSpPr>${shapes}`);
  if (carrier.hideMaster) next = showMasterOff(next);
  zip.file(part, next);
  if (relocated.added.length > 0) {
    const rels = targetRelsXml.replace(
      "</Relationships>",
      () => `${relocated.added.map(writeRelationship).join("")}</Relationships>`,
    );
    zip.file(targetRelsPart, rels);
  }
}

async function removeCarriers(zip: JSZip, layoutExport: LayoutExport): Promise<void> {
  const { carriers, pageCount } = layoutExport;
  for (const carrier of carriers) {
    const number = carrier.slideIndex + 1;
    zip.remove(`ppt/slides/slide${number}.xml`);
    zip.remove(`ppt/slides/_rels/slide${number}.xml.rels`);
    zip.remove(`ppt/notesSlides/notesSlide${number}.xml`);
    zip.remove(`ppt/notesSlides/_rels/notesSlide${number}.xml.rels`);
  }
  const presentationRels = parseRelationships(await readPart(zip, "ppt/_rels/presentation.xml.rels"));
  const dropped = new Set(
    presentationRels
      .filter((rel) => rel.type.endsWith("/slide") && slideNumberOf(rel.target) > pageCount)
      .map((rel) => rel.id),
  );
  if (dropped.size !== carriers.length) {
    throw new Error("native exporter: the carrier slides are not the slides after the pages");
  }
  await editPart(zip, "ppt/presentation.xml", (xml) =>
    xml.replace(/<p:sldId\b[^>]*\/>/g, (tag) => (dropped.has(attribute(tag, "r:id")) ? "" : tag)),
  );
  await editPart(zip, "ppt/_rels/presentation.xml.rels", (xml) =>
    xml.replace(/<Relationship\b[^>]*\/>/g, (tag) => (dropped.has(attribute(tag, "Id")) ? "" : tag)),
  );
  // Overrides for parts that do not exist (one slideMaster override per slide, for example) go too.
  await editPart(zip, "[Content_Types].xml", (xml) =>
    xml.replace(/<Override\b[^>]*\/>/g, (tag) => (zip.file(attribute(tag, "PartName").slice(1)) ? tag : "")),
  );
  await editPart(zip, "docProps/app.xml", (xml) => appCounts(xml, pageCount));
}

/** The slide-count fields and the title list of docProps/app.xml, for the pages that remain. */
function appCounts(xml: string, pageCount: number): string {
  let removed = 0;
  const kept = xml
    .replace(/<Slides>\d+<\/Slides>/, () => `<Slides>${pageCount}</Slides>`)
    .replace(/<Notes>\d+<\/Notes>/, () => `<Notes>${pageCount}</Notes>`)
    .replace(
      /(<vt:lpstr>Slide Titles<\/vt:lpstr><\/vt:variant>\s*<vt:variant><vt:i4>)\d+(<\/vt:i4>)/,
      (_match, open: string, close: string) => `${open}${pageCount}${close}`,
    )
    .replace(/<vt:lpstr>Slide (\d+)<\/vt:lpstr>/g, (tag, number: string) => {
      if (Number(number) <= pageCount) return tag;
      removed++;
      return "";
    });
  return kept.replace(
    /(<vt:vector size=")(\d+)(" baseType="lpstr">)/,
    (_match, open: string, size: string, close: string) => `${open}${Number(size) - removed}${close}`,
  );
}

/** Replaces the picture and hyperlink ids of a carrier with fresh ids in the target part. */
function relocator(source: Relationship[], target: Relationship[]) {
  const added: Relationship[] = [];
  const renamed = new Map<string, string>();
  let next = Math.max(0, ...target.map((rel) => Number(/\d+/.exec(rel.id)?.[0] ?? 0))) + 1;
  const rewrite = (xml: string): string =>
    xml.replace(/(\br:(?:embed|link|id)=")(rId\d+)(")/g, (match, open: string, id: string, close: string) => {
      const existing = renamed.get(id);
      if (existing) return `${open}${existing}${close}`;
      const rel = source.find((item) => item.id === id);
      if (!rel) return match;
      const fresh = `rId${next++}`;
      renamed.set(id, fresh);
      added.push({ ...rel, id: fresh });
      return `${open}${fresh}${close}`;
    });
  return { rewrite, added };
}

function backgroundOf(slideXml: string): string {
  const head = slideXml.slice(0, slideXml.indexOf("<p:spTree>"));
  return /<p:bg>[\s\S]*?<\/p:bg>/.exec(head)?.[0] ?? "";
}

function shapeTreeOf(slideXml: string): string {
  const start = slideXml.indexOf("</p:grpSpPr>");
  const end = slideXml.indexOf("</p:spTree>");
  if (start < 0 || end < 0) throw new Error("native exporter: a carrier slide has no shape tree");
  return slideXml.slice(start + "</p:grpSpPr>".length, end);
}

function layoutPartOf(slideRels: Relationship[]): string {
  const rel = slideRels.find((item) => item.type.endsWith("/slideLayout"));
  if (!rel) throw new Error("native exporter: a layout carrier has no slideLayout relationship");
  return path.posix.normalize(path.posix.join("ppt/slides", rel.target));
}

function showMasterOff(xml: string): string {
  return xml.replace("<p:sldLayout ", () => '<p:sldLayout showMasterSp="0" ');
}

type Relationship = { id: string; type: string; target: string; mode?: string };

function parseRelationships(xml: string): Relationship[] {
  return [...xml.matchAll(/<Relationship\b[^>]*\/>/g)].map(([tag]) => ({
    id: attribute(tag, "Id"),
    type: attribute(tag, "Type"),
    target: attribute(tag, "Target"),
    mode: attribute(tag, "TargetMode") || undefined,
  }));
}

function writeRelationship(rel: Relationship): string {
  const mode = rel.mode ? ` TargetMode="${rel.mode}"` : "";
  return `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}"${mode}/>`;
}

function attribute(tag: string, name: string): string {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

function slideNumberOf(target: string): number {
  return Number(/slide(\d+)\.xml$/.exec(target)?.[1] ?? 0);
}

function relsPartOf(part: string): string {
  return path.posix.join(path.posix.dirname(part), "_rels", `${path.posix.basename(part)}.rels`);
}

async function readPart(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (!file) throw new Error(`native exporter: ${name} is missing while placing layouts`);
  return file.async("string");
}

async function editPart(zip: JSZip, name: string, edit: (xml: string) => string): Promise<void> {
  zip.file(name, edit(await readPart(zip, name)));
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
