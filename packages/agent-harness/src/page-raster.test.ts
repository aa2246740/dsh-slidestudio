import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { createPageRasterPort, savePageRaster } from "./page-raster.js";

function stripedPng(): Buffer {
  // Minimal valid PNG header + we only need length > 64 for the port.
  const raw = Buffer.alloc(80, 7);
  raw[0] = 0x89;
  raw[1] = 0x50;
  raw[2] = 0x4e;
  raw[3] = 0x47;
  return raw;
}

describe("page raster", () => {
  it("is unavailable without editor URL or injected shot", async () => {
    const port = createPageRasterPort({ editorBaseUrl: undefined });
    assert.equal(port.available, false);
    const shot = await port.render({ projectRoot: "/tmp/missing-deck", pageIndex: 0 });
    assert.equal(shot.kind, "unavailable");
    assert.match(shot.note, /did not see the slide|unavailable/i);
  });

  it("writes a native-slide PNG from an injected screenshot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raster-"));
    createEmptyProject(dir, { title: "真页" });
    const bytes = stripedPng();
    const layout = {
      checked: true as const,
      fontsReady: true,
      footerZoneTop: 500,
      hardIssues: [],
      warnings: [],
      ok: true,
    };
    const port = createPageRasterPort({
      editorBaseUrl: "http://127.0.0.1:55200",
      screenshot: async () => ({ bytes, width: 960, height: 540, layout }),
    });
    assert.equal(port.available, true);
    const shot = await port.render({ projectRoot: dir, pageIndex: 0 });
    assert.equal(shot.kind, "native-slide");
    assert.ok(shot.bytes && shot.bytes.length >= 64);
    assert.deepEqual(shot.layout, layout);
    const saved = savePageRaster(dir, "page-01", shot.bytes!);
    assert.equal(saved.src, "_agent/rasters/page-01.png");
    assert.ok(fs.existsSync(saved.abs));
  });

  it("does not claim a native slide when the shot throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raster-fail-"));
    createEmptyProject(dir, { title: "失败" });
    const port = createPageRasterPort({
      editorBaseUrl: "http://127.0.0.1:55200",
      screenshot: async () => {
        throw new Error("browser down");
      },
    });
    const shot = await port.render({ projectRoot: dir, pageIndex: 0 });
    assert.equal(shot.kind, "unavailable");
    assert.match(shot.note, /did not see the slide/);
  });
});
