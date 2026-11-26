import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { test } from "node:test";
import { SUPPORTED_TYPES_ZH, detectType } from "./detect.mjs";

const detect = (/** @type {string} */ name, /** @type {Uint8Array} */ bytes) =>
  detectType({ name, bytes, declaredMime: undefined });

const POTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.template";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const HEIC_HINT =
  "暂不支持 HEIC 照片；请在手机相册里把照片导出为 JPG（或在 iPhone「设置 → 相机 → 格式」里选「兼容性最佳」）后再上传";

/**
 * An ISO-BMFF `ftyp` box followed by a stub `mdat`.
 * @param {string} major
 * @param {string[]} [compatible]
 */
function isoBmff(major, compatible = []) {
  const brands = [major, ...compatible];
  const size = 16 + brands.length * 4;
  const box = Buffer.alloc(size);
  box.writeUInt32BE(size, 0);
  box.write("ftyp", 4, "ascii");
  box.write(major, 8, "ascii");
  brands.forEach((brand, index) => box.write(brand, 16 + index * 4, "ascii"));
  const mdat = Buffer.alloc(16);
  mdat.writeUInt32BE(16, 0);
  mdat.write("mdat", 4, "ascii");
  return Buffer.concat([box, mdat]);
}

/**
 * @param {string} mainContentType
 */
function presentationZip(mainContentType) {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Override PartName="/ppt/presentation.xml" ContentType="${mainContentType}"/></Types>`,
      ),
      "ppt/presentation.xml": strToU8("<p:presentation/>"),
    }),
  );
}

const THMX_TYPES =
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Override PartName="/theme/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`;

test("an SVG is detected by its root element and goes to the svg parser", () => {
  const result = detect("logo.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"/>`));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "image");
    assert.equal(result.parserId, "svg-raster-v1");
    assert.equal(result.detectedMime, "image/svg+xml");
    assert.equal(result.extensionMismatch, false);
  }
});

test("an XML prolog, BOM, comment and DOCTYPE before the root do not hide an SVG", () => {
  const svg = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported -->\n` +
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`,
    ),
  ]);
  const result = detect("illustrator.svg", svg);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.parserId, "svg-raster-v1");
});

test("SVG content under a .txt name is still an SVG, with the mismatch warning", () => {
  const result = detect("looks-like.txt", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"/>`));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.parserId, "svg-raster-v1");
    assert.equal(result.extensionMismatch, true);
    assert.match(result.warnings[0]?.message ?? "", /扩展名为 \.txt.*SVG/);
  }
});

test("text that only mentions <svg> after other content stays text", () => {
  const result = detect("notes.md", Buffer.from("# 图示\n\n示例：`<svg width=1>` 是矢量图标签\n"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.kind, "text");
});

test("a .svg file that is not SVG is refused in Chinese", () => {
  const result = detect("fake.svg", Buffer.from("plain words, not markup"));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unsupported-type");
    assert.match(result.message, /不是有效的 SVG/);
  }
});

test(".potx is read as a deck template with the template mime", () => {
  const result = detect("tpl.potx", presentationZip(`${POTX_MIME}.main+xml`));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "deck-template");
    assert.equal(result.parserId, "pptx-ooxml-v2");
    assert.equal(result.detectedMime, POTX_MIME);
    assert.equal(result.extensionMismatch, false);
  }
});

test("a .pptx renamed .potx and a .potx renamed .pptx are detected by content with a warning", () => {
  const pptxAsPotx = detect("deck.potx", presentationZip(`${PPTX_MIME}.main+xml`));
  assert.equal(pptxAsPotx.ok, true);
  if (pptxAsPotx.ok) {
    assert.equal(pptxAsPotx.detectedMime, PPTX_MIME);
    assert.equal(pptxAsPotx.extensionMismatch, true);
    assert.match(pptxAsPotx.warnings[0]?.message ?? "", /扩展名为 \.potx/);
  }
  const potxAsPptx = detect("deck.pptx", presentationZip(`${POTX_MIME}.main+xml`));
  assert.equal(potxAsPptx.ok, true);
  if (potxAsPptx.ok) {
    assert.equal(potxAsPptx.detectedMime, POTX_MIME);
    assert.equal(potxAsPptx.extensionMismatch, true);
    assert.match(potxAsPptx.warnings[0]?.message ?? "", /扩展名为 \.pptx/);
  }
});

