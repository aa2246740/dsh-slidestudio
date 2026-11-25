import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  saveProject,
  titleOnlyCoverPage,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import {
  openSession,
  selectElement,
  setSelectedRichText,
  setSelectedTextRangeStyle,
  setSelectedTextStyle,
  persist,
  renderModel,
  undo,
  insertTable,
  mergeTableCells,
} from "./index.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-"));
}

function listedCoverProject(dir: string, opts: { title?: string } = {}): PptdProject {
  const title = opts.title ?? "Untitled";
  const project = createEmptyProject(dir, { title });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage(title));
  saveProject(project);
  return project;
}

const ALLOW = [
  "element.text.content.set",
  "element.text.toolbar.bold.toggle",
  "element.bounds.set",
  "chrome.history.undo",
  "chrome.history.redo",
];

describe("canvas-session rich text and table merge", () => {
  it("range style writes spans into saved YAML and undoes", () => {
    const dir = tmp();
    listedCoverProject(dir, { title: "Hello" });
    const s = openSession(dir, { allowedControlIds: ALLOW });
    selectElement(s, "title");
    setSelectedTextRangeStyle(s, "element.text.toolbar.bold.toggle", 0, 2, {
      bold: true,
      color: "#FF6900",
    });
    persist(s);
    const saved = (loadProject(dir).pages[0]!.page.elements[0] as { content: { text: string; bold?: boolean } })
      .content;
    assert.match(saved.text, /<span style="/);
    assert.match(saved.text, /font-weight:700/);
    assert.match(saved.text, /#FF6900/);
    assert.equal(saved.bold, undefined);
    const model = renderModel(s);
    assert.equal(model.elements[0]!.text, "Hello");
    assert.equal(model.elements[0]!.runs?.[0]!.text, "He");
    assert.equal(model.elements[0]!.runs?.[0]!.bold, true);
    assert.equal(model.elements[0]!.runs?.[0]!.underline, undefined);
    undo(s);
    const restored = (s.project.pages[0]!.page.elements[0] as { content: { text: string } }).content.text;
    assert.equal(restored, "Hello");
  });

  it("sanitizes rich text by stripping script and unknown attrs", () => {
    const dir = tmp();
    listedCoverProject(dir, { title: "Hi" });
    const s = openSession(dir, { allowedControlIds: ALLOW });
    selectElement(s, "title");
    setSelectedRichText(
      s,
      "element.text.content.set",
      '<p><span onclick="alert(1)" style="font-weight:700">Hi</span><script>evil()</script></p>',
    );
    persist(s);
    const text = (loadProject(dir).pages[0]!.page.elements[0] as { content: { text: string } }).content.text;
    assert.doesNotMatch(text, /onclick/i);
    assert.doesNotMatch(text, /script/i);
    assert.doesNotMatch(text, /evil/i);
    assert.match(text, /font-weight:700/);
    assert.match(text, /Hi/);
    const model = renderModel(s);
    assert.equal(model.elements[0]!.text, "Hi");
    assert.equal(model.elements[0]!.runs?.[0]!.bold, true);
  });

  it("rejects unsafe text link protocols before mutating session state", () => {
    const dir = tmp();
    listedCoverProject(dir, { title: "Link" });
    const s = openSession(dir, {
      allowedControlIds: ["element.text.toolbar.link.set", "chrome.history.undo", "chrome.history.redo"],
    });
    selectElement(s, "title");
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "java\nscript:alert(1)",
      "http://[",
    ]) {
      const before = structuredClone(s);
      assert.throws(
        () => setSelectedTextStyle(s, "element.text.toolbar.link.set", { href }),
        /unsafe|control characters|malformed/,
      );
      assert.deepEqual(s, before, `rejected href must not mutate session: ${href}`);
    }

    for (const href of [
      "https://example.com/guide",
      "http://example.com",
      "mailto:owner@example.com",
      "tel:+8613800138000",
      "../relative/page",
      "#section",
    ]) {
      setSelectedTextStyle(s, "element.text.toolbar.link.set", { href });
      assert.equal(renderModel(s).elements[0]!.href, href);
    }
    setSelectedTextStyle(s, "element.text.toolbar.link.set", { href: null });
    assert.equal(renderModel(s).elements[0]!.href, undefined);
  });

  it("rejects single and partial-overlap table merges but absorbs fully contained merges", () => {
    const dir = tmp();
    listedCoverProject(dir, { title: "Table" });
    const s = openSession(dir, {
      allowedControlIds: ["insert.table", "element.table.merge", "chrome.history.undo", "chrome.history.redo"],
    });
    const id = insertTable(s, "insert.table");

    const beforeSingle = structuredClone(s);
    assert.throws(() => mergeTableCells(s, "element.table.merge", 0, 0, 0, 0), /at least two cells/);
    assert.deepEqual(s, beforeSingle, "single-cell merge must not mutate session or undo history");

    mergeTableCells(s, "element.table.merge", 0, 1, 1, 1);
    let table = renderModel(s).elements.find((element) => element.id === id)!;
    assert.equal(table.tableRows![0]![1]!.rowSpan, 2);
    assert.equal(table.tableRows![0]![1]!.colSpan, 1);

    const beforePartial = structuredClone(s);
    assert.throws(() => mergeTableCells(s, "element.table.merge", 0, 0, 0, 1), /partially overlaps merged cell 0,1/);
    assert.deepEqual(s, beforePartial, "partial overlap must not mutate session or undo history");

    mergeTableCells(s, "element.table.merge", 0, 0, 1, 1);
    table = renderModel(s).elements.find((element) => element.id === id)!;
    assert.equal(table.tableRows![0]![0]!.rowSpan, 2);
    assert.equal(table.tableRows![0]![0]!.colSpan, 2);
    assert.equal(table.tableRows![0]![1]!.rowSpan, undefined);
    assert.equal(table.tableRows![0]![1]!.colSpan, undefined);
  });
});
