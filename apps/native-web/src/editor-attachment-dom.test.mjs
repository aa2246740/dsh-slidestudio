import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { mountEditorAttachments } from "../public/editor-attachments.js";
import { UPLOAD_STALL_MS, createAttachmentChips, parseAttachmentPublic } from "../public/attachment-chips.js";
import { MATERIAL_SCOPE } from "../public/material-scope.js";
import { styleDisplayName } from "../public/style-catalog-names.js";
import {
  PARSED_DOCX,
  PARSED_PDF,
  PARSED_PNG,
  PARSED_XLSX,
  UNSUPPORTED_PPT,
  FakeXHR,
  chipsIn,
  click,
  fetchedUrls,
  fileLike,
  EDITOR_MARKUP,
  installDom,
  query,
  required,
  textOf,
  tick,
  xhr,
} from "./attachment-dom-harness.test.mjs";

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

beforeEach(() => {
  env = installDom(EDITOR_MARKUP, { url: "http://editor.test/index.html?project=test-project" });
});
afterEach(() => env.restore());

test("editor composer uploads png/xlsx/pdf through the binary route with parsed chips", async () => {
  const att = mount();
  att.ingestFiles([
    fileLike("sample.png", 1200, "image/png"),
    fileLike("sample.xlsx", 2048),
    fileLike("text.pdf", 4096, "application/pdf"),
  ]);
  assert.equal(FakeXHR.instances.length, 2); // concurrency cap, third queued
  assert.match(textOf(chip(2)), /排队中/);
  xhr(0).finish(200, PARSED_PNG);
  await tick();
  xhr(1).finish(200, PARSED_XLSX);
  await tick();
  assert.equal(FakeXHR.instances.length, 3);
  xhr(2).finish(200, PARSED_PDF);
  await tick();
  assert.equal(chips().length, 3);
  for (const request of FakeXHR.instances) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/attachments/upload");
    assert.equal(request.requestHeaders["Content-Type"], "application/octet-stream");
  }
  assert.equal(xhr(0).requestHeaders["X-Attachment-Name"], encodeURIComponent("sample.png"));
  assert.match(textOf(chip(0)), /已识别 · 1\.2 KB/);
  assert.match(textOf(chip(1)), /XLSX 表格/);
  assert.match(textOf(chip(1)), /sample\.xlsx/);
  assert.deepEqual(
    att.pending().map((entry) => entry.id),
    ["att-png", "att-xlsx", "att-pdf"],
  );
});

test("a bad file fails alone while the rest of the batch parses", async () => {
  const att = mount();
  att.ingestFiles([
    fileLike("legacy.ppt", 512),
    fileLike("sample.png", 1200, "image/png"),
    fileLike("text.pdf", 4096, "application/pdf"),
  ]);
  xhr(0).finish(200, UNSUPPORTED_PPT);
  xhr(1).finish(200, PARSED_PNG);
  await tick();
  xhr(2).finish(200, PARSED_PDF);
  await tick();
  assert.equal(chips().length, 3);
  const bad = chip(0);
  assert.match(textOf(bad), /不支持/);
  assert.match(textOf(bad), /请另存为 \.pptx/);
  assert.equal(bad.querySelector(".chip-retry"), null);
  assert.ok(bad.querySelector(".chip-remove"));
  assert.match(textOf(chip(1)), /已识别/);
  assert.match(textOf(chip(2)), /已识别/);
  assert.equal(att.gate(), "资料“legacy.ppt”不能使用，请移除或重试后再发送");
  click(bad, ".chip-remove");
  assert.equal(att.gate(), "");
  assert.equal(chips().length, 2);
});

test("busy uploads block the gate and removing mid-upload aborts the XHR", async () => {
  const att = mount();
  att.ingestFiles([fileLike("near-limit.png", 19 * 1024 * 1024, "image/png")]);
  assert.equal(att.gate(), "资料仍在上传或解析，请稍候");
  assert.equal(att.busy(), true);
  const request = xhr(0);
  click(chip(0), ".chip-remove");
  assert.equal(request.aborted, true);
  assert.equal(chips().length, 0);
  request.finish(200, PARSED_PNG);
  await tick();
  assert.equal(chips().length, 0);
  assert.equal(att.gate(), "");
});

