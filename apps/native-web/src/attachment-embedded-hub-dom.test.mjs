import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mountHubAttachments, parseAttachmentPublic } from "../public/hub-attachments.js";
import { embeddedImageSelection } from "../public/attachment-quota.js";
import {
  FakeXHR,
  HUB_MARKUP,
  chipsIn,
  documentPayload,
  embedded,
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

/** @type {ReturnType<typeof installDom>} */
let env;
const chips = () => chipsIn(required("attach-row"));
/** @param {number} index */
const chip = (index) => {
  const node = chips()[index];
  assert.ok(node, `chip #${index}`);
  return node;
};
/** @param {Partial<Parameters<typeof mountHubAttachments>[0]>} [overrides] */
const mount = (overrides = {}) => mountHubAttachments({ onChange: () => {}, onMessage: () => {}, ...overrides });

beforeEach(() => {
  env = installDom(HUB_MARKUP, { url: "http://hub.test/", fetchImpl: async () => jsonResponse({}) });
});
afterEach(() => env.restore());

test("VAL-PDF-007: a document chip lists its pictures and sends them together with the document", async () => {
  const attachments = mount();
  attachments.ingestFiles([fileLike("报告.docx", 20_480)]);
  xhr(0).finish(200, documentPayload(2));
  await tick();
  assert.equal(chips().length, 1, "pictures are not separate chips");
  assert.match(textOf(chip(0)), /已识别 · 20\.0 KB · 内嵌图片 2 张/);
  query(chip(0), ".chip-toggle").click();
  assert.deepEqual(
    [...chip(0).querySelectorAll(".chip-embedded-detail")].map((line) => line.textContent),
    ["内含 2 张图片，已作为图片资料，可放进页面（来自文档第 2 段、来自文档第 4 段）"],
  );
  assert.deepEqual(
    attachments.selection().map(({ id }) => id),
    ["doc-1", "emb-1", "emb-2"],
    "the document stays selected; its pictures follow it",
  );
});

test("a converted WPS document keeps its conversion badge next to the picture count (M8-SCR-14)", async () => {
  const attachments = mount();
  attachments.ingestFiles([fileLike("报告.wps", 20_480)]);
  xhr(0).finish(
    200,
    documentPayload(2, {
      id: "legacy-wps-1",
      name: "报告.wps",
      summary: { zh: "（由 WPS .wps 转换）Word 文档 · 1 个标题 · 2 张图片" },
      warnings: [
        {
          code: "converted-from-legacy",
          message:
            "已把 WPS 文字（.wps）自动转换成 .docx 后读取；段落格式可能与原文件不同，要完全一致请用 Word 或 WPS 另存为 .docx 后上传",
        },
      ],
    }),
  );
  await tick();
  const status = textOf(chip(0).querySelector(".chip-status"));
  assert.equal(status, "已从 WPS .wps 转换 · 20.0 KB · 内嵌图片 2 张");
  assert.deepEqual(
    attachments.selection().map(({ id }) => id),
    ["legacy-wps-1", "emb-1", "emb-2"],
  );
  query(chip(0), ".chip-toggle").click();
  assert.match(textOf(chip(0).querySelector(".chip-detail")), /（由 WPS \.wps 转换）/);
  assert.match(textOf(chip(0).querySelector(".chip-detail")), /可能与原文件不同/);
});

test("a document is never refused for its pictures; what exceeds the 20-image quota is reported", async () => {
  const attachments = mount();
  const files = Array.from({ length: 18 }, (_, index) => fileLike(`own-${index}.png`, 100, "image/png"));
  attachments.ingestFiles(files);
  for (let index = 0; index < files.length; index += 1) {
    while (!FakeXHR.instances[index]) await tick();
    xhr(index).finish(200, imagePayload(index));
    await tick();
  }
  attachments.ingestFiles([fileLike("报告.docx", 20_480)]);
  xhr(18).finish(200, documentPayload(5));
  await tick();
  assert.equal(chips().length, 19);
  const ids = attachments.selection().map(({ id }) => id);
  assert.equal(ids.length, 18 + 1 + 2);
  assert.deepEqual(ids.slice(-3), ["doc-1", "emb-1", "emb-2"]);
  query(chip(18), ".chip-toggle").click();
  assert.match(textOf(chip(18)), /另有 3 张内嵌图片没有随本次发送：每次最多 20 张图片，名额已满/);
  assert.doesNotMatch(textOf(chip(18)), /剩下的会随后续消息继续发送/, "the Hub sends once");
  query(chip(18), ".chip-remove").click();
  assert.equal(attachments.selection().length, 18);
});

test("an identical standalone upload that dedupes onto an embedded picture is not added twice", async () => {
  /** @type {string[]} */
  const messages = [];
  const attachments = mount({ onMessage: (message) => messages.push(message) });
  attachments.ingestFiles([fileLike("报告.docx", 20_480)]);
  xhr(0).finish(200, documentPayload(2));
  await tick();
  attachments.ingestFiles([fileLike("same.png", 900, "image/png")]);
  xhr(1).finish(200, { ...imagePayload(0), id: "emb-1", name: "same.png", duplicateOf: "emb-1" });
  await tick();
  assert.equal(chips().length, 1);
  assert.ok(messages.some((message) => message.includes("已存在相同文件")));
  assert.deepEqual(
    attachments.selection().map(({ id }) => id),
    ["doc-1", "emb-1", "emb-2"],
  );
});

test("the selection never repeats an id when a standalone chip already holds a picture's record", () => {
  const standalone = { id: "emb-2", status: "parsed", kind: "image", name: "same.png" };
  const doc = {
    id: "doc-1",
    status: "parsed",
    kind: "document",
    parser: "docx-ooxml-v1",
    name: "报告.docx",
    embeddedImages: parseAttachmentPublic(documentPayload(3)).embeddedImages,
  };
  const selection = embeddedImageSelection(
    /** @type {Parameters<typeof embeddedImageSelection>[0]} */ ([doc, standalone]),
  );
  assert.deepEqual(
    selection.get(doc)?.included.map(({ id }) => id),
    ["emb-1", "emb-3"],
  );
  assert.equal(selection.get(doc)?.omitted, 0);
});

test("the public reply parser accepts pictures only on a parsed DOCX or PDF and checks each entry", () => {
  const valid = parseAttachmentPublic(documentPayload(2));
  assert.equal(valid.embeddedImages?.length, 2);
  assert.equal(valid.embeddedImages?.[0]?.origin, "docx");
  const pdf = documentPayload(1, { parser: "pdf-unpdf-v4", name: "a.pdf" });
  assert.equal(parseAttachmentPublic(pdf).embeddedImages?.length, 1);
  const [one] = embedded(1);
  const invalid = [
    documentPayload(1, { kind: "text", parser: "text-utf8-v1" }),
    documentPayload(1, { parser: "xlsx-ooxml-v1" }),
    documentPayload(1, { embeddedImages: [] }),
    documentPayload(1, { embeddedImages: embedded(41) }),
    documentPayload(1, { embeddedImages: [{ ...one, origin: "pptx" }] }),
    documentPayload(1, { embeddedImages: [{ ...one, parser: "docx-ooxml-v1" }] }),
    documentPayload(1, { embeddedImages: [{ ...one, note: "" }] }),
    documentPayload(1, { embeddedImages: [{ ...one, needsVision: "yes" }] }),
    documentPayload(1, { status: "failed", errorCode: "corrupt", message: "x" }),
  ];
  for (const payload of invalid) {
    assert.throws(() => parseAttachmentPublic(payload), /资料上传回复无效/);
  }
});

test("the public reply keeps where a picture sits in a DOCX table", () => {
  const [picture] = embedded(1);
  const inTable = { ...picture, id: "tbl-1", note: "来自文档第 1 个表格", position: { table: 1, row: 2, column: 3 } };
  const decoded = parseAttachmentPublic(documentPayload(0, { embeddedImages: [inTable] }));
  assert.equal(decoded.embeddedImages?.[0]?.note, "来自文档第 1 个表格");
  assert.deepEqual(decoded.embeddedImages?.[0]?.position, { table: 1, row: 2, column: 3 });
});
