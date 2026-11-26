import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmptyProject, saveProject } from "@open-slidestudio/pptd-v2";
import { directorBrief } from "./director-brief.js";

test("the director routes element scopes to edit_elements and whole-page edits to write_page", () => {
  const prompt = directorBrief("Revise the selected title");
  assert.match(prompt, /review scope is elements, use edit_elements/);
  assert.match(prompt, /do not call write_page/);
  assert.match(prompt, /whole-page and deck edits still use write_page/);
});

function textElement(elementId: string, text: string, y: number) {
  return {
    elementId,
    elementType: "text" as const,
    bounds: [80, y, 800, 60] as [number, number, number, number],
    content: { text, fontSize: 28, color: "#223344" },
  };
}

test("batch element tool accepts both same-page targets and a second page without broadening scope", async () => {
  const { prepareElementEdit } = await import("./edit-elements.js");
  const { stableSha256 } = await import("@open-slidestudio/presentation-run");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch-elements-"));
  const project = createEmptyProject(root, { title: "Batch" });
  project.pages = ["p1", "p2"].map((id) => ({
    path: `pages/${id}.page`,
    page: {
      pageType: "content",
      elements: [
        textElement("title", "Title", 70),
        textElement("body", "Body", 170),
        textElement("footer", "Untouched", 410),
      ],
    },
  }));
  project.presentation.pages = project.pages.map((page) => page.path);
  saveProject(project);
  const items = [
    {
      pagePath: "pages/p1.page",
      scope: { kind: "elements", pageId: "p1", elementIds: ["title"] },
      pageBody: project.pages[0]!.page,
    },
    {
      pagePath: "pages/p1.page",
      scope: { kind: "elements", pageId: "p1", elementIds: ["body"] },
      pageBody: project.pages[0]!.page,
    },
    {
      pagePath: "pages/p2.page",
      scope: { kind: "elements", pageId: "p2", elementIds: ["title"] },
      pageBody: project.pages[1]!.page,
    },
  ];
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "ai-review-lock.v1.json"),
    JSON.stringify({ ...items[0], items, expiresAt: Date.now() + 60_000 }),
  );
  const expectedPageSha256 = stableSha256({ ...project.pages[0]!.page, id: "p1" });
  const accepted = prepareElementEdit(root, {
    pageId: "p1",
    expectedPageSha256,
    elements: [textElement("title", "New title", 70), textElement("body", "New body", 170)],
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  if (accepted.ok) assert.deepEqual(accepted.page.elements[2], project.pages[0]!.page.elements[2]);
  assert.equal(
    prepareElementEdit(root, { pageId: "p1", expectedPageSha256, elements: [textElement("title", "Only first", 70)] })
      .ok,
    false,
  );
  assert.equal(
    prepareElementEdit(root, {
      pageId: "p1",
      expectedPageSha256,
      elements: [textElement("title", "New", 70), textElement("footer", "Wrong", 410)],
    }).ok,
    false,
  );
  assert.equal(
    prepareElementEdit(root, {
      pageId: "p2",
      expectedPageSha256: stableSha256({ ...project.pages[1]!.page, id: "p2" }),
      elements: [textElement("title", "Page two", 70)],
    }).ok,
    true,
  );
});
