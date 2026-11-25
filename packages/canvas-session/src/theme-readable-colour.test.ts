import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, listComposedPage, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";
import {
  insertImage,
  insertSmartArt,
  openSession,
  rebuildSelectedImage,
  selectElement,
  type CanvasSession,
} from "./index.js";

/*
 * Ruling 134: an older theme may store a six-digit colour without its `#`. SmartArt insertion
 * and the image rebuild copy the theme colours into new elements, so they must write `#RRGGBB`.
 * An unprefixed value would be refused on the next agent write of that page.
 */
const CONTROLS = ["insert.smartart", "insert.image", "element.image.rebuild"];
const UNPREFIXED = /^[0-9A-Fa-f]{6}$/;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-theme-readable-"));
}

function oldThemeDeck(dir: string): void {
  const project = createEmptyProject(dir, { title: "旧主题" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("旧主题"));
  project.presentation.theme = { colors: { primary: "D97757", text: "1A1917" } };
  saveProject(project);
}

/** Every string value inside a JSON-like value, depth first. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringsOf);
  }
  return [];
}

function storedElements(s: CanvasSession, ids: string[]) {
  const page = s.project.pages[0]!.page;
  return page.elements.filter((e) => ids.includes(e.elementId));
}

describe("unprefixed theme colours on new elements (ruling 134)", () => {
  it("SmartArt insert stores #RRGGBB on its nodes and labels", () => {
    const dir = tmp();
    oldThemeDeck(dir);
    const s = openSession(dir, { allowedControlIds: CONTROLS });
    const diagramId = insertSmartArt(s, "insert.smartart", "process");
    const created = s.project.pages[0]!.page.elements.filter(
      (e) => (e as { smartArt?: { id: string } }).smartArt?.id === diagramId,
    );
    assert.ok(created.length >= 6, "SmartArt creates nodes, labels and connectors");
    const values = stringsOf(created);
    assert.deepEqual(
      values.filter((value) => UNPREFIXED.test(value)),
      [],
      "no stored colour is an unprefixed six-digit hex",
    );
    assert.ok(values.includes("#D97757"), "the primary colour is stored as #D97757");
    assert.ok(values.includes("#1A1917"), "the text colour is stored as #1A1917");
  });

  it("image rebuild stores #RRGGBB on the nodes it creates", () => {
    const dir = tmp();
    oldThemeDeck(dir);
    const s = openSession(dir, { allowedControlIds: CONTROLS });
    const imageId = insertImage(s, "insert.image");
    selectElement(s, imageId);
    const out = rebuildSelectedImage(s, "element.image.rebuild", "感知, 路由, 决策");
    const created = storedElements(s, out.created);
    assert.ok(created.length >= 6, "the rebuild creates labelled nodes and connectors");
    const values = stringsOf(created);
    assert.deepEqual(
      values.filter((value) => UNPREFIXED.test(value)),
      [],
      "no stored colour is an unprefixed six-digit hex",
    );
    assert.ok(values.includes("#D97757"), "the primary colour is stored as #D97757");
    assert.ok(values.includes("#1A1917"), "the text colour is stored as #1A1917");
  });
});
