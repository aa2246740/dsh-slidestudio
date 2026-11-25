/** Kimi YAML PPTD v2 — types used by native stack (subset + extensible). */

export type Color = string;

export type SolidFill = { type: "solid"; color: Color };
/** `alpha` is 0 to 1 and multiplies the alpha of `color` (#RRGGBBAA) when painted. */
export type GradientStop = { position: number; color: Color; alpha?: number };
export type GradientFill = {
  type: "gradient";
  gradientType: "linear" | "radial";
  stops: GradientStop[];
  angle?: number;
};
export type ImageFill = {
  type: "image";
  src: string;
  fit?: { mode: "fill" | "contain" | "cover" };
  opacity?: number;
  /** stretch (the default) draws the picture once across the shape; tile repeats it at natural size. */
  mode?: "stretch" | "tile";
  /** Fractions removed from the picture before it fills the shape. Same rules as an image crop. */
  crop?: ImageCrop;
};
export type Fill = SolidFill | GradientFill | ImageFill;

export type Bounds = [number, number, number, number]; // x,y,w,h

/**
 * Semantic placement used by layout QA. It does not affect drawing order or
 * document content, and remains optional for existing PPTD files.
 */
export type LayoutRole = "footer" | "content" | "decoration";

/** Editable shapes that jointly implement a requested non-chart exhibit. */
export type ExhibitRole = "funnel" | "gauge" | "pyramid" | "matrix" | "timeline" | "kpi-card" | "comparison-card";

export type TextContent = {
  text: string;
  style?: string;
  color?: Color;
  fontSize?: number;
  fontFamily?: string | { latin: string; ea: string };
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  backgroundColor?: Color;
  lineHeight?: number;
  letterSpacing?: number;
  align?: [string, string];
  wrap?: boolean;
  list?: "bullet" | "number";
  href?: string;
  /**
   * A field the text fills in at draw and export time. `pageNumber` replaces `{page}` (the
   * 1-based position) and `{pages}` (the page count). The stored text keeps the placeholder.
   */
  field?: "pageNumber";
};

/**
 * Blur and offsets are PPTD px. `opacity` (0 to 1) multiplies the colour's alpha. With no
 * colour the shadow is black at `opacity` (default 25 %). See effect-paint.ts for defaults.
 */
export type ElementShadow = {
  blur?: number;
  color?: Color;
  offsetX?: number;
  offsetY?: number;
  opacity?: number;
};

/** Native SmartArt is shapes + labels + connectors (no dual IR). */
export type SmartArtLayout = "process" | "cycle" | "hierarchy";
export type SmartArtRole = "node" | "label" | "connector";
export type SmartArtMeta = {
  id: string;
  layout: SmartArtLayout;
  role: SmartArtRole;
  index?: number;
};

export type ElementBase = {
  elementId: string;
  elementType: string;
  bounds: Bounds;
  rotation?: number;
  opacity?: number;
  flipH?: boolean;
  flipV?: boolean;
  locked?: boolean;
  hidden?: boolean;
  groupId?: string;
  shadow?: ElementShadow;
  /** Layout QA role. Text without a role is treated as content. */
  layoutRole?: LayoutRole;
  /** Visual-contract role. A label alone never satisfies a diagram role. */
  exhibitRole?: ExhibitRole;
  /** AC-07: diagram membership; nodes stay independently selectable. */
  smartArt?: SmartArtMeta & {
    /** User-moved node: relayout keeps its position and re-flows others. */
    pinned?: boolean;
  };
  /**
   * Set only on the read-only copies that `saveProject` writes from the page's master and layout
   * (see inheritance.ts). Such copies carry `mst-` or `lyt-` ids. Agents and editor commands never set it.
   */
  inherited?: InheritedFrom;
};

/** Where an inherited copy came from. */
export type InheritedFrom = {
  scope: "master" | "layout";
  ownerId: string;
  elementId: string;
};

export type TextElement = ElementBase & {
  elementType: "text";
  content: TextContent;
};

/** Free path in viewBox units: absolute M/L/C/Q/Z only (DECISIONS #30). */
export type PathGeometry = { viewBox: [number, number]; path: string };

export type ShapeElement = ElementBase & {
  elementType: "shape";
  /** An official catalog name, or "custom" together with `geometry`. */
  shapeName: string;
  geometry?: PathGeometry;
  fill?: Fill;
  border?: { style?: string; width?: number; color?: Color };
  adjustments?: number[];
};

export type ImageCrop = {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
};

/** A picture clip: an official catalogue preset, or "custom" together with the same geometry as a custom shape. */
export type ShapeDef = {
  shapeName: string;
  adjustments?: number[];
  geometry?: PathGeometry;
};

export type ImageElement = ElementBase & {
  elementType: "image";
  src: string;
  fit?: { mode: "fill" | "contain" | "cover" };
  crop?: ImageCrop;
  cropShape?: ShapeDef;
};

export type TableCell = {
  text?: string;
  bold?: boolean;
  color?: Color;
  fill?: Fill;
  align?: [string, string];
  rowSpan?: number;
  colSpan?: number;
};

export type TableElement = ElementBase & {
  elementType: "table";
  columnWidths: number[];
  rowHeights?: number[];
  rows: TableCell[][];
};

