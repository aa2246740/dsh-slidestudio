import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { embeddedWarnings } from "./embedded-warnings.mjs";

const section = (overrides = {}) => ({
  found: 3,
  countComplete: true,
  kept: 3,
  limit: 40,
  skipped: {},
  ...overrides,
});

describe("VAL-PDF-007: chip warnings for the pictures found in a DOCX or PDF", () => {
  test("a document that stopped at the 41st picture says 40 or more, never a total", () => {
    const [warning] = embeddedWarnings({
      section: section({ found: 41, countComplete: false, kept: 40 }),
      timedOut: false,
    });
    assert.equal(warning.code, "embedded-images-limit");
    assert.equal(warning.message, "文档里有 40 张以上可用图片，只保留了前 40 张；其余图片可另存后单独上传");
  });

  test("a counted document keeps naming its total", () => {
    const [warning] = embeddedWarnings({
      section: section({ found: 45, countComplete: true, kept: 40 }),
      timedOut: false,
    });
    assert.match(warning.message, /45 张可用图片，只保留了前 40 张/);
  });

  test("page scans and decoration are explained by reason with their counts", () => {
    const warnings = embeddedWarnings({
      section: section({
        skipped: { small: 2, pageScan: 3, strip: 4, faint: 5, flat: 6, duplicate: 7 },
      }),
      timedOut: false,
    });
    assert.equal(warnings.length, 1);
    const message = warnings[0].message;
    assert.match(message, /3 张是铺满整页的扫描图（整页内容见页面预览）/);
    assert.match(message, /4 张是细长条（长宽比超过 8，多为分隔线或装饰）/);
    assert.match(message, /5 张几乎透明（多为阴影或装饰）/);
    assert.match(message, /6 张是单色渐隐的填充（色条、阴影等装饰）/);
    assert.match(message, /2 张小于 64×64 像素/);
    assert.match(message, /7 张与已保留的图片重复/);
  });

  test("a document with nothing skipped and nothing over the limit has no warning", () => {
    assert.deepEqual(embeddedWarnings({ section: section(), timedOut: false }), []);
  });

  test("a scan that ran out of time or memory says so", () => {
    const [timeout] = embeddedWarnings({
      section: section(),
      timedOut: true,
      pagesScanned: 7,
    });
    assert.match(timeout.message, /只扫描了前 7 页/);
    const [memory] = embeddedWarnings({
      section: section({ kept: 2 }),
      timedOut: false,
      stopped: "memory",
    });
    assert.match(memory.message, /只保留了已经提取的 2 张/);
  });
});
