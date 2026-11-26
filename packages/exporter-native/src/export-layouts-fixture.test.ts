import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportProjectToPptx } from "./export-pptd.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const committed = path.join(repoRoot, "test-fixtures", "layouts-project");

describe("export-native on the committed layouts fixture", () => {
  it("exports all 24 pages of the <P_LYT> structure as one readable package", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-layouts-fixture-"));
    try {
      fs.cpSync(committed, dir, { recursive: true });
      const result = await exportProjectToPptx(dir);
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(result.data);
      const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
      assert.equal(slides.length, 24);
      const cover = await zip.file("ppt/slides/slide1.xml")?.async("string");
      assert.ok(cover?.includes("封面标题"), "the cover keeps its own title text");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
