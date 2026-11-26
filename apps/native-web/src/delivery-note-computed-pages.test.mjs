import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildSystemDeliveryNote,
  cleanupScratchRoots,
  scratchProject,
  writeSealedAgentDir,
} from "./delivery-note-test-fixture.mjs";

const UNEXPLAINED = /没有说明来源/;

/** @param {string} pageId @param {Record<string, unknown>} [overrides] */
function page(pageId, overrides = {}) {
  return {
    pageId,
    title: pageId,
    declared: null,
    detected: null,
    visionValues: [],
    queries: [],
    ...overrides,
  };
}

/** @param {unknown[]} pages */
function noteFor(pages) {
  const projectRoot = scratchProject("delivery-note-computed-");
  writeSealedAgentDir(projectRoot, "24-page");
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "delivery-provenance.v1.json"),
    JSON.stringify({
      schema: "delivery-provenance/v1",
      contextEpochId: "epoch-computed",
      deckSha256: "c".repeat(64),
      materials: [],
      design: {
        stylePriority: "agent",
        designSystemId: null,
        adoptedSourceIds: [],
        designAspects: [],
        userColors: [],
        components: [],
        styleHintsUsed: [],
      },
      images: [],
      pages,
      data: {},
      conflicts: [],
      layouts: [],
    }),
  );
  return buildSystemDeliveryNote({ projectRoot });
}

afterEach(cleanupScratchRoots);

describe("pages whose numbers come from table computation", () => {
  it("lists a page with computed figures and no detection on its own line, not as unexplained", () => {
    const note = noteFor([
      page("01_cover"),
      page("02_trend", { computedFigureCount: 8 }),
      page("03_plan"),
      page("04_summary", { computedFigureCount: 3 }),
    ]);

    assert.ok(note?.lines.includes("由表格计算得到数字的页：第 2 页（8 个）；第 4 页（3 个）。"));
    assert.ok(note?.lines.includes("没有说明来源，也未检测到资料数字的页：第 1、3 页。"));
  });

  it("drops the unexplained line when every page is covered by computation", () => {
    const note = noteFor([page("01_a", { computedFigureCount: 2 })]);

    assert.ok(note?.lines.includes("由表格计算得到数字的页：第 1 页（2 个）。"));
    assert.equal(
      note?.lines.some((line) => UNEXPLAINED.test(line)),
      false,
    );
  });

  it("keeps the detection line for a page that has both, without repeating it as computed", () => {
    const note = noteFor([
      page("01_data", {
        computedFigureCount: 5,
        detected: { quotedCount: 2, sourcePages: [4], periodMismatch: null },
      }),
    ]);

    assert.ok(note?.lines.includes("与资料数字完全一致的页：第 1 页（2 个数字，来自资料第 4 页）。"));
    assert.equal(
      note?.lines.some((line) => line.startsWith("由表格计算得到数字的页")),
      false,
    );
  });

  it("still discloses a mock declaration on a page whose figures are computed", () => {
    const note = noteFor([page("01_mock", { declared: { basis: "mock" }, computedFigureCount: 4 })]);

    assert.ok(note?.lines.includes("由表格计算得到数字的页：第 1 页（4 个）。"));
    assert.ok(note?.lines.includes("标为示意数据的页：第 1 页。"));
    assert.equal(
      note?.lines.some((line) => UNEXPLAINED.test(line)),
      false,
    );
  });

  it("ignores a computed count that is zero, negative or not a whole number", () => {
    const note = noteFor([
      page("01_zero", { computedFigureCount: 0 }),
      page("02_negative", { computedFigureCount: -3 }),
      page("03_fraction", { computedFigureCount: 1.5 }),
    ]);

    assert.equal(
      note?.lines.some((line) => line.startsWith("由表格计算得到数字的页")),
      false,
    );
    assert.ok(note?.lines.includes("没有说明来源，也未检测到资料数字的页：第 1–3 页。"));
  });
});
