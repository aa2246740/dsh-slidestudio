/**
 * Custom path geometry for `shapeName: "custom"` (architecture §3.19, DECISIONS #30).
 *
 * The stored `path` is a string of absolute M/L/C/Q/Z commands in `viewBox` units.
 * OOXML arcTo is converted to cubics before a path reaches PPTD, so it is refused here.
 * Every command letter is explicit: implicit repetition would make segment counts
 * ambiguous for the editor and the exporter.
 */

export const CUSTOM_SHAPE_NAME = "custom";
export const CUSTOM_PATH_MAX_SEGMENTS = 256;
export const CUSTOM_PATH_MAX_BYTES = 4096;
// border.width of a custom shape is PPTD px, like a preset shape and a line (ruling 112).
// A colour without a width draws at DEFAULT_BORDER_WIDTH_PX from border-units.ts.

export type CustomPathCommand = "M" | "L" | "C" | "Q" | "Z";
export type CustomPathSegment = { command: CustomPathCommand; points: number[] };
export type ParsedCustomPath = { segments: CustomPathSegment[] } | { issue: string };

const ARITY: Record<CustomPathCommand, number> = { M: 2, L: 2, C: 6, Q: 4, Z: 0 };
// A command letter is always a token of its own, so `ZM` reads as Z then M. Any other run of
// letters is one unknown token, which the parser refuses by name. NaN and Infinity must come
// before the letter run, or their N and I would be read as unknown letters.
const TOKEN = /[MLCQZ]|[+-]?(?:NaN|Infinity)|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z]+|[^\s,]/g;

type Token =
  | { kind: "command"; command: CustomPathCommand }
  | { kind: "number"; value: number }
  | { kind: "nonfinite" }
  | { kind: "unknown" };

function classify(token: string): Token {
  if (token === "M" || token === "L" || token === "C" || token === "Q" || token === "Z") {
    return { kind: "command", command: token };
  }
  if (/^[+-]?(?:NaN|Infinity)$/.test(token)) return { kind: "nonfinite" };
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) {
    const value = Number(token);
    return Number.isFinite(value) ? { kind: "number", value } : { kind: "nonfinite" };
  }
  return { kind: "unknown" };
}

const shownToken = (token: string): string => token.slice(0, 12);

/**
 * Parse a custom path. The issue text names the problem only; callers add the
 * element reference. Returns the segments in order, one per command letter.
 */
export function parseCustomPath(path: string): ParsedCustomPath {
  const text = path.trim();
  if (!text) return { issue: "geometry.path 为空" };
  const bytes = new TextEncoder().encode(path).length;
  if (bytes > CUSTOM_PATH_MAX_BYTES) {
    return { issue: `geometry.path 超过 4 KiB（当前 ${bytes} 字节）` };
  }
  const tokens = text.match(TOKEN) ?? [];
  const segments: CustomPathSegment[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    const head = classify(token);
    if (head.kind === "nonfinite") {
      return { issue: `geometry.path 含有非有限数字 ${shownToken(token)}` };
    }
    if (head.kind === "number") {
      return { issue: "geometry.path 中的数字缺少命令字母，每段都必须写出 M、L、C、Q 或 Z" };
    }
    if (head.kind === "unknown") return unknownCommand(token);
    if (segments.length === 0 && head.command !== "M") {
      return { issue: "geometry.path 必须以 M 开始" };
    }
    const arity = ARITY[head.command];
    const points: number[] = [];
    index += 1;
    for (let n = 0; n < arity; n += 1) {
      const argument = tokens[index];
      const arg = argument === undefined ? undefined : classify(argument);
      if (arg === undefined || arg.kind === "command") {
        return { issue: `geometry.path 的 ${head.command} 命令需要 ${arity} 个数字` };
      }
      if (arg.kind === "nonfinite") {
        return { issue: `geometry.path 含有非有限数字 ${shownToken(argument!)}` };
      }
      if (arg.kind === "unknown") return unknownCommand(argument!);
      points.push(arg.value);
      index += 1;
    }
    segments.push({ command: head.command, points });
  }
  if (segments.length > CUSTOM_PATH_MAX_SEGMENTS) {
    return {
      issue: `geometry.path 超过 ${CUSTOM_PATH_MAX_SEGMENTS} 段（当前 ${segments.length} 段）`,
    };
  }
  return { segments };
}

