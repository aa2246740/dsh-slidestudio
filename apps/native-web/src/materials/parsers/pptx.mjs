/**
 * `pptx-ooxml-v2` — PowerPoint template material. Reads slide size, the theme
 * colour scheme (including sysClr lastClr fallbacks) and major/minor fonts
 * with the Hans script variant, masters and their layouts with placeholder
 * geometry as slide fractions (inheriting the master box when the layout has
 * none), per-slide text/title/hidden state, and media entries with sharp
 * dimensions, usage roles and the logo-candidate heuristic (a master/layout
 * picture smaller than 35% × 25% of the slide that is not a background).
 */
import { createHash } from "node:crypto";
import { normalizeSourceFonts } from "@open-slidestudio/pptd-v2";
import { MaterialRejection } from "../zip-guard.mjs";
import { hasUndecodableLogo, LOGO_IMAGE_CORRUPT_NOTE, logoTooLargeNote, oversizedLogoBytes } from "../logo-bytes.mjs";
import { buildSummaryZh } from "../summary.mjs";
import { PackageReader, attrOf, descendantsOf, firstOf, parseRels, parseXml, resolvePartPath } from "./ooxml.mjs";

import { geometryOf, parseShapes } from "./pptx-geometry.mjs";
import { colorMapOf, noteColors, observedColors } from "./pptx-colors.mjs";
import { readTemplateMedia } from "./pptx-logos.mjs";
import { clusterArchetypes } from "./pptx-archetypes.mjs";
import { readSlide } from "./pptx-slides.mjs";
import { readDecorations, templateKitOutput } from "./pptx-kit.mjs";
import { fontStatistics } from "./pptx-fonts.mjs";
import { COLOR_KEYS, emptyColors, parseTheme } from "./ooxml-theme.mjs";
export { parseShapes } from "./pptx-geometry.mjs";

const CORRUPT_MESSAGE = "文件已损坏或内容不完整，无法解析；请重新导出后上传";

/** Layout placeholders without their own box inherit the master's by type. */
const INHERIT_TYPE = { ctrTitle: "title", subTitle: "body" };

/** Placeholder box as fractions of the slide size. @typedef {{x: number, y: number, w: number, h: number}} Box */

/** @typedef {{type: string|null, idx: string|null}} PlaceholderInfo */

/** @typedef {import("./pptx-geometry.mjs").Shape} Shape */

/** @typedef {import("./ooxml-theme.mjs").Theme} Theme */

/** @typedef {{type: string|null, idx: string|null, box: Box|null, inherited?: boolean}} PlaceholderBox */

/** @typedef {{part: string, name: string|null, type: string, placeholders: PlaceholderBox[], slideCount?: number}} Layout */

/** @typedef {{part: string, placeholders: PlaceholderBox[], layouts: Layout[]}} Master */

/** @typedef {{index: number, part: string, hidden: boolean, title: string|null, text: string, placeholders:number, tableText?:string,notes?:string}} SlideEntry */

/** @typedef {{sourcePart: string, role: string, box: Box}} Placement */
/** @typedef {import("./pptx-logos.mjs").MediaUse} MediaUse */
/** @typedef {{id: string, part: string, bytes: number, format: string, width?: number, height?: number, roles: string[], logoCandidate: boolean, sha256?: string, placements?: Placement[], logoUndecodable?: boolean}} MediaEntry */

/**
 * Pages per layout, so the design source can say which layout carries the chrome most pages show.
 * @param {Master[]} masters
 * @param {Map<string,import("./pptx-logos.mjs").LayoutUse>} layoutUses
 */
function countLayoutPages(masters, layoutUses) {
  for (const master of masters) {
    for (const layout of master.layouts) {
      layout.slideCount = layoutUses.get(layout.part)?.slides.length ?? 0;
    }
  }
}

/**
 * @typedef {{
 *   pkg: PackageReader, presPart: string,
 *   presRels: Map<string, import("./ooxml.mjs").PartRelationship>,
 *   width: number, height: number, mediaUse: Map<string, MediaUse>,
 *   contexts: Map<string,{root:import("./ooxml.mjs").DomNode,master:import("./ooxml.mjs").DomNode,theme:Theme,map:Record<string,string>}>,
 *   colorUses: Map<string,import("./pptx-colors.mjs").ColorUse>,
 *   layoutUses: Map<string,import("./pptx-logos.mjs").LayoutUse>,
 *   firstTheme: Theme|null,
 * }} DeckState
 */

