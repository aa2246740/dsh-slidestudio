/**
 * Custom geometry (`a:custGeom`) evaluation on top of the preset interpreter's guide
 * formulas: guide lists are evaluated in order, arcTo becomes cubic Béziers, and the result is
 * one absolute M/L/C/Q/Z path that a PPTD `custom` shape can store.
 */
import { deg, evalFmla, seedGuides, type Guides, type PathCmd } from "./ooxml-geom.js";

export type OoxmlGuide = { name: string; fmla: string };
/** A custGeom read into plain data: operands stay strings (guide names or literals). */
export type OoxmlCustomGeometry = {
  avLst?: OoxmlGuide[];
  gdLst?: OoxmlGuide[];
  paths: { w: number; h: number; fill?: string; cmds: PathCmd[] }[];
};
export type OoxmlCustomPath = { viewBox: [number, number]; path: string } | { issue: string };

const FORMULA_OPS = new Set([
  "val",
  "*/",
  "+-",
  "+/",
  "?:",
  "abs",
  "at2",
  "cat2",
  "sat2",
  "cos",
  "sin",
  "tan",
  "sqrt",
  "max",
  "min",
  "mod",
  "pin",
]);
// Shapes converted from vector graphics carry one scaling guide per coordinate (hundreds).
const CUSTOM_MAX_GUIDES = 4096;
const CUSTOM_MAX_COMMANDS = 1024;
const NUMBER_TOKEN = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** Unlike the preset reader, an unknown operator or operand is an error, not 0. */
function strictOperand(tok: string, g: Guides): number | undefined {
  if (Object.hasOwn(g, tok)) return g[tok];
  return NUMBER_TOKEN.test(tok) ? Number(tok) : undefined;
}

function strictFormula(fmla: string, g: Guides): number | undefined {
  const parts = fmla.trim().split(/\s+/);
  if (!FORMULA_OPS.has(parts[0] ?? "")) return undefined;
  const operands = parts.slice(1);
  if (operands.length > 3 || operands.some((tok) => strictOperand(tok, g) === undefined)) {
    return undefined;
  }
  const value = evalFmla(fmla, g);
  return Number.isFinite(value) ? value : undefined;
}

type ArcPoints = { cubics: number[][]; x: number; y: number };

/**
 * arcTo angles are visual (the ray from the centre), as the preset definitions assume when they
 * compute arc ends with at2/cat2/sat2; the point on the ellipse sits at the matching
 * parametric angle. The arc becomes cubics of at most a quarter turn each.
 */
function arcToCubics(x0: number, y0: number, wr: number, hr: number, stAng: number, swAng: number): ArcPoints {
  const st = (deg(stAng) * Math.PI) / 180;
  const sw = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, (deg(swAng) * Math.PI) / 180));
  if (!(wr > 0) || !(hr > 0) || sw === 0) return { cubics: [], x: x0, y: y0 };
  const t0 = Math.atan2(wr * Math.sin(st), hr * Math.cos(st));
  const end = st + sw;
  let dt = Math.atan2(wr * Math.sin(end), hr * Math.cos(end)) - t0;
  dt += Math.round((sw - dt) / (2 * Math.PI)) * 2 * Math.PI;
  const cx = x0 - wr * Math.cos(t0);
  const cy = y0 - hr * Math.sin(t0);
  const count = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / count;
  const k = (4 / 3) * Math.tan(step / 4);
  const cubics: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    const a = t0 + i * step;
    const b = a + step;
    const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)] as const;
    cubics.push([
      cx + wr * (ca - k * sa),
      cy + hr * (sa + k * ca),
      cx + wr * (cb + k * sb),
      cy + hr * (sb - k * cb),
      cx + wr * cb,
      cy + hr * sb,
    ]);
  }
  const last = cubics[cubics.length - 1]!;
  return { cubics, x: last[4]!, y: last[5]! };
}

const trim = (n: number): string => String(Math.round(n * 1e4) / 1e4 || 0);

type PathCursor = { x: number; y: number; startX: number; startY: number; commands: number };

