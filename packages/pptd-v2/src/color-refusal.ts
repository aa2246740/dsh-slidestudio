/**
 * Chinese refusals for colours a PPTD value may not carry (M5-SCR-005). `toRgbHex` throws
 * InvalidPptdColorError for an unknown `$token`, an unprefixed hex or an invalid colour, and the
 * exporter then fails the whole deck. Every write path asks `colorRefusal` first. It decides by
 * calling `toRgbHex`, so a colour is refused here if and only if the exporter would throw.
 */
import { officialPptdColorKind, themeColorIsCyclic, toRgbHex } from "./theme.js";
import type { Theme } from "./types.js";

/** The Chinese reason this colour cannot be written, or undefined when the export accepts it. */
export function colorRefusal(value: string | null | undefined, theme?: Theme): string | undefined {
  if (value == null || String(value).trim() === "") return undefined;
  try {
    toRgbHex(String(value), theme);
    return undefined;
  } catch {
    return refusalText(String(value), theme);
  }
}

function refusalText(value: string, theme: Theme | undefined): string {
  const text = value.trim();
  const shown = JSON.stringify(text);
  if (themeColorIsCyclic(text, theme)) {
    return `颜色 ${shown} 的主题引用形成循环，请在主题中改用 #RRGGBB。`;
  }
  if (value.startsWith("$")) {
    const target = theme?.colors?.[text.slice(1)];
    if (target === undefined) {
      return `颜色 ${shown} 在主题 colors 中不存在，请先在主题中定义该颜色或改用 #RRGGBB。`;
    }
    return `颜色 ${shown} 在主题中是 ${JSON.stringify(target)}，不是 #RRGGBB 或 #RRGGBBAA。`;
  }
  if (text.startsWith("$")) return `颜色 ${JSON.stringify(value)} 的 $ 引用前后不能有空格。`;
  if (officialPptdColorKind(text) === "unprefixed") {
    return `颜色 ${shown} 缺少 # 前缀，请写成 #${text}。`;
  }
  return `颜色 ${shown} 不是 #RRGGBB、#RRGGBBAA 或主题 $颜色名。`;
}

/**
 * Refusals for a whole theme before it is saved. Each `colors` entry must be a literal
 * #RRGGBB or #RRGGBBAA, because the theme is the table tokens resolve against. Each text style
 * colour must resolve in that theme. Messages name the key, for example `colors.primary`.
 */
export function themeColorRefusals(theme: Theme | null | undefined): string[] {
  const current = theme ?? undefined;
  const issues: string[] = [];
  for (const [key, value] of Object.entries(current?.colors ?? {})) {
    if (typeof value !== "string" || officialPptdColorKind(value) !== "hash") {
      issues.push(`主题颜色 colors.${key} 必须是 #RRGGBB 或 #RRGGBBAA，当前为 ${JSON.stringify(value)}。`);
    }
  }
  for (const [name, style] of Object.entries(current?.textStyles ?? {})) {
    const refusal = colorRefusal(typeof style?.color === "string" ? style.color : undefined, current);
    if (refusal) issues.push(`主题文字样式 textStyles.${name}.color：${refusal}`);
  }
  return issues;
}