/** @param {Theme|null} theme @returns {Theme} */
function themeOrEmpty(theme) {
  return theme ?? { name: null, colors: emptyColors(), fonts: { major: null, minor: null } };
}

/**
 * One slide master with its theme, colour map, placeholders and layouts.
 * @param {DeckState} state @param {import("./ooxml.mjs").DomNode} masterId
 * @returns {Master|null}
 */
function readMaster(state, masterId) {
  const { pkg, width, height } = state;
  const masterRel = state.presRels.get(attrOf(masterId, "r:id") ?? "");
  if (!masterRel) return null;
  const masterPart = resolvePartPath(state.presPart, masterRel.target);
  const masterText = pkg.text(masterPart);
  if (masterText === undefined) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
  const masterXml = parseXml(masterText, masterPart);
  const masterRels = parseRels(pkg, masterPart);

  const themeRel = [...masterRels.values()].find((entry) => entry.type === "theme");
  const theme = themeRel ? parseTheme(pkg, resolvePartPath(masterPart, themeRel.target)) : null;
  if (theme && !state.firstTheme) state.firstTheme = theme;

  const activeTheme = themeOrEmpty(theme);
  const masterMap = colorMapOf(masterXml);
  noteColors(masterXml, activeTheme, masterMap, state.colorUses);
  const masterShapes = parseShapes(masterXml, width, height);
  noteUsages(masterXml, masterPart, masterRels, masterShapes, "master", state.mediaUse);

  const masterPlaceholders = masterShapes
    .filter((shape) => shape.ph)
    .map((shape) => ({
      type: shape.ph?.type ?? null,
      idx: shape.ph?.idx ?? null,
      box: shape.box,
    }));
  const masterBoxByType = new Map(masterPlaceholders.map((p) => [p.type ?? "", p.box]));
  const master = { part: masterPart, xml: masterXml, rels: masterRels, theme: activeTheme, map: masterMap };

  /** @type {Layout[]} */
  const layouts = [];
  for (const layoutId of descendantsOf(masterXml, "sldLayoutId")) {
    const layout = readLayout(state, master, masterBoxByType, layoutId);
    if (layout) layouts.push(layout);
  }
  return { part: masterPart, placeholders: masterPlaceholders, layouts };
}

/**
 * @param {DeckState} state
 * @param {{part: string, xml: import("./ooxml.mjs").DomNode, rels: Map<string, import("./ooxml.mjs").PartRelationship>, theme: Theme, map: Record<string,string>}} master
 * @param {Map<string, Box|null>} masterBoxByType
 * @param {import("./ooxml.mjs").DomNode} layoutId
 * @returns {Layout|null}
 */
function readLayout(state, master, masterBoxByType, layoutId) {
  const { pkg } = state;
  const layoutRel = master.rels.get(attrOf(layoutId, "r:id") ?? "");
  if (!layoutRel) return null;
  const layoutPart = resolvePartPath(master.part, layoutRel.target);
  const layoutText = pkg.text(layoutPart);
  if (layoutText === undefined) return null;
  const layoutXml = parseXml(layoutText, layoutPart);
  const layoutRels = parseRels(pkg, layoutPart);
  state.layoutUses.set(layoutPart, { master: master.part, slides: [] });
  state.contexts.set(layoutPart, {
    root: layoutXml,
    master: master.xml,
    theme: master.theme,
    map: colorMapOf(layoutXml, master.map),
  });
  const layoutShapes = parseShapes(layoutXml, state.width, state.height);
  noteUsages(layoutXml, layoutPart, layoutRels, layoutShapes, "layout", state.mediaUse);
  return {
    part: layoutPart,
    name: attrOf(layoutXml, "name") ?? attrOf(firstOf(layoutXml, "cSld") ?? layoutXml, "name") ?? null,
    type: attrOf(layoutXml, "type") ?? "custom",
    placeholders: layoutShapes.filter((shape) => shape.ph).map((shape) => layoutPlaceholder(shape, masterBoxByType)),
  };
}

