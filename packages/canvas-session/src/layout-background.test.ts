import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  saveProject,
  type DeckLayout,
  type DeckMaster,
  type Fill,
  type Page,
} from "@open-slidestudio/pptd-v2";
import {
  enterLayout,
  enterMaster,
  exitLayout,
  openSession,
  persist,
  renderAllPages,
  renderModel,
  setPageBackground,
  type CanvasSession,
} from "./index.js";

/*
 * What a layout surface paints behind its elements: the layout's own background, else the master it
 * names, else white. That is the fallback a page using the layout gets, so the layout is edited on
 * the colour its pages show. The fallback is only painted: the stored layout never takes it.
 */
const CONTROLS = ["theme.layout.enter", "theme.layout.exit", "theme.background.set"];
const DARK: Fill = { type: "solid", color: "#1F2937" };
const RED: Fill = { type: "solid", color: "#B91C1C" };

const MASTER: DeckMaster = { id: "main", name: "母版", background: DARK, elements: [] };
const LAYOUTS: DeckLayout[] = [
  { id: "inherit", name: "跟随母版", masterId: "main", elements: [] },
  { id: "override", name: "自带背景", masterId: "main", background: RED, elements: [] },
  { id: "bare", name: "无母版", elements: [] },
];

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-layout-background-"));
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** One page per layout, saved to disk and opened again, as the editor does. */
function savedDeck(
  dir: string,
  master: DeckMaster | undefined = MASTER,
  layouts: DeckLayout[] = LAYOUTS,
): CanvasSession {
  const project = createEmptyProject(dir, { title: "版式背景" });
  if (master) project.presentation.masters = [master];
  project.presentation.layouts = structuredClone(layouts);
  layouts.forEach((layout, n) => {
    const page: Page = { layoutId: layout.id, elements: [] };
    listComposedPage(project, `pages/p${n + 1}.page`, page);
  });
  saveProject(project);
  return openSession(dir, { allowedControlIds: CONTROLS });
}

/** The background colour a render paints; the stored hex keeps its case, so compare in one. */
function paint(model: { backgroundCss: string }): string {
  return model.backgroundCss.toLowerCase();
}

function shown(s: CanvasSession, layoutId: string): string {
  enterLayout(s, "theme.layout.enter", layoutId);
  const css = paint(renderModel(s));
  exitLayout(s, "theme.layout.exit");
  return css;
}

describe("layout surface background (ML-006)", () => {
  it("a layout with no background shows the master it names, and its own background wins", () => {
    const dir = tmp();
    const s = savedDeck(dir);
    assert.equal(shown(s, "inherit"), "#1f2937", "the master's background shows");
    assert.equal(shown(s, "override"), "#b91c1c", "the layout's own background wins");
  });

  it("a layout with no master shows white", () => {
    const s = savedDeck(tmp());
    assert.equal(shown(s, "bare"), "#ffffff");
    const noMaster = savedDeck(tmp(), undefined, [LAYOUTS[2]!]);
    assert.equal(shown(noMaster, "bare"), "#ffffff", "the deck has no master at all");
  });

  it("the page rail's miniatures use the same rule", () => {
    const dir = tmp();
    const s = savedDeck(dir);
    const miniature = (surface: CanvasSession["surface"]): string =>
      paint(renderModel({ ...s, surface, selection: { kind: "none" } }));
    assert.equal(miniature({ kind: "layout", layoutId: "inherit" }), "#1f2937");
    assert.equal(miniature({ kind: "layout", layoutId: "bare" }), "#ffffff");
    assert.equal(miniature({ kind: "master" }), "#1f2937");
  });

  it("a master with no background shows white, and a picture background paints as the page does", () => {
    const dir = tmp();
    const s = savedDeck(dir, { id: "main", name: "母版", elements: [] });
    enterMaster(s, "theme.layout.enter");
    assert.equal(paint(renderModel(s)), "#ffffff");
    assert.equal(shown(s, "inherit"), "#ffffff");

    const photo: Fill = { type: "image", src: "media/bg.png" };
    const picture = savedDeck(tmp(), { id: "main", name: "母版", background: photo, elements: [] });
    enterLayout(picture, "theme.layout.enter", "inherit");
    assert.equal(renderModel(picture).backgroundImage, "media/bg.png");
  });

  it("the fallback is never written into the layout, the pages or the files", () => {
    const dir = tmp();
    const s = savedDeck(dir);
    const files = ["deck.pptd", "pages/p1.page", "pages/p2.page", "pages/p3.page"];
    const before = files.map((file) => sha256(path.join(dir, file)));
    enterLayout(s, "theme.layout.enter", "inherit");
    renderModel(s);
    renderAllPages(s);
    assert.equal(
      s.project.presentation.layouts?.find((layout) => layout.id === "inherit")?.background,
      undefined,
      "the stored layout still has no background",
    );
    persist(s);
    assert.deepEqual(
      files.map((file) => sha256(path.join(dir, file))),
      before,
      "an unchanged save leaves every byte alone",
    );
    assert.equal(
      loadProject(dir).presentation.layouts?.find((layout) => layout.id === "inherit")?.background,
      undefined,
    );
  });

  it("pages keep their own precedence: page, then layout, then master", () => {
    const dir = tmp();
    const s = savedDeck(dir);
    s.pageIndex = 0;
    assert.equal(paint(renderModel(s)), "#1f2937", "an inheriting page shows the master's");
    s.pageIndex = 1;
    assert.equal(paint(renderModel(s)), "#b91c1c", "the layout's background reaches its page");
    s.pageIndex = 0;
    setPageBackground(s, "theme.background.set", "#00AA00");
    assert.equal(paint(renderModel(s)), "#00aa00", "the page's own background wins");
    assert.equal(paint(renderAllPages(s)[2]!), "#ffffff", "a page whose layout has no master stays white");
  });

  it("a background set on the layout becomes the layout's own", () => {
    const dir = tmp();
    const s = savedDeck(dir);
    enterLayout(s, "theme.layout.enter", "inherit");
    setPageBackground(s, "theme.background.set", "#00AA00");
    assert.equal(paint(renderModel(s)), "#00aa00");
    assert.equal(s.project.presentation.layouts?.find((layout) => layout.id === "inherit")?.background?.type, "solid");
  });
});
