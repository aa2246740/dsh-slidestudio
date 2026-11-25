import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, saveProject } from "./parse.js";
import type { PptdElement, TextElement } from "./types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const committed = path.join(repoRoot, "test-fixtures", "layouts-project");

function digests(dir: string): Record<string, string> {
  const files = ["deck.pptd", ...fs.readdirSync(path.join(dir, "pages")).map((f) => `pages/${f}`)];
  return Object.fromEntries(
    files.map((rel) => [
      rel,
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(dir, rel)))
        .digest("hex"),
    ]),
  );
}

describe("committed layouts fixture (the <P_LYT> structure)", () => {
  it("has 24 pages: cover on page 1, body on pages 2 to 23, no layout on page 24", () => {
    const project = loadProject(committed);
    assert.equal(project.pages.length, 24);
    assert.deepEqual(
      project.pages.map((entry) => entry.page.layoutId ?? null),
      ["cover", ...Array(22).fill("body"), null],
    );
  });

  it("defines master main with a bottom-right {page} field, and the cover and body layouts", () => {
    const { presentation } = loadProject(committed);
    assert.deepEqual(
      presentation.masters!.map((master) => master.id),
      ["main"],
    );
    const number = presentation.masters![0]!.elements[0] as TextElement;
    assert.equal(number.elementId, "pageno");
    assert.equal(number.content.field, "pageNumber");
    assert.equal(number.content.text, "{page}");
    assert.ok(number.bounds[0] + number.bounds[2] >= 900, "page number sits at the right edge");
    assert.ok(number.bounds[1] >= 480, "page number sits at the bottom");

    const layouts = presentation.layouts!;
    assert.deepEqual(
      layouts.map((layout) => [layout.id, layout.name]),
      [
        ["cover", "封面"],
        ["body", "正文"],
      ],
    );
  });

  it("gives the cover a gradient background, hidden master elements and a custom arc", () => {
    const cover = loadProject(committed).presentation.layouts![0]!;
    assert.equal(cover.showMasterElements, false);
    assert.equal(cover.background?.type, "gradient");
    const arc = cover.elements.find((element) => element.elementId === "arc") as PptdElement & {
      shapeName?: string;
      fill?: { type?: string };
      shadow?: unknown;
      geometry?: unknown;
    };
    assert.equal(arc.elementType, "shape");
    assert.equal(arc.shapeName, "custom");
    assert.ok(arc.geometry, "the arc is a custom path");
    assert.equal(arc.fill?.type, "gradient");
    assert.ok(arc.shadow, "the arc casts a shadow");
  });

  it("gives body a full-width header rule, a logo at each top corner and a footer", () => {
    const body = loadProject(committed).presentation.layouts![1]!;
    assert.equal(body.masterId, "main");
    assert.equal(body.showMasterElements, undefined);

    const rule = body.elements.find((element) => element.elementId === "header-rule")!;
    assert.equal(rule.elementType, "line");
    assert.deepEqual(rule.bounds, [0, 56, 960, 2]);

    const logoA = body.elements.find((element) => element.elementId === "logo-a")!;
    const logoB = body.elements.find((element) => element.elementId === "logo-b")!;
    assert.equal(logoA.elementType, "image");
    assert.equal(logoB.elementType, "image");
    assert.ok(logoA.bounds[0] < 100 && logoA.bounds[1] < 56, "logo A is top left");
    assert.ok(logoB.bounds[0] + logoB.bounds[2] > 860 && logoB.bounds[1] < 56, "logo B is top right");

    const footer = body.elements.find((element) => element.elementId === "footer")!;
    assert.equal(footer.layoutRole, "footer");
  });

  it("gives every page its own title, and no page has a title copy", () => {
    const { pages } = loadProject(committed);
    for (const [index, entry] of pages.entries()) {
      const title = entry.page.elements.find((element) => element.elementId === "title");
      assert.ok(title, `page ${index + 1} has an own title`);
      assert.equal(title.inherited, undefined, `page ${index + 1} title is own content`);
    }
  });

  it("loads and saves with the same bytes, so the committed copies are already materialised", () => {
    const before = digests(committed);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptd-layouts-fixture-"));
    try {
      fs.cpSync(committed, dir, { recursive: true });
      saveProject(loadProject(dir));
      assert.deepEqual(digests(dir), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
