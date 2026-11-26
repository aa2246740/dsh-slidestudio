/**
 * The only font policy for slide content.
 *
 * Slides name fonts that Windows ships and that Office and WPS both resolve,
 * so a deck looks the same on the canvas and after export without embedding
 * anything. Product chrome (the UI) keeps its own font stack and never reads
 * this table.
 *
 * Latin and East Asian text are named separately, the way PowerPoint assigns
 * glyphs: the `latin` face draws ASCII, the `ea` face draws CJK.
 */

export type FontPair = { latin: string; ea: string };

export type FontScript = "latin" | "ea";

export type FontEntry = {
  name: string;
  script: FontScript;
  /** CSS stack used where the face is not installed, e.g. on macOS. */
  fallbacks: readonly string[];
};

export const SLIDE_FONTS: readonly FontEntry[] = [
  { name: "微软雅黑", script: "ea", fallbacks: ["Microsoft YaHei", "PingFang SC"] },
  { name: "黑体", script: "ea", fallbacks: ["SimHei", "Heiti SC"] },
  { name: "宋体", script: "ea", fallbacks: ["SimSun", "Songti SC"] },
  { name: "楷体", script: "ea", fallbacks: ["KaiTi", "Kaiti SC"] },
  { name: "仿宋", script: "ea", fallbacks: ["FangSong", "STFangsong"] },
  { name: "Arial", script: "latin", fallbacks: [] },
  { name: "Times New Roman", script: "latin", fallbacks: [] },
  { name: "Georgia", script: "latin", fallbacks: [] },
  { name: "Verdana", script: "latin", fallbacks: [] },
  { name: "Tahoma", script: "latin", fallbacks: [] },
  { name: "Courier New", script: "latin", fallbacks: [] },
];

/** New decks, charts and tables use this pair unless a run says otherwise. */
export const DEFAULT_FONT_PAIR: FontPair = { latin: "Arial", ea: "微软雅黑" };

/**
 * Marker the chart XML patcher splits into `<a:latin>` and `<a:ea>`. A pipe
 * cannot be the separator: pptxgenjs reads `body|heading` there and drops
 * the second face. `***` survives both the writer and the attribute
 * sanitizer, which strips braces.
 * `chart-layout.ts` repeats this string verbatim because the browser loads
 * that file on its own and cannot import this module. The two copies are
 * pinned equal by a test; change them together.
 */
export const CHART_FONT_FACE = `${DEFAULT_FONT_PAIR.latin}***${DEFAULT_FONT_PAIR.ea}`;

const FONT_BY_NAME = new Map(SLIDE_FONTS.map((entry) => [entry.name.toLowerCase(), entry]));

export function fontEntry(name: string): FontEntry | undefined {
  return FONT_BY_NAME.get(name.trim().toLowerCase());
}

/** True for exactly the names in `SLIDE_FONTS`, case-insensitively. */
export function isSlideFont(name: string): boolean {
  return FONT_BY_NAME.has(name.trim().toLowerCase());
}

/** Canonical spelling for a known font, otherwise the trimmed input. */
export function canonicalFontName(name: string): string {
  const entry = fontEntry(name);
  return entry ? entry.name : name.trim();
}

function quoteCssFamily(name: string): string {
  return /^[A-Za-z](?:[A-Za-z]|-)*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * CSS `font-family` stack for a PPTD font. Latin is listed before the East
 * Asian stack, which mirrors PowerPoint: a browser takes the first family
 * that has the glyph, so ASCII comes from the Latin face and CJK from the
 * East Asian face. A bare string is treated as the face for both scripts.
 */
export function fontCss(family: string | FontPair | undefined): string {
  const pair = resolveFontPair(family);
  const latin = fontEntry(pair.latin);
  const ea = fontEntry(pair.ea);
  const families = [pair.latin, ...(latin?.fallbacks ?? []), pair.ea, ...(ea?.fallbacks ?? []), "sans-serif"];
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const name of families) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    stack.push(quoteCssFamily(name));
  }
  return stack.join(", ");
}

/**
 * Turn any stored fontFamily into the pair the renderer and exporter share.
 * An unknown name is kept verbatim, so a deck saved before this policy still
 * renders the face it named rather than being silently rewritten.
 */
