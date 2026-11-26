import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { mountHubAttachments } from "../public/hub-attachments.js";
import { UPLOAD_STALL_MS } from "../public/attachment-chips.js";
import { MATERIAL_SCOPE } from "../public/material-scope.js";
import {
  FakeXHR,
  chipsIn,
  click,
  fileLike,
  HUB_MARKUP,
  installDom,
  jsonResponse,
  query,
  required,
  textOf,
  tick,
  xhr,
} from "./attachment-dom-harness.test.mjs";

const PARSED_RECORD = {
  id: "att-1",
  name: "sample.xlsx",
  size: 1536,
  kind: "table",
  status: "parsed",
  parser: "xlsx-ooxml-v1",
  summary: { zh: "XLSX 表格 · 2 个工作表 · 共 120 行" },
  warnings: [],
  needsVision: false,
};

/** @type {ReturnType<typeof installDom>} */
let env;
/** @param {Record<string, unknown>} [overrides] */
const parsedRecord = (overrides = {}) => ({ ...PARSED_RECORD, ...overrides });
/** @param {Partial<Parameters<typeof mountHubAttachments>[0]>} [overrides] */
const mount = (overrides = {}) => mountHubAttachments({ onChange: () => {}, onMessage: () => {}, ...overrides });
const rowChips = () => chipsIn(required("attach-row"));
/** @param {number} index */
const chip = (index) => {
  const node = rowChips()[index];
  assert.ok(node, `chip #${index}`);
  return node;
};
const modal = () => required("attach-modal");

beforeEach(() => {
  env = installDom(HUB_MARKUP, {
    url: "http://hub.test/",
    fetchImpl: async () => new Response("[]", { status: 500 }),
  });
});
afterEach(() => env.restore());

test("chips move queued → uploading(%) → parsing → parsed through the binary route", async () => {
  const attachments = mount();
  attachments.ingestFiles([
    fileLike("sample.xlsx", 1536),
    fileLike("near-limit.png", 19 * 1024 * 1024, "image/png"),
    fileLike("third.csv", 20, "text/csv"),
  ]);
  assert.equal(FakeXHR.instances.length, 2);
  assert.equal(rowChips().length, 3);
  assert.match(textOf(chip(2)), /排队中/);
  const first = xhr(0);
  assert.equal(first.method, "POST");
  assert.equal(first.url, "/api/attachments/upload");
  assert.equal(first.requestHeaders["Content-Type"], "application/octet-stream");
  assert.equal(first.requestHeaders["X-Attachment-Name"], encodeURIComponent("sample.xlsx"));
  first.progress(768, 1536);
  assert.match(textOf(chip(0)), /上传中 50%/);
  assert.equal(query(chip(0), ".chip-progress-bar").style.width, "50%");
  assert.equal(query(chip(0), ".chip-progress").getAttribute("aria-valuenow"), "50");
  first.uploaded();
  assert.match(textOf(chip(0)), /解析中/);
  first.finish(200, parsedRecord());
  await tick();
  assert.match(textOf(chip(0)), /已识别/);
  assert.match(textOf(chip(0)), /1\.5 KB/);
  assert.equal(chip(0).dataset.attachId, "att-1");
  assert.deepEqual(attachments.selection()[0], { id: "att-1", name: "sample.xlsx", status: "parsed" });
  xhr(1).finish(200, parsedRecord({ id: "att-3", name: "near-limit.png", kind: "image" }));
  await tick();
  assert.equal(FakeXHR.instances.length, 3);
  xhr(2).finish(200, parsedRecord({ id: "att-4", name: "third.csv" }));
  await tick();
  assert.equal(rowChips().length, 3);
  assert.match(textOf(chip(2)), /third\.csv/);
});

test("unsupported chips show the Chinese reason and offer remove only; failed chips offer retry", async () => {
  const attachments = mount();
  attachments.ingestFiles([fileLike("legacy.ppt", 4096)]);
  xhr(0).finish(200, {
    ...parsedRecord({ id: "att-2", name: "legacy.ppt", kind: null, parser: null, summary: null }),
    status: "unsupported",
    message: "这是旧版 PPT（.ppt）格式，请另存为 .pptx 后再上传",
  });
  await tick();
  assert.match(textOf(chip(0)), /不支持/);
  assert.match(textOf(chip(0)), /请另存为 \.pptx/);
  assert.equal(chip(0).querySelector(".chip-retry"), null);
  assert.ok(chip(0).querySelector(".chip-remove"));
  attachments.ingestFiles([fileLike("sample.png", 999, "image/png")]);
  xhr(1).networkError();
  await tick();
  assert.match(textOf(chip(1)), /网络连接中断，上传失败，请检查网络后重试/);
  click(chip(1), ".chip-retry");
  assert.equal(FakeXHR.instances.length, 3);
  xhr(2).finish(200, parsedRecord({ id: "att-9", name: "sample.png", kind: "image" }));
  await tick();
  assert.match(textOf(chip(1)), /已识别/);
});

