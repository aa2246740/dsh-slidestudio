/**
 * ECMA-376 DrawingML preset geometry interpreter.
 * Source XML: LibreOffice copy of presetShapeDefinitions.xml (public OOXML).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const XML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/data/presetShapeDefinitions.xml",
);

type Guides = Record<string, number>;

type PathCmd =
  | { k: "M" | "L"; x: string; y: string }
  | { k: "C"; x1: string; y1: string; x2: string; y2: string; x: string; y: string }
  | { k: "Q"; x1: string; y1: string; x: string; y: string }
  | { k: "A"; wr: string; hr: string; st: string; sw: string }
  | { k: "Z" };

type ParsedPath = {
  w: number;
  h: number;
  cmds: PathCmd[];
  fill?: string;
  stroke?: string;
};

type AhDef = {
  kind: "xy" | "polar";
  gdRefX?: string;
  gdRefY?: string;
  gdRefAng?: string;
  minX?: string;
  maxX?: string;
  minY?: string;
  maxY?: string;
  minAng?: string;
  maxAng?: string;
  posX: string;
  posY: string;
};

type ParsedShape = {
  name: string;
  av: Guides;
  gds: { name: string; fmla: string }[];
  paths: ParsedPath[];
  ahs: AhDef[];
};

export type AdjustHandle = {
  kind: "xy" | "polar";
  /** Position in viewBox 0–100. */
  x: number;
  y: number;
  adjIndexX?: number;
  adjIndexY?: number;
  adjIndexAng?: number;
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  minAng?: number;
  maxAng?: number;
};

export type ShapeGeometry = {
  fill: string;
  stroke: string;
  handles: AdjustHandle[];
};

const cache = new Map<string, ParsedShape>();
let loaded = false;

function loadXml(): void {
  if (loaded) return;
  loaded = true;
  const xml = fs.readFileSync(XML_PATH, "utf8");
  const re = /^ {2}<([A-Za-z0-9]+)>\r?\n([\s\S]*?)^ {2}<\/\1>/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    cache.set(m[1]!, parseBlock(m[1]!, m[2]!));
  }
}

function gdsFrom(block: string, tag: string): { name: string; fmla: string }[] {
  const inner = block.match(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`))?.[0] ?? "";
  return [...inner.matchAll(/<gd name="([^"]+)" fmla="([^"]+)"/g)].map((x) => ({
    name: x[1]!,
    fmla: x[2]!,
  }));
}

function parseAhLst(body: string): AhDef[] {
  const inner = body.match(/<ahLst[\s\S]*?<\/ahLst>/)?.[0] ?? "";
  const out: AhDef[] = [];
  const re = /<(ahXY|ahPolar)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    const kind = m[1] === "ahPolar" ? "polar" : "xy";
    const attrs = m[2] ?? "";
    const pos = /<pos x="([^"]+)" y="([^"]+)"/.exec(m[3] ?? "");
    out.push({
      kind,
      gdRefX: attr(attrs, "gdRefX") || undefined,
      gdRefY: attr(attrs, "gdRefY") || undefined,
      gdRefAng: attr(attrs, "gdRefAng") || undefined,
      minX: attr(attrs, "minX") || undefined,
      maxX: attr(attrs, "maxX") || undefined,
      minY: attr(attrs, "minY") || undefined,
      maxY: attr(attrs, "maxY") || undefined,
      minAng: attr(attrs, "minAng") || undefined,
      maxAng: attr(attrs, "maxAng") || undefined,
      posX: pos?.[1] ?? "hc",
      posY: pos?.[2] ?? "vc",
    });
  }
  return out;
}

function parseBlock(name: string, body: string): ParsedShape {
  const av: Guides = {};
  for (const g of gdsFrom(body, "avLst")) {
    const n = Number(g.fmla.replace(/^val\s+/, ""));
    if (Number.isFinite(n)) av[g.name] = n;
  }
  const paths: ParsedPath[] = [];
  for (const pm of body.matchAll(/<path\b([^>]*)>([\s\S]*?)<\/path>/g)) {
    const attrs = pm[1] ?? "";
    const w = Number(/w="(\d+)"/.exec(attrs)?.[1] ?? 21600);
    const h = Number(/h="(\d+)"/.exec(attrs)?.[1] ?? 21600);
    const fill = /fill="([^"]+)"/.exec(attrs)?.[1];
    const stroke = /stroke="([^"]+)"/.exec(attrs)?.[1];
    const cmds: PathCmd[] = [];
    const inner = pm[2] ?? "";
    const tok =
      /<(moveTo|lnTo|cubicBezTo|quadBezTo|arcTo|close)(\s[^>]*)?>([\s\S]*?)<\/\1>|<(arcTo|close)(\s[^>]*)?\/>/g;
    let t: RegExpExecArray | null;
    while ((t = tok.exec(inner))) {
      const kind = t[1] || t[4];
      const pts = [...(t[3] ?? "").matchAll(/<pt x="([^"]+)" y="([^"]+)"/g)].map((p) => [
        p[1]!,
        p[2]!,
      ]);
      if (kind === "moveTo" && pts[0]) cmds.push({ k: "M", ...ref(pts[0]) });
      else if (kind === "lnTo" && pts[0]) cmds.push({ k: "L", ...ref(pts[0]) });
      else if (kind === "cubicBezTo" && pts.length >= 3) cmds.push({ k: "C", ...cubic(pts) });
      else if (kind === "quadBezTo" && pts.length >= 2) cmds.push({ k: "Q", ...quad(pts) });
      else if (kind === "arcTo") {
        const a = `${t[2] ?? ""} ${t[5] ?? ""}`;
        cmds.push({
          k: "A",
          wr: attr(a, "wR"),
          hr: attr(a, "hR"),
          st: attr(a, "stAng"),
          sw: attr(a, "swAng"),
        });
      } else if (kind === "close") cmds.push({ k: "Z" });
    }
    paths.push({ w, h, cmds, fill, stroke });
  }
  return { name, av, gds: gdsFrom(body, "gdLst"), paths, ahs: parseAhLst(body) };
}

function attr(s: string, n: string): string {
  return new RegExp(`${n}="([^"]+)"`).exec(s)?.[1] ?? "0";
}
function ref(p: string[]): { x: string; y: string } {
  return { x: p[0]!, y: p[1]! };
}
function cubic(pts: string[][]) {
  return {
    x1: pts[0]![0]!,
    y1: pts[0]![1]!,
    x2: pts[1]![0]!,
    y2: pts[1]![1]!,
    x: pts[2]![0]!,
    y: pts[2]![1]!,
  };
}
function quad(pts: string[][]) {
  return { x1: pts[0]![0]!, y1: pts[0]![1]!, x: pts[1]![0]!, y: pts[1]![1]! };
}

