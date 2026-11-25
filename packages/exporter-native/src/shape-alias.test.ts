import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { createEmptyProject, listComposedPage, saveProject } from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";

test("exports rectangle as a native full-bounds rect without hiding real unknown degradation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-shape-alias-"));
  try {
    const project = createEmptyProject(dir, { title: "Shape aliases" });
    listComposedPage(project, "pages/cover.page", {
      pageType: "cover",
      elements: [
        {
          elementId: "alias-rectangle",
          elementType: "shape",
          shapeName: "rectangle",
          bounds: [0, 0, 960, 540],
          rotation: 45,
          flipH: true,
          flipV: true,
          fill: { type: "solid", color: "#123456" },
        },
        {
          elementId: "legacy-unknown",
          elementType: "shape",
          shapeName: "unknown-inset-placeholder",
          bounds: [40, 40, 80, 80],
          fill: { type: "solid", color: "#654321" },
        },
        {
          elementId: "canonical-decagon",
          elementType: "shape",
          shapeName: "decagon",
          bounds: [140, 40, 80, 80],
          fill: { type: "solid", color: "#456789" },
        },
      ],
    });
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const aliasDegradations = result.report.degradations.filter((row) => row.elementId === "alias-rectangle");
    assert.deepEqual(aliasDegradations, []);
    assert.equal(
      result.report.degradations.some((row) => row.elementId === "canonical-decagon"),
      false,
    );
    assert.ok(
      result.report.degradations.some((row) => row.elementId === "legacy-unknown" && row.kind === "shape-as-rect"),
    );

    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml);
    const aliasShapeXml = xml.match(/name="alias-rectangle"[\s\S]*?<\/p:sp>/)?.[0];
    assert.ok(aliasShapeXml);
    assert.match(aliasShapeXml, /<a:prstGeom prst="rect">/);
    assert.match(aliasShapeXml, /<a:xfrm[^>]*rot="2700000"/);
    assert.match(aliasShapeXml, /<a:xfrm[^>]*flipH="1"/);
    assert.match(aliasShapeXml, /<a:xfrm[^>]*flipV="1"/);
    assert.match(xml, /name="canonical-decagon"[\s\S]*?<a:prstGeom prst="decagon">/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
