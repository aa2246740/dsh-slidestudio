import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAttachmentChips } from "../public/attachment-chips.js";
import { mountHubAttachments } from "../public/hub-attachments.js";
import { mountEditorAttachments } from "../public/editor-attachments.js";
import { oversizeReason } from "../public/attachment-limits.js";
import { formatsNote, MODAL_COPY } from "../public/material-scope.js";
import { TOO_LARGE_FOR_TYPE_MESSAGE, UPLOAD_CAP_MESSAGE } from "./materials/size-limits.mjs";
import {
  EDITOR_MARKUP,
  FakeXHR,
  HUB_MARKUP,
  chipsIn,
  fileLike,
  installDom,
  jsonResponse,
  query,
  required,
  textOf,
  tick,
  xhr,
} from "./attachment-dom-harness.test.mjs";

const MB = 1024 * 1024;
/** The accept list the pages ship before any conversion switch. */
const ROUND1_ACCEPT =
  ".png,.jpg,.jpeg,.webp,.gif,.avif,.svg,.zip,.pptx,.potx,.thmx,.xlsx,.csv,.tsv,.pdf,.docx,.txt,.md,.json";
const LEGACY_ACCEPT = `${ROUND1_ACCEPT},.ppt,.doc,.xls,.dps,.et,.wps`;
const HUB_WITH_ACCEPT = HUB_MARKUP.replace(
  '<input id="attach-file" type="file" multiple />',
  `<input id="attach-file" type="file" multiple accept="${ROUND1_ACCEPT}" />`,
);
const EDITOR_WITH_ACCEPT = EDITOR_MARKUP.replace(
  '<input id="agent-attachment-file" type="file" multiple hidden />',
  `<input id="agent-attachment-file" type="file" multiple hidden accept="${ROUND1_ACCEPT}" />`,
);

/** @param {string} name @param {number} megabytes */
const file = (name, megabytes) => fileLike(name, megabytes * MB);
/** @type {ReturnType<typeof installDom> | null} */
let env = null;
afterEach(async () => {
  await env?.restore();
  env = null;
});

/** @param {boolean | "down"} available */
function health(available) {
  return async () => {
    if (available === "down") throw new Error("network down");
    return jsonResponse({
      ok: true,
      legacyConvert: available ? { available: true } : { available: false, reason: "本机未安装 LibreOffice" },
    });
  };
}
/** @param {boolean | "down"} [available] */
function hub(available = false) {
  env = installDom(HUB_WITH_ACCEPT, { url: "http://hub.test/", fetchImpl: health(available) });
  return mountHubAttachments({ onChange: () => {}, onMessage: () => {} });
}
/** @param {boolean} [available] */
function editor(available = false) {
  env = installDom(EDITOR_WITH_ACCEPT, { url: "http://editor.test/?project=p", fetchImpl: health(available) });
  return mountEditorAttachments({ projectKey: () => "p", apiPath: (path) => path });
}
async function settle(steps = 8) {
  for (let index = 0; index < steps; index += 1) await tick();
}
const hubChipTexts = () => chipsIn(required("attach-row")).map((chip) => textOf(chip));

test("decks and PDFs are allowed 50 MB, every other file 20 MB, whatever the browser lets through", () => {
  assert.equal(oversizeReason(file("deck.pptx", 50)), "");
  assert.equal(oversizeReason(file("template.potx", 49)), "");
  assert.equal(oversizeReason(file("REPORT.PDF", 50)), "");
  assert.equal(oversizeReason(file("photo.png", 20)), "");
  assert.equal(oversizeReason(file("deck.pptx", 51)), UPLOAD_CAP_MESSAGE);
  assert.equal(oversizeReason(file("a.pdf", 50.1)), UPLOAD_CAP_MESSAGE);
  for (const name of [
    "photo.png",
    "photo.avif",
    "logo.svg",
    "data.xlsx",
    "memo.docx",
    "notes.txt",
    "a.zip",
    "x.thmx",
  ]) {
    assert.equal(oversizeReason(file(name, 21)), TOO_LARGE_FOR_TYPE_MESSAGE, name);
  }
  for (const name of ["old.ppt", "old.doc", "old.xls", "old.wps", "old.et", "old.dps"]) {
    assert.equal(oversizeReason(file(name, 19)), "", name);
    assert.equal(oversizeReason(file(name, 21)), TOO_LARGE_FOR_TYPE_MESSAGE, name);
  }
});