test("offline upload: a stalled XHR fails the chip with a Chinese reason and retry", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const file = fileLike("sample.png", 999, "image/png");
  mount().ingestFiles([file]);
  assert.equal(FakeXHR.instances.length, 1);
  assert.ok(xhr(0).timeout > 0, "a sane upload timeout is armed");
  assert.match(textOf(chip(0)), /上传中 0%/);
  mock.timers.tick(UPLOAD_STALL_MS + 1);
  await tick();
  assert.match(textOf(chip(0)), /失败 · 网络连接中断，上传失败，请检查网络后重试/);
  assert.equal(xhr(0).aborted, true);
  click(chip(0), ".chip-retry");
  assert.equal(rowChips().length, 1, "no duplicate chip");
  assert.equal(xhr(1).body, file, "retry posts the original File");
  assert.match(textOf(chip(0)), /上传中/);
  xhr(1).finish(200, parsedRecord({ id: "att-off", name: "sample.png", kind: "image" }));
  await tick();
  assert.match(textOf(chip(0)), /已识别/);
});

test("an XHR timeout and an abort the user did not request fail the chip in Chinese", async () => {
  mount().ingestFiles([fileLike("slow.png", 999, "image/png"), fileLike("cut.png", 999, "image/png")]);
  xhr(0).timedOut();
  xhr(1).abort();
  await tick();
  assert.match(textOf(chip(0)), /失败 · 上传超时，请检查网络后重试/);
  assert.match(textOf(chip(1)), /失败 · 上传中断，请检查网络后重试/);
  for (const node of rowChips()) {
    assert.doesNotMatch(textOf(node), /aborted|timeout/i);
    assert.ok(node.querySelector(".chip-retry"));
  }
});

test("a failed upload releases its queue slot so the rest of the batch continues", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  mount().ingestFiles([
    fileLike("offline.png", 1, "image/png"),
    fileLike("good.csv", 10, "text/csv"),
    fileLike("later.txt", 5, "text/plain"),
  ]);
  assert.equal(FakeXHR.instances.length, 2, "two uploads in flight, third queued");
  mock.timers.tick(UPLOAD_STALL_MS - 1);
  xhr(1).progress(5, 10);
  mock.timers.tick(2);
  await tick();
  assert.match(textOf(chip(0)), /失败 · 网络连接中断/);
  assert.equal(FakeXHR.instances.length, 3, "queued third file started");
  xhr(1).finish(200, parsedRecord({ id: "att-csv", name: "good.csv" }));
  xhr(2).finish(200, parsedRecord({ id: "att-txt", name: "later.txt" }));
  await tick();
  assert.match(textOf(chip(1)), /已识别/);
  assert.match(textOf(chip(2)), /已识别/);
});

test("remove aborts an in-flight upload and the chip never comes back", async () => {
  const attachments = mount();
  attachments.ingestFiles([fileLike("near-limit.png", 19 * 1024 * 1024, "image/png")]);
  const request = xhr(0);
  click(chip(0), ".chip-remove");
  assert.equal(request.aborted, true);
  assert.equal(rowChips().length, 0);
  request.progress(500, 1000);
  request.finish(200, parsedRecord({ id: "att-x", name: "near-limit.png" }));
  await tick();
  assert.equal(rowChips().length, 0);
  assert.equal(attachments.selection().length, 0);
});

test("duplicates are not added twice; a duplicate from an earlier visit reuses its id", async () => {
  /** @type {string[]} */
  const messages = [];
  const attachments = mount({ onMessage: (message) => messages.push(message) });
  attachments.ingestFiles([fileLike("renamed-old.pdf", 500, "application/pdf")]);
  xhr(0).finish(200, parsedRecord({ id: "att-old", name: "text.pdf", kind: "document", duplicateOf: "att-old" }));
  await tick();
  assert.equal(chip(0).dataset.attachId, "att-old");
  attachments.ingestFiles([fileLike("renamed.pdf", 500, "application/pdf")]);
  xhr(1).finish(200, parsedRecord({ id: "att-old", name: "text.pdf", kind: "document", duplicateOf: "att-old" }));
  await tick();
  assert.equal(rowChips().length, 1);
  assert.equal(attachments.selection().length, 1);
  assert.ok(messages.some((message) => message.includes("已存在相同文件")));
});

