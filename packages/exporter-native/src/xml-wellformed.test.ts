import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { exportProjectToPptx } from "./export-pptd.js";
import { createEmptyProject, listComposedPage, saveProject } from "@open-slidestudio/pptd-v2";
import { assertWellFormedXml } from "./xml-lint.js";

function buildFixtureProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptd-export-xml-"));
  const project = createEmptyProject(dir, { title: 'XML <check> & "quotes"' });
  listComposedPage(project, "pages/p1.page", {
    background: { type: "solid", color: "#FFFFFF" },
    elements: [
      {
        elementId: "t1",
        elementType: "text",
        bounds: [40, 40, 600, 80],
        content: {
          text: 'Fish & Chips <fast> "quoted"',
          fontSize: 28,
          color: "#111111",
          fontFamily: { latin: 'A & B "Odd"', ea: "宋体" },
        },
      },
      {
        elementId: "s1",
        elementType: "shape",
        shapeName: "roundRect",
        bounds: [40, 160, 300, 120],
        fill: { type: "solid", color: "#0057FF" },
        border: { color: "#111111", width: 2, style: "dash" },
      },
      {
        elementId: "tb1",
        elementType: "table",
        bounds: [40, 320, 600, 240],
        columnWidths: [2, 1, 1],
        rowHeights: [1, 1],
        rows: [
          [{ text: "a", colSpan: 2, bold: true }, { text: "" }, { text: "b" }],
          [{ text: "c & <d>" }, { text: "e", fill: { type: "solid", color: "#EEEEEE" } }, { text: "f", rowSpan: 1 }],
        ],
      },
    ],
  });
  saveProject(project);
  return dir;
}

/** Resolve once the wall clock has entered a different two-second slot (DOS time resolution). */
async function nextTwoSecondSlot(): Promise<void> {
  const slot = Math.floor(Date.now() / 2000);
  while (Math.floor(Date.now() / 2000) === slot) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("exported pptx xml well-formedness", () => {
  it("every xml/rels part in the package is well-formed", async () => {
    const dir = buildFixtureProject();
    const { data, report } = await exportProjectToPptx(dir);
    assert.equal(report.ok, true, JSON.stringify(report.degradations));
    const zip = await JSZip.loadAsync(data);
    const xmlParts = Object.keys(zip.files).filter((n) => n.endsWith(".xml") || n.endsWith(".rels"));
    assert.ok(xmlParts.length > 5, "expected several xml parts");
    for (const part of xmlParts) {
      const xml = await zip.files[part]!.async("string");
      assertWellFormedXml(xml, part);
    }
  });

  it("docProps timestamps are pinned for reproducible output", async () => {
    const dir = buildFixtureProject();
    const a = await exportProjectToPptx(dir);
    // Zip entries carry DOS times with two-second resolution: the second export
    // must land in a later slot, or the test passes by accident.
    await nextTwoSecondSlot();
    const b = await exportProjectToPptx(dir);
    const zip = await JSZip.loadAsync(a.data);
    const core = await zip.files["docProps/core.xml"]!.async("string");
    assert.match(core, /<dcterms:created[^>]*>2000-01-01T00:00:00Z</);
    assert.deepEqual(a.data, b.data);
  });
});