/** @param {Shape} shape @param {Map<string, Box|null>} masterBoxByType @returns {PlaceholderBox} */
function layoutPlaceholder(shape, masterBoxByType) {
  const ownType = shape.ph?.type ?? "body";
  const inheritType = INHERIT_TYPE[/** @type {"ctrTitle"|"subTitle"} */ (ownType)] ?? ownType;
  const inherited = !shape.box && masterBoxByType.has(inheritType);
  return {
    type: ownType,
    idx: shape.ph?.idx ?? null,
    box: shape.box ?? masterBoxByType.get(inheritType) ?? null,
    inherited,
  };
}

/**
 * Every listed slide, with the per-slide tables, charts, SmartArt and template-kit decorations.
 * @param {DeckState} state @param {import("./ooxml.mjs").DomNode} pres
 */
function readDeckSlides(state, pres) {
  /** @type {SlideEntry[]} */
  const slides = [];
  const deck = {
    slides,
    detailSlides: /** @type {object[]} */ ([]),
    tables: /** @type {NonNullable<ReturnType<typeof readSlide>>["tables"]} */ ([]),
    charts: /** @type {NonNullable<ReturnType<typeof readSlide>>["charts"]} */ ([]),
    smartArts: /** @type {NonNullable<ReturnType<typeof readSlide>>["smartArts"]} */ ([]),
    diagramWarnings: /** @type {NonNullable<ReturnType<typeof readSlide>>["diagramWarnings"]} */ ([]),
    diagramBudget: { count: 0, truncated: false },
    kitSlides: /** @type {({index: number} & ReturnType<typeof readDecorations>)[]} */ ([]),
    /** @type {{index:number,shapes:Shape[],chartRuns:import("./pptx-geometry.mjs").Run[]}[]} */
    fontPages: [],
    /** @type {number[]} */
    chartSizes: [],
  };
  let index = 0;
  for (const slideId of descendantsOf(pres, "sldId")) {
    index += 1;
    const slideRel = state.presRels.get(attrOf(slideId, "r:id") ?? "");
    if (!slideRel) continue;
    collectSlide(state, deck, resolvePartPath(state.presPart, slideRel.target), index);
  }
  return deck;
}

/**
 * @param {DeckState} state @param {ReturnType<typeof readDeckSlides>} deck
 * @param {string} slidePart @param {number} index
 */
function collectSlide(state, deck, slidePart, index) {
  const { width, height } = state;
  const slide = readSlide(
    state.pkg,
    slidePart,
    index,
    width,
    height,
    state.contexts,
    state.firstTheme,
    state.colorUses,
    deck.diagramBudget,
  );
  if (!slide) return;
  if (slide.layoutPart) state.layoutUses.get(slide.layoutPart)?.slides.push(index);
  deck.kitSlides.push({
    index,
    ...readDecorations({
      root: slide.root,
      part: slidePart,
      rels: slide.rels,
      theme: slide.theme,
      map: slide.map,
      width,
      height,
    }),
  });
  noteUsages(slide.root, slidePart, slide.rels, slide.shapes, "slide", state.mediaUse);
  deck.fontPages.push({ index, shapes: slide.shapes, chartRuns: slide.chartRuns });
  deck.chartSizes.push(...slide.chartSizes);
  deck.tables.push(...slide.tables);
  deck.charts.push(...slide.charts);
  deck.smartArts.push(...slide.smartArts);
  deck.diagramWarnings.push(...slide.diagramWarnings);
  const summary = slide.summary;
  deck.detailSlides.push({
    ...slide.detail,
    part: summary.part,
    hidden: summary.hidden,
    title: summary.title,
    text: summary.text,
    placeholders: summary.placeholders,
    ...(summary.tableText ? { tableText: summary.tableText } : {}),
    ...(summary.notes ? { notes: summary.notes } : {}),
  });
  deck.slides.push(summary);
}

/** @param {SlideEntry[]} slides @param {{index:number,shapes:Shape[]}[]} fontPages */
function archetypesOf(slides, fontPages) {
  return clusterArchetypes(
    slides.map((slide) => ({
      ...slide,
      shapes: fontPages.find((page) => page.index === slide.index)?.shapes ?? [],
    })),
  );
}