test(".thmx is a theme file read for palette and fonts only", () => {
  const thmx = Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(THMX_TYPES),
      "theme/theme/theme1.xml": strToU8("<a:theme/>"),
    }),
  );
  const result = detect("brand.thmx", thmx);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "deck-template");
    assert.equal(result.parserId, "thmx-theme-v1");
    assert.equal(result.detectedMime, "application/vnd.ms-officetheme");
    assert.equal(result.extensionMismatch, false);
  }
});

test("a Word file with its own theme part is not mistaken for a theme file", () => {
  const docx = Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
      "word/document.xml": strToU8("<w:document/>"),
      "word/theme/theme1.xml": strToU8("<a:theme/>"),
    }),
  );
  const result = detect("report.docx", docx);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.parserId, "docx-ooxml-v1");
});

test("a template that declares its main part but lacks the file is corrupt", () => {
  const broken = Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Override PartName="/ppt/presentation.xml" ContentType="${POTX_MIME}.main+xml"/></Types>`,
      ),
      "docProps/app.xml": strToU8("<Properties/>"),
    }),
  );
  const result = detect("broken.potx", broken);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "corrupt");
});

test("HEIC and HEIF brands are refused with the export-as-JPG hint", () => {
  const cases = /** @type {[string, Buffer][]} */ ([
    ["photo.heic", isoBmff("heic", ["mif1", "heic"])],
    ["photo-heix.heif", isoBmff("heix", ["mif1"])],
    ["photo-heic.jpg", isoBmff("heic", ["mif1", "heic"])],
    ["clip.heif", isoBmff("hevc", ["mif1"])],
    ["clip.png", isoBmff("hevx", ["msf1"])],
    ["samsung.jpg", isoBmff("mif1", ["heic"])],
  ]);
  for (const [name, bytes] of cases) {
    const result = detect(name, bytes);
    assert.equal(result.ok, false, name);
    if (!result.ok) {
      assert.equal(result.code, "unsupported-type", name);
      assert.equal(result.message, HEIC_HINT, name);
      assert.match(result.message, /导出为 JPG/);
    }
  }
});

test("a .heic or .heif name with unreadable content still gets the hint", () => {
  for (const name of ["photo.heic", "photo.HEIF"]) {
    const result = detect(name, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.message, HEIC_HINT, name);
  }
});

test("AVIF is an image for the raster-substituting parser, whatever it is called", () => {
  const cases = /** @type {[string, Buffer][]} */ ([
    ["photo.avif", isoBmff("avif", ["mif1", "avif", "miaf"])],
    ["photo.heic", isoBmff("avif", ["mif1", "miaf"])],
    ["photo.HEIF", isoBmff("avif", ["mif1", "avif"])],
    ["sequence.avif", isoBmff("avis", ["msf1"])],
    ["mif1-avif.jpg", isoBmff("mif1", ["avif"])],
  ]);
  for (const [name, bytes] of cases) {
    const result = detect(name, bytes);
    assert.equal(result.ok, true, name);
    if (result.ok) {
      assert.equal(result.kind, "image", name);
      assert.equal(result.parserId, "avif-raster-v1", name);
      assert.equal(result.detectedMime, "image/avif", name);
    }
  }
});

test("a name that disagrees with the AVIF content is warned about, not trusted", () => {
  const avif = isoBmff("avif", ["mif1", "avif", "miaf"]);
  for (const name of ["photo.jpg", "photo.png", "photo.heic", "photo.heif"]) {
    const result = detect(name, avif);
    assert.equal(result.ok, true, name);
    if (result.ok) {
      assert.equal(result.extensionMismatch, true, name);
      assert.equal(result.warnings[0]?.code, "extension-mismatch", name);
      assert.match(result.warnings[0]?.message ?? "", /AVIF 图片/, name);
    }
  }
  const honest = detect("photo.avif", avif);
  assert.equal(honest.ok && honest.extensionMismatch, false);
});

test("HEIC content under an .avif name is still HEIC", () => {
  for (const heic of [isoBmff("heic", ["mif1", "heic"]), isoBmff("mif1", ["heic"]), isoBmff("heix", ["mif1"])]) {
    const result = detect("photo.avif", heic);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "unsupported-type");
      assert.equal(result.message, HEIC_HINT);
    }
  }
});

test("the supported-type sentence names the new formats and is the one shared string", () => {
  for (const word of ["SVG", "AVIF", ".potx", ".thmx", "PDF", "PNG"]) {
    assert.ok(SUPPORTED_TYPES_ZH.includes(word), word);
  }
  const unknown = detect("random.bin", Buffer.from([0x01, 0x02, 0x03, 0xfe, 0xff, 0x00]));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.ok(unknown.message.includes(SUPPORTED_TYPES_ZH));
});