test("re-uploading the same file shows the dedupe hint", async () => {
  /** @type {string[]} */
  const messages = [];
  const att = mount({ onMessage: (message) => messages.push(message) });
  att.ingestFiles([fileLike("text.pdf", 4096, "application/pdf")]);
  xhr(0).finish(200, PARSED_PDF);
  await tick();
  att.ingestFiles([fileLike("copy.pdf", 4096, "application/pdf")]);
  xhr(1).finish(200, { ...PARSED_PDF, duplicateOf: "att-pdf" });
  await tick();
  assert.equal(chips().length, 1);
  assert.ok(messages.some((message) => message.includes("已存在相同文件")));
});

test("offline upload in the composer fails in Chinese and retry reuses the chip", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const att = mount();
  const file = fileLike("sample.png", 1200, "image/png");
  att.ingestFiles([file]);
  assert.equal(FakeXHR.instances.length, 1);
  mock.timers.tick(UPLOAD_STALL_MS + 1);
  await tick();
  assert.match(textOf(chip(0)), /失败 · 网络连接中断，上传失败，请检查网络后重试/);
  click(chip(0), ".chip-retry");
  await tick();
  assert.equal(chips().length, 1);
  assert.equal(FakeXHR.instances.length, 2);
  assert.equal(xhr(1).body, file);
  xhr(1).finish(200, PARSED_PNG);
  await tick();
  assert.match(textOf(chip(0)), /已识别/);
  assert.equal(att.gate(), "");
});

test("failed chips offer retry; retry re-posts the same file", async () => {
  mount().ingestFiles([fileLike("sample.png", 1200, "image/png")]);
  xhr(0).finish(500, { error: "服务器繁忙" });
  await tick();
  assert.match(textOf(chip(0)), /失败 · 服务器繁忙/);
  click(chip(0), ".chip-retry");
  assert.equal(FakeXHR.instances.length, 2);
  assert.equal(xhr(1).requestHeaders["X-Attachment-Name"], encodeURIComponent("sample.png"));
  xhr(1).finish(200, PARSED_PNG);
  await tick();
  assert.match(textOf(chip(0)), /已识别/);
});

test("expand toggle shows summary, scope explanation, and warnings in order", async () => {
  const hint = "风格线索：强调色 #C00000；字体 HYQiHei-EES → 微软雅黑（风格参考；自由风格下可作配色来源）";
  mount().ingestFiles([fileLike("mixed.pdf", 4096, "application/pdf")]);
  xhr(0).finish(200, {
    ...PARSED_PDF,
    name: "mixed.pdf",
    summary: { zh: "PDF · 5 页 · 约 255 字 · 第 2 页几乎没有文字（可能是整页图片），未识别（不做 OCR）" },
    warnings: [
      {
        code: "scanned-pages",
        message:
          "第 2 页几乎没有可提取的文字，可能是整页图片或扫描件；当前版本不做文字识别（OCR），这几页的内容 Agent 读不到",
      },
    ],
    styleProfile: {
      schema: "style-profile/v1",
      source: "pdf-vector-ops",
      pagesScanned: 5,
      accentColors: [{ hex: "#C00000", share: 0.85, roles: ["text", "fill"] }],
      neutralColors: [{ hex: "#000000" }],
      fonts: [{ source: "HYQiHei-EES", share: 0.9, mapped: { latin: "Arial", ea: "微软雅黑" } }],
    },
    styleHintLine: hint,
  });
  await tick();
  click(chip(0), ".chip-toggle");
  const detail = query(chip(0), ".chip-detail");
  assert.equal(detail.hidden, false);
  assert.equal(query(chip(0), ".chip-toggle").getAttribute("aria-expanded"), "true");
  assert.match(textOf(detail), /PDF · 5 页/);
  assert.equal(textOf(query(chip(0), ".chip-scope")), "读文字 · 自由风格下可作配色来源");
  assert.equal(textOf(query(chip(0), ".chip-scope-detail")), MATERIAL_SCOPE.document?.["pdf-unpdf-v4"]?.detail);
  assert.equal(textOf(query(chip(0), ".chip-style-hint")), hint);
  assert.match(textOf(detail), /第 2 页几乎没有文字（可能是整页图片）/);
  assert.doesNotMatch(textOf(detail), /扫描图片/);
  assert.deepEqual(
    [...detail.querySelectorAll("p")].map((node) => node.className),
    ["", "chip-scope-detail", "chip-style-hint", ""],
  );
  assert.equal(query(chip(0), ".chip-toggle").dataset.control, "chrome.workspace.assistant.attach.chip.expand");
  assert.equal(query(chip(0), ".chip-remove").dataset.control, "chrome.workspace.assistant.attach.chip.remove");
  assert.equal(query(chip(0), ".chip-remove").getAttribute("aria-label"), "移除附件 mixed.pdf");
});

