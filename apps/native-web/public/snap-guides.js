/**
 *  Selection snap / animation grouping used by the native editor. Loaded by the editor (script tag) and by unit tests — keep this the only place that decides guide positions and trigger groups.
 */
(function (root) {
  /** @import { SnapResult } from "./snap-guides.types.js" */
  /** @import { Bounds, Animation as NativeAnimation } from "@open-slidestudio/pptd-v2" */
  /** @typedef {{dist: number, delta: number, pos: number | null, kind: "edge" | "center"}} SnapChoice */
  /** @param {unknown} value @returns {value is Bounds} */
  function isBounds(value) {
    return (
      Array.isArray(value) &&
      value.length === 4 &&
      value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
      value[2] >= 0 &&
      value[3] >= 0 &&
      Number.isFinite(value[0] + value[2]) &&
      Number.isFinite(value[1] + value[3])
    );
  }

  /** @param {Bounds} b */
  function edges(b) {
    const [x, y, w, h] = b;
    return {
      left: x,
      right: x + w,
      cx: x + w / 2,
      top: y,
      bottom: y + h,
      cy: y + h / 2,
    };
  }

  /** @param {unknown} moving @param {unknown} [others] @param {unknown} [threshold]
   * @param {unknown} [pageSize] @returns {SnapResult} */
  function computeSnapGuides(moving, others, threshold = 6, pageSize) {
    if (!isBounds(moving)) throw new Error("Snap requires finite nonnegative-size bounds");
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
      throw new Error("Snap tolerance must be finite and nonnegative");
    }
    const tol = threshold;
    const refs = Array.isArray(others) ? others.filter(isBounds) : [];
    if (Array.isArray(pageSize) && pageSize.length === 2) {
      const page = [0, 0, ...pageSize];
      if (isBounds(page) && page[2] > 0 && page[3] > 0) refs.unshift(page);
    }
    const m = edges(moving);
    /** @type {SnapChoice} */
    let bestX = { dist: tol + 1, delta: 0, pos: null, kind: "edge" };
    /** @type {SnapChoice} */
    let bestY = { dist: tol + 1, delta: 0, pos: null, kind: "edge" };

    /** @param {number} from @param {number} to @param {"edge" | "center"} kind */
    const considerX = (from, to, kind) => {
      const dist = Math.abs(from - to);
      if (dist <= tol && dist < bestX.dist) bestX = { dist, delta: to - from, pos: to, kind };
    };
    /** @param {number} from @param {number} to @param {"edge" | "center"} kind */
    const considerY = (from, to, kind) => {
      const dist = Math.abs(from - to);
      if (dist <= tol && dist < bestY.dist) bestY = { dist, delta: to - from, pos: to, kind };
    };

    for (const o of refs) {
      const e = edges(o);
      considerX(m.left, e.left, "edge");
      considerX(m.left, e.cx, "center");
      considerX(m.left, e.right, "edge");
      considerX(m.cx, e.left, "center");
      considerX(m.cx, e.cx, "center");
      considerX(m.cx, e.right, "center");
      considerX(m.right, e.left, "edge");
      considerX(m.right, e.cx, "center");
      considerX(m.right, e.right, "edge");
      considerY(m.top, e.top, "edge");
      considerY(m.top, e.cy, "center");
      considerY(m.top, e.bottom, "edge");
      considerY(m.cy, e.top, "center");
      considerY(m.cy, e.cy, "center");
      considerY(m.cy, e.bottom, "center");
      considerY(m.bottom, e.top, "edge");
      considerY(m.bottom, e.cy, "center");
      considerY(m.bottom, e.bottom, "edge");
    }

    /** @type {SnapResult["guides"]} */
    const guides = [];
    let dx = 0;
    let dy = 0;
    if (bestX.pos != null) {
      dx = bestX.delta;
      guides.push({ axis: "x", pos: bestX.pos, kind: bestX.kind });
    }
    if (bestY.pos != null) {
      dy = bestY.delta;
      guides.push({ axis: "y", pos: bestY.pos, kind: bestY.kind });
    }
    return {
      guides,
      snap: [moving[0] + dx, moving[1] + dy, moving[2], moving[3]],
    };
  }

  /** @param {unknown} value */
  function validTime(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  }

  /** @param {unknown} value @returns {value is NativeAnimation} */
  function isAnimation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = /** @type {Record<string, unknown>} */ (value);
    return (
      Object.hasOwn(item, "elementId") &&
      typeof item.elementId === "string" &&
      item.elementId.trim().length > 0 &&
      Object.hasOwn(item, "effect") &&
      typeof item.effect === "string" &&
      item.effect.trim().length > 0 &&
      (item.trigger === undefined || typeof item.trigger === "string") &&
      (item.direction === undefined || typeof item.direction === "string") &&
      (item.durationMs === undefined || validTime(item.durationMs)) &&
      (item.delayMs === undefined || validTime(item.delayMs))
    );
  }

  /** @param {unknown} anims @returns {NativeAnimation[]} */
  function readAnimations(anims) {
    return Array.isArray(anims) ? anims.filter(isAnimation) : [];
  }

  /** @param {unknown} [anims] */
  function animationGroups(anims) {
    /** @type {NativeAnimation[][]} */
    const groups = [];
    for (const a of readAnimations(anims)) {
      if (a.effect === "none") continue;
      const previous = groups.at(-1);
      if ((a.trigger === "withPrevious" || a.trigger === "with-previous") && previous) {
        previous.push(a);
      } else {
        groups.push([a]);
      }
    }
    return groups;
  }

  /** @param {unknown} [anims] @param {unknown} [stepMs] */
  function staggerDelays(anims, stepMs = 70) {
    if (!validTime(stepMs)) throw new Error("Animation stagger must be finite and nonnegative");
    const step = /** @type {number} */ (stepMs);
    const list = readAnimations(anims);
    const groups = animationGroups(list);
    /** @type {Map<NativeAnimation, number>} */
    const delayOf = new Map();
    let cursor = 0;
    for (const g of groups) {
      const first = g[0];
      const last = g.at(-1);
      if (!first || !last) continue;
      const base =
        first.trigger === "afterPrevious" || first.trigger === "after-previous" ? cursor : (first.delayMs ?? cursor);
      g.forEach((a, i) => {
        delayOf.set(a, base + i * step);
      });
      cursor = (delayOf.get(last) ?? 0) + (last.durationMs ?? 400);
    }
    return list.map((a) => ({
      ...a,
      delayMs: delayOf.get(a) ?? a.delayMs ?? 0,
      durationMs: a.durationMs ?? 400,
    }));
  }

  /** @param {unknown} css */
  function isDarkCss(css) {
    if (typeof css !== "string") return false;
    let h = css.match(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![a-z0-9])/i)?.[1];
    if (!h) {
      const start = /rgba?\(/i.exec(css);
      if (!start) return false;
      const contentStart = start.index + start[0].length;
      const end = css.indexOf(")", contentStart);
      if (end < 0) return false;
      const parts = css
        .slice(contentStart, end)
        .split(",")
        .map((part) => part.trim());
      if (parts.length < 3 || parts.length > 4 || !parts.slice(0, 3).every((part) => /^\d+$/.test(part))) return false;
      if (parts[3] !== undefined && !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(parts[3])) return false;
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      if ([r, g, b].some((channel) => !Number.isFinite(channel) || channel > 255)) return false;
      return (r * 299 + g * 587 + b * 114) / 1000 < 140;
    }
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 < 140;
  }

  root.computeSnapGuides = computeSnapGuides;
  root.animationGroups = animationGroups;
  root.staggerDelays = staggerDelays;
  root.isDarkCss = isDarkCss;
})(typeof globalThis !== "undefined" ? globalThis : window);
