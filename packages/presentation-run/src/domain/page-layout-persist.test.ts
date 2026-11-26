import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { createEmptyProject, loadProject, saveProject, type Page } from "@open-slidestudio/pptd-v2";
import { pageRevisionSha256 } from "./hashing.js";
import { persistPageKey } from "./layout-qa.js";
import { persistWrittenPages } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";
import type { SkillPageInput } from "./skill-pages.js";

const BODY_NOTE = {
  elementId: "note",
  elementType: "text" as const,
  bounds: [80, 500, 400, 24] as [number, number, number, number],
  layoutRole: "footer" as const,
  content: { text: "版式页脚", fontSize: 12 },
};

const PAGE_TEXT = {
  elementId: "title",
  elementType: "text" as const,
  bounds: [80, 120, 800, 64] as [number, number, number, number],
  content: { text: "第一版标题", fontSize: 32 },
};

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-layout-persist-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "版式持久化" });
  const project = loadProject(root);
  project.presentation.layouts = [{ id: "body", name: "正文", elements: [BODY_NOTE] }];
  saveProject(project);
  return root;
}

function persist(root: string, pages: SkillPageInput[], opts?: { expectedPageSha256?: string }) {
  return persistWrittenPages(
    {
      brief: "版式持久化",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: root,
    },
    pages,
    opts,
  );
}

function pageFile(root: string, id: string) {
  const loaded = loadProject(root).pages.find((entry) => persistPageKey(entry.path) === persistPageKey(id));
  assert.ok(loaded, `page ${id} is persisted`);
  return loaded;
}

it("persists layoutId on the page file and lets saveProject materialise the layout copies", (t) => {
  const root = fixture(t);
  const written = persist(root, [{ id: "p01", layoutId: "body", elements: [PAGE_TEXT] }]);
  assert.deepEqual(written, { ok: true });
  const loaded = pageFile(root, "p01").page as Page;
  assert.equal(loaded.layoutId, "body");
  const copies = loaded.elements.filter((element) => element.inherited !== undefined);
  assert.deepEqual(
    copies.map((copy) => copy.elementId),
    ["lyt-body-note"],
  );
  assert.equal(loaded.elements.at(-1)?.elementId, "title");
});

it("accepts the own-body revision sha of a page that carries layout copies", (t) => {
  const root = fixture(t);
  assert.deepEqual(persist(root, [{ id: "p01", layoutId: "body", elements: [PAGE_TEXT] }]), {
    ok: true,
  });
  const loaded = pageFile(root, "p01");
  // The page must actually carry copies, or the full-body and own-body hashes coincide.
  assert.ok(loaded.page.elements.some((element) => element.inherited !== undefined));
  const expected = pageRevisionSha256(loaded.page, persistPageKey(loaded.path));
  const edited = { ...PAGE_TEXT, content: { text: "第二版标题", fontSize: 32 } };
  const result = persist(root, [{ id: "p01", layoutId: "body", elements: [edited] }], {
    expectedPageSha256: expected,
  });
  assert.deepEqual(result, { ok: true });
  const last = pageFile(root, "p01").page.elements.at(-1) as { content?: { text?: string } } | undefined;
  assert.equal(last?.content?.text, "第二版标题");
});
