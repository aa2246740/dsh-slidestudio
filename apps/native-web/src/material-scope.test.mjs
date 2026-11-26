import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  MATERIAL_SCOPE,
  materialScope,
  renderStyleSourceNotice,
  styleSourceNoticeVisible,
} from "../public/material-scope.js";

/** @typedef {import("../public/material-scope.js").ScopeItem} ScopeItem */

const DOCX = { kind: "document", parser: "docx-ooxml-v1", name: "report.docx", status: "parsed" };
const PDF = { kind: "document", parser: "pdf-unpdf-v1", name: "report.pdf", status: "parsed" };
const XLSX = { kind: "table", parser: "xlsx-ooxml-v1", name: "data.xlsx", status: "parsed" };
const TEXT = { kind: "text", parser: "text-utf8-v1", name: "notes.txt", status: "parsed" };
const STYLE_BRIEF = "参考这个PPT风格和内容，做一份 9 月月报";
const PDF_HINT = "风格线索：强调色 #C00000；字体 HYQiHei-EES → 微软雅黑（风格参考；自由风格下可作配色来源）";

/** @param {unknown} kind @param {unknown} parser @param {Record<string, unknown>} [record] */
function scope(kind, parser, record = {}) {
  const copy = materialScope(kind, parser, record);
  assert.ok(copy, `${String(kind)}/${String(parser)} has scope copy`);
  return copy;
}

/** A detached status paragraph inside its own window. */
function noticeElement() {
  const dom = new JSDOM('<p id="style-source-notice" role="status" hidden></p>');
  const notice = dom.window.document.getElementById("style-source-notice");
  assert.ok(notice);
  return { notice, close: () => dom.window.close() };
}

test("materialScope uses kind and parser version for honest M2 chip copy", () => {
  const pdfDetail = /自由风格.*配色.*字体、版式和装饰只作参考.*看图.*页面图片.*风格包.*\.pptx/;
  const rows = [
    { kind: "document", parser: "pdf-unpdf-v2", label: "读文字 · 自由风格下可作配色来源", detail: pdfDetail },
    { kind: "document", parser: "pdf-unpdf-v1", label: "读文字 · 自由风格下可作配色来源", detail: pdfDetail },
    {
      kind: "document",
      parser: "docx-ooxml-v1",
      label: "读文字 · 风格只作线索",
      detail: /颜色.*字体.*只作风格线索.*\.pptx/,
    },
    { kind: "table", parser: "csv-v1", label: "读数据 · 可做原生图表", detail: /表格数据.*原生图表.*不提供.*版式/ },
    {
      kind: "table",
      parser: "xlsx-ooxml-v1",
      label: "读数据 · 可做原生图表",
      detail: /表格数据.*原生图表.*不提供.*版式/,
    },
    { kind: "text", parser: "text-utf8-v1", label: "读文字", detail: /只提取文字.*不提供.*设计来源/ },
    { kind: "deck-template", parser: "pptx-ooxml-v1", label: "读取模板线索", detail: /主题色.*字体.*版式.*页面文字/ },
    {
      kind: "image",
      parser: "image-sharp-v1",
      label: "可放进页面 · 可作配色来源",
      detail: /AI 决定放进哪一页.*采用它的配色.*版式和气质需要支持看图的模型/,
    },
  ];
  for (const row of rows) {
    const copy = scope(row.kind, row.parser, { needsVision: row.kind === "image" });
    assert.equal(copy.label, row.label, `${row.kind}/${row.parser} collapsed line`);
    assert.match(copy.detail, row.detail, `${row.kind}/${row.parser} expanded explanation`);
    assert.ok([...copy.label].length <= 18, `${row.kind}/${row.parser} label stays compact`);
  }
  assert.equal(scope("document", "future-doc-parser").label, "读文字 · 风格只作线索");
  assert.equal(MATERIAL_SCOPE.document?.["pdf-unpdf-v2"]?.label, "读文字 · 自由风格下可作配色来源");
  assert.equal(MATERIAL_SCOPE.document?.default?.label, "读文字 · 风格只作线索");
  assert.match(scope("image", "image-sharp-v1").label, /可作配色来源/);
  assert.match(scope("image", "image-sharp-v1", { needsVision: false }).detail, /采用它的配色/);
  assert.doesNotMatch(scope("deck-template", "pptx-ooxml-v1").label, /只取风格 · 不读页面文字/);
  assert.equal(materialScope(null, "x"), null);
  assert.equal(materialScope("unknown-kind", "x"), null);
});