export function resolveFontPair(family: string | FontPair | undefined): FontPair {
  if (!family) return { ...DEFAULT_FONT_PAIR };
  if (typeof family === "string") {
    const entry = fontEntry(family);
    if (entry?.script === "latin") return { latin: entry.name, ea: DEFAULT_FONT_PAIR.ea };
    if (entry?.script === "ea") return { latin: DEFAULT_FONT_PAIR.latin, ea: entry.name };
    return { latin: family, ea: family };
  }
  return {
    latin: canonicalFontName(family.latin || DEFAULT_FONT_PAIR.latin),
    ea: canonicalFontName(family.ea || DEFAULT_FONT_PAIR.ea),
  };
}

/**
 * Role a requested face plays, used only to guess the closest common face for
 * text the Agent wrote. Order matters: "黑体" must win over the "黑" in
 * "得意黑", and songti markers must win before the generic sans fallback.
 */
/**
 * Faces the Agent has actually been told to use, by the old OpenKimi font
 * guide and the design packs. Matching the name is more reliable than reading
 * a role out of "得意黑" or "Source Han Serif".
 */
const KNOWN_FONT_ROLES: Record<string, string> = {
  misans: "hei",
  "noto sans sc": "hei",
  "noto sans cjk sc": "hei",
  "source han sans": "hei",
  "source han sans sc": "hei",
  思源黑体: "hei",
  阿里妈妈数黑体: "hei",
  得意黑: "kai",
  "smiley sans": "kai",
  liter: "hei",
  hedvigletterssans: "hei",
  quattrocentosans: "hei",
  coda: "hei",
  jersey15: "hei",
  jersey20charted: "hei",
  inter: "hei",
  思源宋体: "song",
  "source han serif": "song",
  "source han serif sc": "song",
  "noto serif sc": "song",
  "noto serif cjk sc": "song",
  "noto serif cjk tc": "song",
  霞鹜新致宋: "song",
  lxgwxinzhissong: "song",
  unna: "song",
  oranienbaum: "song",
  sortsmillgoudy: "song",
  times: "song",
  cambria: "song",
  阿里妈妈刀隶体: "kai",
  阿里妈妈东方大楷: "kai",
  站酷文艺体: "kai",
  站酷庆科黄油体: "kai",
  飞波正点体: "kai",
  程荣光刻楷: "kai",
  "lxgw bright": "kai",
  "zcool kuaile": "kai",
  "long cang": "kai",
  精品点阵体: "kai",
  pressstart2p: "kai",
  luckiestguy: "kai",
};

const FONT_ROLE_RULES: readonly { role: string; pattern: RegExp }[] = [
  {
    role: "kai",
    pattern: /kaiti|楷体|楷|calligraphy|handwrit|script|brush|cursive|kai|行书|隶书/i,
  },
  { role: "fangsong", pattern: /fangsong|仿宋|仿/i },
  { role: "song", pattern: /songti|simsun|serif|song|宋体|宋|明朝|明/i },
  { role: "hei", pattern: /hei|gothic|sans|黑|雅黑|圆体/i },
];

const FONT_ROLE_TARGETS: Record<string, { latin: string; ea: string }> = {
  kai: { latin: "Georgia", ea: "楷体" },
  fangsong: { latin: "Times New Roman", ea: "仿宋" },
  song: { latin: "Times New Roman", ea: "宋体" },
  hei: { latin: "Arial", ea: "微软雅黑" },
};

function fontRole(name: string): string {
  const mapped = KNOWN_FONT_ROLES[name.trim().toLowerCase()];
  if (mapped) return mapped;
  const known = fontEntry(name);
  if (known) {
    if (known.name === "微软雅黑" || known.name === "黑体") return "hei";
    if (known.name === "宋体") return "song";
    if (known.name === "楷体") return "kai";
    if (known.name === "仿宋") return "fangsong";
    if (known.name === "Georgia") return "kai";
    if (known.name === "Times New Roman") return "song";
    if (known.name === "Courier New") return "mono";
    return "hei";
  }
  for (const rule of FONT_ROLE_RULES) {
    if (rule.pattern.test(name)) return rule.role;
  }
  if (/mono|courier|consolas|code/i.test(name)) return "mono";
  if (/[一-龥]/.test(name)) return "hei";
  return "latin-sans";
}

export type FontReplacement = {
  from: string | FontPair;
  to: string | FontPair;
};