test("editor image chips expand to the M4 wording for vision and text-only models (VAL-IMG-011)", async () => {
  mount().ingestFiles([fileLike("brand-redwhite.png", 1200, "image/png"), fileLike("plain.png", 1200, "image/png")]);
  xhr(0).finish(200, { ...PARSED_PNG, name: "brand-redwhite.png" });
  xhr(1).finish(200, { ...PARSED_PNG, id: "att-plain", name: "plain.png", needsVision: false });
  await tick();
  click(chip(0), ".chip-toggle");
  assert.equal(textOf(query(chip(0), ".chip-scope")), "可放进页面 · 可作配色来源");
  assert.equal(
    textOf(query(chip(0), ".chip-scope-detail")),
    "附件提供图片文件；由 AI 决定放进哪一页，也可采用它的配色作为设计来源（选了首页风格包时以风格包为准）。读取版式和气质需要支持看图的模型，文本模型只能看到颜色、尺寸和朝向。",
  );
  click(chip(1), ".chip-toggle");
  assert.equal(
    textOf(query(chip(1), ".chip-scope-detail")),
    "附件提供图片文件；由 AI 决定放进哪一页，也可采用它的配色作为设计来源（选了首页风格包时以风格包为准）。能否读取版式和气质取决于当前模型是否支持看图。",
  );
});

test("editor chips say what the file can be used for in an edit turn, only in the expanded detail (VAL-EDIT-005)", async () => {
  const pptx = {
    id: "att-pptx",
    name: "new-template.pptx",
    size: 8192,
    kind: "deck-template",
    status: "parsed",
    parser: "pptx-ooxml-v2",
    summary: { zh: "PPTX · 8 页样例（文字可按需读取）" },
    warnings: [],
    needsVision: false,
  };
  const att = mount();
  att.ingestFiles([
    fileLike("sample.png", 1200, "image/png"),
    fileLike("sample.xlsx", 2048),
    fileLike("new-template.pptx", 8192),
  ]);
  xhr(0).finish(200, PARSED_PNG);
  xhr(1).finish(200, PARSED_XLSX);
  await tick();
  xhr(2).finish(200, pptx);
  await tick();
  att.ingestFiles([fileLike("text.pdf", 4096, "application/pdf"), fileLike("report.docx", 3072)]);
  xhr(3).finish(200, PARSED_PDF);
  xhr(4).finish(200, PARSED_DOCX);
  await tick();
  /** @type {[string, string | undefined][]} */
  const wanted = [
    ["可放进页面 · 可作配色来源", "可让 AI 用它换图"],
    ["读数据 · 可做原生图表", "可让 AI 按它更新图表"],
    ["风格 · 版式 · 内容按需读取", "可让 AI 整套换成这个模板"],
    ["读文字 · 自由风格下可作配色来源", undefined],
    ["读文字 · 风格只作线索", undefined],
  ];
  assert.equal(chips().length, wanted.length);
  wanted.forEach(([scope, editUse], index) => {
    assert.equal(textOf(query(chip(index), ".chip-scope")), scope);
    assert.equal(query(chip(index), ".chip-detail").hidden, true);
    assert.doesNotMatch(textOf(query(chip(index), ".chip-toggle")), /可让 AI/);
    click(chip(index), ".chip-toggle");
    const expanded = chip(index);
    const line = expanded.querySelector(".chip-edit-use");
    if (editUse === undefined) assert.equal(line, null, scope);
    else {
      assert.equal(line?.textContent, editUse, scope);
      assert.deepEqual(
        [...expanded.querySelectorAll(".chip-detail p")].map((node) => node.className),
        ["", "chip-scope-detail", "chip-edit-use"],
      );
    }
    assert.deepEqual(
      [...expanded.querySelectorAll("button")].map((button) => button.dataset.control),
      ["chrome.workspace.assistant.attach.chip.expand", "chrome.workspace.assistant.attach.chip.remove"],
    );
  });
});

test("the Hub's chips never carry the edit-use line (VAL-EDIT-005)", () => {
  const hub = document.createElement("div");
  document.body.append(hub);
  const engine = createAttachmentChips({
    targets: [{ key: "hub", element: hub }],
    controlPrefix: "hub.attachments",
  });
  engine.addParsed(parseAttachmentPublic(PARSED_PNG));
  engine.addParsed(parseAttachmentPublic(PARSED_XLSX));
  engine.addParsed(
    parseAttachmentPublic({
      ...PARSED_PNG,
      id: "att-pptx",
      name: "new-template.pptx",
      kind: "deck-template",
      parser: "pptx-ooxml-v2",
    }),
  );
  for (const toggle of hub.querySelectorAll(".chip-toggle")) /** @type {HTMLElement} */ (toggle).click();
  assert.equal(hub.querySelectorAll(".chip-detail").length, 3);
  assert.equal(hub.querySelector(".chip-edit-use"), null);
  assert.doesNotMatch(textOf(hub), /可让 AI/);
});

