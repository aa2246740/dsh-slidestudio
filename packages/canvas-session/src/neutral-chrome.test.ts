import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { openSession, renderModel } from "./index.js";

function coverProject(): { dir: string; project: PptdProject } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-chrome-"));
  const project = createEmptyProject(dir, { title: "Chrome" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("Chrome"));
  saveProject(project);
  return { dir, project };
}

describe("canvas render model carries the neutral chrome flag", () => {
  it("is false for a deck without the flag, so the editor keeps the legacy table rule", () => {
    const { dir } = coverProject();
    assert.equal(renderModel(openSession(dir)).neutralChrome, false);
  });

  it("is true only when the saved theme sets neutralChrome", () => {
    const { dir, project } = coverProject();
    project.presentation.theme = { ...project.presentation.theme, neutralChrome: true };
    saveProject(project);
    assert.equal(renderModel(openSession(dir)).neutralChrome, true);
  });
});
