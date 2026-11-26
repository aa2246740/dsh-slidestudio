import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mountEditorAttachments } from "../public/editor-attachments.js";
import {
  PARSED_PDF,
  PARSED_PNG,
  FakeXHR,
  chipsIn,
  fileLike,
  imagePackPayload,
  EDITOR_MARKUP,
  installDom,
  jsonResponse,
  query,
  required,
  textOf,
  tick,
  xhr,
} from "./attachment-dom-harness.test.mjs";

const STORAGE_KEY = "oss.editor.agent-attachments:test-project";

/** @type {ReturnType<typeof installDom>} */
let env;

/** @param {Partial<Parameters<typeof mountEditorAttachments>[0]>} [overrides] */
function mount(overrides = {}) {
  return mountEditorAttachments({
    projectKey: () => "test-project",
    apiPath: (path) => path,
    ...overrides,
  });
}

const chips = () => chipsIn(required("agent-attachments"));
/** @param {number} index */
const chip = (index) => {
  const node = chips()[index];
  assert.ok(node, `chip #${index}`);
  return node;
};
/** @param {unknown} url */
const lastSegment = (url) => decodeURIComponent(String(url).split("/").pop() || "");

/** Record DELETEs, answer everything else 200.
 * @param {string[]} deleted @param {number} [deleteStatus] */
function deletingFetch(deleted, deleteStatus = 200) {
  return env.setFetch(async (url, options = {}) => {
    if (options.method === "DELETE") deleted.push(lastSegment(url));
    return jsonResponse({}, options.method === "DELETE" ? deleteStatus : 200);
  });
}

/** @param {{name: string, size: number}} file @param {number} index */
function quotaPayload(file, index) {
  const image = /\.(?:png|jpe?g|webp|gif)$/i.test(file.name);
  return {
    id: `quota-${index}`,
    name: file.name,
    size: file.size,
    kind: image ? "image" : "text",
    status: "parsed",
    parser: image ? "image-sharp-v1" : "text-utf8-v1",
    summary: { zh: image ? "PNG 图片 · 10×10" : "文本（.txt） · 1 字" },
    warnings: [],
    needsVision: image,
  };
}

/** @param {number} count @param {{name: string, size: number}[]} files */
async function finishQuotaUploads(count, files) {
  for (let index = 0; index < count; index += 1) {
    while (!FakeXHR.instances[index]) await tick();
    const file = files[index];
    assert.ok(file);
    xhr(index).finish(200, quotaPayload(file, index));
    await tick();
  }
}

/** @param {string} prefix @param {number} count @param {string} extension @param {string} type */
const files = (prefix, count, extension, type) =>
  Array.from({ length: count }, (_, index) => fileLike(`${prefix}-${index + 1}.${extension}`, 100, type));

beforeEach(() => {
  env = installDom(EDITOR_MARKUP, { url: "http://editor.test/index.html?project=test-project" });
});
afterEach(() => env.restore());

test("persisted selection restores parsed chips after reload; unsupported ids drop", async () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      { id: "att-png", name: "sample.png", bytes: 1200 },
      { id: "att-stale", name: "gone.csv", bytes: 1 },
    ]),
  );
  env.setFetch(async (url) => (String(url).includes("att-stale") ? jsonResponse({}, 404) : jsonResponse(PARSED_PNG)));
  const att = mount();
  await att.restore();
  assert.equal(chips().length, 1);
  assert.match(textOf(chip(0)), /sample\.png/);
  assert.match(textOf(chip(0)), /已识别/);
  assert.equal(att.pending()[0]?.id, "att-png");
});

test("a picture and a PDF stored by earlier builds keep their chips after restore", async () => {
  const picture = {
    id: "att-legacy-picture",
    name: "legacy-exif.jpg",
    size: 2048,
    kind: "image",
    status: "parsed",
    parser: "image-sharp-v1",
    summary: { zh: "JPEG 图片 · 600×800 · 主色 #F4F1EA" },
    warnings: [],
    needsVision: true,
    imageMetadata: { orientation: "portrait" },
  };
  const pdf = { ...PARSED_PDF, id: "att-legacy-pdf", name: "styled-report.pdf", parser: "pdf-unpdf-v4" };
  /** @type {Map<string, unknown>} */
  const bodies = new Map([
    [picture.id, picture],
    [pdf.id, pdf],
  ]);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([picture, pdf].map(({ id, name, size }) => ({ id, name, bytes: size }))),
  );
  env.setFetch(async (url) => {
    const body = bodies.get(lastSegment(url));
    return body ? jsonResponse(body) : jsonResponse({}, 404);
  });
  const att = mount();
  await att.restore();
  assert.deepEqual(
    chips().map((node) => textOf(node).match(/legacy-exif\.jpg|styled-report\.pdf/)?.[0]),
    ["legacy-exif.jpg", "styled-report.pdf"],
  );
  assert.deepEqual(
    att
      .pending()
      .map(({ id }) => id)
      .sort(),
    [picture.id, pdf.id].sort(),
  );
  query(chip(0), ".chip-toggle").click();
  assert.match(textOf(chip(0).querySelector(".chip-style-hint")), /纵向/);
});

test("the selection persists to localStorage without any owner field", async () => {
  const att = mount();
  att.ingestFiles([fileLike("sample.png", 1200, "image/png")]);
  xhr(0).finish(200, PARSED_PNG);
  await tick();
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  assert.deepEqual(saved, [{ id: "att-png", name: "sample.png", bytes: 1200, consumed: false }]);
  assert.equal(att.pending().length, 1);
});

