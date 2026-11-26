/** Width in PPTD px of a bordered shape or line that has a colour but no stored width. */
export type BorderWidth = number;

declare global {
  // border-width.js sets this on globalThis before the editor module runs.
  var DEFAULT_BORDER_WIDTH_PX: BorderWidth;
}
