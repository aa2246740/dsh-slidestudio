/**
 * @open-slidestudio/pptd-v2
 *
 * Kimi YAML PPTD v2 — sole document SSOT for native offline stack.
 */

export type * from "./types.js";
export { normalizeSourceFonts, type SourceFontMapping } from "./source-fonts.js";
export {
  WRITE_PAGE_PARAMETER_SPEC,
  PPTD_ELEMENT_PARAMETER_SPEC,
  EDIT_ELEMENTS_PARAMETER_SPEC,
  writePageJsonSchema,
  editElementsJsonSchema,
  canonicalWritePageIssues,
  canonicalEditElementsIssues,
  canonicalFillIssues,
  canonicalShadowIssues,
  canonicalTextStylePatchIssues,
  isCanonicalWritePageArgs,
  isCanonicalEditElementsArgs,
  coerceLineArrowHead,
  normalizeWritePageLineArrows,
  normalizeWritePageDialect,
  type CanonicalWritePageArgs,
  type CanonicalEditElementsArgs,
} from "./write-page-schema.js";
export { WRITE_LAYOUT_PARAMETER_SPEC, writeLayoutJsonSchema } from "./write-layout-schema.js";
export {
  COMPONENT_ELEMENT,
  isComponentReference,
  writePageProviderJsonSchema,
  type ComponentReference,
} from "./component-element-schema.js";
export {
  PROVENANCE_PROPERTY,
  canonicalProvenanceIssues,
  parseProvenanceDeclaration,
  type ProvenanceBasis,
  type ProvenanceDeclaration,
  type ProvenanceMaterialRef,
  type ProvenanceQuotedValue,
} from "./write-page-provenance.js";
export {
  categoricalChartModel,
  chartGrouping,
  chartKind,
  chartSurfaceColor,
  isDarkChartSurface,
  placeScatterLabels,
  scatterChartModel,
  waterfallChartModel,
  type ChartSurfaceBounds,
  type ChartSurfaceCandidate,
  type ChartSurfaceInput,
  type CategoricalChartModel,
  type CategoricalChartSeries,
  type CategoricalKind,
  type ScatterChartModel,
  type ScatterLabelPlacement,
  type ScatterLabelPoint,
  type ScatterPoint,
  type SupportedChartKind,
  type WaterfallBar,
  type WaterfallChartModel,
} from "./chart-semantics.js";
export { chartKindIssues } from "./chart-kind-rules.js";
export {
  CHART_GRID,
  CHART_GRID_NEUTRAL,
  CHART_INK,
  CHART_INK_NEUTRAL,
  CHART_PALETTE,
  CHART_TEXT_PX,
  alignedSecondaryScale,
  chartChrome,
  chartLayout,
  chartNumberFormatCode,
  chartSwatch,
  chartZeroHiddenFormatCode,
  formatChartValue,
  measureChartText,
  niceScale,
  percentText,
  resolveChartLegend,
  seriesDecimals,
  widestTickText,
  type ChartChrome,
  type ChartLayout,
  type ChartLayoutOptions,
  type ChartScale,
  type LegendLayout,
  type LegendPosition,
  type LegendSpec,
  type Point,
  type Rect,
} from "./chart-layout.js";
export {
  DEFAULT_TEXT_LINE_HEIGHT,
  TEXT_LAYOUT_CONTRACT_V1,
  effectiveLayoutRole,
  footerZoneTopForSlide,
  type TextLayoutContractV1,
} from "./text-layout.js";
export {
  loadProject,
  saveProject,
  withProjectWriteLock,
  createEmptyProject,
  titleOnlyCoverPage,
  listComposedPage,
  calculateMaterialFingerprint,
  PptdError,
} from "./parse.js";
export {
  inheritedBackground,
  materializeInheritance,
  ownPageBody,
  chromeSha256,
  setOwnPageBackground,
} from "./inheritance.js";
export {
  LAYOUT_ID_PATTERN,
  MAX_LAYOUT_ELEMENTS,
  MAX_LAYOUTS,
  assertLayoutSchema,
  assertPageOwnership,
  layoutReferenceIssues,
  layoutSchemaIssues,
  pageOwnershipIssues,
  type LayoutIssue,
  type LayoutIssueCode,
} from "./layout-schema.js";
export { layoutDuplicateIssues } from "./layout-duplicates.js";
export {
  SHAPE_ALIASES,
  SHAPE_CATALOG,
  SHAPE_BY_NAME,
  SUPPORTED_SHAPE_NAMES,
  canonicalShapeName,
  isSupportedShapeName,
  shapeDefaults,
  type ShapeInfo,
} from "./shape-catalog.js";
export { shapePath, shapeSvg, shapeGeometry, adjUnit } from "./shape-path.js";
export { DEFAULT_BORDER_WIDTH_PX, drawnBorderWidth } from "./border-units.js";
export {
  CUSTOM_PATH_MAX_BYTES,
  CUSTOM_PATH_MAX_SEGMENTS,
  CUSTOM_SHAPE_NAME,
  customGeometryIssues,
  isCustomShape,
  parseCustomPath,
  resolveCustomGeometry,
  type CustomPathCommand,
  type CustomPathSegment,
  type ParsedCustomPath,
  type ResolvedCustomGeometry,
} from "./custom-geometry.js";
export { findPageBackdrop, isPlainRectShape } from "./page-backdrop.js";
export { PICTURE_SURFACE_COLOR, pageSurface, type PageSurface } from "./page-surface.js";
export { opaqueSolidHex, solidFillColor } from "./solid-fill.js";
export { colorRefusal, themeColorRefusals } from "./color-refusal.js";
export {
  readableColor,
  sanitizeDeckColors,
  sanitizeProjectColors,
  type ColorFallback,
  type SanitizedDeckColors,
} from "./color-fallback.js";
export { fillPageNumberTokens, PAGE_COUNT_TOKEN, PAGE_NUMBER_TOKEN } from "./page-number-field.js";
export { TABLE_BODY_FILL, TABLE_HEADER_FILL, tableCellSolidHex, tableCellTextHex } from "./table-cell-color.js";
export { cropIssue, imageClipIssues } from "./image-clip.js";
export { effectIssues, fillEffectIssues, shadowIssues } from "./effect-issues.js";
export {
  SHADOW_DEFAULTS,
  paintColor,
  paintCss,
  resolveElementShadow,
  type PaintColor,
  type ResolvedElementShadow,
} from "./effect-paint.js";
export { probeImageSize } from "./image-size.js";
export { UNSTYLED_LINE_COLOR, UNSTYLED_LINE_WIDTH, resolvedLineBorder, unstyledLineColor } from "./line-border.js";
export {
  ooxmlShapePath,
  ooxmlPresetNames,
  ooxmlShapeGeometry,
  ooxmlAdjustHandles,
  type AdjustHandle,
  type ShapeGeometry,
} from "./ooxml-geom.js";
export {
  ooxmlCustomGeometry,
  type OoxmlCustomGeometry,
  type OoxmlCustomPath,
  type OoxmlGuide,
} from "./ooxml-custom-geom.js";
export {
  CHART_FONT_FACE,
  DEFAULT_FONT_PAIR,
  SLIDE_FONTS,
  canonicalFontName,
  defaultThemeTextStyles,
  fontCss,
  fontEntry,
  isSlideFont,
  normalizeFontFamily,
  normalizePageFonts,
  resolveFontPair,
  type FontEntry,
  type FontPair,
  type FontReplacement,
  type FontScript,
} from "./font-policy.js";
export {
  resolveThemeColor,
  officialPptdColorKind,
  InvalidPptdColorError,
  toRgbHex,
  colorAlpha,
  relativeLuminance,
  contrastRatio,
  shapePaintFill,
  elementFillPaint,
  solidFillPaint,
  svgFillFromFillCss,
  stripHtmlToText,
  parseRichText,
  serializeRichText,
  applyRangeStyle,
  toCssColor,
  unescapePlainText,
  resolveTextStyle,
  type ResolvedTextStyle,
  type RichTextRun,
  type RangeStylePatch,
  type OfficialPptdColorKind,
  type ShapePaintFill,
  type ElementFillPaint,
} from "./theme.js";
