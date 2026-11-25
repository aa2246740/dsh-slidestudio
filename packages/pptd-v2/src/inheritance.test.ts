import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromeSha256,
  inheritedBackground,
  materializeInheritance,
  ownPageBody,
  setOwnPageBackground,
} from "./inheritance.js";
import { layoutReferenceIssues } from "./layout-schema.js";
import { createEmptyProject, listComposedPage, loadProject, saveProject } from "./parse.js";
import type { DeckLayout, DeckMaster, Fill, Page, PptdElement, PptdProject, TextElement } from "./types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const layoutsFixture = path.join(repoRoot, "test-fixtures", "layouts-project");
const roundOneFixture = path.join(repoRoot, "packages", "pptd-v2", "src", "__fixtures__", "round1-old-format");
const fidelityFixture = path.join(repoRoot, "test-fixtures", "pptd-fidelity-project");

/** Body pages are 2 to 23 (index 1 to 22). */
const BODY_INDEXES = Array.from({ length: 22 }, (_, index) => index + 1);

function copyOf(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptd-inheritance-"));
  fs.cpSync(source, dir, { recursive: true });
  return dir;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Every deck and page file, keyed by relative path, as sha256. */
function digests(dir: string): Record<string, string> {
  const files = ["deck.pptd", ...fs.readdirSync(path.join(dir, "pages")).map((f) => `pages/${f}`)];
  return Object.fromEntries(files.map((rel) => [rel, sha256(fs.readFileSync(path.join(dir, rel)))]));
}

function ids(page: Page): string[] {
  return page.elements.map((element) => element.elementId);
}

describe("materialised inheritance on save", () => {
  it("returns a project without masters or layouts unchanged", () => {
    for (const source of [roundOneFixture, fidelityFixture]) {
      const project = loadProject(source);
      const before = JSON.stringify(project);
      assert.equal(materializeInheritance(project), project);
      assert.equal(JSON.stringify(project), before);
    }
  });

  it("writes master copies, then layout copies, then the page's own elements", () => {
    const dir = copyOf(layoutsFixture);
    saveProject(loadProject(dir));
    const body = loadProject(dir).pages[1]!.page;
    assert.deepEqual(ids(body).slice(0, 6), [
      "mst-main-pageno",
      "lyt-body-header-rule",
      "lyt-body-logo-a",
      "lyt-body-logo-b",
      "lyt-body-footer",
      "title",
    ]);
    assert.deepEqual(body.elements[0]!.inherited, {
      scope: "master",
      ownerId: "main",
      elementId: "pageno",
    });
    assert.deepEqual(body.elements[2]!.inherited, {
      scope: "layout",
      ownerId: "body",
      elementId: "logo-a",
    });
    assert.equal(body.elements[5]!.inherited, undefined);
  });

  it("gives the cover layout copies but no master copies, and page 24 no copies at all", () => {
    const dir = copyOf(layoutsFixture);
    saveProject(loadProject(dir));
    const pages = loadProject(dir).pages;
    const cover = pages[0]!.page;
    assert.deepEqual(
      cover.elements.filter((element) => element.inherited).map((element) => element.elementId),
      ["lyt-cover-arc"],
    );
    const last = pages[23]!.page;
    assert.equal(last.layoutId, undefined);
    assert.equal(
      last.elements.some((element) => element.inherited),
      false,
    );
    assert.equal(last.backgroundInherited, undefined);
  });

  it("copies do not alias their definition or each other", () => {
    const dir = copyOf(layoutsFixture);
    const project = loadProject(dir);
    saveProject(project);
    const definition = project.presentation.masters![0]!.elements[0]!;
    const copyOnPage2 = project.pages[1]!.page.elements[0]!;
    const copyOnPage3 = project.pages[2]!.page.elements[0]!;
    assert.notEqual(copyOnPage2, definition);
    assert.notEqual(copyOnPage2, copyOnPage3);
    copyOnPage2.bounds[0] = 999;
    assert.notEqual(definition.bounds[0], 999);
    assert.notEqual(copyOnPage3.bounds[0], 999);
  });

  it("keeps the page number as a placeholder that the editor and export fill per page", () => {
    const dir = copyOf(layoutsFixture);
    saveProject(loadProject(dir));
    const copy = loadProject(dir).pages[4]!.page.elements[0] as TextElement;
    assert.equal(copy.elementId, "mst-main-pageno");
    assert.equal(copy.content.text, "{page}");
    assert.equal(copy.content.field, "pageNumber");
  });

  it("a second save is byte-identical to the first", () => {
    const dir = copyOf(layoutsFixture);
    saveProject(loadProject(dir));
    const first = digests(dir);
    saveProject(loadProject(dir));
    assert.deepEqual(digests(dir), first);
  });

  it("only saveProject adds copies: a page composed in memory has none until the save", () => {
    const source = loadProject(copyOf(layoutsFixture));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptd-inheritance-compose-"));
    const project = createEmptyProject(dir, { title: "保存时生成副本" });
    project.presentation.masters = structuredClone(source.presentation.masters);
    project.presentation.layouts = structuredClone(source.presentation.layouts);
    const own: PptdElement = {
      elementId: "title",
      elementType: "shape",
      shapeName: "rect",
      bounds: [40, 40, 300, 60],
      fill: { type: "solid", color: "#1D4ED8" },
    };
    listComposedPage(project, "pages/01.page", { layoutId: "body", elements: [own] });
    assert.deepEqual(ids(project.pages[0]!.page), ["title"]);

    saveProject(project);
    const materialised = [
      "mst-main-pageno",
      "lyt-body-header-rule",
      "lyt-body-logo-a",
      "lyt-body-logo-b",
      "lyt-body-footer",
      "title",
    ];
    assert.deepEqual(ids(project.pages[0]!.page), materialised);
    assert.deepEqual(ids(loadProject(dir).pages[0]!.page), materialised);
  });
});

describe("background precedence: page over layout over master over white", () => {
  function inlineProject(): {
    project: PptdProject;
    masterBackground: Fill;
    layoutBackground: Fill;
    ownBackground: Fill;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptd-precedence-"));
    const project = createEmptyProject(dir, { title: "背景优先级" });
    const masterBackground: Fill = { type: "solid", color: "#FFF7ED" };
    const layoutBackground: Fill = {
      type: "gradient",
      gradientType: "linear",
      angle: 90,
      stops: [
        { position: 0, color: "#DBEAFE" },
        { position: 1, color: "#BFDBFE" },
      ],
    };
    const ownBackground: Fill = { type: "solid", color: "#111827" };
    const master: DeckMaster = {
      id: "main",
      name: "母版",
      background: masterBackground,
      elements: [],
    };
    project.presentation.masters = [master];
    project.presentation.layouts = [
      { id: "plain", name: "普通", masterId: "main", elements: [] } as DeckLayout,
      {
        id: "tinted",
        name: "色底",
        masterId: "main",
        background: layoutBackground,
        elements: [],
      } as DeckLayout,
    ];
    listComposedPage(project, "pages/01.page", { layoutId: "plain", elements: [] });
    listComposedPage(project, "pages/02.page", { layoutId: "tinted", elements: [] });
    listComposedPage(project, "pages/03.page", {
      layoutId: "plain",
      background: ownBackground,
      elements: [],
    });
    listComposedPage(project, "pages/04.page", { elements: [] });
    return { project, masterBackground, layoutBackground, ownBackground };
  }

  it("uses the master background when the layout has none, flagged as inherited", () => {
    const { project, masterBackground } = inlineProject();
    saveProject(project);
    const page = loadProject(project.rootDir).pages[0]!.page;
    assert.deepEqual(page.background, masterBackground);
    assert.equal(page.backgroundInherited, true);
  });

  it("prefers the layout background over the master background", () => {
    const { project, layoutBackground } = inlineProject();
    saveProject(project);
    const page = loadProject(project.rootDir).pages[1]!.page;
    assert.deepEqual(page.background, layoutBackground);
    assert.equal(page.backgroundInherited, true);
  });

  it("keeps a page's own background over the layout and clears nothing", () => {
    const { project, ownBackground } = inlineProject();
    saveProject(project);
    const page = loadProject(project.rootDir).pages[2]!.page;
    assert.deepEqual(page.background, ownBackground);
    assert.equal(page.backgroundInherited, undefined);
  });

  it("leaves a page with no layout and no background white, with no background key", () => {
    const { project } = inlineProject();
    saveProject(project);
    const page = loadProject(project.rootDir).pages[3]!.page;
    assert.equal(page.background, undefined);
    assert.equal(page.backgroundInherited, undefined);
  });

  it("setting an own background clears the inherited flag and survives later saves", () => {
    const dir = copyOf(layoutsFixture);
    const project = loadProject(dir);
    setOwnPageBackground(project.pages[1]!.page, { type: "solid", color: "#EEEEEE" });
    saveProject(project);
    const reloaded = loadProject(dir);
    assert.deepEqual(reloaded.pages[1]!.page.background, { type: "solid", color: "#EEEEEE" });
    assert.equal(reloaded.pages[1]!.page.backgroundInherited, undefined);

    const layout = reloaded.presentation.layouts!.find((entry) => entry.id === "body")!;
    layout.background = { type: "solid", color: "#F0FDF4" };
    saveProject(reloaded);
    assert.deepEqual(loadProject(dir).pages[1]!.page.background, {
      type: "solid",
      color: "#EEEEEE",
    });
    assert.deepEqual(loadProject(dir).pages[2]!.page.background, {
      type: "solid",
      color: "#F0FDF4",
    });
  });
});

describe("own-content identity and chrome hash", () => {
  it("ownPageBody strips copies and inherited background, so its hash survives a logo move", () => {
    const dir = copyOf(layoutsFixture);
    const before = loadProject(dir);
    const ownBefore = before.pages.map((entry) => sha256(JSON.stringify(ownPageBody(entry.page))));
    const chromeBefore = before.pages.map((entry) => chromeSha256(before, entry.page));

    const project = loadProject(dir);
    const logo = project.presentation
      .layouts!.find((entry) => entry.id === "body")!
      .elements.find((element) => element.elementId === "logo-a")!;
    logo.bounds = [logo.bounds[0] + 40, logo.bounds[1], logo.bounds[2], logo.bounds[3]];
    saveProject(project);

    const after = loadProject(dir);
    for (const index of BODY_INDEXES) {
      const copy = after.pages[index]!.page.elements.find((el) => el.elementId === "lyt-body-logo-a")!;
      assert.equal(copy.bounds[0], logo.bounds[0], `page ${index + 1} copy moved`);
    }
    const ownAfter = after.pages.map((entry) => sha256(JSON.stringify(ownPageBody(entry.page))));
    assert.deepEqual(ownAfter, ownBefore);

    const chromeAfter = after.pages.map((entry) => chromeSha256(after, entry.page));
    for (const index of BODY_INDEXES) {
      assert.notEqual(chromeAfter[index], chromeBefore[index], `body page ${index + 1} chrome`);
    }
    assert.equal(chromeAfter[0], chromeBefore[0], "cover chrome is unchanged");
    assert.equal(chromeAfter[23], "none");
    assert.equal(chromeBefore[23], "none");
  });

  it("ownPageBody keeps the layoutId and the page's own elements", () => {
    const page = loadProject(layoutsFixture).pages[1]!.page;
    const own = ownPageBody(page);
    assert.equal(own.layoutId, "body");
    assert.deepEqual(
      own.elements.map((element) => element.elementId),
      ["title", "body-text"],
    );
  });

  it("ownPageBody drops an inherited background and keeps the page's own", () => {
    const project = loadProject(copyOf(layoutsFixture));
    const cover = project.pages[0]!.page;
    assert.equal(cover.backgroundInherited, true);
    assert.equal(ownPageBody(cover).background, undefined);
    assert.equal(ownPageBody(cover).backgroundInherited, undefined);

    const own: Fill = { type: "solid", color: "#FFEECC" };
    setOwnPageBackground(cover, own);
    assert.deepEqual(ownPageBody(cover).background, own);
    assert.equal(ownPageBody(cover).backgroundInherited, undefined);
  });

  it("chromeSha256 changes when a page moves, because its page number changes", () => {
    const dir = copyOf(layoutsFixture);
    const project = loadProject(dir);
    const page2 = project.pages[1]!.page;
    const before = chromeSha256(project, page2);
    project.pages.reverse();
    project.presentation.pages = project.pages.map((entry) => entry.path);
    assert.notEqual(chromeSha256(project, page2), before);
  });

  it("a dangling layoutId loads, loses its copies on save, and is refused by write checks", () => {
    const dir = copyOf(layoutsFixture);
    const project = loadProject(dir);
    project.pages[1]!.page.layoutId = "gone";
    saveProject(project);

    const reloaded = loadProject(dir);
    const page = reloaded.pages[1]!.page;
    assert.equal(page.layoutId, "gone");
    assert.equal(
      page.elements.some((element) => element.inherited),
      false,
    );
    assert.equal(chromeSha256(reloaded, page), "none");
    assert.deepEqual(
      layoutReferenceIssues(reloaded.presentation, page).map((issue) => issue.code),
      ["layout_missing"],
    );
  });
});

describe("the background a layout gives its pages", () => {
  const dark: Fill = { type: "solid", color: "#1F2937" };
  const red: Fill = { type: "solid", color: "#B91C1C" };
  const presentation = {
    masters: [{ id: "main", name: "母版", background: dark, elements: [] }],
  } as unknown as PptdProject["presentation"];
  const layout = (extra: Partial<DeckLayout>): DeckLayout => ({
    id: "body",
    name: "正文",
    elements: [],
    ...extra,
  });

  it("is the layout's own, else its master's, else none", () => {
    assert.equal(inheritedBackground(presentation, layout({ masterId: "main", background: red })), red);
    assert.equal(inheritedBackground(presentation, layout({ masterId: "main" })), dark);
    assert.equal(inheritedBackground(presentation, layout({})), undefined);
    assert.equal(inheritedBackground(presentation, layout({ masterId: "gone" })), undefined);
  });
});