export const pptxParser = {
  id: "pptx-ooxml-v2",
  engine: "fflate + @xmldom/xmldom + sharp",
  /** @type {"deck-template"} */
  kind: "deck-template",

  /**
   * @param {{name: string, bytes: Uint8Array}} input
   * @param {{kitMaxBytes?: number, chromeGreyMaxBytes?: number, slideGreyMaxBytes?: number}} [options] Test seams for the
   *   template kit's size cap and the total size of derived layout and master greys.
   * @returns {Promise<import("../derivative.mjs").ParserResult<object>>}
   */
  async parse({ bytes }, options = {}) {
    const pkg = new PackageReader(bytes);
    const presPart = "ppt/presentation.xml";
    const presText = pkg.text(presPart);
    if (presText === undefined) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
    const pres = parseXml(presText, presPart);

    const sizeEl = firstOf(pres, "sldSz");
    const slideWidth = Number(attrOf(sizeEl ?? pres, "cx")) || 0;
    const slideHeight = Number(attrOf(sizeEl ?? pres, "cy")) || 0;
    const presRels = parseRels(pkg, presPart);

    /** @type {Map<string, MediaUse>} */
    const mediaUse = new Map();

    /** @type {Master[]} */
    const masters = [];
    /** @type {Map<string,{root:import("./ooxml.mjs").DomNode,master:import("./ooxml.mjs").DomNode,theme:Theme,map:Record<string,string>}>} */
    const contexts = new Map();
    /** @type {Map<string,import("./pptx-colors.mjs").ColorUse>} */
    const colorUses = new Map();
    /** @type {Map<string,import("./pptx-logos.mjs").LayoutUse>} */
    const layoutUses = new Map();

    /** @type {DeckState} */
    const state = {
      pkg,
      presPart,
      presRels,
      width: slideWidth,
      height: slideHeight,
      mediaUse,
      contexts,
      colorUses,
      layoutUses,
      firstTheme: null,
    };
    for (const masterId of descendantsOf(pres, "sldMasterId")) {
      const master = readMaster(state, masterId);
      if (master) masters.push(master);
    }
    const firstTheme = state.firstTheme;
    const deck = readDeckSlides(state, pres);
    const { slides, detailSlides, tables, charts, smartArts, diagramWarnings, diagramBudget } = deck;
    const { fontPages } = deck;
    const chartSizes = new Set(deck.chartSizes);
    countLayoutPages(masters, layoutUses);

    const { media, logos, logo, photos, chromePhotos, assets, warnings } = await readTemplateMedia(
      pkg,
      mediaUse,
      layoutUses,
      {
        chromeGreyMaxBytes: options.chromeGreyMaxBytes,
        slideGreyMaxBytes: options.slideGreyMaxBytes,
      },
    );

    const theme = themeOrEmpty(firstTheme);
    const layoutCount = masters.reduce((sum, master) => sum + master.layouts.length, 0);
    const themeColorCount = COLOR_KEYS.filter((key) => theme.colors?.[key]).length;
    const logoCandidates = logos.length;
    const fonts = theme.fonts ?? {};
    const fontMappings = normalizeSourceFonts(fonts);
    const oversizedLogo = oversizedLogoBytes(media);
    const corruptLogo = hasUndecodableLogo(media);
    const typography = fontStatistics(fontPages);
    const chartTier = typography.fontSizeTiers.find((tier) => tier.role === "chart");
    if (chartTier) chartTier.pt = [...chartSizes].sort((a, b) => b - a);
    const archetypes = archetypesOf(slides, fontPages);
    const kit = templateKitOutput(
      {
        pkg,
        width: slideWidth,
        height: slideHeight,
        slides: deck.kitSlides,
        contexts,
        layoutUses,
        archetypes,
        smartArts,
        photos,
        chromePhotos,
        photoAssets: assets,
      },
      { maxBytes: options.kitMaxBytes },
    );
    const detailLayouts = [...contexts].map(([part, context]) => ({
      part,
      shapes: parseShapes(context.root, slideWidth, slideHeight).map(geometryOf),
    }));
    const colorsObserved = observedColors(colorUses);
    const diagramOutput = smartArtOutput(smartArts);
    const templateDetail = {
      version: 2,
      observedColors: colorsObserved,
      fontsUsed: typography.fontsUsed,
      fontSizeTiers: typography.fontSizeTiers,
      logos,
      archetypes,
      photos,
      slides: detailSlides,
      layouts: detailLayouts,
      tables,
      charts,
      assets,
      ...diagramOutput.detail,
    };
    const detailBytes = `${JSON.stringify(templateDetail, null, 2)}\n`;
    return {
      payload: {
        slideSize: {
          cx: slideWidth,
          cy: slideHeight,
          aspect: slideHeight ? Math.round((slideWidth / slideHeight) * 1000) / 1000 : null,
        },
        theme: { ...theme, fontMappings },
        masters,
        slides,
        media,
        logoCandidates,
        logos,
        logo,
        photos,
        archetypes,
        observedColors: colorsObserved,
        ...typography,
        ...diagramOutput.summary,
        templateDetail,
        detail: {
          file: "template-detail.json",
          sha256: createHash("sha256").update(detailBytes).digest("hex"),
        },
        ...kit.payload,
      },
      summary: buildSummaryZh({
        parserId: this.id,
        themeColorCount,
        fonts,
        fontsUsed: typography.fontsUsed,
        layoutCount,
        slideCount: slides.length,
        logoCandidates,
        logoSelected: Boolean(logo),
        extra: [
          ...kit.copy,
          ...diagramOutput.copy,
          ...Object.entries(theme.colors).flatMap(([key, value]) => (value ? [`${key} ${value}`] : [])),
          ...Object.values(fontMappings).map((mapping) =>
            mapping.note.startsWith("字体已") ? mapping.note : `原字体不可用，已映射：${mapping.note}`,
          ),
          ...(oversizedLogo ? [logoTooLargeNote(oversizedLogo)] : []),
          ...(corruptLogo ? [LOGO_IMAGE_CORRUPT_NOTE] : []),
          ...warnings.map((warning) => warning.message),
        ],
      }),
      warnings: [...warnings, ...diagramWarnings, ...kit.warnings],
      truncated: {
        applied:
          kit.truncated ||
          diagramBudget.truncated ||
          diagramWarnings.some((warning) => warning.code === "smartart-truncated"),
      },
    };
  },
};

