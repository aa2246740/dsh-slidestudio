import assert from "node:assert/strict";
import test from "node:test";
import { sampleTextElementIds, sampleTextIndex } from "./layout-sample-text.js";

// Synthetic sample wording only: a report file name, a slide title with a numbering-only title beside it.
const SAMPLE = sampleTextIndex({
  name: "示例季度经营报告.pptx",
  derivative: {
    "deck-template": {
      slides: [
        { title: "示例季度经营概览", text: "样例数值说明与季度要点" },
        { title: "03", text: "" },
      ],
    },
  },
});

const text = (elementId: string, value: string) => ({
  elementId,
  elementType: "text",
  content: { text: value },
});

test("a generic footer, a page-number field and digit-only numbering are not sample wording", () => {
  const elements = [text("note", "本页仅供内部参考"), text("page", "{page} / {pages}"), text("section", "第 03 页")];
  assert.deepEqual(sampleTextElementIds(elements, SAMPLE), []);
});

test("a footer that repeats the sample report name is reported by element id only", () => {
  const elements = [text("footer", "示例季度经营报告 · 2026年"), text("note", "本页仅供内部参考")];
  assert.deepEqual(sampleTextElementIds(elements, SAMPLE), ["footer"]);
});

test("a text that contains a sample slide title is reported", () => {
  assert.deepEqual(sampleTextElementIds([text("heading", "示例季度经营概览")], SAMPLE), ["heading"]);
});

test("a run of four characters shared with sample paragraph text is reported", () => {
  assert.deepEqual(sampleTextElementIds([text("line", "以下为季度要点说明")], SAMPLE), ["line"]);
});

test("an empty or missing template index refuses nothing", () => {
  const none = sampleTextIndex({ name: "", derivative: {} });
  assert.deepEqual(sampleTextElementIds([text("footer", "示例季度经营报告")], none), []);
});
