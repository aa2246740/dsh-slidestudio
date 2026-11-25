/** OOXML adj units: 0–100000 → 0–1. */
export function adjUnit(v: number | undefined, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return n / 100000;
}

export function pick(adj: number[] | undefined, i: number, fallback: number): number {
  const v = adj?.[i];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function poly(pts: [number, number][]): string {
  return pts.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`).join(" ") + " Z";
}

export function star(n: number, inner: number): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? 48 : 48 * inner;
    pts.push([50 + Math.cos(a) * r, 50 + Math.sin(a) * r]);
  }
  return poly(pts);
}

export function ngon(n: number): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push([50 + Math.cos(a) * 46, 50 + Math.sin(a) * 46]);
  }
  return poly(pts);
}
