import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  type Bounds,
  type DeckLayout,
  type PptdElement,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import {
  groupSelected,
  openSession,
  renderModel,
  selectElement,
  selectMany,
  setSelectedBounds,
  setSelectedOpacity,
  tabSelect,
  ungroupSelected,
  type CanvasSession,
} from "./index.js";

/*
 * A user's group and a layout's group may share a groupId: both are free text and the page keeps
 * the copies' groupId as it was written. A click on an own member must still select only the
 * page's own elements, and every command that works on the selection must leave a copy alone.
 */
const BOUNDS = "element.bounds.set";
const OPACITY = "element.opacity.set";
const GROUP = "element.group.set";
const UNGROUP = "element.ungroup.set";
const TAB = "selection.tab";
const CONTROLS = [BOUNDS, OPACITY, GROUP, UNGROUP, TAB];

function textBox(elementId: string, bounds: Bounds, groupId?: string): TextElement {
  const element: TextElement = { elementId, elementType: "text", bounds, content: { text: "x" } };
  if (groupId !== undefined) (element as { groupId?: string }).groupId = groupId;
  return element;
}

const BODY: DeckLayout = {
  id: "body",
  name: "正文",
  elements: [textBox("badge-a", [24, 12, 100, 30], "brand"), textBox("badge-b", [140, 12, 100, 30], "brand")],
};

/** Page 2 uses the layout and has its own group named like the layout's. */
function groupDeck(): CanvasSession {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-inherited-group-"));
  const project = createEmptyProject(dir, { title: "同名分组" });
  project.presentation.layouts = [BODY];
  listComposedPage(project, "pages/p1.page", {
    layoutId: "body",
    elements: [textBox("t", [0, 80, 90, 30])],
  });
  listComposedPage(project, "pages/p2.page", {
    layoutId: "body",
    elements: [
      textBox("card-a", [60, 200, 120, 40], "brand"),
      textBox("card-b", [200, 200, 120, 40], "brand"),
      textBox("solo", [60, 300, 120, 40]),
    ],
  });
  saveProject(project);
  const session = openSession(dir, { allowedControlIds: CONTROLS });
  session.pageIndex = 1;
  return session;
}

function element(session: CanvasSession, id: string): PptdElement {
  const found = session.project.pages[session.pageIndex]!.page.elements.find((item) => item.elementId === id);
  assert.ok(found, `${id} is on the page`);
  return found;
}

function selectedIds(session: CanvasSession): string[] {
  const selection = renderModel(session).selection;
  if (selection.kind === "element") return [selection.elementId];
  return selection.kind === "multi" ? selection.elementIds : [];
}

const COPIES = ["lyt-body-badge-a", "lyt-body-badge-b"];

describe("a group that shares its groupId with a layout's group (VAL-LAYOUT-006)", () => {
  it("materialises the copies with the layout's groupId", () => {
    const session = groupDeck();
    for (const id of COPIES) {
      assert.equal((element(session, id) as { groupId?: string }).groupId, "brand");
    }
  });

  it("a click on an own member selects the own group and no copy", () => {
    const session = groupDeck();
    selectElement(session, "card-a");
    assert.deepEqual(selectedIds(session), ["card-a", "card-b"]);
  });

  it("moves only the own group when it is dragged", () => {
    const session = groupDeck();
    selectElement(session, "card-a");
    setSelectedBounds(session, BOUNDS, [90, 200, 120, 40], "card-a");
    assert.deepEqual(element(session, "card-a").bounds, [90, 200, 120, 40]);
    assert.deepEqual(element(session, "card-b").bounds, [230, 200, 120, 40]);
    assert.deepEqual(element(session, "lyt-body-badge-a").bounds, [24, 12, 100, 30]);
    assert.deepEqual(element(session, "lyt-body-badge-b").bounds, [140, 12, 100, 30]);
  });

  it("styles only the own group", () => {
    const session = groupDeck();
    selectElement(session, "card-b");
    setSelectedOpacity(session, OPACITY, 0.4);
    assert.equal(element(session, "card-a").opacity, 0.4);
    assert.equal(element(session, "card-b").opacity, 0.4);
    for (const id of COPIES) assert.equal(element(session, id).opacity, undefined);
  });

  it("ungroups only the own group and keeps the copies' group", () => {
    const session = groupDeck();
    selectElement(session, "card-a");
    ungroupSelected(session, UNGROUP);
    assert.equal((element(session, "card-a") as { groupId?: string }).groupId, undefined);
    assert.equal((element(session, "card-b") as { groupId?: string }).groupId, undefined);
    for (const id of COPIES) {
      assert.equal((element(session, id) as { groupId?: string }).groupId, "brand");
    }
  });

  it("a command never reaches a copy, even if the selection names one", () => {
    const session = groupDeck();
    session.selection = {
      kind: "multi",
      pageIndex: session.pageIndex,
      elementIds: ["card-a", "lyt-body-badge-a"],
    };
    setSelectedOpacity(session, OPACITY, 0.25);
    assert.equal(element(session, "card-a").opacity, 0.25);
    assert.equal(element(session, "lyt-body-badge-a").opacity, undefined);
    session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: COPIES[0]! };
    assert.throws(() => setSelectedOpacity(session, OPACITY, 0.5), /no element selected/);
  });

  it("an own element that is the only own member of its group is a single selection", () => {
    const session = groupDeck();
    delete (element(session, "card-b") as { groupId?: string }).groupId;
    selectElement(session, "card-a");
    assert.deepEqual(selectedIds(session), ["card-a"]);
    assert.equal(renderModel(session).selection.kind, "element");
  });

  it("groups own elements without touching a copy", () => {
    const session = groupDeck();
    selectMany(session, ["solo", "card-a"]);
    const groupId = groupSelected(session, GROUP);
    assert.equal((element(session, "solo") as { groupId?: string }).groupId, groupId);
    for (const id of COPIES) {
      assert.equal((element(session, id) as { groupId?: string }).groupId, "brand");
    }
  });

  it("still refuses a direct pick of a copy and skips copies in bulk and Tab selection", () => {
    const session = groupDeck();
    assert.throws(() => selectElement(session, COPIES[0]!), /版式和母版的元素只能在版式中修改，不能在页面上选中/);
    selectMany(session, ["card-a", ...COPIES]);
    assert.deepEqual(selectedIds(session), ["card-a"]);
    const seen: string[] = [];
    session.selection = { kind: "none" };
    for (let i = 0; i < 4; i++) {
      tabSelect(session, TAB, 1);
      seen.push(...selectedIds(session));
    }
    assert.equal(
      seen.some((id) => COPIES.includes(id)),
      false,
    );
  });
});
