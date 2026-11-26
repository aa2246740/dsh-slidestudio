import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeExportReport } from "../public/export-degradation-labels.js";
import { encodeExportReportHeader } from "./export-response.mjs";
import { exportWireReport, rasterWireReport } from "./export-wire-report.mjs";

const report = {
  ok: true,
  slideCount: 2,
  nativeCoverage: 0.9,
  degradations: [
    { slideIndex: 1, elementId: "pic", kind: "missing-image", reason: "image not found" },
    { slideIndex: 2, elementId: "box", kind: "shadow-not-exported", reason: "text shadow" },
  ],
  bytes: 1234,
  embeddedFonts: [{ typeface: "微软雅黑" }],
};

describe("export report wire", () => {
  it("keeps the degradation count and adds the kind of each degradation", () => {
    const wire = exportWireReport(report);
    assert.equal(wire.degradations, 2);
    assert.deepEqual(wire.degradationKinds, [{ kind: "missing-image" }, { kind: "shadow-not-exported" }]);
    assert.equal(wire.coverage, 0.9);
    assert.deepEqual(wire.embeddedFonts, [{ typeface: "微软雅黑" }]);
    assert.equal("skippedFonts" in wire, false);
    assert.equal(JSON.stringify(wire).includes("image not found"), false, "reasons stay private");
  });

  it("decodes the kinds the editor needs for the per-kind export lines", () => {
    const decoded = decodeExportReport(encodeExportReportHeader(exportWireReport(report)));
    assert.equal(decoded?.degradations, 2);
    assert.deepEqual(decoded?.degradationKinds, [{ kind: "missing-image" }, { kind: "shadow-not-exported" }]);
    assert.deepEqual(decoded?.embeddedFonts, [{ typeface: "微软雅黑" }]);
  });

  it("decodes an older count-only report without kinds, as JSON or base64url", () => {
    const plain = JSON.stringify({ ok: true, slideCount: 1, bytes: 9, degradations: 3 });
    for (const header of [plain, Buffer.from(plain, "utf8").toString("base64url")]) {
      const decoded = decodeExportReport(header);
      assert.equal(decoded?.degradations, 3);
      assert.equal(decoded?.degradationKinds, undefined);
    }
  });

  it("rejects a broken report instead of returning a partial one", () => {
    assert.equal(decodeExportReport(null), null);
    assert.equal(decodeExportReport(""), null);
    assert.equal(decodeExportReport("%%%"), null);
    assert.equal(decodeExportReport(JSON.stringify({ slideCount: 1, bytes: 2 })), null);
    assert.equal(decodeExportReport(JSON.stringify({ ok: true, slideCount: -1, bytes: 2 })), null);
    assert.equal(
      decodeExportReport(JSON.stringify({ ok: true, slideCount: 1, bytes: 2, degradationKinds: [{}] })),
      null,
    );
    assert.equal(decodeExportReport("x".repeat(70_000)), null);
  });

  it("raster exports report zero degradations and keep the raster kind", () => {
    const png = rasterWireReport({ slideCount: 1, bytes: 10, kind: "native-slide", layoutOk: null });
    assert.deepEqual(png, {
      ok: true,
      slideCount: 1,
      bytes: 10,
      degradations: 0,
      degradationKinds: [],
      kind: "native-slide",
      layoutOk: null,
    });
    const pdf = rasterWireReport({ slideCount: 3, bytes: 99 });
    assert.equal("kind" in pdf, false);
    assert.equal(decodeExportReport(encodeExportReportHeader(pdf))?.slideCount, 3);
  });
});
