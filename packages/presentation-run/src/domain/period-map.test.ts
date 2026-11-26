import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectivePeriods, parsePeriodMap } from "./period-map.js";

describe("write_todo.periodMap shape", () => {
  it("keeps the Chinese label form and normalizes ISO month forms to it", () => {
    assert.deepEqual(parsePeriodMap({ from: "2026年8月", to: "2026年9月" }), {
      from: "2026年8月",
      to: "2026年9月",
    });
    assert.deepEqual(parsePeriodMap({ from: "2026-08", to: "2026-09" }), {
      from: "2026年8月",
      to: "2026年9月",
    });
    assert.deepEqual(parsePeriodMap({ from: " 2026/8 ", to: "2026/09" }), {
      from: "2026年8月",
      to: "2026年9月",
    });
    assert.deepEqual(parsePeriodMap({ from: "2026年1-8月", to: "2026年1-9月" }), {
      from: "2026年1-8月",
      to: "2026年1-9月",
    });
    assert.deepEqual(parsePeriodMap({ from: "Q2", to: "Q3" }), { from: "Q2", to: "Q3" });
  });

  it("rejects every other shape with a Chinese message that names the field", () => {
    const cases: [unknown, RegExp][] = [
      ["2026-08", /periodMap 必须是对象.*from.*to/],
      [["2026-08", "2026-09"], /periodMap 必须是对象/],
      [null, /periodMap 必须是对象/],
      [{ from: "2026年8月" }, /periodMap\.to 缺少期间/],
      [{ to: "2026年9月" }, /periodMap\.from 缺少期间/],
      [{ from: "  ", to: "2026年9月" }, /periodMap\.from 缺少期间/],
      [{ from: 8, to: "2026年9月" }, /periodMap\.from 缺少期间/],
      [{ from: "上个月", to: "2026年9月" }, /periodMap\.from「上个月」不是可识别的期间.*2026年8月.*2026-08/],
      [{ from: "2026年8月", to: "2026-13" }, /periodMap\.to「2026-13」不是可识别的期间/],
      [{ from: "2026年8月", to: "2026-08" }, /from 和 to 不能是同一个期间（2026年8月）/],
      [{ from: "2026年8月", to: "2026年9月", note: "x" }, /只能有 from 和 to.*note/],
    ];
    for (const [input, expected] of cases) {
      assert.throws(() => parsePeriodMap(input), expected, JSON.stringify(input));
    }
  });
});

describe("period labels a page or source effectively carries", () => {
  const map = { from: "2026年8月", to: "2026年9月" };

  it("uses the map only where the text names no period", () => {
    assert.deepEqual(effectivePeriods(["2026年9月"], map, "page"), ["2026年9月"]);
    assert.deepEqual(effectivePeriods([], map, "page"), ["2026年9月"]);
    assert.deepEqual(effectivePeriods([], map, "source"), ["2026年8月"]);
    assert.deepEqual(effectivePeriods(["2026年7月"], map, "source"), ["2026年7月"]);
  });

  it("leaves labels untouched without a map", () => {
    assert.deepEqual(effectivePeriods([], undefined, "page"), []);
    assert.deepEqual(effectivePeriods(["2026年7月"], undefined, "source"), ["2026年7月"]);
  });
});