test("Hub: a deck up to 50 MB is uploaded, one above is refused on its chip without any request", () => {
  const attachments = hub();
  attachments.ingestFiles([file("big.pptx", 49), file("tpl.potx", 30), file("scan.pdf", 40)]);
  assert.equal(FakeXHR.instances.length, 2);
  attachments.ingestFiles([file("huge.pptx", 51)]);
  assert.equal(FakeXHR.instances.length, 2);
  const chip = hubChipTexts().at(-1) ?? "";
  assert.match(chip, /huge\.pptx/);
  assert.ok(chip.includes(`失败 · ${UPLOAD_CAP_MESSAGE}`), chip);
  assert.deepEqual(
    attachments.selection().find((item) => item.name === "huge.pptx"),
    { id: undefined, name: "huge.pptx", status: "failed" },
  );
});

test("Hub: an image above 20 MB is refused with both limits, a 413 reads the same, retry never uploads", async () => {
  const attachments = hub();
  attachments.ingestFiles([file("photo.png", 21), file("legacy.ppt", 21)]);
  assert.equal(FakeXHR.instances.length, 0);
  for (const chip of hubChipTexts()) assert.ok(chip.includes(`失败 · ${TOO_LARGE_FOR_TYPE_MESSAGE}`), chip);
  query(document, "#attach-row .chip-retry").click();
  assert.equal(FakeXHR.instances.length, 0);
  attachments.ingestFiles([fileLike("renamed.dat", 1024)]);
  xhr(0).finish(413, { error: TOO_LARGE_FOR_TYPE_MESSAGE, code: "ATTACHMENT_TOO_LARGE" });
  await tick();
  assert.ok((hubChipTexts()[2] || "").includes(`失败 · ${TOO_LARGE_FOR_TYPE_MESSAGE}`));
});

test("editor: the shared chip engine applies the same limits", () => {
  env = installDom("<div></div>");
  const row = document.createElement("div");
  document.body.append(row);
  const engine = createAttachmentChips({
    targets: [{ key: "row", element: row }],
    controlPrefix: "chrome.workspace.assistant.attach",
    editUse: true,
  });
  engine.ingestFiles([file("deck.pptx", 45), file("scan.pdf", 51), file("photo.jpg", 22)]);
  assert.equal(FakeXHR.instances.length, 1);
  const texts = chipsIn(row).map((chip) => textOf(chip));
  assert.ok(texts[1]?.includes(UPLOAD_CAP_MESSAGE));
  assert.ok(texts[2]?.includes(TOO_LARGE_FOR_TYPE_MESSAGE));
});

test("the shared table states both limits, the new formats and the HEIC hint", () => {
  for (const needle of ["50MB", "20MB", "SVG（SVG 转换为图片）", "AVIF", "POTX", "THMX", "HEIC", "导出为 JPG"]) {
    assert.ok(
      MODAL_COPY.supportedLine.includes(needle) || formatsNote(false).includes(needle),
      `modal copy should mention ${needle}`,
    );
  }
  const note = formatsNote(false);
  for (const needle of ["图片 ZIP 包", "TXT / MD / JSON", "每次最多发送 20 张图片和 6 个其他附件", "另存为新格式"]) {
    assert.ok(note.includes(needle), needle);
  }
  assert.doesNotMatch(note, /Markdown/);
  assert.match(formatsNote(true), /旧版 \.ppt \/ \.doc \/ \.xls 和 WPS 格式会自动转换，效果可能与原文件不同/);
});

