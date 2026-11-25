/** Element-relative px to slide inches: `px` of `slidePx` pixels spans `slideIn` inches. */
export function pxToIn(px: number, slidePx: number, slideIn: number): number {
  return (px / slidePx) * slideIn;
}