function unknownCommand(token: string): { issue: string } {
  return {
    issue: `geometry.path 含有不支持的命令 ${shownToken(token)}，只允许绝对命令 M、L、C、Q、Z`,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** True for a custom shape. Preset shapes never carry geometry. */
export function isCustomShape(element: unknown): boolean {
  return isRecord(element) && element.elementType === "shape" && element.shapeName === CUSTOM_SHAPE_NAME;
}

function viewBoxIssue(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return "geometry.viewBox 必须是两个数字 [宽, 高]";
  }
  if (value.some((side) => typeof side !== "number" || !Number.isFinite(side))) {
    return "geometry.viewBox 必须是有限数字";
  }
  if (value.some((side) => typeof side === "number" && side <= 0)) {
    return "geometry.viewBox 宽高必须大于 0";
  }
  return undefined;
}

/**
 * Geometry rules for one owner of a shape: a shape element, or the cropShape of a
 * picture. `owner` is the Chinese prefix of each message ("" for a shape).
 */
function geometryIssues(where: string, owner: string, shapeName: unknown, geometry: unknown): string[] {
  if (shapeName !== CUSTOM_SHAPE_NAME) {
    return geometry != null ? [`${where}${owner}只有 shapeName "custom" 可以带 geometry`] : [];
  }
  if (geometry == null) {
    return [`${where}${owner}缺少 geometry：自定义形状（shapeName "custom"）必须提供 viewBox 与 path`];
  }
  if (!isRecord(geometry)) return [`${where}${owner}的 geometry 必须是对象`];
  const issues: string[] = [];
  const viewBox = viewBoxIssue(geometry.viewBox);
  if (viewBox) issues.push(`${where}${owner}的 ${viewBox}`);
  if (typeof geometry.path !== "string") {
    return [...issues, `${where}${owner}的 geometry.path 必须是字符串`];
  }
  const parsed = parseCustomPath(geometry.path);
  if ("issue" in parsed) issues.push(`${where}${owner}的 ${parsed.issue}`);
  return issues;
}

/**
 * Chinese write-page refusals for every custom shape in an element list, plus
 * geometry that a preset shape carries. A picture's cropShape follows the same
 * rules. Each message names the element index and id.
 */
export function customGeometryIssues(elements: unknown): string[] {
  if (!Array.isArray(elements)) return [];
  const issues: string[] = [];
  elements.forEach((item, index) => {
    if (!isRecord(item)) return;
    const where = `$.elements[${index}]（elementId "${String(item.elementId ?? "")}"）`;
    if (item.elementType === "shape") {
      issues.push(...geometryIssues(where, "", item.shapeName, item.geometry));
    } else if (item.elementType === "image" && isRecord(item.cropShape)) {
      issues.push(...geometryIssues(where, "的 cropShape", item.cropShape.shapeName, item.cropShape.geometry));
    }
  });
  return issues;
}

export type ResolvedCustomGeometry =
  { viewBox: [number, number]; path: string; segments: CustomPathSegment[] } | { issue: string };

/**
 * The paintable form of a stored custom geometry. The editor and the exporter both
 * read geometry through this function, so they agree on what is drawable. A stored
 * geometry that fails here (for example a hand-edited file) returns the issue text.
 */
export function resolveCustomGeometry(geometry: unknown): ResolvedCustomGeometry {
  if (!isRecord(geometry)) return { issue: "geometry 必须是对象" };
  const viewBox = viewBoxIssue(geometry.viewBox);
  if (viewBox) return { issue: viewBox };
  if (typeof geometry.path !== "string") return { issue: "geometry.path 必须是字符串" };
  const parsed = parseCustomPath(geometry.path);
  if ("issue" in parsed) return { issue: parsed.issue };
  const [width, height] = geometry.viewBox as [number, number];
  return { viewBox: [width, height], path: geometry.path, segments: parsed.segments };
}
