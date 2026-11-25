import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, type ImageElement, type PptdElement } from "@open-slidestudio/pptd-v2";
import {
  enterLayout,
  exitLayout,
  openSession,
  persist,
  selectElement,
  setImageSrc,
  type CanvasSession,
} from "./index.js";

/*
 * Replacing a picture changes the file it draws and nothing else: the element keeps its place, size,
 * fit, crop and clip, on a page and in a layout (whose copies on every using page follow). The
 * committed edit-ops project has a cropped, clipped picture on page 3 and a logo in layout `body`.
 */
const FIXTURE = fileURLToPath(new URL("../../../test-fixtures/edit-ops-project", import.meta.url));
const CONTROLS = ["element.image.replace", "theme.layout.enter", "theme.layout.exit"];
const REPLACEMENT = "media/replacement.png";

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-image-replace-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  fs.copyFileSync(path.join(dir, "media/old-photo.png"), path.join(dir, REPLACEMENT));
  return dir;
}

const imageNamed = (elements: readonly PptdElement[], elementId: string): ImageElement => {
  const found = elements.find((element) => element.elementId === elementId);
  assert.equal(found?.elementType, "image", elementId);
  return found as ImageElement;
};

const withoutSrc = ({ src: _src, ...rest }: ImageElement) => rest;

function sessionAt(dir: string, pageIndex: number): CanvasSession {
  return openSession(dir, { allowedControlIds: CONTROLS, pageIndex });
}

describe("picture replacement keeps geometry (guards: the commands already behave this way)", () => {
  it("on a page it changes only src, so position, size, fit, crop and clip stay", () => {
    const dir = copyFixture();
    const before = imageNamed(loadProject(dir).pages[2]!.page.elements, "photo");
    const s = sessionAt(dir, 2);
    selectElement(s, "photo");
    setImageSrc(s, "element.image.replace", REPLACEMENT);
    persist(s);

    const after = imageNamed(loadProject(dir).pages[2]!.page.elements, "photo");
    assert.equal(after.src, REPLACEMENT);
    assert.deepEqual(withoutSrc(after), withoutSrc(before));
    assert.deepEqual(after.crop, { left: 0.1, top: 0.05, right: 0.15, bottom: 0.1 });
    assert.deepEqual(after.cropShape, { shapeName: "roundRect" });
    assert.deepEqual(after.fit, { mode: "cover" });
  });

  it("in a layout it changes only src, and every using page's copy follows with its geometry", () => {
    const dir = copyFixture();
    const copiesBefore = loadProject(dir).pages.map((entry) =>
      entry.page.elements.find((element) => element.elementId === "lyt-body-logo"),
    );
    const s = sessionAt(dir, 1);
    enterLayout(s, "theme.layout.enter", "body", "logo");
    setImageSrc(s, "element.image.replace", REPLACEMENT);
    assert.equal(s.undoStack.length, 1, "the replacement is one undo step");
    exitLayout(s, "theme.layout.exit");
    persist(s);

    const after = loadProject(dir);
    const layoutLogo = imageNamed(after.presentation.layouts![0]!.elements, "logo");
    assert.equal(layoutLogo.src, REPLACEMENT);
    assert.deepEqual(layoutLogo.bounds, [24, 12, 120, 40]);
    after.pages.forEach((entry, index) => {
      const copy = entry.page.elements.find((element) => element.elementId === "lyt-body-logo");
      if (!copiesBefore[index]) {
        assert.equal(copy, undefined, `${entry.path} has no body layout`);
        return;
      }
      assert.equal((copy as ImageElement).src, REPLACEMENT, entry.path);
      assert.deepEqual(withoutSrc(copy as ImageElement), withoutSrc(copiesBefore[index] as ImageElement), entry.path);
    });
  });
});
