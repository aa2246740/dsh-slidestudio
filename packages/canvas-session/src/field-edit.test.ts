import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  parseRichText,
  saveProject,
  type Bounds,
  type DeckLayout,
  type DeckMaster,
  type RichTextRun,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import {
  enterLayout,
  enterMaster,
  openSession,
  persist,
  renderModel,
  selectElement,
  setSelectedRichText,
  setSelectedTextRangeStyle,
  type CanvasSession,
  type RenderElement,
} from "./index.js";

/*
 * A page-number field shows a number but stores a token. The editor fills its text box from the
 * render model and sends offsets back for range styles, so the offsets must be in the stored text:
 * a range over the shown number must never split `{page}`.
 */
const RANGE = "element.text.range.set";
const RICH = "element.text.content.set";
const CONTROLS = [RANGE, RICH, "theme.layout.enter", "theme.layout.exit"];

function fieldText(elementId: string, text: string, bounds: Bounds): TextElement {
  return {
    elementId,
    elementType: "text",
    bounds,
    content: { text, field: "pageNumber", fontSize: 12 },
  };
}

function plainText(elementId: string, text: string, bounds: Bounds): TextElement {
  return { elementId, elementType: "text", bounds, content: { text } };
}

const MASTER: DeckMaster = {
  id: "main",
  name: "母版",
  elements: [fieldText("pageno", "第 {page} 页", [880, 506, 60, 22])],
};
const BODY: DeckLayout = {
  id: "body",
  name: "正文",
  masterId: "main",
  elements: [fieldText("foot", "页 {page}", [40, 506, 200, 22])],
};

const OWN_TEXT = "页 {page} / {pages}";
const OWN_SHOWN = "页 2 / 3";

/** Three body pages; page 2 has a page-owned field and an ordinary text with a literal token. */
function fieldDeck(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-field-edit-"));
  const project = createEmptyProject(dir, { title: "页码编辑" });
  project.presentation.masters = [MASTER];
  project.presentation.layouts = [BODY];
  for (let n = 1; n <= 3; n++) {
    const elements = [plainText("title", `第 ${n} 页`, [60, 80, 600, 60])];
    if (n === 2) {
      elements.push(
        fieldText("own-number", OWN_TEXT, [60, 300, 400, 30]),
        plainText("literal", "{page} 原样", [60, 400, 300, 30]),
      );
    }
    listComposedPage(project, `pages/p${n}.page`, { layoutId: "body", elements });
  }
  saveProject(project);
  return dir;
}

/** The deck's second page, with its field selected as a click would leave it. */
function pageTwo(): { dir: string; session: CanvasSession } {
  const dir = fieldDeck();
  const session = openSession(dir, { allowedControlIds: CONTROLS });
  session.pageIndex = 1;
  selectElement(session, "own-number");
  return { dir, session };
}

function shown(session: CanvasSession, id: string): RenderElement {
  const element = renderModel(session).elements.find((item) => item.id === id);
  assert.ok(element, `${id} is on the surface`);
  return element;
}

/** The text a page-owned element stores, in memory. */
function storedOnPage(session: CanvasSession, id: string): string {
  const element = session.project.pages[session.pageIndex]!.page.elements.find((item) => item.elementId === id);
  return (element as TextElement).content.text;
}

/** The text the editor fills its box with: the stored text of a field, else what is shown. */
function editorText(element: RenderElement): string {
  return element.edit?.text ?? element.text ?? "";
}

/** The offsets of `needle` in the text the editor edits. */
function editRange(element: RenderElement, needle: string): [number, number] {
  assert.ok(element.edit, `${element.id} has a stored-text editing projection`);
  const at = element.edit.text.indexOf(needle);
  assert.ok(at >= 0, `${needle} is in the editing text`);
  return [at, at + needle.length];
}

/** The stored runs that hold part of `token`; a whole token sits in exactly one run. */
function runsHolding(stored: string, token: string): RichTextRun[] {
  return parseRichText(stored).filter((run) => run.text.includes(token));
}

