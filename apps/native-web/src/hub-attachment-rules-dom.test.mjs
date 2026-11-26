import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { hubSendState, mountHubAttachments, parseAttachmentPublic } from "../public/hub-attachments.js";
import { styleDisplayName } from "../public/style-catalog-names.js";
import {
  FakeXHR,
  chipsIn,
  click,
  fetchedUrls,
  fileLike,
  imagePackPayload,
  HUB_MARKUP,
  installDom,
  jsonResponse,
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
const PACK_PRIORITY = (/** @type {string} */ label) =>
  `已选择风格『${label}』，配色、字体和装饰以它为准；附件用于 Logo、照片、内容和数据，版式只作参考。要按附件风格，请切回『自由风格』。`;

/** @type {ReturnType<typeof installDom>} */
let env;
/** @param {Record<string, unknown>} [overrides] */
const parsedRecord = (overrides = {}) => ({ ...PARSED_RECORD, ...overrides });
/** @param {Partial<Parameters<typeof mountHubAttachments>[0]>} [overrides] */
const mount = (overrides = {}) => mountHubAttachments({ onChange: () => {}, onMessage: () => {}, ...overrides });
const rowChips = () => chipsIn(required("attach-row"));

/** @param {{name: string, size: number}} file @param {number} index */
function quotaPayload(file, index) {
  const image = /\.(?:png|jpe?g|webp|gif)$/i.test(file.name);
  return parsedRecord({
    id: `quota-${index}`,
    name: file.name,
    size: file.size,
    kind: image ? "image" : "text",
    parser: image ? "image-sharp-v1" : "text-utf8-v1",
    summary: { zh: image ? "PNG 图片 · 10×10" : "文本（.txt） · 1 字" },
    needsVision: image,
  });
}

/** @param {{name: string, size: number}[]} files */
async function finishQuotaUploads(files) {
  for (const [index, file] of files.entries()) {
    while (!FakeXHR.instances[index]) await tick();
    xhr(index).finish(200, quotaPayload(file, index));
    await tick();
  }
}

/** @param {string} prefix @param {number} count @param {string} extension @param {string} type */
const files = (prefix, count, extension, type) =>
  Array.from({ length: count }, (_, index) => fileLike(`${prefix}-${index + 1}.${extension}`, 100, type));

beforeEach(() => {
  env = installDom(HUB_MARKUP, {
    url: "http://hub.test/",
    fetchImpl: async () => new Response("[]", { status: 500 }),
  });
});
afterEach(() => env.restore());

test("Hub style reminder updates with parsed kinds and never affects send eligibility", async () => {
  let context = { brief: "参考这个PPT风格和内容，做一份月报", designSystemId: "", stylePackName: "" };
  const attachments = mount({ styleNoticeContext: () => context });
  const notice = required("style-source-notice");
  attachments.ingestFiles([fileLike("report.docx", 4096)]);
  xhr(0).finish(200, parsedRecord({ id: "att-docx", name: "report.docx", kind: "document", parser: "docx-ooxml-v1" }));
  await tick();
  assert.equal(notice.hidden, false);
  assert.match(textOf(notice), /Word、表格和文本只提供文字或数据/);
  assert.equal(attachments.sendState({ briefFilled: true }).disabled, false);
  attachments.ingestFiles([fileLike("brand.pptx", 4096)]);
  xhr(1).finish(
    200,
    parsedRecord({ id: "att-pptx", name: "brand.pptx", kind: "deck-template", parser: "pptx-ooxml-v1" }),
  );
  await tick();
  assert.equal(notice.hidden, true, "a style source hides the keyword-only reminder");
  context = { ...context, designSystemId: "work/warm-clay-works", stylePackName: "暖陶作品" };
  attachments.refreshStyleNotice();
  assert.equal(notice.hidden, false);
  assert.match(textOf(notice), /^已选择风格『暖陶作品』，配色、字体和装饰以它为准/);
  assert.equal(notice.querySelector("button, a, [role=button], [data-control]"), null);
  assert.equal(attachments.sendState({ briefFilled: true }).disabled, false);
  click(rowChips()[1], ".chip-remove");
  assert.equal(notice.hidden, false, "removing the style source restores the non-blocking reminder");
  assert.match(textOf(notice), /没有.*可作风格来源/);
  context.brief = "做一份月报";
  attachments.refreshStyleNotice();
  assert.equal(notice.hidden, true);
});

for (const [kind, parser, name, packId] of [
  ["deck-template", "pptx-ooxml-v2", "brand.pptx", "work/warm-clay-works"],
  ["image", "image-sharp-v1", "brand.png", "finance/honey-orange-memo"],
  ["document", "pdf-unpdf-v3", "brand.pdf", "academic/paper-white-courseware"],
]) {
  test(`VAL-ASPECT-007: Hub explains ${kind} priority before any send`, async () => {
    const label = styleDisplayName(packId || "", undefined);
    const attachments = mount({
      styleNoticeContext: () => ({ brief: "", designSystemId: packId, stylePackName: label }),
    });
    attachments.ingestFiles([fileLike(name || "", 4096)]);
    xhr(0).finish(200, parsedRecord({ kind, parser, name }));
    await tick();
    const notice = required("style-source-notice");
    assert.equal(notice.hidden, false);
    assert.equal(textOf(notice), PACK_PRIORITY(label));
    assert.equal(attachments.sendState({ briefFilled: true }).disabled, false);
    assert.deepEqual(
      FakeXHR.instances.map((request) => request.url),
      ["/api/attachments/upload"],
    );
    // Mount probes /api/health once for the legacy accept list; nothing else.
    assert.deepEqual(fetchedUrls(env.fetchMock), ["/api/health"]);
  });
}

test("send rules: busy chips block, bad chips block with the file name, parsed-only is allowed", () => {
  const busy = { disabled: true, reason: "资料仍在上传或解析，请稍候" };
  assert.deepEqual(hubSendState([], { briefFilled: false }), {
    disabled: true,
    reason: "请填写文稿要求，或添加至少一个已识别的参考资料",
  });
  assert.equal(hubSendState([], { briefFilled: true }).disabled, false);
  assert.equal(hubSendState([{ name: "a", status: "parsed", id: "x" }], { briefFilled: false }).disabled, false);
  for (const status of /** @type {const} */ (["uploading", "parsing", "queued"])) {
    assert.deepEqual(hubSendState([{ name: "b.png", status }], { briefFilled: true }), busy);
  }
  assert.deepEqual(
    hubSendState(
      [
        { name: "a", status: "parsed", id: "x" },
        { name: "legacy.xls", status: "unsupported" },
      ],
      { briefFilled: true },
    ),
    { disabled: true, reason: "资料“legacy.xls”不能使用，请移除或重试后再发送" },
  );
  assert.deepEqual(hubSendState([{ name: "a", status: "failed" }], { briefFilled: true }), {
    disabled: true,
    reason: "资料“a”不能使用，请移除或重试后再发送",
  });
});

test("parseAttachmentPublic rejects malformed upload replies instead of painting them", () => {
  const valid = parseAttachmentPublic(PARSED_RECORD);
  assert.equal(valid.id, "att-1");
  assert.equal(valid.summary?.zh, "XLSX 表格 · 2 个工作表 · 共 120 行");
  for (const value of [
    null,
    [],
    { ...PARSED_RECORD, status: "ok" },
    { ...PARSED_RECORD, id: "" },
    { ...PARSED_RECORD, size: "12" },
    { ...PARSED_RECORD, summary: { zh: 3 } },
    { ...PARSED_RECORD, warnings: "none" },
    { ...PARSED_RECORD, warnings: [{ code: 1 }] },
    { ...PARSED_RECORD, styleHintLine: "x".repeat(241) },
    { ...PARSED_RECORD, needsVision: "yes" },
  ]) {
    assert.throws(() => parseAttachmentPublic(value), /资料上传回复无效/);
  }
});

test("parseAttachmentPublic enforces the bounded PDF style-profile contract", () => {
  const accent = { hex: "#C00000", share: 1, roles: ["fill"] };
  const font = { source: "HYQiHei-EES", share: 1, mapped: { latin: "Arial", ea: "微软雅黑" } };
  const styleProfile = {
    schema: "style-profile/v1",
    source: "pdf-vector-ops",
    pagesScanned: 1,
    accentColors: [accent],
    neutralColors: [{ hex: "#FFFFFF" }],
    fonts: [font],
  };
  const pdf = { ...PARSED_RECORD, kind: "document", parser: "pdf-unpdf-v3", styleProfile };
  assert.deepEqual(parseAttachmentPublic(pdf).styleProfile, styleProfile);
  for (const invalidProfile of [
    { ...styleProfile, pagesScanned: 0 },
    { ...styleProfile, pagesScanned: 31 },
    { ...styleProfile, accentColors: Array.from({ length: 6 }, () => accent) },
    { ...styleProfile, accentColors: [{ hex: "#C00000", share: 1 }] },
    { ...styleProfile, neutralColors: Array.from({ length: 13 }, () => ({ hex: "#FFFFFF" })) },
    { ...styleProfile, fonts: Array.from({ length: 5 }, () => font) },
  ]) {
    assert.throws(() => parseAttachmentPublic({ ...pdf, styleProfile: invalidProfile }), /资料上传回复无效/);
  }
});

test("parseAttachmentPublic accepts a PDF whose only colours are page-pixel statistics", () => {
  const parsed = parseAttachmentPublic({
    ...PARSED_RECORD,
    kind: "document",
    parser: "pdf-unpdf-v3",
    styleProfile: {
      schema: "style-profile/v1",
      source: "pdf-page-pixels",
      pagesScanned: 2,
      accentColors: [],
      neutralColors: [],
      fonts: [],
    },
  });
  assert.equal(parsed.styleProfile?.source, "pdf-page-pixels");
  assert.equal(parsed.styleProfile && "pagesScanned" in parsed.styleProfile && parsed.styleProfile.pagesScanned, 2);
});

test("Hub allows 20 images plus 6 other attachments and rejects each next item", async () => {
  /** @type {string[]} */
  const messages = [];
  const attachments = mount({ onMessage: (message) => messages.push(message) });
  const picked = [...files("photo", 20, "png", "image/png"), ...files("note", 6, "txt", "text/plain")];
  attachments.ingestFiles(picked);
  await finishQuotaUploads(picked);
  assert.equal(rowChips().length, 26);
  assert.equal(attachments.selection().length, 26);
  assert.deepEqual(attachments.sendState({ briefFilled: true }), { disabled: false, reason: "" });
  attachments.ingestFiles([fileLike("photo-21.png", 100, "image/png")]);
  attachments.ingestFiles([fileLike("note-7.txt", 100, "text/plain")]);
  assert.equal(rowChips().length, 26);
  assert.equal(FakeXHR.instances.length, 26);
  assert.ok(messages.includes("每次最多发送 20 张图片"));
  assert.ok(messages.includes("除图片外，每次最多发送 6 个附件"));
});

test("Hub image-pack chips expose each contained image to the outgoing selection", async () => {
  const attachments = mount();
  attachments.ingestFiles([fileLike("photos.zip", 4096, "application/zip")]);
  xhr(0).finish(200, imagePackPayload());
  await tick();
  assert.match(textOf(rowChips()[0]), /图片包 · 8 张图片/);
  click(rowChips()[0], ".chip-toggle");
  assert.match(textOf(rowChips()[0]), /说明\.txt/);
  assert.match(textOf(rowChips()[0]), /__MACOSX/);
  assert.deepEqual(
    attachments.selection().map((attachment) => attachment.id),
    Array.from({ length: 8 }, (_, index) => `pack-image-${index + 1}`),
  );
});

test("Hub does not add a duplicate chip for an image already inside a selected pack", async () => {
  /** @type {string[]} */
  const messages = [];
  const attachments = mount({ onMessage: (message) => messages.push(message) });
  attachments.ingestFiles([fileLike("photos.zip", 4096, "application/zip")]);
  xhr(0).finish(200, imagePackPayload());
  await tick();
  attachments.ingestFiles([fileLike("照片1.jpg", 300, "image/jpeg")]);
  xhr(1).finish(
    200,
    parsedRecord({
      id: "pack-image-1",
      name: "照片1.jpg",
      kind: "image",
      parser: "image-sharp-v1",
      duplicateOf: "pack-image-1",
      needsVision: true,
    }),
  );
  await tick();
  assert.equal(rowChips().length, 1);
  assert.equal(attachments.selection().length, 8);
  assert.ok(messages.some((message) => message.includes("已存在相同文件")));
});

test("Hub rejects an image pack that would exceed the 20-image quota", async () => {
  /** @type {string[]} */
  const messages = [];
  /** @type {string[]} */
  const deleted = [];
  env.setFetch(async (url, options = {}) => {
    if (options.method === "DELETE") deleted.push(decodeURIComponent(String(url).split("/").pop() || ""));
    return jsonResponse({});
  });
  const attachments = mount({ onMessage: (message) => messages.push(message) });
  const picked = files("photo", 13, "png", "image/png");
  attachments.ingestFiles(picked);
  await finishQuotaUploads(picked);
  attachments.ingestFiles([fileLike("photos.zip", 4096, "application/zip")]);
  xhr(13).finish(200, imagePackPayload());
  await tick();
  assert.equal(rowChips().length, 13);
  assert.equal(attachments.selection().length, 13);
  assert.ok(messages.includes("每次最多发送 20 张图片"));
  assert.equal(deleted.length, 9, "the rejected pack and its eight child records are cleaned up");
});

test("items() exposes read-only scope state and repaint() keeps the chips", async () => {
  const attachments = mount();
  attachments.ingestFiles([fileLike("sample.xlsx", 1536)]);
  xhr(0).finish(200, parsedRecord());
  await tick();
  assert.deepEqual(attachments.items(), [
    { kind: "table", parser: "xlsx-ooxml-v1", name: "sample.xlsx", status: "parsed" },
  ]);
  attachments.repaint();
  assert.equal(rowChips().length, 1);
});
