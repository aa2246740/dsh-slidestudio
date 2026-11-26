import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LAYOUT_DEFINITION_MISSING,
  LAYOUT_MASTER_REFUSAL,
  layoutEditInstruction,
  layoutEditTarget,
  layoutLockScope,
} from "../public/layout-edit-turn.js";
import { STALE_PAGE_TARGET } from "../public/work-agent-scope.js";

/** @param {Record<string, unknown>} [overrides] */
const layoutModel = (overrides = {}) => ({
  layoutPanel: { surface: { kind: "layout", layoutId: "body", name: "正文", useCount: 2 } },
  pagePaths: ["pages/01_page.page", "pages/02_page.page", "pages/03_page.page"],
  pageIndex: 1,
  ...overrides,
});

describe("layout-mode AI turn target", () => {
  it("locks the layout on screen, anchored on the current page", () => {
    const target = layoutEditTarget(layoutModel());
    assert.ok(target?.ok);
    assert.equal(target.scope, "page");
    assert.deepEqual(target.editableMeta, ["layouts"]);
    assert.equal(target.layoutId, "body");
    assert.equal(target.layoutName, "正文");
    assert.equal(target.pageIndex, 1);
    assert.equal(target.pagePath, "pages/02_page.page");
    assert.deepEqual(target.pagePaths, ["pages/02_page.page"]);
    assert.equal(target.targetPageId, "02_page");
    assert.deepEqual(target.targetPageIds, ["02_page"]);
    assert.deepEqual(target.elementIds, []);
    assert.equal(target.label, "修改范围：版式『正文』");
    assert.deepEqual(layoutLockScope(target), { editableMeta: ["layouts"], layoutId: "body" });
  });

  it("clamps a page index past the deck onto its last page", () => {
    const target = layoutEditTarget(layoutModel({ pageIndex: 9 }));
    assert.equal(target?.ok && target.targetPageId, "03_page");
  });

  it("is null on a page, so the assistant-intent target applies", () => {
    assert.equal(layoutEditTarget(layoutModel({ layoutPanel: { surface: { kind: "page" } } })), null);
    assert.equal(layoutEditTarget({}), null);
    assert.equal(layoutEditTarget(null), null);
  });

  it("refuses a master, which no AI turn may edit", () => {
    const target = layoutEditTarget(
      layoutModel({ layoutPanel: { surface: { kind: "master", id: "m", name: "母版" } } }),
    );
    assert.equal(target?.ok, false);
    assert.equal(target && !target.ok && target.error, LAYOUT_MASTER_REFUSAL);
    assert.equal(target?.scope, "invalid");
    assert.match(target?.label ?? "", /^无法发送 · 母版/);
  });

  it("refuses when the deck has no page to anchor the lock on", () => {
    const target = layoutEditTarget(layoutModel({ pagePaths: [], pageIndex: 0 }));
    assert.equal(target?.ok, false);
    assert.equal(target && !target.ok && target.error, STALE_PAGE_TARGET);
    assert.match(STALE_PAGE_TARGET, /目标页面当前不可用/);
  });
});

describe("layout-mode AI turn instruction", () => {
  const definition = {
    id: "body",
    name: "正文",
    elements: [{ elementId: "logo", elementType: "image", src: "media/logo-a.png" }],
  };
  const instruction = layoutEditInstruction({
    layoutId: "body",
    layoutName: "正文",
    definition,
    layoutSha256: "f".repeat(64),
    text: "把Logo换成这个",
  });

  it("asks for write_layout once, for this layout id, with the hash it was given", () => {
    assert.match(instruction, /write_layout/);
    assert.match(instruction, /scope 为 "layout"/);
    assert.match(instruction, /id 为 "body"/);
    assert.ok(instruction.includes(`expectedLayoutSha256 为 "${"f".repeat(64)}"`));
  });

  it("carries the current definition as the editing baseline", () => {
    assert.ok(instruction.includes(JSON.stringify(definition)));
  });

  it("keeps the user's words in a request block, not as slide copy", () => {
    assert.ok(instruction.includes("<user_request>把Logo换成这个</user_request>"));
    assert.match(instruction, /不是要写进版式的文案/);
  });

  it("names no tool the layout turn withholds", () => {
    for (const name of [
      "write_page",
      "edit_elements",
      "edit_page_background",
      "delete_pages",
      "reorder_pages",
      "update_deck",
      "read_page",
    ]) {
      assert.equal(instruction.includes(name), false, `instruction names ${name}`);
    }
  });

  it("refuses to write a layout the server did not return", () => {
    assert.throws(() => layoutEditInstruction({ layoutId: "body", text: "x" }), {
      message: LAYOUT_DEFINITION_MISSING,
    });
    assert.throws(
      () => layoutEditInstruction({ layoutId: "body", definition, text: "x" }),
      /版式/,
      "a definition without its hash is refused too",
    );
  });
});