test("consumeSent removes chips on delete success and keeps failed ones marked", async () => {
  /** @type {string[]} */
  const messages = [];
  const att = mount({ onMessage: (message) => messages.push(message) });
  att.ingestFiles([fileLike("sample.png", 1200, "image/png")]);
  xhr(0).finish(200, PARSED_PNG);
  await tick();
  assert.equal(chips().length, 1);
  deletingFetch([]);
  await att.consumeSent(att.pending());
  assert.equal(chips().length, 0);
  att.ingestFiles([fileLike("text.pdf", 4096, "application/pdf")]);
  xhr(1).finish(200, PARSED_PDF);
  await tick();
  deletingFetch([], 500);
  await att.consumeSent(att.pending());
  assert.equal(chips().length, 1);
  assert.match(textOf(chip(0)), /已发送，待清理/);
  assert.deepEqual(messages, ["Agent 已收到附件，但有附件清理失败；可用 × 重试清理。"]);
});

test("removing a chip with × deletes its server record", async () => {
  /** @type {string[]} */
  const deleted = [];
  const att = mount();
  att.ingestFiles([fileLike("sample.png", 1200, "image/png")]);
  xhr(0).finish(200, PARSED_PNG);
  await tick();
  deletingFetch(deleted);
  query(chip(0), ".chip-remove").click();
  await tick();
  assert.deepEqual(deleted, ["att-png"]);
  assert.equal(att.pending().length, 0);
});

test("editor allows 20 images plus 6 other attachments and rejects each next item", async () => {
  /** @type {string[]} */
  const messages = [];
  const att = mount({ onMessage: (message) => messages.push(message) });
  const picked = [...files("photo", 20, "png", "image/png"), ...files("note", 6, "txt", "text/plain")];
  att.ingestFiles(picked);
  await finishQuotaUploads(picked.length, picked);
  assert.equal(chips().length, 26);
  assert.equal(att.pending().length, 26);
  assert.equal(att.gate(), "");
  att.ingestFiles([fileLike("photo-21.png", 100, "image/png")]);
  att.ingestFiles([fileLike("note-7.txt", 100, "text/plain")]);
  assert.equal(chips().length, 26);
  assert.equal(FakeXHR.instances.length, 26);
  assert.ok(messages.includes("每次最多发送 20 张图片"));
  assert.ok(messages.includes("除图片外，每次最多发送 6 个附件"));
});

test("editor expands image-pack pending items and cleans up parent plus children after send", async () => {
  /** @type {string[]} */
  const deleted = [];
  deletingFetch(deleted);
  const att = mount();
  att.ingestFiles([fileLike("sample.png", 1200, "image/png"), fileLike("photos.zip", 4096, "application/zip")]);
  xhr(0).finish(200, PARSED_PNG);
  await tick();
  xhr(1).finish(200, imagePackPayload());
  await tick();
  assert.equal(chips().length, 2);
  assert.match(textOf(chip(1)), /图片包 · 8 张图片/);
  const packIds = Array.from({ length: 8 }, (_, index) => `pack-image-${index + 1}`);
  assert.deepEqual(
    att.pending().map((attachment) => attachment.id),
    ["att-png", ...packIds],
  );
  await att.consumeSent(att.pending());
  assert.equal(chips().length, 0);
  assert.deepEqual(new Set(deleted), new Set(["att-png", "pack-parent", ...packIds]));
});

test("editor does not add a duplicate chip for an image already inside a selected pack", async () => {
  /** @type {string[]} */
  const messages = [];
  const att = mount({ onMessage: (message) => messages.push(message) });
  att.ingestFiles([fileLike("photos.zip", 4096, "application/zip")]);
  xhr(0).finish(200, imagePackPayload());
  await tick();
  att.ingestFiles([fileLike("照片1.jpg", 300, "image/jpeg")]);
  xhr(1).finish(200, { ...PARSED_PNG, id: "pack-image-1", name: "照片1.jpg", duplicateOf: "pack-image-1" });
  await tick();
  assert.equal(chips().length, 1);
  assert.equal(att.pending().length, 8);
  assert.ok(messages.some((message) => message.includes("已存在相同文件")));
});

test("editor counts image-pack contents toward the shared image quota", async () => {
  /** @type {string[]} */
  const messages = [];
  /** @type {string[]} */
  const deleted = [];
  deletingFetch(deleted);
  const att = mount({ onMessage: (message) => messages.push(message) });
  const picked = files("photo", 13, "png", "image/png");
  att.ingestFiles(picked);
  await finishQuotaUploads(picked.length, picked);
  att.ingestFiles([fileLike("photos.zip", 4096, "application/zip")]);
  xhr(13).finish(200, imagePackPayload());
  await tick();
  assert.equal(chips().length, 13);
  assert.equal(att.pending().length, 13);
  assert.ok(messages.includes("每次最多发送 20 张图片"));
  assert.equal(deleted.length, 9);
  assert.ok(deleted.includes("pack-parent"));
  assert.ok(deleted.includes("pack-image-8"));
});

test("busy changes reach onBusy and items reach onItemsChanged", async () => {
  /** @type {boolean[]} */
  const busy = [];
  /** @type {number[]} */
  const counts = [];
  const att = mount({
    onBusy: (value) => busy.push(value),
    onItemsChanged: (pending) => counts.push(pending.length),
  });
  att.ingestFiles([fileLike("sample.png", 1200, "image/png")]);
  xhr(0).finish(200, PARSED_PNG);
  await tick();
  assert.deepEqual(busy, [true, false]);
  assert.equal(counts.at(-1), 1);
  att.repaint();
  assert.equal(chips().length, 1);
});