describe("a page-number field is edited in its stored text", () => {
  it("gives the editor the stored text while the shown text keeps the number", () => {
    const { session } = pageTwo();
    const own = shown(session, "own-number");
    assert.equal(own.text, OWN_SHOWN);
    assert.ok(own.edit, "the field has an editing projection");
    assert.equal(own.edit.text, OWN_TEXT);
    assert.equal(own.edit.runs.map((run) => run.text).join(""), OWN_TEXT);
  });

  it("bold over the stored token keeps {page} whole and shows the number bold", () => {
    const { dir, session } = pageTwo();
    const [start, end] = editRange(shown(session, "own-number"), "{page}");
    setSelectedTextRangeStyle(session, RANGE, start, end, { bold: true });
    const stored = storedOnPage(session, "own-number");
    const holding = runsHolding(stored, "{page}");
    assert.equal(holding.length, 1, "the token is in one run");
    assert.equal(holding[0]!.text, "{page}");
    assert.equal(holding[0]!.bold, true);
    assert.equal(
      parseRichText(stored)
        .map((run) => run.text)
        .join(""),
      OWN_TEXT,
    );
    const after = shown(session, "own-number");
    assert.equal(after.text, OWN_SHOWN);
    assert.deepEqual(
      after.runs?.map((run) => [run.text, run.bold === true]),
      [
        ["页 ", false],
        ["2", true],
        [" / 3", false],
      ],
      "prefix, number and suffix are all correct and only the number is bold",
    );
    persist(session);
    const saved = loadProject(dir).pages[1]!.page.elements.find(
      (item) => item.elementId === "own-number",
    ) as TextElement;
    assert.equal(runsHolding(saved.content.text, "{page}")[0]?.text, "{page}");
  });

  it("bold over the whole text, the editor's default selection, keeps both tokens whole", () => {
    const { session } = pageTwo();
    const own = shown(session, "own-number");
    setSelectedTextRangeStyle(session, RANGE, 0, editorText(own).length, { bold: true });
    const stored = storedOnPage(session, "own-number");
    assert.equal(runsHolding(stored, "{page}").length, 1);
    assert.equal(runsHolding(stored, "{pages}").length, 1);
    assert.equal(shown(session, "own-number").text, OWN_SHOWN);
  });

  it("a range that cuts into a token is widened to the whole token", () => {
    const { session } = pageTwo();
    const [start] = editRange(shown(session, "own-number"), "{page}");
    // From the middle of {page} into the text after it.
    setSelectedTextRangeStyle(session, RANGE, start + 2, start + 9, { italic: true });
    const holding = runsHolding(storedOnPage(session, "own-number"), "{page}");
    assert.equal(holding.length, 1, "the token is not split");
    assert.equal(holding[0]!.text.startsWith("{page}"), true);
    assert.equal(holding[0]!.italic, true);
    assert.equal(shown(session, "own-number").text, OWN_SHOWN);
  });

  it("saving the editor's text with an appended character keeps the field live", () => {
    const { session } = pageTwo();
    const own = shown(session, "own-number");
    // The editor saves what it holds, which is the editing text plus what was typed.
    setSelectedRichText(session, RICH, `${editorText(own)}!`);
    assert.equal(storedOnPage(session, "own-number"), `${OWN_TEXT}!`);
    assert.equal(shown(session, "own-number").text, `${OWN_SHOWN}!`);
  });

  it("a layout's field is edited as {page} while the layout shows the number mark", () => {
    const dir = fieldDeck();
    const session = openSession(dir, { allowedControlIds: CONTROLS });
    session.pageIndex = 1;
    enterLayout(session, "theme.layout.enter", "body", "foot");
    const foot = shown(session, "foot");
    assert.equal(foot.text, "页 ‹#›");
    const [start, end] = editRange(foot, "{page}");
    setSelectedTextRangeStyle(session, RANGE, start, end, { bold: true });
    persist(session);
    const layout = loadProject(dir).presentation.layouts?.find((item) => item.id === "body");
    const stored = layout?.elements.find((item) => item.elementId === "foot") as TextElement;
    assert.equal(runsHolding(stored.content.text, "{page}")[0]?.text, "{page}");
    assert.equal(shown(session, "foot").text, "页 ‹#›");
  });

  it("the master's field is edited as {page} too", () => {
    const dir = fieldDeck();
    const session = openSession(dir, { allowedControlIds: CONTROLS });
    enterMaster(session, "theme.layout.enter", "pageno");
    const number = shown(session, "pageno");
    assert.equal(number.text, "第 ‹#› 页");
    const [start, end] = editRange(number, "{page}");
    setSelectedTextRangeStyle(session, RANGE, start, end, { bold: true });
    persist(session);
    const master = loadProject(dir).presentation.masters?.[0];
    const stored = master?.elements.find((item) => item.elementId === "pageno") as TextElement;
    assert.equal(runsHolding(stored.content.text, "{page}")[0]?.text, "{page}");
  });

  it("an ordinary text with a literal token has no projection and edits as shown", () => {
    const { session } = pageTwo();
    assert.equal(shown(session, "literal").edit, undefined);
    selectElement(session, "literal");
    setSelectedTextRangeStyle(session, RANGE, 0, 6, { bold: true });
    assert.equal(shown(session, "literal").text, "{page} 原样");
    assert.equal(runsHolding(storedOnPage(session, "literal"), "{page}").length, 1);
  });
});
