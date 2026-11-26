/**
 * Element shadow for the editor render model. One validated value and one CSS colour, so the
 * canvas, the native-web paint and the exporter draw the same blur, offsets and alpha.
 */
import {
  canonicalShadowIssues,
  paintCss,
  resolveElementShadow,
  type ElementShadow,
  type Theme,
} from "@open-slidestudio/pptd-v2";

/** A shadow as the editor draws it: PPTD px for blur and offsets, CSS colour with its alpha. */
export type RenderShadow = { blur: number; offsetX: number; offsetY: number; color: string };

/** Throws the Chinese refusal for a negative blur or an opacity outside 0 to 1. */
export function assertShadowValid(shadow: unknown): void {
  const issues = canonicalShadowIssues(shadow);
  if (issues.length) throw new Error(issues.join("；"));
}

/** The shadow the editor draws, with the editor defaults filled in; undefined without a shadow. */
export function renderShadow(shadow: ElementShadow | undefined, theme?: Theme): RenderShadow | undefined {
  const resolved = resolveElementShadow(shadow, theme);
  if (!resolved) return undefined;
  return {
    blur: resolved.blur,
    offsetX: resolved.offsetX,
    offsetY: resolved.offsetY,
    color: paintCss(resolved.paint),
  };
}
