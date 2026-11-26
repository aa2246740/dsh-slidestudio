import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTextStyle,
  stripHtmlToText,
  parseRichText,
  serializeRichText,
  applyRangeStyle,
  toRgbHex,
  officialPptdColorKind,
  InvalidPptdColorError,
  toCssColor,
  colorAlpha,
  contrastRatio,
  shapePaintFill,
  elementFillPaint,
  svgFillFromFillCss,
  type RichTextRun,
  type RangeStylePatch,
} from "./theme.js";

function normalize(runs: RichTextRun[]): RichTextRun[] {
  return applyRangeStyle(runs, 0, 0, {});
}

describe("pptd-v2 theme helpers", () => {
  it("strips HTML rich text to plain", () => {
    assert.equal(stripHtmlToText('<p><span style="font-size:16px">NEODECK</span></p>'), "NEODECK");
    assert.equal(stripHtmlToText("plain"), "plain");
  });

  it("parses Kimi metric HTML into sized runs", () => {
    const runs = parseRichText(
      '<p><span style="font-size:36px; color:#FFFFFF; font-weight:700;">1:3</span><span style="font-size:15px; color:#FFFFFFB3;"> 头身比</span></p>',
    );
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.text, "1:3");
    assert.equal(runs[0]!.fontSize, 36);
    assert.equal(runs[0]!.bold, true);
    assert.equal(runs[1]!.text, " 头身比");
    assert.equal(runs[1]!.fontSize, 15);
    assert.match(toCssColor("#FFFFFFB3"), /^rgba\(/);
    const hex8 = resolveTextStyle({ text: "头身比", color: "#FFFFFFB3" });
    assert.match(hex8.color, /^rgba\(/);
    assert.equal(hex8.colorHex, "#FFFFFF");
  });

  it("normalizes 8-digit hex and theme refs", () => {
    assert.equal(toRgbHex("#000000F2"), "#000000");
    assert.equal(toRgbHex("$primary", { colors: { primary: "#FF6900" } }), "#FF6900");
    let unresolved: string | undefined;
    try {
      unresolved = toRgbHex("$nope");
    } catch (error) {
      assert.equal(error instanceof InvalidPptdColorError, true);
      unresolved = undefined;
    }
    assert.equal(unresolved, undefined);
    assert.throws(() => toRgbHex("$nope", { colors: { primary: "#2563EB" } }), InvalidPptdColorError);
    assert.ok(Math.abs((colorAlpha("#00000099") ?? 0) - 0.6) < 0.01);
  });

  it("treats missing fill as no paint even when opacity is set", () => {
    assert.equal(shapePaintFill(undefined, 0.3), undefined);
    assert.equal(shapePaintFill({ type: "none" }, 0.3), undefined);
    const white = shapePaintFill({ type: "solid", color: "#FFFFFF" }, 0.3);
    assert.equal(white?.hex, "#FFFFFF");
    assert.ok(Math.abs((white?.alpha ?? 0) - 0.3) < 0.001);
    assert.ok(contrastRatio("#FFFFFF", "#FFFFFF") < 1.01);
    assert.ok(contrastRatio("#08151C", "#FFFFFF") >= 3);
  });

  it("unprefixed RRGGBB never becomes #000000 (official Color is #RRGGBB)", () => {
    assert.equal(officialPptdColorKind("#0E0807"), "hash");
    assert.equal(officialPptdColorKind("#E8DED7"), "hash");
    assert.equal(officialPptdColorKind("0E0807"), "unprefixed");
    assert.equal(officialPptdColorKind("E8DED7"), "unprefixed");
    assert.equal(toRgbHex("#0E0807"), "#0E0807");
    assert.equal(toRgbHex("#E8DED7"), "#E8DED7");
    for (const raw of ["0E0807", "E8DED7", "FF4D4D"]) {
      let got: string | undefined;
      try {
        got = toRgbHex(raw);
      } catch (error) {
        assert.equal(error instanceof InvalidPptdColorError, true, raw);
        continue;
      }
      assert.equal(got.toUpperCase(), `#${raw.toUpperCase()}`);
      assert.notEqual(got.toUpperCase(), "#000000");
      assert.notEqual(got.toUpperCase(), "#FFFFFF");
    }
  });

  it("maps omitted shape fill to no paint and omitted icon fill to black (PPTD defaults)", () => {
    assert.equal(elementFillPaint("shape", undefined, 0.3).type, "none");
    assert.equal(elementFillPaint("shape", { type: "none" }, 0.22).type, "none");
    assert.equal(elementFillPaint("chart", undefined).type, "none");
    assert.equal(elementFillPaint("table", undefined, 0.18).type, "none");
    assert.equal(elementFillPaint("icon", { type: "none" }).type, "none");
    const icon = elementFillPaint("icon", undefined, 1);
    assert.equal(icon.type, "solid");
    if (icon.type === "solid") assert.equal(icon.hex, "#000000");
    assert.equal(svgFillFromFillCss(undefined), "none");
    assert.equal(svgFillFromFillCss(""), "none");
    assert.notEqual(svgFillFromFillCss(undefined), "#2563EB");
    const primary = elementFillPaint("shape", { type: "solid", color: "#A100FF" }, 0.3);
    assert.equal(primary.type, "solid");
    if (primary.type === "solid") {
      assert.equal(primary.hex, "#A100FF");
      assert.ok(Math.abs(primary.alpha - 0.3) < 0.001);
    }
  });

  it("resolves text style chain from theme", () => {
    const st = resolveTextStyle(
      { style: "$coverTitle", text: "小米 YU7" },
      {
        colors: { white: "#FFFFFF", primary: "#FF6900" },
        textStyles: {
          coverTitle: {
            fontSize: 86,
            color: "$white",
            bold: true,
            letterSpacing: 8,
          },
        },
      },
    );
    assert.equal(st.text, "小米 YU7");
    assert.equal(st.fontSize, 86);
    assert.equal(st.color, "#FFFFFF");
    assert.equal(st.colorHex, "#FFFFFF");
    assert.equal(st.bold, true);
    assert.equal(st.letterSpacing, 8);
  });

  it("unescapes JSON-style \\n in YAML plain scalars", () => {
    const st = resolveTextStyle({ text: "上午：新宿\\n· 展望台" });
    assert.equal(st.text.includes("\\n"), false);
    assert.equal(st.text.includes("\n"), true);
    assert.match(st.text, /上午：新宿\n· 展望台/);
  });

  it("defaults fontFamily to the Office/WPS pair and keeps latin and ea apart", () => {
    const bare = resolveTextStyle({ text: "标题" });
    assert.deepEqual(bare.fontFamily, { latin: "Arial", ea: "微软雅黑" });
    const eaOnly = resolveTextStyle({ text: "标题", fontFamily: "宋体" });
    assert.deepEqual(eaOnly.fontFamily, { latin: "Arial", ea: "宋体" });
    const pair = resolveTextStyle({
      text: "标题",
      fontFamily: { latin: "Georgia", ea: "楷体" },
    });
    assert.deepEqual(pair.fontFamily, { latin: "Georgia", ea: "楷体" });
    const fromTheme = resolveTextStyle(
      { text: "标题", style: "$title" },
      { textStyles: { title: { fontFamily: { latin: "Times New Roman", ea: "宋体" } } } },
    );
    assert.deepEqual(fromTheme.fontFamily, { latin: "Times New Roman", ea: "宋体" });
  });

  it("passes list and href through", () => {
    const st = resolveTextStyle({
      text: "一项\n二项",
      list: "bullet",
      href: "https://example.com",
    });
    assert.equal(st.list, "bullet");
    assert.equal(st.href, "https://example.com");
  });

  it("keeps theme alpha on body text ($w70)", () => {
    const st = resolveTextStyle({ text: "slogan", color: "$w70", fontSize: 15 }, { colors: { w70: "#FFFFFFB3" } });
    assert.match(st.color, /^rgba\(255, 255, 255, 0\.7/);
  });

  it("plain editing text strips markup and runs carry underline", () => {
    const st = resolveTextStyle({
      text: '<p><span style="text-decoration:underline;font-weight:700">Hi</span> there</p>',
    });
    assert.equal(st.text, "Hi there");
    assert.equal(st.runs[0]!.underline, true);
    assert.equal(st.runs[0]!.bold, true);
    assert.equal(st.underline, true);
  });
});

describe("serializeRichText / parseRichText round-trip", () => {
  it("leaves a single unstyled paragraph as a plain escaped string", () => {
    assert.equal(serializeRichText([{ text: "plain" }]), "plain");
    assert.equal(serializeRichText([{ text: 'a <b> & "c"' }]), "a &lt;b&gt; &amp; &quot;c&quot;");
    assert.deepEqual(parseRichText(serializeRichText([{ text: 'a <b> & "c"' }])), [{ text: 'a <b> & "c"' }]);
  });

  it("uses style-only spans with canonical css", () => {
    const html = serializeRichText([
      {
        text: "Hi",
        fontSize: 36,
        color: "#FF6900",
        bold: true,
        italic: true,
        underline: true,
      },
    ]);
    assert.equal(
      html,
      '<p><span style="font-size:36px;color:#FF6900;font-weight:700;font-style:italic;text-decoration:underline">Hi</span></p>',
    );
  });

  it("round-trips styled runs losslessly after normalize", () => {
    const runs: RichTextRun[] = [
      { text: "He", bold: true, color: "#FF6900" },
      { text: "llo", fontSize: 18 },
    ];
    assert.deepEqual(parseRichText(serializeRichText(runs)), normalize(runs));
  });

  it("round-trips underline from <u> and text-decoration", () => {
    const fromTag = parseRichText("<p><u>under</u></p>");
    assert.equal(fromTag.length, 1);
    assert.equal(fromTag[0]!.text, "under");
    assert.equal(fromTag[0]!.underline, true);
    const fromCss = parseRichText('<p><span style="text-decoration:underline">under</span></p>');
    assert.deepEqual(fromCss, [{ text: "under", underline: true }]);
    assert.deepEqual(parseRichText(serializeRichText(fromTag)), fromCss);
  });

  it("round-trips multi-paragraph newlines as one \\n per break", () => {
    const runs: RichTextRun[] = [{ text: "hello\nworld", bold: true }];
    const html = serializeRichText(runs);
    assert.equal(
      html,
      '<p><span style="font-weight:700">hello</span></p><p><span style="font-weight:700">world</span></p>',
    );
    assert.deepEqual(parseRichText(html), normalize(runs));
  });

  it("escapes entities inside styled spans", () => {
    const runs: RichTextRun[] = [{ text: 'A&B <C> "D"', italic: true }];
    const html = serializeRichText(runs);
    assert.match(html, /A&amp;B &lt;C&gt; &quot;D&quot;/);
    assert.doesNotMatch(html, /<C>/);
    assert.deepEqual(parseRichText(html), normalize(runs));
  });
});

describe("applyRangeStyle", () => {
  it("splits a mid-run range and merges identical neighbors", () => {
    const out = applyRangeStyle([{ text: "Hello" }], 1, 4, { bold: true });
    assert.deepEqual(out, [{ text: "H" }, { text: "ell", bold: true }, { text: "o" }]);
    const merged = applyRangeStyle(out, 1, 4, { bold: null });
    assert.deepEqual(merged, [{ text: "Hello" }]);
  });

  it("applies a prefix range and a cross-run range", () => {
    const prefix = applyRangeStyle([{ text: "Hello" }], 0, 2, {
      bold: true,
      color: "#FF6900",
    });
    assert.deepEqual(prefix, [{ text: "He", bold: true, color: "#FF6900" }, { text: "llo" }]);
    const crossed = applyRangeStyle(
      [
        { text: "AB", bold: true },
        { text: "CD", italic: true },
      ],
      1,
      3,
      { color: "#112233" },
    );
    assert.deepEqual(crossed, [
      { text: "A", bold: true },
      { text: "B", bold: true, color: "#112233" },
      { text: "C", italic: true, color: "#112233" },
      { text: "D", italic: true },
    ]);
  });

  it("styles across a paragraph break and can clear fields with null", () => {
    const multi = applyRangeStyle([{ text: "hello\nworld" }], 3, 8, {
      underline: true,
      fontSize: 20,
    });
    assert.deepEqual(multi, [{ text: "hel" }, { text: "lo\nwo", underline: true, fontSize: 20 }, { text: "rld" }]);
    assert.deepEqual(parseRichText(serializeRichText(multi)), multi);
    const cleared = applyRangeStyle(multi, 3, 8, {
      underline: null,
      fontSize: null,
    });
    assert.deepEqual(cleared, [{ text: "hello\nworld" }]);
  });

  it("clamps inverted and empty ranges", () => {
    const runs: RichTextRun[] = [{ text: "Hi", italic: true }];
    assert.deepEqual(applyRangeStyle(runs, 2, 0, { bold: true }), [{ text: "Hi", italic: true, bold: true }]);
    assert.deepEqual(applyRangeStyle(runs, 1, 1, { bold: true } as RangeStylePatch), [{ text: "Hi", italic: true }]);
  });
});

describe("rich text hardening", () => {
  it("drops HTML comments including clipboard StartFragment markers", () => {
    assert.deepEqual(parseRichText("<!--StartFragment--><p>hello</p><!--EndFragment-->"), [{ text: "hello" }]);
    assert.deepEqual(parseRichText("<p>a<!-- hidden -->b</p>"), [{ text: "ab" }]);
  });

  it("decodes &amp; last so double-escaped entities stay literal", () => {
    // &amp;lt; must become the literal text "&lt;", never "<".
    assert.deepEqual(parseRichText("a &amp;lt; b"), [{ text: "a &lt; b" }]);
    assert.deepEqual(parseRichText("a &lt; b"), [{ text: "a < b" }]);
    // &amp;quot; stays literal "&quot;" while the real &quot; decodes to "
    assert.deepEqual(parseRichText("&amp;quot;x&quot;"), [{ text: '&quot;x"' }]);
  });

  it("decodes numeric entities", () => {
    assert.deepEqual(parseRichText("it&#39;s &#x27;ok&#x27;"), [{ text: "it's 'ok'" }]);
  });

  it("normalizes CRLF/CR line endings in run text", () => {
    assert.deepEqual(parseRichText("a\r\nb\rc"), [{ text: "a\nb\nc" }]);
  });

  it("does not leak style from self-closing tags", () => {
    const runs = parseRichText('<p><b/><span style="color:#FF0000"/>after</p>');
    assert.deepEqual(runs, [{ text: "after" }]);
  });

  it("rejects hostile or malformed inline css values", () => {
    const runs = parseRichText('<p><span style="color:url(javascript:alert(1));font-size:99999px">x</span></p>');
    assert.deepEqual(runs, [{ text: "x" }]);
  });
});
