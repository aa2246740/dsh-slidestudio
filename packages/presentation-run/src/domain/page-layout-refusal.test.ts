import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { createEmptyProject, loadProject, saveProject, type Page } from "@open-slidestudio/pptd-v2";
import { persistWrittenPages } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";
import type { SkillPageInput } from "./skill-pages.js";

const LOGO_SRC = "media/logo-a.png";
const LOGO = {
  elementId: "logo",
  elementType: "image" as const,
  bounds: [860, 20, 80, 40] as [number, number, number, number],
  src: LOGO_SRC,
};
const TITLE = {
  elementId: "title",
  elementType: "text" as const,
  bounds: [80, 120, 800, 64] as [number, number, number, number],
  content: { text: "第一版标题", fontSize: 32 },
};

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-layout-refusal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "版式拒绝" });
  const project = loadProject(root);
  project.presentation.layouts = [{ id: "body", name: "正文", elements: [LOGO] }];
  saveProject(project);
  return root;
}

/** The persistence result, read loosely: a refusal carries its code and Chinese detail. */
function persist(root: string, pages: SkillPageInput[]) {
  return persistWrittenPages(
    {
      brief: "版式拒绝",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: root,
    },
    pages,
  ) as { ok: boolean; error?: string; detail?: string };
}

function image(elementId: string, src: string, x: number) {
  return {
    elementId,
    elementType: "image" as const,
    bounds: [x, 20, 80, 40] as [number, number, number, number],
    src,
  };
}

it("refuses a page whose layoutId names no layout, in Chinese, and writes no page", (t) => {
  const root = fixture(t);
  const result = persist(root, [{ id: "p01", layoutId: "nope", elements: [TITLE] } as SkillPageInput]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "layout_missing");
  assert.equal(result.detail, "版式 nope 不存在，请先定义该版式或改用已有版式");
  assert.equal(loadProject(root).pages.length, 0);
});

it("refuses an own element whose id uses the copy prefix mst- or lyt-", (t) => {
  const root = fixture(t);
  const result = persist(root, [
    {
      id: "p01",
      layoutId: "body",
      elements: [TITLE, { ...image("lyt-body-logo", LOGO_SRC, 860) }],
    } as SkillPageInput,
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "reserved_element_id");
  assert.match(result.detail ?? "", /不能以 mst- 或 lyt- 开头/);
});

it("refuses an own image that redraws the layout logo within 4 px, in Chinese", (t) => {
  const root = fixture(t);
  const result = persist(root, [
    {
      id: "p01",
      layoutId: "body",
      elements: [TITLE, image("my-logo", LOGO_SRC, 864)],
    } as SkillPageInput,
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "duplicate_layout_element");
  assert.match(result.detail ?? "", /已在版式『正文』里，不要在页面上重复画/);
});

it("accepts the same src 5 px from the layout logo, and a different src at the same spot", (t) => {
  const root = fixture(t);
  const moved = persist(root, [
    {
      id: "p01",
      layoutId: "body",
      elements: [TITLE, image("my-logo", LOGO_SRC, 865)],
    } as SkillPageInput,
  ]);
  assert.deepEqual(moved, { ok: true });
  const photo = persist(root, [
    {
      id: "p02",
      layoutId: "body",
      elements: [TITLE, image("my-photo", "media/photo.png", 860)],
    } as SkillPageInput,
  ]);
  assert.deepEqual(photo, { ok: true });
  const pages = loadProject(root).pages.map((entry) => entry.page as Page);
  assert.equal(pages.length, 2);
});
