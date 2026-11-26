import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mountEditorAttachments } from "../public/editor-attachments.js";
import {
  EDITOR_MARKUP,
  FakeXHR,
  chipsIn,
  documentPayload,
  fileLike,
  imagePayload,
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
/** @type {string[]} */
let deleted = [];

/** @type {import("./attachment-dom-harness.test.mjs").FetchImpl} */
async function recordingFetch(url, options = {}) {
  if (options.method === "DELETE") {
    deleted.push(decodeURIComponent(String(url).split("/").pop() || ""));
    return jsonResponse({});
  }
  return jsonResponse({}, 404);
}

const mount = () => mountEditorAttachments({ projectKey: () => "test-project", apiPath: (path) => path });
const chips = () => chipsIn(required("agent-attachments"));
const documentChip = () => {
  const node = chips().find((element) => element.dataset.attachId === "doc-1");
  assert.ok(node, "the document chip is shown");
  return node;
};
/** @param {number} from @param {number} to */
const embeddedIds = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => `emb-${from + index}`);
const ownIds = Array.from({ length: 8 }, (_, index) => `own-${index}`);
const bigPdf = () => documentPayload(40, { parser: "pdf-unpdf-v4", name: "报告.pdf" });

/** 8 standalone photos, then a document that carries 40 pictures.
 * @param {{ingestFiles: (files: ArrayLike<File>) => unknown}} att */
async function eightPhotosAndABigDocument(att) {
  att.ingestFiles(Array.from({ length: 8 }, (_, index) => fileLike(`own-${index}.png`, 100, "image/png")));
  for (let index = 0; index < 8; index += 1) {
    while (!FakeXHR.instances[index]) await tick();
    xhr(index).finish(200, imagePayload(index));
    await tick();
  }
  att.ingestFiles([fileLike("报告.pdf", 20_480)]);
  xhr(8).finish(200, bigPdf());
  await tick();
}

beforeEach(() => {
  deleted = [];
  env = installDom(EDITOR_MARKUP, {
    url: "http://editor.test/index.html?project=test-project",
    fetchImpl: recordingFetch,
  });
});
afterEach(() => env.restore());

test("pending() carries the pictures after their document and a sent document deletes all of them", async () => {
  const att = mount();
  att.ingestFiles([fileLike("报告.docx", 20_480)]);
  xhr(0).finish(200, documentPayload(3));
  await tick();
  const pending = att.pending();
  assert.deepEqual(
    pending.map(({ id }) => id),
    ["doc-1", "emb-1", "emb-2", "emb-3"],
  );
  assert.equal(pending[1]?.name, "报告-image1.png");
  await att.consumeSent(pending);
  assert.equal(chips().length, 0);
  assert.deepEqual(new Set(deleted), new Set(["doc-1", ...embeddedIds(1, 3)]));
});

test("pictures that did not fit the quota stay with the sent document and ride along with the next sends", async () => {
  const att = mount();
  await eightPhotosAndABigDocument(att);
  const first = att.pending();
  assert.deepEqual(
    first.map(({ id }) => id),
    [...ownIds, "doc-1", ...embeddedIds(1, 12)],
  );
  await att.consumeSent(first);
  assert.deepEqual(new Set(deleted), new Set(ownIds), "the document and all 40 pictures stay");
  assert.equal(chips().length, 1);
  assert.match(textOf(documentChip()), /文档已发送 · 内嵌图片还剩 28 张待发送/);
  const second = att.pending();
  assert.deepEqual(
    second.map(({ id }) => id),
    embeddedIds(13, 32),
    "20 more pictures, and no document id",
  );
  await att.consumeSent(second);
  assert.equal(deleted.length, 8, "nothing else deleted yet");
  assert.match(textOf(documentChip()), /还剩 8 张待发送/);
  const third = att.pending();
  assert.deepEqual(
    third.map(({ id }) => id),
    embeddedIds(33, 40),
  );
  await att.consumeSent(third);
  assert.equal(chips().length, 0, "the last batch removes the chip");
  for (const id of ["doc-1", ...embeddedIds(1, 40)]) assert.ok(deleted.includes(id), `${id} is cleaned up`);
  assert.deepEqual(att.pending(), []);
});