test("PDF chip shows the server-computed style line verbatim", () => {
  const copy = scope("document", "pdf-unpdf-v2", { styleHintLine: PDF_HINT });
  assert.equal(copy.styleHintLine, PDF_HINT);
  assert.ok(copy.label.endsWith("自由风格下可作配色来源"));
  assert.ok(copy.styleHintLine?.endsWith("（风格参考；自由风格下可作配色来源）"));
  const fromProfile = scope("document", "pdf-unpdf-v2", {
    styleProfile: {
      schema: "style-profile/v1",
      source: "pdf-vector-ops",
      pagesScanned: 1,
      accentColors: [{ hex: "#C00000", share: 1, roles: ["fill"] }],
      neutralColors: [{ hex: "#000000" }],
      fonts: [{ source: "HYQiHei-EES", share: 1, mapped: { latin: "Arial", ea: "微软雅黑" } }],
    },
  });
  assert.equal(fromProfile.styleHintLine, undefined);
  assert.equal(scope("document", "pdf-unpdf-v2", { styleHintLine: "" }).styleHintLine, undefined);
});

test("VAL-FMT-006: Word chip shows the theme hint line as clue-only copy", () => {
  const copy = scope("document", "docx-ooxml-v1", {
    styleHintLine: "风格线索：强调色 #00589C、#B5573A；字体 思源宋体 → 宋体（风格只作线索，不作为设计来源）",
  });
  assert.equal(copy.label, "读文字 · 风格只作线索");
  assert.match(copy.styleHintLine || "", /风格线索：强调色 #00589C、#B5573A/);
  assert.match(copy.styleHintLine || "", /字体 思源宋体 → 宋体/);
  assert.ok(copy.styleHintLine?.endsWith("（风格只作线索，不作为设计来源）"));
  assert.equal(scope("document", "docx-ooxml-v1").styleHintLine, undefined);
});

test("materialScope follows detected parser identity and uses extensions only for legacy records", () => {
  const rows = [
    { parser: "pdf-unpdf-v3", name: "renamed.docx", detail: /读取可识别的文字/, hint: PDF_HINT },
    { parser: "pdf-unpdf-v3", name: "renamed.txt", detail: /读取可识别的文字/, hint: PDF_HINT },
    { parser: "docx-ooxml-v1", name: "renamed.pdf", detail: /读取 Word 中的文字/, hint: "" },
    { parser: null, name: "legacy.docx", detail: /读取 Word 中的文字/, hint: "" },
    { parser: "future-doc-parser", name: "future-legacy.docx", detail: /读取 Word 中的文字/, hint: "" },
    { parser: null, name: "legacy.pdf", detail: /读取可识别的文字/, hint: PDF_HINT },
  ];
  for (const row of rows) {
    const copy = scope("document", row.parser, {
      name: row.name,
      ...(row.hint ? { styleHintLine: row.hint } : {}),
    });
    assert.match(copy.detail, row.detail, `${row.name} scope`);
    if (row.hint) assert.match(copy.styleHintLine || "", /#C00000.*HYQiHei-EES/, `${row.name} hint`);
    else assert.equal(copy.styleHintLine, undefined, `${row.name} has no PDF hint`);
  }
});

test("style-source reminder follows the M2 truth table", () => {
  /** @type {[string, ScopeItem[], boolean, string][]} */
  const rows = [
    [STYLE_BRIEF, [DOCX], true, "Word with style words"],
    [
      STYLE_BRIEF,
      [DOCX, { kind: "deck-template", parser: "pptx-ooxml-v1", status: "parsed" }],
      false,
      "PPTX suppresses",
    ],
    [STYLE_BRIEF, [DOCX, { kind: "image", parser: "image-sharp-v1", status: "parsed" }], false, "image suppresses"],
    [STYLE_BRIEF, [DOCX, PDF], false, "PDF suppresses"],
    [STYLE_BRIEF, [XLSX], true, "table data"],
    ["沿用 LOGO", [DOCX], true, "case-insensitive logo keyword"],
    ["Follow the brand template", [DOCX], true, "English style wording"],
    ["做一份 9 月运营月报", [DOCX], false, "no style wording"],
    ["", [DOCX], false, "empty brief"],
    [STYLE_BRIEF, [DOCX, { status: "uploading" }], false, "busy attachment"],
    [STYLE_BRIEF, [PDF], false, "PDF is style-capable"],
    [STYLE_BRIEF, [TEXT], true, "text attachment"],
    [STYLE_BRIEF, [{ ...DOCX, status: "failed" }], false, "unparsed attachment"],
    [STYLE_BRIEF, [], false, "no recognized attachment"],
  ];
  for (const [brief, items, expected, name] of rows) {
    assert.equal(styleSourceNoticeVisible({ brief, items }), expected, name);
  }
});

test("renamed files keep their signature-detected role in every reminder", () => {
  const renamedPdf = { kind: "document", parser: "pdf-unpdf-v3", name: "月报.docx", status: "parsed" };
  const renamedWord = { kind: "document", parser: "docx-ooxml-v1", name: "报告.pdf", status: "parsed" };
  /** @type {[ScopeItem[], boolean, string][]} */
  const rows = [
    [[DOCX, renamedPdf], false, "a renamed PDF is still a style source"],
    [[renamedPdf], false, "a renamed PDF alone is style-capable"],
    [[renamedWord], true, "a renamed Word still reads as textual"],
    [[DOCX, renamedWord], true, "renamed Word does not suppress"],
  ];
  for (const [items, expected, name] of rows) {
    assert.equal(styleSourceNoticeVisible({ brief: STYLE_BRIEF, items }), expected, name);
  }
});

test("renamed files resolve the style-pack priority reminder by parser identity", () => {
  const { notice, close } = noticeElement();
  const pack = { designSystemId: "work/warm-clay-works", stylePackName: "暖陶作品" };
  renderStyleSourceNotice(notice, {
    brief: "",
    items: [{ kind: "document", parser: "pdf-unpdf-v3", name: "月报.docx", status: "parsed" }],
    ...pack,
  });
  assert.match(notice.textContent || "", /^已选择风格『暖陶作品』/);
  renderStyleSourceNotice(notice, {
    brief: STYLE_BRIEF,
    items: [{ kind: "document", parser: "docx-ooxml-v1", name: "报告.pdf", status: "parsed" }],
    ...pack,
  });
  assert.match(notice.textContent || "", /没有.*可作风格来源/);
  close();
});

test("records without a parser id keep the extension as a legacy fallback", () => {
  /** @type {[ScopeItem, boolean][]} */
  const rows = [
    [{ kind: "document", parser: null, name: "a.docx", status: "parsed" }, true],
    [{ kind: "document", parser: null, name: "a.pdf", status: "parsed" }, false],
    [{ kind: "document", parser: "pdf-unpdf-v2", name: "a.docx", status: "parsed" }, false],
  ];
  for (const [item, expected] of rows) {
    assert.equal(
      styleSourceNoticeVisible({ brief: STYLE_BRIEF, items: [item] }),
      expected,
      `${item.name} with parser ${item.parser}`,
    );
  }
});

test("style-pack priority copy names the selected pack and is a plain status", () => {
  const { notice, close } = noticeElement();
  const pptx = { kind: "deck-template", parser: "pptx-ooxml-v1", status: "parsed" };
  const pack = { designSystemId: "work/warm-clay-works", stylePackName: "暖陶作品" };
  renderStyleSourceNotice(notice, { brief: STYLE_BRIEF, items: [DOCX, pptx], ...pack });
  assert.equal(notice.hidden, false);
  assert.equal(
    notice.textContent,
    "已选择风格『暖陶作品』，配色、字体和装饰以它为准；附件用于 Logo、照片、内容和数据，版式只作参考。要按附件风格，请切回『自由风格』。",
  );
  assert.equal(notice.getAttribute("role"), "status");
  assert.equal(notice.querySelector("button, a, [role=button], [data-control]"), null);
  renderStyleSourceNotice(notice, { brief: STYLE_BRIEF, items: [DOCX], ...pack });
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent || "", /没有.*可作风格来源/);
  renderStyleSourceNotice(notice, {
    brief: STYLE_BRIEF,
    items: [{ kind: "image", parser: "image-sharp-v1", status: "parsed" }],
    designSystemId: "",
  });
  assert.equal(notice.hidden, true);
  close();
});