function commandOperands(cmd: PathCmd, at: (tok: string) => number | undefined): Array<number | undefined> {
  if (cmd.k === "A") return [at(cmd.wr), at(cmd.hr), at(cmd.st), at(cmd.sw)];
  if (cmd.k === "C") return [at(cmd.x1), at(cmd.y1), at(cmd.x2), at(cmd.y2), at(cmd.x), at(cmd.y)];
  if (cmd.k === "Q") return [at(cmd.x1), at(cmd.y1), at(cmd.x), at(cmd.y)];
  if (cmd.k === "Z") return [];
  return [at(cmd.x), at(cmd.y)];
}

function appendCustomCommand(
  cmd: PathCmd,
  cursor: PathCursor,
  out: string[],
  point: (x: number, y: number) => string,
  at: (tok: string) => number | undefined,
): string | undefined {
  cursor.commands += 1;
  if (cursor.commands > CUSTOM_MAX_COMMANDS) return "自定义形状的路径段过多";
  if (cmd.k === "Z") {
    out.push("Z");
    cursor.x = cursor.startX;
    cursor.y = cursor.startY;
    return undefined;
  }
  const raw = commandOperands(cmd, at);
  if (raw.some((n) => n === undefined || !Number.isFinite(n))) {
    return "自定义形状的路径坐标无法求值";
  }
  const n = raw as number[];
  if (cmd.k === "A") {
    const arc = arcToCubics(cursor.x, cursor.y, n[0]!, n[1]!, n[2]!, n[3]!);
    for (const c of arc.cubics) {
      out.push(`C ${point(c[0]!, c[1]!)} ${point(c[2]!, c[3]!)} ${point(c[4]!, c[5]!)}`);
    }
    cursor.x = arc.x;
    cursor.y = arc.y;
    return undefined;
  }
  const pairs = [];
  for (let i = 0; i < n.length; i += 2) pairs.push(point(n[i]!, n[i + 1]!));
  out.push(`${cmd.k} ${pairs.join(" ")}`);
  cursor.x = n[n.length - 2]!;
  cursor.y = n[n.length - 1]!;
  if (cmd.k === "M") {
    cursor.startX = cursor.x;
    cursor.startY = cursor.y;
  }
  return undefined;
}

/**
 * Evaluate a custGeom (guide formulas and arcTo included) into one absolute M/L/C/Q/Z path in
 * the first drawn path's coordinate space. `extent` is the shape size in EMU; it supplies the
 * space only when a path declares no w/h. Any unresolved guide, non-finite number or empty
 * path returns an issue.
 */
export function ooxmlCustomGeometry(extent: { w: number; h: number }, geometry: OoxmlCustomGeometry): OoxmlCustomPath {
  const guides = [...(geometry.avLst ?? []), ...(geometry.gdLst ?? [])];
  if (guides.length > CUSTOM_MAX_GUIDES) return { issue: "自定义形状的计算公式过多" };
  const drawn = geometry.paths.filter((p) => p.fill !== "none");
  const paths = drawn.length ? drawn : geometry.paths.slice(0, 1);
  const first = paths[0];
  if (!first) return { issue: "自定义形状没有路径" };
  const viewW = first.w > 0 ? first.w : extent.w;
  const viewH = first.h > 0 ? first.h : extent.h;
  if (!(viewW > 0) || !(viewH > 0)) return { issue: "自定义形状的路径尺寸无效" };
  // Guides share the drawn path's coordinate space, as the preset interpreter does.
  const g = seedGuides(viewW, viewH);
  for (const guide of guides) {
    const value = strictFormula(guide.fmla, g);
    if (value === undefined) return { issue: `计算公式 ${guide.name} 无法求值` };
    g[guide.name] = value;
  }
  const out: string[] = [];
  const cursor = { x: 0, y: 0, startX: 0, startY: 0, commands: 0 };
  for (const part of paths) {
    const sx = viewW / (part.w > 0 ? part.w : extent.w);
    const sy = viewH / (part.h > 0 ? part.h : extent.h);
    const point = (x: number, y: number) => `${trim(x * sx)} ${trim(y * sy)}`;
    const at = (tok: string): number | undefined => strictOperand(tok, g);
    cursor.x = 0;
    cursor.y = 0;
    cursor.startX = 0;
    cursor.startY = 0;
    for (const cmd of part.cmds) {
      const issue = appendCustomCommand(cmd, cursor, out, point, at);
      if (issue) return { issue };
    }
  }
  if (!out.length || !out[0]!.startsWith("M ")) return { issue: "自定义形状的路径必须以起点开始" };
  return { viewBox: [viewW, viewH], path: out.join(" ") };
}