test("hub picker widens its accept list and modal note when the service converts legacy files", async () => {
  hub(true);
  await settle();
  const note = textOf(required("attach-formats-note"));
  assert.ok(env && env.fetchMock.mock.calls.some((call) => call.arguments[0] === "/api/health"));
  assert.equal(/** @type {HTMLInputElement} */ (required("attach-file")).accept, LEGACY_ACCEPT);
  assert.equal(note, formatsNote(true));
  assert.match(note, /和 WPS 格式会自动转换/);
  assert.doesNotMatch(note, /需要先另存为新格式/);
});

for (const [label, available] of /** @type {const} */ ([
  ["unavailable", false],
  ["unreachable", "down"],
])) {
  test(`hub picker keeps round-1 accept and note while the converter is ${label}`, async () => {
    hub(available);
    await settle();
    assert.equal(/** @type {HTMLInputElement} */ (required("attach-file")).accept, ROUND1_ACCEPT);
    assert.equal(textOf(required("attach-formats-note")), formatsNote(false));
  });
}

test("editor picker widens its accept list only when the converter is available", async () => {
  editor(true);
  await settle();
  assert.equal(/** @type {HTMLInputElement} */ (required("agent-attachment-file")).accept, LEGACY_ACCEPT);
  await env?.restore();
  editor(false);
  await settle();
  const accept = /** @type {HTMLInputElement} */ (required("agent-attachment-file")).accept;
  assert.equal(accept, ROUND1_ACCEPT);
  for (const legacy of [".ppt", ".doc", ".xls", ".dps", ".et", ".wps"]) {
    assert.equal(accept.includes(`${legacy},`), false, `no ${legacy} when converter is off`);
  }
});

/** @param {string} id @param {string} name @param {string} summary @param {string} warning */
const converted = (id, name, summary, warning) => ({
  id,
  name,
  size: 4000,
  kind: "deck-template",
  status: "parsed",
  parser: "pptx-ooxml-v2",
  summary: { zh: summary },
  warnings: [{ code: "converted-from-legacy", message: warning }],
  needsVision: false,
});

test("converted legacy uploads show the 「已从 … 转换」 chip mark, plain uploads keep 「已识别」", async () => {
  const att = editor();
  att.ingestFiles([fileLike("legacy.ppt", 4000), fileLike("deck.dps", 6000), fileLike("report.docx", 3000)]);
  assert.equal(FakeXHR.instances.length, 2);
  const fidelity = "版式、图表和特效可能与原文件不同，要完全一致请用 PowerPoint 或 WPS 另存为 .pptx 后上传";
  xhr(0).finish(200, converted("att-ppt", "legacy.ppt", "（由 .ppt 转换）PPTX 演示 · 1 页", fidelity));
  xhr(1).finish(200, {
    ...converted("att-dps", "deck.dps", "（由 WPS .dps 转换）PPTX 演示 · 2 页", fidelity),
    size: 6000,
  });
  await settle(2);
  xhr(2).finish(200, {
    ...converted("att-docx", "report.docx", "Word 文档 · 2 个标题", ""),
    size: 3000,
    kind: "document",
    parser: "docx-ooxml-v1",
    warnings: [],
  });
  await settle(2);
  const chips = chipsIn(required("agent-attachments"));
  assert.equal(chips.length, 3);
  assert.match(textOf(chips[0]), /已从 \.ppt 转换 · 3\.9 KB/);
  assert.match(textOf(chips[1]), /已从 WPS \.dps 转换 · 5\.9 KB/);
  assert.match(textOf(chips[2]), /已识别 · 2\.9 KB/);
  assert.doesNotMatch(textOf(chips[2]), /转换/);
  query(chips[0], ".chip-toggle").click();
  assert.match(textOf(query(chipsIn(required("agent-attachments"))[0], ".chip-detail")), /可能与原文件不同/);
});
