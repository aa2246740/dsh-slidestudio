import type { Animation, Bounds } from "@open-slidestudio/pptd-v2";

export type SnapResult = {
  guides: { axis: "x" | "y"; pos: number; kind: "edge" | "center" }[];
  snap: Bounds;
};

declare global {
  function computeSnapGuides(moving: unknown, others?: unknown, threshold?: unknown, pageSize?: unknown): SnapResult;
  function animationGroups(anims?: unknown): Animation[][];
  function staggerDelays(anims?: unknown, stepMs?: unknown): (Animation & { delayMs: number; durationMs: number })[];
  function isDarkCss(css: unknown): boolean;
}