test("parsed chips expand to the recognized summary plus warnings and collapse again", async () => {
  const hint = "风格线索：强调色 #C00000；字体 HYQiHei-EES → 微软雅黑（风格参考；自由风格下可作配色来源）";
  mount().ingestFiles([fileLike("mixed-scan.pdf", 2048, "application/pdf")]);
  xhr(0).finish(
    200,
    parsedRecord({
      id: "att-pdf2",
      name: "mixed-scan.pdf",
      kind: "document",
      parser: "pdf-unpdf-v3",
      summary: { zh: "PDF · 5 页 · 约 255 字" },
      styleHintLine: hint,
      warnings: [{ code: "scanned-pages", message: "第 2 页几乎没有可提取的文字" }],
    }),
  );
  await tick();
  click(chip(0), ".chip-toggle");
  const detail = query(chip(0), ".chip-detail");
  assert.equal(query(chip(0), ".chip-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(query(chip(0), ".chip-toggle").getAttribute("aria-controls"), detail.id);
  assert.equal(detail.hidden, false);
  assert.equal(textOf(query(chip(0), ".chip-scope-detail")), MATERIAL_SCOPE.document?.["pdf-unpdf-v4"]?.detail);
  assert.equal(textOf(query(chip(0), ".chip-style-hint")), hint);
  assert.deepEqual(
    [...detail.querySelectorAll("p")].map((node) => node.className),
    ["", "chip-scope-detail", "chip-style-hint", ""],
  );
  // The modal list shows the same expanded content under its own detail id.
  const modalDetail = query(document, "#attach-modal-list .reference-chip .chip-detail");
  assert.equal(modalDetail.hidden, false);
  assert.notEqual(modalDetail.id, detail.id);
  click(chip(0), ".chip-toggle");
  assert.equal(query(chip(0), ".chip-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(query(chip(0), ".chip-detail").hidden, true);
});

test("closing the modal during an upload confirms; confirm keeps uploads running in the background", async () => {
  mount().ingestFiles([fileLike("near-limit.png", 19 * 1024 * 1024, "image/png")]);
  const request = xhr(0);
  click(document, "#btn-attach");
  assert.equal(modal().hidden, false);
  assert.equal(required("btn-attach").getAttribute("aria-expanded"), "true");
  click(document, "#btn-attach-close");
  const confirmBox = required("attach-close-confirm");
  assert.equal(confirmBox.hidden, false);
  assert.match(textOf(required("attach-close-text")), /正在上传/);
  assert.equal(document.activeElement, required("btn-attach-cancel"));
  click(document, "#btn-attach-cancel");
  assert.equal(confirmBox.hidden, true);
  assert.equal(modal().hidden, false);
  click(document, "#btn-attach-close");
  click(document, "#btn-attach-confirm");
  assert.equal(confirmBox.hidden, true);
  assert.equal(modal().hidden, true);
  assert.equal(request.aborted, false);
  assert.equal(document.activeElement, required("btn-attach"), "focus returns to the trigger");
  request.finish(200, parsedRecord({ id: "att-bg", name: "near-limit.png", kind: "image" }));
  await tick();
  assert.match(textOf(chip(0)), /已识别/);
  click(document, "#btn-attach");
  click(document, "#btn-attach-close");
  assert.equal(modal().hidden, true);
  assert.equal(confirmBox.hidden, true);
});

test("Escape closes the confirm first, then the modal; the drop zone opens the picker by keyboard", () => {
  mount().ingestFiles([fileLike("near-limit.png", 19 * 1024 * 1024, "image/png")]);
  const input = /** @type {HTMLInputElement} */ (required("attach-file"));
  let opened = 0;
  input.click = () => {
    opened += 1;
  };
  click(document, "#btn-attach");
  const escape = () => document.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Escape" }));
  escape();
  assert.equal(required("attach-close-confirm").hidden, false);
  escape();
  assert.equal(required("attach-close-confirm").hidden, true);
  assert.equal(modal().hidden, false);
  required("drop-zone").dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
  required("drop-zone").dispatchEvent(new env.win.KeyboardEvent("keydown", { key: " " }));
  assert.equal(opened, 2);
});

test("the demo button adds the local brand samples once and closes the modal", async () => {
  /** @type {string[]} */
  const messages = [];
  const sample = parsedRecord({ id: "demo-1", name: "brand-voice.md", kind: "text", parser: "text-utf8-v1" });
  env.setFetch(async (url, options = {}) =>
    options.method === "POST" && String(url).endsWith("/api/attachments/demo")
      ? jsonResponse({ attachments: [sample] })
      : jsonResponse({}, 500),
  );
  const attachments = mount({ onMessage: (message) => messages.push(message) });
  click(document, "#btn-attach");
  click(document, "#btn-demo-ref");
  await tick();
  await tick();
  assert.equal(modal().hidden, true);
  assert.deepEqual(attachments.selection(), [{ id: "demo-1", name: "brand-voice.md", status: "parsed" }]);
  click(document, "#btn-demo-ref");
  await tick();
  await tick();
  assert.deepEqual(messages, ["已加入本地品牌样例", "样例资料已在列表中，未重复添加"]);
  assert.equal(rowChips().length, 1);
});

test("the modal sentences are painted from the shared table at mount", () => {
  mount();
  assert.match(textOf(required("attach-formats-note")), /PPTX、POTX 和 PDF 单个不超过 50MB/);
  assert.match(textOf(query(document, ".attach-capability-note")), /PDF 和 Word 提取文字/);
});