function samePair(a: FontPair, b: FontPair): boolean {
  return a.latin === b.latin && a.ea === b.ea;
}

/**
 * Rewrite an Agent-requested font onto `SLIDE_FONTS`. A face already in the
 * table is kept; anything else is replaced by the common face with the same
 * role. `fontNotes` says exactly what moved, so the tool result can tell the
 * model its request was not used verbatim.
 */
export function normalizeFontFamily(value: unknown): {
  fontFamily: string | FontPair;
  note?: string;
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const latin = typeof rec.latin === "string" ? rec.latin.trim() : "";
    const ea = typeof rec.ea === "string" ? rec.ea.trim() : "";
    if (!latin && !ea) return { fontFamily: { ...DEFAULT_FONT_PAIR } };
    const next: FontPair = {
      latin:
        latin && isSlideFont(latin) ? canonicalFontName(latin) : nearestFont(latin || DEFAULT_FONT_PAIR.latin, "latin"),
      ea: ea && isSlideFont(ea) ? canonicalFontName(ea) : nearestFont(ea || DEFAULT_FONT_PAIR.ea, "ea"),
    };
    const original = { latin, ea };
    return samePair(next, { latin: original.latin || next.latin, ea: original.ea || next.ea })
      ? { fontFamily: next }
      : {
          fontFamily: next,
          note: `字体 {latin: ${latin || "（缺省）"}, ea: ${ea || "（缺省）"}} 换成 {latin: ${next.latin}, ea: ${next.ea}}`,
        };
  }
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { fontFamily: { ...DEFAULT_FONT_PAIR } };
  if (isSlideFont(name)) return { fontFamily: canonicalFontName(name) };
  const next = nearestFont(name, "both");
  return { fontFamily: next, note: `字体「${name}」换成「${next}」` };
}

function nearestFont(name: string, script: FontScript | "both"): string {
  const role = fontRole(name);
  if (role === "mono") return "Courier New";
  if (role === "latin-sans") return "Arial";
  const target = FONT_ROLE_TARGETS[role] ?? FONT_ROLE_TARGETS.hei!;
  if (script === "ea") return target.ea;
  if (script === "latin") return target.latin;
  // A bare family name stands for both scripts. CJK faces are named in
  // Chinese; everything else, including the old bundled Latin faces that
  // covered Chinese too, maps to the East Asian face of its role.
  return target.ea;
}

/**
 * Walk Agent-authored page args and rewrite every fontFamily onto
 * `SLIDE_FONTS`. Covers element content, theme text styles and declared
 * custom fonts. Returns one note per value that actually changed.
 */
export function normalizePageFonts(args: Record<string, unknown>): FontReplacement[] {
  const notes: FontReplacement[] = [];
  const elements = Array.isArray(args.elements) ? args.elements : [];
  for (const element of elements) {
    if (!element || typeof element !== "object" || Array.isArray(element)) continue;
    const rec = element as Record<string, unknown>;
    const content = rec.content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
      rewriteFontField(content as Record<string, unknown>, notes);
    }
    rewriteFontField(rec, notes);
  }
  const theme = args.theme;
  if (theme && typeof theme === "object" && !Array.isArray(theme)) {
    const textStyles = (theme as Record<string, unknown>).textStyles;
    if (textStyles && typeof textStyles === "object" && !Array.isArray(textStyles)) {
      for (const style of Object.values(textStyles as Record<string, unknown>)) {
        if (style && typeof style === "object" && !Array.isArray(style)) {
          rewriteFontField(style as Record<string, unknown>, notes);
        }
      }
    }
  }
  return notes;
}

function rewriteFontField(owner: Record<string, unknown>, notes: FontReplacement[]): void {
  if (!Object.prototype.hasOwnProperty.call(owner, "fontFamily")) return;
  const before = owner.fontFamily as string | FontPair;
  const { fontFamily, note } = normalizeFontFamily(before);
  owner.fontFamily = fontFamily;
  if (note) notes.push({ from: before, to: fontFamily });
}

/** The theme object a new deck starts from: the default pair for every role. */
export function defaultThemeTextStyles(): Record<string, { fontFamily: FontPair }> {
  return {
    title: { fontFamily: { ...DEFAULT_FONT_PAIR } },
    body: { fontFamily: { ...DEFAULT_FONT_PAIR } },
  };
}