test("editor style reminder follows attachments, remains non-blocking, and has no controls", async () => {
  let selection = { designSystemId: "", stylePackName: "" };
  const att = mount({ styleNoticeContext: () => selection });
  const notice = required("style-source-notice");
  att.ingestFiles([fileLike("report.docx", PARSED_DOCX.size)]);
  xhr(0).finish(200, PARSED_DOCX);
  await tick();
  assert.equal(textOf(query(chip(0), ".chip-scope")), "读文字 · 风格只作线索");
  assert.equal(notice.hidden, true);
  const brief = /** @type {HTMLTextAreaElement} */ (required("work-brief"));
  brief.value = "参考这个PPT风格，做一份月报";
  brief.dispatchEvent(new env.win.Event("input", { bubbles: true }));
  assert.equal(notice.hidden, false);
  assert.match(textOf(notice), /Word、表格和文本只提供文字或数据/);
  assert.equal(att.gate(), "");
  selection = { designSystemId: "finance/honey-orange-memo", stylePackName: "蜜橙备忘" };
  att.ingestFiles([fileLike("report.pdf", PARSED_PDF.size)]);
  xhr(1).finish(200, { ...PARSED_PDF, name: "report.pdf" });
  await tick();
  assert.equal(
    textOf(notice),
    "已选择风格『蜜橙备忘』，配色、字体和装饰以它为准；附件用于 Logo、照片、内容和数据，版式只作参考。要按附件风格，请切回『自由风格』。",
  );
  assert.equal(notice.querySelector("button, a, [role=button], [data-control]"), null);
  assert.equal(att.gate(), "");
  click(chip(1), ".chip-remove");
  assert.match(textOf(notice), /没有.*可作风格来源/);
  brief.value = "只做一份月报";
  brief.dispatchEvent(new env.win.Event("input", { bubbles: true }));
  assert.equal(notice.hidden, true);
  assert.equal(att.gate(), "");
});

for (const [kind, parser, name, packId] of [
  ["deck-template", "pptx-ooxml-v2", "brand.pptx", "work/warm-clay-works"],
  ["image", "image-sharp-v1", "brand.png", "finance/honey-orange-memo"],
  ["document", "pdf-unpdf-v3", "brand.pdf", "academic/paper-white-courseware"],
]) {
  test(`VAL-ASPECT-007: editor explains ${kind} priority before any send`, async () => {
    const label = styleDisplayName(packId || "", undefined);
    const att = mount({ styleNoticeContext: () => ({ designSystemId: packId, stylePackName: label }) });
    att.ingestFiles([fileLike(name || "", 4096)]);
    xhr(0).finish(200, { ...PARSED_PDF, kind, parser, name });
    await tick();
    const notice = required("style-source-notice");
    assert.equal(notice.hidden, false);
    assert.equal(
      textOf(notice),
      `已选择风格『${label}』，配色、字体和装饰以它为准；附件用于 Logo、照片、内容和数据，版式只作参考。要按附件风格，请切回『自由风格』。`,
    );
    assert.equal(att.gate(), "");
    assert.deepEqual(
      FakeXHR.instances.map((request) => request.url),
      ["/api/attachments/upload"],
    );
    // Mount probes /api/health once for the legacy accept list; nothing else.
    assert.deepEqual(fetchedUrls(env.fetchMock), ["/api/health"]);
  });
}

test("the composer plus button opens the file picker and picked files upload", async () => {
  mount();
  const input = /** @type {HTMLInputElement} */ (required("agent-attachment-file"));
  let opened = 0;
  input.click = () => {
    opened += 1;
  };
  click(document, "#composer-plus");
  assert.equal(opened, 1);
  Object.defineProperty(input, "files", { value: [fileLike("sample.png", 1200, "image/png")], configurable: true });
  input.dispatchEvent(new env.win.Event("change"));
  assert.equal(FakeXHR.instances.length, 1);
  xhr(0).finish(200, PARSED_PNG);
  await tick();
  assert.equal(chips().length, 1);
});
