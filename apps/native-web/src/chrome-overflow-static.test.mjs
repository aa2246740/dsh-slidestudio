import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PUBLIC = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../public");
const appJs = fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8");
const hubJs = fs.readFileSync(path.join(PUBLIC, "hub.js"), "utf8");
const styles = fs.readFileSync(path.join(PUBLIC, "styles.css"), "utf8");
const hubCss = fs.readFileSync(path.join(PUBLIC, "hub.css"), "utf8");

const LONG = Array.from(
  { length: 80 },
  (_, i) =>
    `## 核心医疗场景 ${i + 1}\n\n南通市医疗物流精调调研，模拟数据。**重点**：仓储、冷链、院内配送。\n| 指标 | 数值 |\n| --- | --- |\n| 时效 | 2h |\n| 覆盖 | 98% |\n`,
).join("\n");

describe("generate/editor chrome overflow", () => {
  it("does not dump the full generate brief into a growing bubble", () => {
    assert.ok(appJs.includes('from "./brief-chip.js"'), "editor imports brief-chip");
    assert.ok(appJs.includes("appendBriefChip("), "editor mounts a brief chip");
    const generatePaint = appJs.slice(
      appJs.indexOf("async function runGenerateFlow"),
      appJs.indexOf("function paintPersistedReason"),
    );
    assert.ok(
      !generatePaint.includes("bubble.textContent = brief"),
      "runGenerateFlow must not paint the full brief as a bubble",
    );
    // The hub no longer paints the run itself: it navigates to the editor at
    // once, and the editor's launch flow creates the session and binds to it.
    const launchJs = fs.readFileSync(path.join(PUBLIC, "launch-flow.js"), "utf8");
    assert.ok(hubJs.includes("location.replace(launchHref("), "hub navigates to the editor on Send");
    assert.ok(launchJs.includes("function handoffToLiveEditor("), "launch flow hands the run to the live editor");
    assert.ok(appJs.includes("handoffToLiveEditor(bound)"), "the editor binds itself to the created session");
    assert.ok(
      !hubJs.includes('innerHTML = `<div class="user-message">${escapeHtml(text)}</div>'),
      "hub must not dump the full brief into .user-message",
    );
  });

  it("caps long chrome text and keeps the editor shell inside the viewport", () => {
    assert.ok(/html,\s*body\s*\{[^}]*overflow:\s*hidden/.test(styles), "html/body overflow hidden");
    assert.ok(/\.shell\s*\{[^}]*overflow:\s*hidden/.test(styles), "shell overflow hidden");
    assert.ok(/\.work-chat\s*\{[^}]*min-height:\s*0/.test(styles), "work-chat min-height 0");
    assert.ok(/\.work-thread\s*\{[^}]*min-height:\s*0/.test(styles), "work-thread min-height 0");
    assert.ok(/\.brief-chip-body\s*\{[^}]*max-height:[^}]*overflow:\s*auto/.test(styles), "editor chip body scrolls");
    assert.ok(
      /\.work-thread \.bubble\s*\{[^}]*max-height:[^}]*overflow:\s*auto/.test(styles),
      "bubbles have max-height",
    );
    assert.ok(
      /\.generation-status-card\s*\{[^}]*min-width:\s*0/.test(styles) &&
        /\.generation-status-title\s*\{[^}]*overflow-wrap:\s*anywhere/.test(styles),
      "generation status card wraps safely inside the narrow sidebar",
    );
    assert.ok(/\.agent-thread\s*\{[^}]*min-height:\s*0/.test(hubCss), "agent-thread min-height 0");
    assert.ok(/\.brief-chip-body\s*\{[^}]*max-height:[^}]*overflow:\s*auto/.test(hubCss), "hub chip body scrolls");
    assert.ok(
      /\.prompt-main textarea\s*\{[^}]*max-height:[^}]*overflow:\s*auto/.test(hubCss),
      "hub brief textarea caps",
    );
  });

  it("labels a long brief without repeating the whole source", async () => {
    const { briefChipLabel } = await import("../public/brief-chip.js");
    const label = briefChipLabel(LONG);
    assert.ok(label.length <= 40);
    assert.ok(label.includes("核心医疗场景"));
    assert.notEqual(label, LONG);
  });
});
