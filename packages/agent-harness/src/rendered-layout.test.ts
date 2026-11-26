import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessRenderedLayout, type RenderedLayoutSnapshot } from "./page-raster.js";

function snapshot(overrides: Partial<RenderedLayoutSnapshot> = {}): RenderedLayoutSnapshot {
  return {
    slideWidth: 960,
    slideHeight: 540,
    fontsReady: true,
    nodes: [
      {
        id: "body",
        type: "text",
        layoutRole: "content",
        left: 80,
        top: 80,
        right: 400,
        bottom: 220,
        scrollWidth: 320,
        clientWidth: 320,
        scrollHeight: 140,
        clientHeight: 140,
      },
      {
        id: "footer",
        type: "text",
        layoutRole: "footer",
        left: 640,
        top: 508,
        right: 920,
        bottom: 528,
        scrollWidth: 280,
        clientWidth: 280,
        scrollHeight: 20,
        clientHeight: 20,
      },
    ],
    ...overrides,
  };
}

describe("rendered layout diagnostics", () => {
  it("accepts content above the footer reserve and a footer inside it", () => {
    const report = assessRenderedLayout(snapshot());
    assert.equal(report.ok, true);
    assert.equal(report.footerZoneTop, 500);
  });

  it("reports only high-confidence hard layout faults", () => {
    const report = assessRenderedLayout(
      snapshot({
        fontsReady: false,
        nodes: [
          {
            id: "overflowing-body",
            type: "text",
            layoutRole: "content",
            left: -1,
            top: 490,
            right: 980,
            bottom: 550,
            scrollWidth: 500,
            clientWidth: 300,
            scrollHeight: 120,
            clientHeight: 40,
          },
        ],
      }),
    );
    assert.equal(report.ok, false);
    assert.deepEqual(report.hardIssues.map((issue) => issue.kind).sort(), [
      "element-outside-slide",
      "font-not-ready",
      "non-footer-text-in-footer-zone",
      "text-overflow-x",
      "text-overflow-y",
    ]);
  });

  it("skips overflow on a layout copy the page cannot fix, but keeps its overlap", () => {
    const copy = {
      ...snapshot().nodes[0]!,
      id: "lyt-body-title",
      inherited: true,
      scrollWidth: 500,
      scrollHeight: 200,
    };
    const own = { ...snapshot().nodes[0]!, id: "own-title", left: 300, right: 520 };
    const report = assessRenderedLayout(snapshot({ nodes: [copy, own] }));
    assert.equal(
      report.hardIssues.some((issue) => issue.kind.startsWith("text-overflow")),
      false,
    );
    assert.ok(
      report.hardIssues.some(
        (issue) => issue.kind === "text-collision" && issue.elementId === "lyt-body-title,own-title",
      ),
      JSON.stringify(report.hardIssues),
    );
  });

  it("does not let a footer role whitelist text that starts in the body zone", () => {
    const report = assessRenderedLayout(
      snapshot({
        nodes: [
          {
            ...snapshot().nodes[1]!,
            top: 490,
            bottom: 510,
          },
        ],
      }),
    );
    assert.equal(report.ok, false);
    assert.equal(report.hardIssues[0]?.kind, "footer-outside-footer-zone");
  });

  it("blocks material text-on-text collisions", () => {
    const report = assessRenderedLayout(
      snapshot({
        nodes: [
          snapshot().nodes[0]!,
          {
            ...snapshot().nodes[0]!,
            id: "overlap",
            left: 300,
            right: 520,
          },
        ],
      }),
    );
    assert.equal(report.ok, false);
    assert.equal(report.hardIssues[0]?.kind, "text-collision");
  });

  it("blocks horizontal rules that visually crowd the text below them", () => {
    const report = assessRenderedLayout(
      snapshot({
        nodes: [
          {
            id: "section-rule",
            type: "rule",
            layoutRole: "decoration",
            left: 72,
            top: 310,
            right: 888,
            bottom: 311,
            scrollWidth: 816,
            clientWidth: 816,
            scrollHeight: 1,
            clientHeight: 1,
          },
          {
            id: "section-label",
            type: "text",
            layoutRole: "content",
            left: 72,
            top: 322,
            right: 888,
            bottom: 338,
            scrollWidth: 816,
            clientWidth: 816,
            scrollHeight: 16,
            clientHeight: 16,
          },
        ],
      }),
    );
    assert.equal(report.ok, false);
    assert.ok(
      report.hardIssues.some(
        (issue) => String(issue.kind) === "line-text-clearance" && issue.elementId === "section-rule,section-label",
      ),
      JSON.stringify(report.hardIssues),
    );

    const crossing = assessRenderedLayout(
      snapshot({
        nodes: [
          {
            id: "crossing-rule",
            type: "rule",
            layoutRole: "decoration",
            left: 72,
            top: 328,
            right: 888,
            bottom: 329,
            scrollWidth: 816,
            clientWidth: 816,
            scrollHeight: 1,
            clientHeight: 1,
          },
          {
            id: "crossed-label",
            type: "text",
            layoutRole: "content",
            left: 72,
            top: 322,
            right: 888,
            bottom: 338,
            scrollWidth: 816,
            clientWidth: 816,
            scrollHeight: 16,
            clientHeight: 16,
          },
        ],
      }),
    );
    assert.ok(
      crossing.hardIssues.some(
        (issue) => String(issue.kind) === "line-text-intersection" && issue.elementId === "crossing-rule,crossed-label",
      ),
      JSON.stringify(crossing.hardIssues),
    );
  });

  it("blocks normal text below 4.5:1 and accepts high-contrast text", () => {
    const failing = assessRenderedLayout(
      snapshot({
        nodes: [
          {
            ...snapshot().nodes[0]!,
            textColor: "rgb(0, 0, 0)",
            backgroundColor: "rgb(14, 42, 71)",
            contrastRatio: 1.44,
            requiredContrast: 4.5,
          },
        ],
      }),
    );
    assert.equal(failing.ok, false);
    assert.equal(failing.hardIssues[0]?.kind, "text-contrast");

    const passing = assessRenderedLayout(
      snapshot({
        nodes: [
          {
            ...snapshot().nodes[0]!,
            textColor: "rgb(244, 236, 221)",
            backgroundColor: "rgb(14, 42, 71)",
            contrastRatio: 12.42,
            requiredContrast: 4.5,
          },
        ],
      }),
    );
    assert.equal(passing.ok, true);
  });

  it("uses the supplied 3:1 threshold only for text classified as large", () => {
    const large = assessRenderedLayout(
      snapshot({
        nodes: [
          {
            ...snapshot().nodes[0]!,
            contrastRatio: 3.2,
            requiredContrast: 3,
          },
        ],
      }),
    );
    assert.equal(large.ok, true);
    const normal = assessRenderedLayout(
      snapshot({
        nodes: [
          {
            ...snapshot().nodes[0]!,
            contrastRatio: 3.2,
            requiredContrast: 4.5,
          },
        ],
      }),
    );
    assert.equal(normal.ok, false);
    assert.equal(normal.hardIssues[0]?.kind, "text-contrast");
  });
});
