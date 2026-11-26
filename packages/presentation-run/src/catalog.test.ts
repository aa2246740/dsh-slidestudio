import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildCatalogDto, resolveCatalogPreviewFile, resolveRepoRoot } from "./catalog.js";

// These tests read the actual pinned source pack and its real JPEG assets.
test("catalog joins every real preview to the exact guide linked by the pinned theme index", () => {
  const root = resolveRepoRoot();
  const index = fs.readFileSync(path.join(root, "vendor/open-kimi-ppt/skill-1.2.0/theme.md"), "utf8");
  const blocks = index.split(/^#### /m);
  const catalog = buildCatalogDto(root);
  assert.equal(catalog.styles.length, 44);
  assert.deepEqual(catalog.formats, [
    { kind: "Slides", layout: "16:9" },
    { kind: "Slides", layout: "4:3" },
  ]);
  assert.equal(new Set(catalog.styles.map((style) => style.id)).size, 44);
  for (const style of catalog.styles) {
    const matches = blocks.filter((block) => block.includes(`](docs/themes/${style.id}.jpg)`));
    assert.equal(matches.length, 1, `${style.id} must have one pinned index entry`);
    assert.ok(
      matches[0]!.includes(`](skills/open-kimi-ppt/${style.designSourceId.replace(/^openkimi:/, "")})`),
      `${style.id} must use its linked source, not a similar slug`,
    );
    assert.equal(style.category, style.id.split("/")[0]);
    for (const preview of style.previews) {
      const file = resolveCatalogPreviewFile(preview.sourceId, root);
      assert.ok(file);
      assert.equal(file.sha256, preview.hash);
      assert.equal(crypto.createHash("sha256").update(file.bytes).digest("hex"), preview.hash);
      assert.equal(file.byteLength, file.bytes.length);
      assert.equal(preview.url, `/slides/catalog/previews/${encodeURIComponent(preview.sourceId)}`);
    }
  }
});

test("unknown preview identities cannot become arbitrary file reads", () => {
  assert.equal(resolveCatalogPreviewFile("../../private-file", resolveRepoRoot()), null);
});
