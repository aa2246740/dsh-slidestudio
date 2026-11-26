/**
 * Colours the user states in their own words (architecture §3.14 rule 7, CAP-18). The Agent
 * declares them in commit_design / write_todo as `userColors:[{hex, reason}]`. The Host checks the
 * shape, saves them in `_agent/runtime.json` and lets pack_color accept them next to every other
 * allowed colour, with the same documented tints and shades. It never reads a colour out of the
 * brief and never writes one into the theme: whether the Agent also puts it there is its choice.
 */
import fs from "node:fs";
import path from "node:path";
import { userPaletteWithVariants } from "./palette-variants.js";

export type UserColor = Readonly<{ hex: string; reason: string }>;

/** A longer list would make the palette restriction meaningless; users name a few colours. */
export const MAX_USER_COLORS = 8;
const MAX_REASON_CHARS = 120;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const FORMAT_HINT = "userColors 写成 [{hex:'#1F4E9A', reason:'用户要求主色换成蓝色'}]";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The checked colours, uppercase and without duplicates. Anything unreadable is a Chinese error
 * that names the field and the fix, so the model can correct the call.
 */
export function parseUserColors(value: unknown): UserColor[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`userColors 的格式不对：${FORMAT_HINT}`);
  if (value.length > MAX_USER_COLORS) {
    throw new Error(`userColors 最多 ${MAX_USER_COLORS} 个颜色，只写用户明确要求的颜色`);
  }
  const colors = new Map<string, UserColor>();
  for (const item of value) {
    const row = record(item);
    const hex = typeof row.hex === "string" ? row.hex.trim() : "";
    if (!HEX.test(hex)) {
      throw new Error(`userColors 的颜色「${hex.slice(0, 20)}」不是 #RRGGBB 十六进制色值，例如 #1F4E9A`);
    }
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    if (!reason) {
      throw new Error(`userColors 的颜色「${hex}」缺少 reason：写明用户的哪句话要求了这个颜色`);
    }
    if (reason.length > MAX_REASON_CHARS) {
      throw new Error(`userColors 的颜色「${hex}」的 reason 超过 ${MAX_REASON_CHARS} 字，请概括`);
    }
    const key = hex.toUpperCase();
    if (!colors.has(key)) colors.set(key, { hex: key, reason });
  }
  return [...colors.values()];
}

/** The saved declaration. An unreadable or invalid file grants nothing (fail closed). */
export function readUserColors(projectRoot: string): UserColor[] {
  try {
    const runtime: unknown = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "runtime.json"), "utf8"));
    return parseUserColors(record(runtime).userColors);
  } catch {
    return [];
  }
}

/** The extra pack_color grants: each declared colour and its documented tints and shades. */
export function userColorPalette(projectRoot: string): Set<string> {
  return userPaletteWithVariants(new Set(readUserColors(projectRoot).map((color) => color.hex)));
}

/**
 * The declaration a plan call carries. An omitted field keeps the saved one; an explicit array,
 * including [], replaces it.
 */
export function resolvePlanningUserColors(projectRoot: string, args: Record<string, unknown>): UserColor[] {
  return args.userColors === undefined ? readUserColors(projectRoot) : parseUserColors(args.userColors);
}