/** Keep detailed geometry out of the small public SmartArt index.
 * @param {NonNullable<ReturnType<typeof readSlide>>["smartArts"]} diagrams */
function smartArtOutput(diagrams) {
  const missing = diagrams.filter((diagram) => diagram.cache === "none").length;
  return {
    detail: diagrams.length ? { smartArts: diagrams } : {},
    summary: diagrams.length
      ? {
          smartArts: diagrams.map((diagram) => ({
            id: diagram.id,
            slide: diagram.slide,
            name: diagram.name,
            box: diagram.box,
            layout: diagram.layout,
            nodeCount: diagram.nodeCount,
            chars: diagram.chars,
            cache: diagram.cache,
          })),
        }
      : {},
    copy: [
      ...(diagrams.length ? [`含 ${diagrams.length} 个 SmartArt（文字和层级可读取）`] : []),
      ...(missing ? [`其中 ${missing} 个只能读取文字`] : []),
    ],
  };
}

/**
 * @param {Map<string, MediaUse>} mediaUse
 * @param {string} part @param {string} role @param {Box|null} box @param {string} sourcePart
 */
function noteUse(mediaUse, part, role, box, sourcePart) {
  const use = mediaUse.get(part) ?? { roles: new Set(), boxes: [], placements: [] };
  use.roles.add(role);
  if (box) {
    use.boxes.push(box);
    use.placements.push({ sourcePart, role, box });
  }
  mediaUse.set(part, use);
}

/**
 * Walk one part's shape tree for media references, including background
 * fills (marked `<role>-background`, which never counts as a logo).
 * @param {import("./ooxml.mjs").DomNode} root @param {string} part
 * @param {Map<string, import("./ooxml.mjs").PartRelationship>} rels
 * @param {Shape[]} shapes @param {string} role
 * @param {Map<string, MediaUse>} mediaUse
 */
function noteUsages(root, part, rels, shapes, role, mediaUse) {
  for (const shape of shapes) {
    if (!shape.embed) continue;
    const target = rels.get(shape.embed);
    if (!target || target.external) continue;
    const mediaPart = resolvePartPath(part, target.target);
    noteUse(mediaUse, mediaPart, role, shape.box, part);
    if (shape.grayscale) {
      const use = mediaUse.get(mediaPart);
      if (use) use.grayscale = true;
    }
  }
  const cSld = firstOf(root, "cSld");
  const bg = cSld ? firstOf(cSld, "bg") : null;
  if (bg) {
    for (const blip of descendantsOf(bg, "blip")) {
      const relId = attrOf(blip, "r:embed");
      const target = relId ? rels.get(relId) : undefined;
      if (target && !target.external) {
        noteUse(mediaUse, resolvePartPath(part, target.target), `${role}-background`, null, part);
      }
    }
  }
}
