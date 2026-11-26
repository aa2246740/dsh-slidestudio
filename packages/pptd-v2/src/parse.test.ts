import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  saveProject,
  titleOnlyCoverPage,
  PptdError,
} from "./parse.js";
import { resolveThemeColor } from "./theme.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pptd-v2-"));
}

describe("pptd-v2 load/save", () => {
  it("creates an empty project with zero composed pages and no host seed", () => {
    const dir = tmpDir();
    const created = createEmptyProject(dir, { title: "测试稿" });
    assert.equal(created.presentation.version, "v2");
    assert.ok(fs.existsSync(path.join(dir, "deck.pptd")));
    assert.equal(created.pages.length, 0);
    assert.deepEqual(created.presentation.pages, []);
    assert.equal(fs.existsSync(path.join(dir, "pages", "1_cover.page")), false);

    const loaded = loadProject(dir);
    assert.equal(loaded.presentation.title, "测试稿");
    assert.equal(loaded.pages.length, 0);
    assert.equal(
      loaded.presentation.pages.some((rel) => rel.replace(/\\/g, "/").split("/").pop() === "1_cover.page"),
      false,
    );
    const manifest = fs.readFileSync(path.join(dir, "deck.pptd"), "utf8");
    assert.doesNotMatch(manifest, /1_cover\.page/);
  });

  it("lists a page only after it is composed, then round-trips", () => {
    const dir = tmpDir();
    const created = createEmptyProject(dir, { title: "测试稿" });
    listComposedPage(created, "pages/cover.page", titleOnlyCoverPage("测试稿"));
    saveProject(created);

    const loaded = loadProject(dir);
    assert.equal(loaded.pages.length, 1);
    assert.equal(loaded.pages[0]!.path, "pages/cover.page");
    assert.equal(loaded.pages[0]!.page.elements[0]!.elementType, "text");
    assert.equal(
      loaded.presentation.pages.some((rel) => rel.replace(/\\/g, "/").split("/").pop() === "1_cover.page"),
      false,
    );

    const el = loaded.pages[0]!.page.elements[0] as {
      elementType: string;
      content: { text: string };
    };
    el.content.text = "改过的标题";
    saveProject(loaded);

    const again = loadProject(path.join(dir, "deck.pptd"));
    const t = again.pages[0]!.page.elements[0] as {
      content: { text: string };
    };
    assert.equal(t.content.text, "改过的标题");
  });

  it("re-reads a page after an external rewrite and never shares mutated objects", () => {
    const dir = tmpDir();
    const created = createEmptyProject(dir, { title: "缓存回归" });
    listComposedPage(created, "pages/cover.page", titleOnlyCoverPage("原标题"));
    saveProject(created);

    const first = loadProject(dir);
    (first.pages[0]!.page.elements[0] as { content: { text: string } }).content.text = "内存里改掉";
    // The cached parse must hand out fresh objects: mutating a returned
    // project must not leak into the next read of the unchanged file.
    const second = loadProject(dir);
    assert.equal((second.pages[0]!.page.elements[0] as { content: { text: string } }).content.text, "原标题");

    // External rewrite (editor/hand edit) — stat signature changes, cache
    // misses, new content wins.
    const pageFile = path.join(dir, "pages", "cover.page");
    fs.writeFileSync(pageFile, fs.readFileSync(pageFile, "utf8").replace("原标题", "外部改过的"));
    const third = loadProject(dir);
    assert.equal((third.pages[0]!.page.elements[0] as { content: { text: string } }).content.text, "外部改过的");
  });

  it("loads syn-smoke fixture", () => {
    const project = loadProject(path.join(repoRoot, "fixtures/syn-smoke"));
    assert.equal(project.pages.length, 2);
    assert.ok(project.pages[1]!.page.elements.some((e) => e.elementType === "chart"));
    assert.ok(project.pages[1]!.page.elements.some((e) => e.elementType === "table"));
  });

  it("loads syn-shapes compare sheet", () => {
    const project = loadProject(path.join(repoRoot, "fixtures/syn-shapes"));
    assert.equal(project.pages.length, 1);
    const names = project.pages[0]!.page.elements.filter((e) => e.elementType === "shape").map(
      (e) => (e as { shapeName?: string }).shapeName,
    );
    for (const n of ["rect", "roundRect", "ellipse", "triangle", "rightArrow", "accentBorderCallout1"]) {
      assert.ok(names.includes(n), n);
    }
  });

  it("loads recovered open-kimi okp-yu7 fixture", () => {
    const project = loadProject(path.join(repoRoot, "fixtures/okp-yu7-ppt"));
    assert.ok(project.pages.length >= 6);
    assert.match(project.presentation.title ?? "", /YU7|小米/);
    assert.ok(project.presentation.theme?.colors?.primary);
  });

  it("rejects non-v2", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "deck.pptd"), "version: v1\nsize: [960, 540]\npages: [pages/a.page]\n");
    assert.throws(() => loadProject(dir), PptdError);
  });

  it("rejects path escape", () => {
    const dir = tmpDir();
    createEmptyProject(dir);
    fs.writeFileSync(path.join(dir, "deck.pptd"), "version: v2\nsize: [960, 540]\npages:\n  - ../outside.page\n");
    assert.throws(() => loadProject(dir), /escapes/);
  });
});

describe("resolveThemeColor", () => {
  it("resolves $token", () => {
    assert.equal(resolveThemeColor("$primary", { colors: { primary: "#2563EB" } }), "#2563EB");
  });
});