test("the chip explains what was sent, what is left and that the rest follows", async () => {
  const att = mount();
  await eightPhotosAndABigDocument(att);
  query(documentChip(), ".chip-toggle").click();
  const before = [...documentChip().querySelectorAll(".chip-embedded-detail")].map((line) => line.textContent);
  assert.match(
    before.at(-1) || "",
    /另有 28 张内嵌图片没有随本次发送：每次最多 20 张图片，名额已满；剩下的会随后续消息继续发送/,
  );
  await att.consumeSent(att.pending());
  const lines = [...documentChip().querySelectorAll(".chip-embedded-detail")].map((line) => line.textContent);
  assert.match(lines[0] || "", /文档已发送，不会重复发送；内含 40 张图片，已发送 12 张，还剩 28 张/);
  assert.match(lines[1] || "", /另有 8 张内嵌图片没有随本次发送/);
});

test("removing the chip after the first send drops the document and every picture, sent or not", async () => {
  const att = mount();
  await eightPhotosAndABigDocument(att);
  await att.consumeSent(att.pending());
  deleted.length = 0;
  query(documentChip(), ".chip-remove").click();
  await tick();
  assert.equal(chips().length, 0);
  assert.deepEqual(new Set(deleted), new Set(["doc-1", ...embeddedIds(1, 40)]));
  assert.deepEqual(att.pending(), []);
});

test("a reload after the first send restores the sent state and the next batch", async () => {
  const att = mount();
  await eightPhotosAndABigDocument(att);
  await att.consumeSent(att.pending());
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  assert.deepEqual(
    saved.map((/** @type {{id: string, documentSent?: boolean}} */ entry) => [entry.id, entry.documentSent]),
    [["doc-1", true]],
  );
  required("agent-attachments").replaceChildren();
  env.setFetch(async () => jsonResponse(bigPdf()));
  const again = mount();
  await again.restore();
  assert.match(textOf(documentChip()), /文档已发送 · 内嵌图片还剩 28 张待发送/);
  assert.deepEqual(
    again.pending().map(({ id }) => id),
    embeddedIds(13, 32),
  );
});

test("a failed clean-up of the last batch keeps the chip marked as sent for a retry", async () => {
  const att = mount();
  await eightPhotosAndABigDocument(att);
  await att.consumeSent(att.pending());
  await att.consumeSent(att.pending());
  env.setFetch(async () => jsonResponse({}, 500));
  await att.consumeSent(att.pending());
  assert.match(textOf(documentChip()), /已发送，待清理/);
  assert.deepEqual(att.pending(), [], "a consumed chip is never sent again");
});

test("a document with all its pictures inside the quota is cleaned up at once", async () => {
  const att = mount();
  att.ingestFiles([fileLike("报告.docx", 20_480)]);
  xhr(0).finish(200, documentPayload(20));
  await tick();
  await att.consumeSent(att.pending());
  assert.equal(chips().length, 0);
  assert.deepEqual(new Set(deleted), new Set(["doc-1", ...embeddedIds(1, 20)]));
});

test("another document and new photos can still be added while a sent document holds pictures", async () => {
  const att = mount();
  await eightPhotosAndABigDocument(att);
  await att.consumeSent(att.pending());
  att.ingestFiles([fileLike("new.png", 100, "image/png")]);
  xhr(9).finish(200, { ...imagePayload(99), id: "own-99", name: "new.png" });
  await tick();
  assert.deepEqual(
    att.pending().map(({ id }) => id),
    [...embeddedIds(13, 31), "own-99"],
    "the new photo takes one of the 20 places, in chip order",
  );
});

test("removing the document chip with × deletes the document and every picture record", async () => {
  const att = mount();
  att.ingestFiles([fileLike("报告.docx", 20_480)]);
  xhr(0).finish(200, documentPayload(2));
  await tick();
  query(chips()[0], ".chip-remove").click();
  await tick();
  assert.equal(chips().length, 0);
  assert.deepEqual(new Set(deleted), new Set(["doc-1", "emb-1", "emb-2"]));
  assert.deepEqual(att.pending(), []);
});

test("a reload restores the document with its pictures from the stored record", async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: "doc-1", name: "报告.docx", bytes: 20_480 }]));
  env.setFetch(async () => jsonResponse(documentPayload(2)));
  const att = mount();
  await att.restore();
  assert.deepEqual(
    att.pending().map(({ id }) => id),
    ["doc-1", "emb-1", "emb-2"],
  );
});
