import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colorRefusal, themeColorRefusals } from "./color-refusal.js";
import { toRgbHex } from "./theme.js";

/*
 * M5-SCR-005: an unknown theme reference must be refused when it is written, in Chinese. The
 * exporter's toRgbHex throws InvalidPptdColorError for it and fails the whole export, so every
 * write path asks colorRefusal first. The refusal must agree with toRgbHex exactly.
 */
const theme = { colors: { primary: "#D97757", text: "#111111" } };
const CJK = /[\u4e00-\u9fff]/;

describe("colorRefusal", () => {
  it("accepts an omitted colour, a literal hex and a $token the theme defines", () => {
    for (const value of [undefined, null, "", "  ", "#D97757", "#D9775780", "#abc", "$primary"]) {
      assert.equal(colorRefusal(value, theme), undefined, JSON.stringify(value));
    }
  });

  it("refuses an unknown $token, an unprefixed hex and an invalid colour in Chinese", () => {
    const cases: Array<[string, RegExp]> = [
      ["$accent9", /主题 colors 中不存在/],
      ["2563EB", /缺少 # 前缀/],
      ["red", /不是 #RRGGBB、#RRGGBBAA 或主题 \$颜色名/],
    ];
    for (const [value, reason] of cases) {
      const message = colorRefusal(value, theme);
      assert.ok(message, value);
      assert.match(message, reason, value);
      assert.match(message, CJK, value);
      assert.ok(message.includes(value), `${value} is named in the refusal`);
    }
  });

  it("refuses a $token whose theme value is not a literal #RRGGBB", () => {
    const message = colorRefusal("$primary", { colors: { primary: "2563EB" } });
    assert.match(message ?? "", /主题中是 "2563EB"/);
  });

  it("is refused exactly when toRgbHex would throw, so no accepted colour reaches a throw", () => {
    const values = [undefined, "", " ", "#D97757", "$primary", " $primary", "$accent9", "2563EB", "red", "#GGGGGG"];
    for (const value of values) {
      let threw = false;
      try {
        toRgbHex(value, theme);
      } catch {
        threw = true;
      }
      assert.equal(colorRefusal(value, theme) !== undefined, threw, JSON.stringify(value));
    }
  });
});

describe("themeColorRefusals", () => {
  it("accepts literal theme colours and text style colours the theme defines", () => {
    assert.deepEqual(
      themeColorRefusals({
        colors: { primary: "#2563EB" },
        textStyles: { body: { color: "$primary" } },
      }),
      [],
    );
  });

  it("refuses a token or unprefixed theme colour and a text style colour the theme lacks", () => {
    const issues = themeColorRefusals({
      colors: { primary: "$primary", accent1: "2563EB" },
      textStyles: { body: { color: "$nope" } },
    });
    assert.equal(issues.length, 3);
    for (const issue of issues) assert.match(issue, CJK);
    const text = issues.join("\n");
    assert.match(text, /colors\.primary/);
    assert.match(text, /colors\.accent1/);
    assert.match(text, /textStyles\.body\.color/);
  });
});
