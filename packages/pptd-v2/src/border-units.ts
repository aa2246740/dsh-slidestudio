/**
 * Units of `border.width` (ruling 112). The width is PPTD px for every element kind (preset
 * shape, custom shape and line), like x, y and shadow lengths. The export slide is 10 inches
 * wide, so 1 px = 9 525 EMU = 0.75 pt, and every exported `a:ln w` is the px width × 9 525.
 */

/** Width in px of a bordered shape or line that has a colour but no width. */
export const DEFAULT_BORDER_WIDTH_PX = 1;

/**
 * The width a border is drawn at, in px: the stored width, the default when only a colour is
 * stored, and 0 without a colour. An explicit 0 stays 0. The canvas, the export and layout QA
 * read the same rule through this function.
 */
export function drawnBorderWidth(border: { color?: string; width?: number } | undefined): number {
  return border?.width ?? (border?.color ? DEFAULT_BORDER_WIDTH_PX : 0);
}
