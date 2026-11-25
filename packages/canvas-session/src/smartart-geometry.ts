import type { Bounds, SmartArtLayout } from "@open-slidestudio/pptd-v2";

/** Default node labels for a new SmartArt diagram, by layout. */
export function defaultSmartArtLabels(layout: SmartArtLayout): string[] {
  if (layout === "cycle") return ["发现", "验证", "迭代", "发布"];
  if (layout === "hierarchy") return ["目标", "路径 A", "路径 B", "路径 C"];
  return ["输入", "处理", "输出"];
}

export function nodePositions(layout: SmartArtLayout, count: number, origin: [number, number]): Bounds[] {
  const [ox, oy] = origin;
  const w = 168;
  const h = 72;
  if (layout === "cycle") {
    const cx = ox + 220;
    const cy = oy + 160;
    const r = 150;
    return Array.from({ length: count }, (_, i) => {
      const a = (Math.PI * 2 * i) / count - Math.PI / 2;
      return [cx + Math.cos(a) * r - w / 2, cy + Math.sin(a) * r - h / 2, w, h] as Bounds;
    });
  }
  if (layout === "hierarchy") {
    const out: Bounds[] = [[ox + 180, oy, w, h]];
    const child = Math.max(1, count - 1);
    const gap = 28;
    const total = child * w + Math.max(0, child - 1) * gap;
    const start = ox + 220 - total / 2;
    for (let i = 0; i < child; i++) {
      out.push([start + i * (w + gap), oy + 140, w, h]);
    }
    return out.slice(0, count);
  }
  const gap = 56;
  return Array.from({ length: count }, (_, i) => [ox + i * (w + gap), oy, w, h] as Bounds);
}

export function connectorPairs(layout: SmartArtLayout, count: number): [number, number][] {
  if (count < 2) return [];
  if (layout === "cycle") {
    return Array.from({ length: count }, (_, i) => [i, (i + 1) % count] as [number, number]);
  }
  if (layout === "hierarchy") {
    return Array.from({ length: count - 1 }, (_, i) => [0, i + 1] as [number, number]);
  }
  return Array.from({ length: count - 1 }, (_, i) => [i, i + 1] as [number, number]);
}
