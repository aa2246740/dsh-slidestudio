/**
 * `thmx-theme-v1` — an Office theme file (`.thmx`). It carries a colour scheme
 * and a font scheme and nothing else, so the record is a deck-template with no
 * masters, layouts, slides, media, logo or sidecar files. Downstream readers see
 * only the `design` part, and the design-aspect gate limits it to `palette` and
 * `fonts`.
 */
import { normalizeSourceFonts } from "@open-slidestudio/pptd-v2";
import { MaterialRejection } from "../zip-guard.mjs";
import { buildSummaryZh } from "../summary.mjs";
import { PackageReader } from "./ooxml.mjs";
import { COLOR_KEYS, parseTheme } from "./ooxml-theme.mjs";

const THEME_PART = "theme/theme/theme1.xml";
const CORRUPT_MESSAGE = "文件已损坏或内容不完整，无法解析；请重新导出后上传";
const NO_COLORS_MESSAGE = "主题文件里没有配色方案，无法读取；请在 Office 中重新保存主题后再上传";

export const thmxParser = {
  id: "thmx-theme-v1",
  engine: "fflate + @xmldom/xmldom",
  /** @type {"deck-template"} */
  kind: "deck-template",

  /**
   * @param {{name: string, bytes: Uint8Array}} input
   * @returns {Promise<import("../derivative.mjs").ParserResult<object>>}
   */
  async parse({ bytes }) {
    const pkg = new PackageReader(bytes);
    if (!pkg.has(THEME_PART)) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
    const theme = parseTheme(pkg, THEME_PART);
    if (!theme) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
    const themeColorCount = COLOR_KEYS.filter((key) => theme.colors[key]).length;
    if (!themeColorCount) throw new MaterialRejection("corrupt", NO_COLORS_MESSAGE);
    const fonts = theme.fonts;
    return {
      payload: {
        theme: { ...theme, fontMappings: normalizeSourceFonts(fonts) },
        masters: [],
        slides: [],
        media: [],
        logoCandidates: 0,
        logos: [],
        logo: null,
        photos: [],
        archetypes: [],
        observedColors: [],
        fontsUsed: [],
      },
      summary: buildSummaryZh({ parserId: this.id, themeColorCount, fonts }),
      warnings: [],
      truncated: { applied: false },
    };
  },
};