function seedGuides(w: number, h: number): Guides {
  const ss = Math.min(w, h);
  const ls = Math.max(w, h);
  return {
    w,
    h,
    l: 0,
    t: 0,
    r: w,
    b: h,
    hc: w / 2,
    vc: h / 2,
    hd2: h / 2,
    hd4: h / 4,
    hd5: h / 5,
    hd6: h / 6,
    hd8: h / 8,
    wd2: w / 2,
    wd4: w / 4,
    wd5: w / 5,
    wd6: w / 6,
    wd8: w / 8,
    wd10: w / 10,
    ss,
    ls,
    ssd2: ss / 2,
    ssd4: ss / 4,
    ssd6: ss / 6,
    ssd8: ss / 8,
    ssd16: ss / 16,
    ssd32: ss / 32,
    /** 60000ths of a degree (ECMA-376). */
    cd8: 2700000,
    cd4: 5400000,
    cd2: 10800000,
    "3cd8": 8100000,
    "3cd4": 16200000,
    "7cd8": 18900000,
  };
}

function num(tok: string, g: Guides): number {
  if (tok in g) return g[tok]!;
  const n = Number(tok);
  return Number.isFinite(n) ? n : 0;
}

function evalFmla(fmla: string, g: Guides): number {
  const p = fmla.trim().split(/\s+/);
  const op = p[0] ?? "val";
  const a = num(p[1] ?? "0", g);
  const b = num(p[2] ?? "0", g);
  const c = num(p[3] ?? "0", g);
  switch (op) {
    case "val":
      return a;
    case "*/":
      return c === 0 ? 0 : (a * b) / c;
    case "+-":
      return a + b - c;
    case "+/":
      return c === 0 ? 0 : (a + b) / c;
    case "?:":
      return a > 0 ? b : c;
    case "abs":
      return Math.abs(a);
    case "at2":
      return ((Math.atan2(b, a) * 180) / Math.PI) * 60000;
    case "cat2":
      return a * Math.cos(Math.atan2(c, b));
    case "sat2":
      return a * Math.sin(Math.atan2(c, b));
    case "cos":
      return a * Math.cos((b / 60000) * (Math.PI / 180));
    case "sin":
      return a * Math.sin((b / 60000) * (Math.PI / 180));
    case "tan":
      return a * Math.tan((b / 60000) * (Math.PI / 180));
    case "sqrt":
      return Math.sqrt(Math.max(0, a));
    case "max":
      return Math.max(a, b);
    case "min":
      return Math.min(a, b);
    case "mod":
      return Math.sqrt(a * a + b * b + c * c);
    case "pin":
      return Math.min(Math.max(b, a), c);
    default:
      return 0;
  }
}

function resolve(shape: ParsedShape, adj: number[] | undefined): Guides {
  const g = seedGuides(21600, 21600);
  const keys = Object.keys(shape.av);
  keys.forEach((k, i) => {
    g[k] = adj?.[i] ?? shape.av[k]!;
  });
  for (const gd of shape.gds) g[gd.name] = evalFmla(gd.fmla, g);
  return g;
}

function v(expr: string | number, g: Guides): number {
  if (typeof expr === "number") return expr;
  return num(expr, g);
}

function deg(emuAng: number): number {
  return emuAng / 60000;
}

