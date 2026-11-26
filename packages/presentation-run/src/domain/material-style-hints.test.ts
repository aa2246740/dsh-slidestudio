import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MaterialKind, MaterialReceipt, VerifiedMaterial } from "./material-pack.js";
import { nonAdoptableMaterialMessage, pdfStyleHintDetail, pdfStyleHints } from "./material-style-hints.js";

const PROFILE = {
  schema: "style-profile/v1",
  source: "pdf-vector-ops",
  pagesScanned: 3,
  accentColors: [{ hex: "#C00000", share: 1, roles: ["fill", "text"] }],
  neutralColors: [{ hex: "#000000" }],
  fonts: [{ source: "HYQiHei-EES", share: 1, mapped: { latin: "Arial", ea: "微软雅黑" } }],
};

/** Signature-truth fixture: `parser`/`detectedMime` decide, the extension is
 * only the upload name's hint and may disagree with it. */
function fixture(
  overrides: {
    parser?: string;
    kind?: MaterialKind;
    name?: string;
    originalExtension?: string;
    detectedMime?: string;
    derivative?: Record<string, unknown>;
  } = {},
): VerifiedMaterial {
  const parser = overrides.parser ?? "pdf-unpdf-v3";
  const kind = overrides.kind ?? "document";
  const name = overrides.name ?? "月报.pdf";
  const detectedMime = overrides.detectedMime ?? "application/pdf";
  const derivative = overrides.derivative ?? {
    source: { detectedMime },
    document: { pageCount: 3, styleProfile: PROFILE },
  };
  const receipt: MaterialReceipt = {
    id: "m-style-fixture",
    name,
    kind,
    parser,
    originalSha256: "a".repeat(64),
    derivativeSha256: "b".repeat(64),
  };
  return {
    id: receipt.id,
    name,
    kind,
    summaryZh: "PDF · 3 页 · 约 900 字",
    needsVision: false,
    parser,
    sha256: receipt.originalSha256,
    parts: [],
    directory: "/tmp/material-style-hints-fixture",
    receipt,
    derivative,
    originalBytes: Buffer.alloc(16),
    originalExtension: overrides.originalExtension ?? ".pdf",
  };
}

describe("pdfStyleHints honours the verified parser over the upload name", () => {
  it("keeps hints for a real PDF renamed .docx", () => {
    const material = fixture({ parser: "pdf-unpdf-v3", originalExtension: ".docx" });
    assert.deepEqual(pdfStyleHints(material)?.accentColors, PROFILE.accentColors);
  });

  it("keeps hints for a real PDF renamed .txt", () => {
    const material = fixture({ parser: "pdf-unpdf-v2", originalExtension: ".txt" });
    const hints = pdfStyleHints(material);
    assert.deepEqual(hints?.accentColors, PROFILE.accentColors);
    assert.deepEqual(hints?.fonts, PROFILE.fonts);
  });

  it("drops hints for a Word file renamed .pdf", () => {
    const material = fixture({
      parser: "docx-ooxml-v1",
      detectedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      originalExtension: ".pdf",
      derivative: {
        source: {
          detectedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      },
    });
    assert.equal(pdfStyleHints(material), undefined);
  });

  it("falls back to the detected MIME for unknown legacy records without a parser", () => {
    const material = fixture({
      parser: "",
      originalExtension: ".docx",
      derivative: {
        source: { detectedMime: "application/pdf" },
        document: { styleProfile: PROFILE },
      },
    });
    assert.ok(pdfStyleHints(material));
  });

  it("uses detected MIME before the extension for an unknown legacy parser", () => {
    const material = fixture({
      parser: "legacy-document-v0",
      originalExtension: ".docx",
      derivative: {
        source: { detectedMime: "application/pdf" },
        document: { styleProfile: PROFILE },
      },
    });
    assert.deepEqual(pdfStyleHints(material)?.accentColors, PROFILE.accentColors);
  });

  it("falls back to the extension only when neither parser nor MIME is known", () => {
    const material = fixture({
      parser: "",
      derivative: { source: { detectedMime: null }, document: { styleProfile: PROFILE } },
    });
    assert.ok(pdfStyleHints(material));
    const other = fixture({
      parser: "",
      originalExtension: ".docx",
      derivative: { source: { detectedMime: null }, document: { styleProfile: PROFILE } },
    });
    assert.equal(pdfStyleHints(other), undefined);
  });
});

describe("pdfStyleHintDetail states what the model can see", () => {
  it("says the pages are unseen only for a text-only model", () => {
    assert.match(pdfStyleHintDetail(PROFILE), /你没有看到页面画面。$/);
    assert.match(pdfStyleHintDetail(PROFILE, { modelAcceptsImages: false }), /你没有看到页面画面/);
  });

  it("keeps palette adoption as the only route to the theme for an image-input model", () => {
    const detail = pdfStyleHintDetail(PROFILE, { modelAcceptsImages: true });
    assert.doesNotMatch(detail, /你没有看到页面画面/);
    assert.doesNotMatch(detail, /不会写入主题|不含图片里的颜色/);
    assert.match(detail, /只有声明 palette 并通过回执校验后才写入主题/);
    assert.match(detail, /配色：#C00000；字体：HYQiHei-EES → Arial \/ 微软雅黑/);
  });
});

describe("nonAdoptableMaterialMessage keeps the PDF identity", () => {
  it("names the PDF and its hint hexes when the upload name hides the PDF", () => {
    const message = nonAdoptableMaterialMessage(
      fixture({ parser: "pdf-unpdf-v3", name: "月报.docx", originalExtension: ".docx" }),
    );
    assert.match(message, /是 PDF，/);
    assert.match(message, /#C00000/);
    assert.match(message, /不要说复刻、还原或沿用/);
    assert.doesNotMatch(message, /你没有看到页面画面|不会写入主题/);
  });

  it("does not call a renamed Word file a PDF", () => {
    const message = nonAdoptableMaterialMessage(
      fixture({
        parser: "docx-ooxml-v1",
        name: "报告.pdf",
        originalExtension: ".pdf",
        detectedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        derivative: {
          source: {
            detectedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        },
      }),
    );
    assert.doesNotMatch(message, /是 PDF/);
    assert.doesNotMatch(message, /PDF 风格线索/);
    assert.match(message, /如需使用原文件的风格，请上传原始 PPTX。/);
  });
});
