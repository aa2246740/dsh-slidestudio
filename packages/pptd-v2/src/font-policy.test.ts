import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CHART_FONT_FACE as CHART_LAYOUT_MARKER } from "./chart-layout.js";
import {
  CHART_FONT_FACE,
  DEFAULT_FONT_PAIR,
  fontCss,
  isSlideFont,
  normalizeFontFamily,
  normalizePageFonts,
  resolveFontPair,
} from "./font-policy.js";

describe("slide font policy", () => {
  it("keeps the chart marker identical in both modules", () => {
    assert.equal(CHART_FONT_FACE, CHART_LAYOUT_MARKER);
    assert.equal(CHART_FONT_FACE, `${DEFAULT_FONT_PAIR.latin}***${DEFAULT_FONT_PAIR.ea}`);
  });

  it("builds a CSS stack with latin before the East Asian fallbacks", () => {
    assert.equal(fontCss({ latin: "Georgia", ea: "楷体" }), 'Georgia, "楷体", KaiTi, "Kaiti SC", sans-serif');
    assert.equal(fontCss("宋体"), 'Arial, "宋体", SimSun, "Songti SC", sans-serif');
    assert.equal(fontCss(undefined), 'Arial, "微软雅黑", "Microsoft YaHei", "PingFang SC", sans-serif');
  });

  it("recognises only the common Office/WPS faces", () => {
    assert.equal(isSlideFont("微软雅黑"), true);
    assert.equal(isSlideFont("arial"), true);
    assert.equal(isSlideFont("MiSans"), false);
    assert.deepEqual(resolveFontPair("MiSans"), { latin: "MiSans", ea: "MiSans" });
    assert.deepEqual(resolveFontPair({ latin: "Arial", ea: "思源宋体" }), {
      latin: "Arial",
      ea: "思源宋体",
    });
  });

  it("maps an Agent-requested face to the closest common face", () => {
    assert.deepEqual(normalizeFontFamily("微软雅黑"), { fontFamily: "微软雅黑" });
    assert.deepEqual(normalizeFontFamily("MiSans"), {
      fontFamily: "微软雅黑",
      note: "字体「MiSans」换成「微软雅黑」",
    });
    assert.deepEqual(normalizeFontFamily("思源宋体"), {
      fontFamily: "宋体",
      note: "字体「思源宋体」换成「宋体」",
    });
    assert.deepEqual(normalizeFontFamily("得意黑"), {
      fontFamily: "楷体",
      note: "字体「得意黑」换成「楷体」",
    });
    assert.deepEqual(normalizeFontFamily("Unna"), {
      fontFamily: "宋体",
      note: "字体「Unna」换成「宋体」",
    });
    assert.deepEqual(normalizeFontFamily("QuattrocentoSans"), {
      fontFamily: "微软雅黑",
      note: "字体「QuattrocentoSans」换成「微软雅黑」",
    });
    assert.deepEqual(normalizeFontFamily("JetBrains Mono"), {
      fontFamily: "Courier New",
      note: "字体「JetBrains Mono」换成「Courier New」",
    });
    const pair = normalizeFontFamily({ latin: "Liter", ea: "Noto Sans SC" });
    assert.deepEqual(pair.fontFamily, { latin: "Arial", ea: "微软雅黑" });
    assert.match(pair.note ?? "", /Liter.*Noto Sans SC/);
  });

  it("rewrites every font in a page and records what changed", () => {
    const page = {
      id: "p1",
      elements: [
        { elementType: "text", content: { text: "标题", fontFamily: "MiSans" } },
        {
          elementType: "text",
          fontFamily: "Unna",
          content: { text: "正文", fontFamily: { latin: "Georgia", ea: "楷体" } },
        },
      ],
      theme: { textStyles: { title: { fontFamily: "思源宋体" } } },
    };
    const notes = normalizePageFonts(page);
    const elements = page.elements as Array<{
      fontFamily?: string;
      content: { fontFamily: string | { latin: string; ea: string } };
    }>;
    assert.equal(elements[0]?.content.fontFamily, "微软雅黑");
    assert.deepEqual(elements[1]?.content.fontFamily, { latin: "Georgia", ea: "楷体" });
    assert.equal(elements[1]?.fontFamily, "宋体");
    assert.equal(page.theme.textStyles.title.fontFamily, "宋体");
    assert.equal(notes.length, 3);
    assert.deepEqual(notes[0], { from: "MiSans", to: "微软雅黑" });
  });
});