function emitPath(pth: ParsedPath, g: Guides): string {
  const parts: string[] = [];
  let x = 0;
  let y = 0;
  const sx = 100 / (pth.w || 21600);
  const sy = 100 / (pth.h || 21600);
  const X = (n: number) => n * sx;
  const Y = (n: number) => n * sy;
  for (const c of pth.cmds) {
    if (c.k === "M") {
      x = v(c.x, g);
      y = v(c.y, g);
      parts.push(`M ${X(x)} ${Y(y)}`);
    } else if (c.k === "L") {
      x = v(c.x, g);
      y = v(c.y, g);
      parts.push(`L ${X(x)} ${Y(y)}`);
    } else if (c.k === "C") {
      const x1 = v(c.x1, g);
      const y1 = v(c.y1, g);
      const x2 = v(c.x2, g);
      const y2 = v(c.y2, g);
      x = v(c.x, g);
      y = v(c.y, g);
      parts.push(`C ${X(x1)} ${Y(y1)} ${X(x2)} ${Y(y2)} ${X(x)} ${Y(y)}`);
    } else if (c.k === "Q") {
      const x1 = v(c.x1, g);
      const y1 = v(c.y1, g);
      x = v(c.x, g);
      y = v(c.y, g);
      parts.push(`Q ${X(x1)} ${Y(y1)} ${X(x)} ${Y(y)}`);
    } else if (c.k === "A") {
      const wr = v(c.wr, g);
      const hr = v(c.hr, g);
      const st = v(c.st, g);
      const sw = v(c.sw, g);
      const a = arcSvg(x, y, wr, hr, st, sw);
      x = a.x;
      y = a.y;
      parts.push(
        `A ${wr * sx} ${hr * sy} 0 ${Math.abs(deg(sw)) > 180 ? 1 : 0} ${sw > 0 ? 1 : 0} ${X(x)} ${Y(y)}`,
      );
    } else if (c.k === "Z") parts.push("Z");
  }
  return parts.join(" ");
}

/** Convert OOXML arcTo into SVG A, given current point. */
function arcSvg(
  x0: number,
  y0: number,
  wr: number,
  hr: number,
  st: number,
  sw: number,
): { d: string; x: number; y: number } {
  const stR = (deg(st) * Math.PI) / 180;
  const swR = (deg(sw) * Math.PI) / 180;
  const cx = x0 - wr * Math.cos(stR);
  const cy = y0 - hr * Math.sin(stR);
  const x1 = cx + wr * Math.cos(stR + swR);
  const y1 = cy + hr * Math.sin(stR + swR);
  const large = Math.abs(deg(sw)) > 180 ? 1 : 0;
  const sweep = sw > 0 ? 1 : 0;
  return {
    d: `A ${wr} ${hr} 0 ${large} ${sweep} ${x1} ${y1}`,
    x: x1,
    y: y1,
  };
}

function adjIndexOf(shape: ParsedShape, name: string | undefined): number | undefined {
  if (!name) return undefined;
  const i = Object.keys(shape.av).indexOf(name);
  return i >= 0 ? i : undefined;
}

function resolveHandles(shape: ParsedShape, g: Guides): AdjustHandle[] {
  return shape.ahs.map((ah) => {
    const x = (v(ah.posX, g) / 21600) * 100;
    const y = (v(ah.posY, g) / 21600) * 100;
    return {
      kind: ah.kind,
      x,
      y,
      adjIndexX: adjIndexOf(shape, ah.gdRefX),
      adjIndexY: adjIndexOf(shape, ah.gdRefY),
      adjIndexAng: adjIndexOf(shape, ah.gdRefAng),
      minX: ah.minX ? v(ah.minX, g) : undefined,
      maxX: ah.maxX ? v(ah.maxX, g) : undefined,
      minY: ah.minY ? v(ah.minY, g) : undefined,
      maxY: ah.maxY ? v(ah.maxY, g) : undefined,
      minAng: ah.minAng ? v(ah.minAng, g) : undefined,
      maxAng: ah.maxAng ? v(ah.maxAng, g) : undefined,
    };
  });
}

export function ooxmlPresetNames(): string[] {
  loadXml();
  return [...cache.keys()];
}

export function ooxmlShapeGeometry(
  name: string,
  adjustments?: number[],
): ShapeGeometry | null {
  loadXml();
  const shape = cache.get(name);
  if (!shape || !shape.paths.length) return null;
  const g = resolve(shape, adjustments);
  const fills: string[] = [];
  const strokes: string[] = [];
  for (const pth of shape.paths) {
    const d = emitPath(pth, g);
    if (!d) continue;
    if (pth.fill === "none") strokes.push(d);
    else fills.push(d);
    if (pth.stroke === "false" && pth.fill !== "none") {
      /* fill-only; already in fills */
    }
  }
  return {
    fill: fills.join(" "),
    stroke: strokes.join(" "),
    handles: resolveHandles(shape, g),
  };
}

export function ooxmlAdjustHandles(name: string, adjustments?: number[]): AdjustHandle[] {
  return ooxmlShapeGeometry(name, adjustments)?.handles ?? [];
}

export function ooxmlShapePath(name: string, adjustments?: number[]): string | null {
  return ooxmlShapeGeometry(name, adjustments)?.fill || null;
}
