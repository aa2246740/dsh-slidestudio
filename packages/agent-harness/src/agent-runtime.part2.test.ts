import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { loadPlaybook } from "./index.js";
import { persistWrittenPages } from "./agent-tools.js";
import type { SkillPageInput } from "./skill-pages.js";

describe("live deck title", () => {
  // A live DSH turn writes pages one at a time. The deck must end up named after
  // the deck the agent actually wrote (the cover headline), not after the raw
  // prompt the user typed — that text used to be re-stamped on every page write.
  const coverPage = (): SkillPageInput => ({
    id: "01_cover",
    pageType: "cover",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 80, 800, 60],
        content: { text: "iPod → iPod shuffle 产品史", fontSize: 32 },
      },
    ],
  });
  const secondPage = (): SkillPageInput => ({
    id: "02_body",
    pageType: "content",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 80, 800, 60],
        content: { text: "从硬盘到闪存", fontSize: 28 },
      },
    ],
  });

  it("keeps the cover headline instead of re-stamping the raw brief", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-live-title-"));
    const state = {
      brief: "做一份极简苹果风格的，介绍 ipod -> ipod shuffle 的产品历史的科普性 ppt",
      playbook: loadPlaybook({ categoryId: "management-report" }),
      todos: [],
      researchNotes: [],
      projectRoot: dir,
    };
    persistWrittenPages(state, [coverPage()]);
    assert.equal(loadProject(dir).presentation.title, "iPod → iPod shuffle 产品史");

    persistWrittenPages(state, [secondPage()]);
    const after = loadProject(dir).presentation.title;
    assert.equal(after, "iPod → iPod shuffle 产品史", "a later page write must not reset the deck title");
    assert.notEqual(after, state.brief.slice(0, 40));
  });

  it("prefers an explicitly authored deck title over the cover headline", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-live-title-explicit-"));
    const state = {
      brief: "做一份极简苹果风格的科普 ppt",
      playbook: loadPlaybook({ categoryId: "management-report" }),
      todos: [],
      researchNotes: [],
      projectRoot: dir,
      skillDeck: { title: "注入生成", pages: [] },
    };
    persistWrittenPages(state, [coverPage()]);
    assert.equal(loadProject(dir).presentation.title, "注入生成");
  });
});