export type ChartData = {
  cols: string[];
  rows: (number | string | null)[][];
};

export type ChartSeries = {
  type: string;
  name?: string;
  encode?: Record<string, string>;
  fill?: string | GradientFill;
  /** Combination charts: bind this series to the right-side value axis. */
  axis?: "primary" | "secondary";
};

/**
 * How bar series share a category: side by side (`clustered`, the default when omitted),
 * stacked on one another, or stacked to 100 percent. Only `bar` charts may stack.
 */
export type ChartGrouping = "clustered" | "stacked" | "percentStacked";

export type ChartElement = ElementBase & {
  elementType: "chart";
  data: ChartData;
  series: ChartSeries[];
  /** Bar grouping; omitted means clustered. Old files never carry it, so they keep their bytes. */
  grouping?: ChartGrouping;
  /**
   * Explicit chart swatches. Pie charts map one color to each category;
   * other charts map one color to each series. This keeps canvas and PPTX
   * export off their built-in default palettes.
   */
  colors?: Color[];
  /** Optional opaque chart-area surface. Manual inserts set this so existing slide content does not show through. */
  background?: Fill;
  title?: string | { text: string };
  legend?: boolean | Record<string, unknown>;
  labels?: boolean;
  axis?: { x?: string; y?: string; secondaryY?: string };
};

export type IconElement = ElementBase & {
  elementType: "icon";
  iconName: string;
  fill?: Fill;
};

export type ArrowType = "arrow" | "stealth" | "diamond" | "oval";

export type LineElement = ElementBase & {
  elementType: "line";
  viewBox: [number, number];
  points: string;
  border?: { style?: string; width?: number; color?: Color };
  curve?: string;
  /** [start, end]; null = no marker (official PPTD). */
  arrow?: [ArrowType | null, ArrowType | null];
  /** Native SmartArt: keep this line attached to these element ids. */
  connects?: [string, string];
  /** AC-07: italic edge label (frame 14). */
  label?: string;
};

export type PptdElement =
  | TextElement
  | ShapeElement
  | ImageElement
  | TableElement
  | ChartElement
  | IconElement
  | LineElement
  | (ElementBase & Record<string, unknown>);

export type AnimationEffect =
  "appear" | "fade-in" | "fly-in" | "zoom-in" | "wipe-in" | "float-in" | "disappear" | "fade-out" | "none";

export type Animation = {
  elementId: string;
  effect: string;
  trigger?: "onClick" | "withPrevious" | "afterPrevious" | string;
  direction?: "up" | "down" | "left" | "right" | string;
  durationMs?: number;
  delayMs?: number;
};

export type Page = {
  pageType?: string;
  background?: Fill;
  notes?: string;
  elements: PptdElement[];
  animations?: Animation[];
  /** The layout this page uses. Omitted means no layout and no master chrome. */
  layoutId?: string;
  /** Written by materialisation: `background` came from the layout or master, not from this page. */
  backgroundInherited?: true;
};

/** Reference frame for a layout slot. It is never painted or exported. */
export type LayoutSlot = {
  role: "title" | "subtitle" | "body" | "chart" | "image" | "note";
  bounds: Bounds;
  style?: string;
};

/**
 * Deck master: the chrome every layout may inherit. This round a deck has at most one.
 * Elements are text, shape, image, line or icon only.
 */
export type DeckMaster = {
  /** Lowercase letter first, then lowercase letters, digits or hyphens, at most 32 characters. */
  id: string;
  name: string;
  background?: Fill;
  elements: PptdElement[];
};

/**
 * Deck layout: decorative chrome that pages choose by `layoutId`. Its elements are copied into
 * each using page on save. Charts, tables, SmartArt and animations are not allowed here.
 */
export type DeckLayout = {
  id: string;
  name: string;
  /** Omitted means the layout inherits no master elements. */
  masterId?: string;
  /** Defaults to true. `false` hides the master's elements on this layout. */
  showMasterElements?: boolean;
  /** Overrides the master background when set. */
  background?: Fill;
  elements: PptdElement[];
  slots?: LayoutSlot[];
  archetype?: string;
};

export type Theme = {
  colors?: Record<string, Color>;
  textStyles?: Record<string, Record<string, unknown>>;
  tableStyles?: Record<string, unknown>;
  /**
   * Set when the deck adopts an image or PDF palette. Tables and charts then
   * use neutral chrome (CCCCCC, D4D4D4, E5E5E5, 525252). Absent means the
   * legacy greys, so decks saved before the flag keep their exact output.
   */
  neutralChrome?: boolean;
};

export type Presentation = {
  version: "v2";
  title?: string;
  size: [number, number];
  theme?: Theme;
  pages: string[];
  customFonts?: { family: string; src: string }[];
  /** At most one master this round. Old decks omit the key and keep their bytes. */
  masters?: DeckMaster[];
  /** At most 12 layouts. */
  layouts?: DeckLayout[];
};

export type LoadedPage = {
  path: string;
  page: Page;
};

/** Fully loaded project in memory (still serializes to YAML PPTD files). */
export type PptdProject = {
  rootDir: string;
  manifestPath: string;
  presentation: Presentation;
  pages: LoadedPage[];
};
