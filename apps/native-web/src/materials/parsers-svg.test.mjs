import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOptionalNative } from "../optional-native.mjs";
import { runParseJob } from "./parse-worker.mjs";
import { sanitizeSvg } from "./parsers/svg-sanitize.mjs";
import { SVG_RASTER_MAX_EDGE, svgRasterParser } from "./parsers/svg-raster.mjs";

const sharp = await loadOptionalNative("sharp");
const NO_SHARP = sharp ? false : "sharp is not installed";
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The tests also pass the `extension` the intake layer carries; the parser reads only `name` and `bytes`.
 * @typedef {{name: string, bytes: Uint8Array}} SvgInput
 * @typedef {{format: string, width: number, height: number, data: string, bytes: number}} SvgRaster
 * @typedef {{raster: SvgRaster, normalized: {format: string}, width: number, dominant: string, palette: string[]}} SvgImage
 * @typedef {import("./derivative.mjs").ParserResult<SvgImage>} SvgResult
 * @typedef {{code?: string, message: string}} CodedError
 */

const buffer = (/** @type {WithImplicitCoercion<string> | { [Symbol.toPrimitive](hint: "string"): string; }} */ text) =>
  Buffer.from(text, "utf8");

/** Namespace declarations are the only legitimate URLs left in a sanitized document. */
const withoutNamespaces = (/** @type {string} */ markup) => markup.replace(/\sxmlns(?::\w+)?="[^"]*"/g, "");

/**
 * @param {string} markup
 */
function assertInert(markup) {
  const body = withoutNamespaces(markup);
  for (const pattern of [
    /script/i,
    /\son[a-z]+\s*=/i,
    /foreignObject/i,
    /<!ENTITY/i,
    /<!DOCTYPE/i,
    /http:/i,
    /https:/i,
    /file:/i,
    /javascript:/i,
  ]) {
    assert.doesNotMatch(body, pattern, `${pattern} survived in: ${markup}`);
  }
}

const logo = `<svg xmlns="${SVG_NS}" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#C8102E"/></svg>`;

const SCRIPT = `<svg xmlns="${SVG_NS}" width="120" height="80" onload="alert(1)"><script>alert(1)</script><rect width="120" height="80" fill="#1F4E79" ONCLICK="alert(2)"/></svg>`;
const EXTERNAL =
  `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="80">` +
  `<image href="http://127.0.0.1:18999/x.png" width="10" height="10"/>` +
  `<image xlink:href="file:///etc/passwd" width="10" height="10"/>` +
  `<rect width="120" height="80" fill="#1F4E79"/></svg>`;
const FOREIGN = `<svg xmlns="${SVG_NS}" width="120" height="80"><foreignObject width="50" height="50"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><rect width="120" height="80" fill="#1F4E79"/></svg>`;
const ENTITY = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe "boom">]><svg xmlns="${SVG_NS}" width="10" height="10"><text>&xxe;</text></svg>`;
const HUGE = `<svg xmlns="${SVG_NS}" width="100000" height="100000"><rect width="10" height="10"/></svg>`;

test("a clean SVG passes through with its shapes and no removal", () => {
  const result = sanitizeSvg(logo);
  assert.deepEqual(result.removed, []);
  assert.match(result.markup, /<circle[^>]*fill="#C8102E"/);
  assert.match(result.markup, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test("scripts and event handlers are removed", () => {
  const result = sanitizeSvg(SCRIPT);
  assertInert(result.markup);
  assert.match(result.markup, /<rect/);
  assert.ok(result.removed.includes("script"));
});

test("external references are removed whatever the attribute spelling", () => {
  const result = sanitizeSvg(EXTERNAL);
  assertInert(result.markup);
  assert.match(result.markup, /<rect/);
  assert.ok(result.removed.includes("external-reference"));
});

test("foreignObject is removed with its subtree", () => {
  const result = sanitizeSvg(FOREIGN);
  assertInert(result.markup);
  assert.doesNotMatch(result.markup, /<div|xhtml/);
  assert.ok(result.removed.includes("foreign-object"));
});

test("a DOCTYPE with entity declarations is rejected", () => {
  assert.throws(
    () => sanitizeSvg(ENTITY),
    (/** @type {CodedError} */ error) => error.code === "unsupported-type" && /实体|DOCTYPE/.test(error.message),
  );
});

test("a bare DOCTYPE with a public id (older Illustrator exports) is removed, not rejected", () => {
  const result = sanitizeSvg(
    `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">` +
      `<svg xmlns="${SVG_NS}" width="10" height="10"><rect width="10" height="10"/></svg>`,
  );
  assertInert(result.markup);
  assert.ok(result.removed.includes("doctype"));
});

test("references that stay inside the file are kept", () => {
  const result = sanitizeSvg(
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20">` +
      `<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>` +
      `<rect id="r" width="10" height="10" fill="url(#g)"/></defs>` +
      `<use href="#r"/><use xlink:href="#r" x="10"/>` +
      `<image width="4" height="4" href="data:image/png;base64,iVBORw0KGgo="/></svg>`,
  );
  assert.deepEqual(result.removed, []);
  assert.match(result.markup, /fill="url\(#g\)"/);
  assert.match(result.markup, /<use[^>]*href="#r"/);
  assert.match(result.markup, /href="data:image\/png;base64,iVBORw0KGgo="/);
});

test("data URIs that are not raster images are removed", () => {
  const result = sanitizeSvg(
    `<svg xmlns="${SVG_NS}" width="20" height="20">` +
      `<image width="4" height="4" href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>` +
      `<image width="4" height="4" href="data:text/html;base64,PGI+"/></svg>`,
  );
  assert.doesNotMatch(result.markup, /data:/);
  assert.ok(result.removed.includes("external-reference"));
});

test("obfuscated script URLs and links are removed", () => {
  const result = sanitizeSvg(
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20">` +
      `<a xlink:href="java&#x73;cript:alert(1)"><rect width="10" height="10"/></a>` +
      `<a href=" JaVaScRiPt:alert(2)"><circle r="3"/></a></svg>`,
  );
  assertInert(result.markup);
  assert.match(result.markup, /<rect/);
  assert.match(result.markup, /<circle/);
});

test("CSS imports and remote url() are neutralised but local paint stays", () => {
  const result = sanitizeSvg(
    `<svg xmlns="${SVG_NS}" width="20" height="20"><style>@import url(http://evil.example/a.css);` +
      `@font-face{font-family:x;src:url(https://evil.example/f.woff)}` +
      `.a{fill:#C8102E;background:url('http://evil.example/b.png')}</style>` +
      `<rect class="a" width="10" height="10" style="fill:url(file:///x);stroke:#112233"/></svg>`,
  );
  assertInert(result.markup);
  assert.match(result.markup, /#C8102E/);
  assert.match(result.markup, /stroke:#112233/);
  assert.ok(result.removed.includes("external-reference"));
});

test("a quoted remote url() is neutralised even with a parenthesis inside it", () => {
  const result = sanitizeSvg(
    `<svg xmlns="${SVG_NS}" width="20" height="20"><style>.a{fill:url("http://evil.example/a)b")}` +
      `.b{fill:url( '#local' )}</style><rect class="a" width="10" height="10"/></svg>`,
  );
  assertInert(result.markup);
  assert.match(result.markup, /\.b\{fill:url\(#local\)\}/);
  assert.ok(result.removed.includes("external-reference"));
});

test("animation and script-like elements are not carried over", () => {
  const result = sanitizeSvg(
    `<svg xmlns="${SVG_NS}" width="20" height="20"><rect width="10" height="10">` +
      `<set attributeName="href" to="javascript:alert(1)"/><animate attributeName="x" to="5"/></rect></svg>`,
  );
  assert.doesNotMatch(result.markup, /<set|<animate/);
  assertInert(result.markup);
});

test("a root that is not <svg> is refused", () => {
  assert.throws(
    () => sanitizeSvg(`<html><body/></html>`),
    (/** @type {CodedError} */ error) => error.code === "unsupported-type",
  );
});

test("malformed XML is a corrupt-file rejection in Chinese", () => {
  assert.throws(
    () => sanitizeSvg(`<svg xmlns="${SVG_NS}"><g></svg>`),
    (/** @type {CodedError} */ error) => error.code === "corrupt" && /损坏|无法/.test(error.message),
  );
});

test("an undefined entity reference is a rejection, not silent text", () => {
  assert.throws(
    () => sanitizeSvg(`<svg xmlns="${SVG_NS}" width="5" height="5"><text>&nope;</text></svg>`),
    (/** @type {CodedError} */ error) => error.code === "corrupt",
  );
});

test("very deep or very large documents are refused as too complex", () => {
  const deep = `<svg xmlns="${SVG_NS}" width="5" height="5">${"<g>".repeat(200)}${"</g>".repeat(200)}</svg>`;
  assert.throws(
    () => sanitizeSvg(deep),
    (/** @type {CodedError} */ error) => error.code === "too-large" && /复杂/.test(error.message),
  );
  const wide = `<svg xmlns="${SVG_NS}" width="5" height="5">${"<g/>".repeat(30000)}</svg>`;
  assert.throws(
    () => sanitizeSvg(wide),
    (/** @type {CodedError} */ error) => error.code === "too-large",
  );
});

test("the parser rasterizes only sanitized markup", { skip: NO_SHARP }, async () => {
  /** @type {string[]} */
  const seen = [];
  const rasterize = async (/** @type {string} */ markup, /** @type {number} */ density) => {
    seen.push(markup);
    return sharp(Buffer.from(markup), { density }).png().toBuffer();
  };
  for (const text of [SCRIPT, EXTERNAL, FOREIGN]) {
    await svgRasterParser.parse(/** @type {SvgInput} */ ({ name: "x.svg", extension: ".svg", bytes: buffer(text) }), {
      rasterize,
    });
  }
  assert.equal(seen.length, 3);
  for (const markup of seen) assertInert(markup);
});

test("a logo becomes a PNG copy of its declared size plus the image style data", { skip: NO_SHARP }, async () => {
  const parsed = /** @type {SvgResult} */ (
    await svgRasterParser.parse(
      /** @type {SvgInput} */ ({
        name: "logo.svg",
        extension: ".svg",
        bytes: buffer(logo),
      }),
    )
  );
  const image = parsed.payload;
  assert.equal(image.raster.format, "png");
  assert.equal(image.raster.width, 100);
  assert.equal(image.raster.height, 100);
  const png = Buffer.from(image.raster.data, "base64");
  assert.equal(png.length, image.raster.bytes);
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 100);
  assert.equal(meta.hasAlpha, true);
  assert.equal(image.normalized.format, "jpeg");
  assert.equal(image.width, 100);
  assert.equal(image.dominant.length, 7);
  assert.ok(image.palette.length >= 1);
  assert.deepEqual(parsed.warnings, []);
  assert.match(parsed.summary.zh, /SVG/);
  assert.match(parsed.summary.zh, /100×100/);
  assert.doesNotMatch(JSON.stringify(parsed.payload), /<svg|<script|<circle/);
});

test(
  "removed active content produces the Chinese warning and the image is still read",
  { skip: NO_SHARP },
  async () => {
    for (const [text, label] of [
      [SCRIPT, "脚本"],
      [EXTERNAL, "外部链接"],
      [FOREIGN, "内嵌网页内容"],
    ]) {
      const parsed = /** @type {SvgResult} */ (
        await svgRasterParser.parse(
          /** @type {SvgInput} */ ({
            name: "x.svg",
            extension: ".svg",
            bytes: buffer(text),
          }),
        )
      );
      const warning = parsed.warnings.find((entry) => entry.code === "svg-sanitized");
      assert.ok(warning, label);
      assert.match(warning.message, new RegExp(`已移除 SVG 中的.*${label}.*按图片读取`));
      assert.equal(parsed.payload.raster.width, 120);
    }
    const both = /** @type {SvgResult} */ (
      await svgRasterParser.parse(
        /** @type {SvgInput} */ ({
          name: "x.svg",
          extension: ".svg",
          bytes: buffer(
            `<svg xmlns="${SVG_NS}" width="20" height="20" onload="x()"><image href="http://a.example/x.png"/></svg>`,
          ),
        }),
      )
    );
    assert.equal(both.warnings[0].message, "已移除 SVG 中的脚本和外部链接，按图片读取");
  },
);

test("the rasterized pixels come from the visible shapes, not from removed content", { skip: NO_SHARP }, async () => {
  const parsed = /** @type {SvgResult} */ (
    await svgRasterParser.parse(
      /** @type {SvgInput} */ ({
        name: "x.svg",
        extension: ".svg",
        bytes: buffer(SCRIPT),
      }),
    )
  );
  const { data, info } = await sharp(Buffer.from(parsed.payload.raster.data, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const middle = ((info.height >> 1) * info.width + (info.width >> 1)) * info.channels;
  assert.deepEqual([...data.subarray(middle, middle + 3)], [0x1f, 0x4e, 0x79]);
});

test("a huge canvas is refused before anything is rendered", { skip: NO_SHARP }, async () => {
  let called = 0;
  const started = Date.now();
  await assert.rejects(
    svgRasterParser.parse(/** @type {SvgInput} */ ({ name: "svg-huge.svg", extension: ".svg", bytes: buffer(HUGE) }), {
      rasterize: async () => {
        called += 1;
        return Buffer.alloc(0);
      },
    }),
    (/** @type {CodedError} */ error) => error.code === "too-large" && /像素|画布/.test(error.message),
  );
  assert.equal(called, 0);
  assert.ok(Date.now() - started < 2000);
});

test("a big canvas is rendered no larger than the documented maximum edge", { skip: NO_SHARP }, async () => {
  const parsed = /** @type {SvgResult} */ (
    await svgRasterParser.parse(
      /** @type {SvgInput} */ ({
        name: "wide.svg",
        extension: ".svg",
        bytes: buffer(
          `<svg xmlns="${SVG_NS}" width="6000" height="3000"><rect width="6000" height="3000" fill="#336699"/></svg>`,
        ),
      }),
    )
  );
  assert.equal(SVG_RASTER_MAX_EDGE, 2048);
  assert.equal(parsed.payload.raster.width, 2048);
  assert.equal(parsed.payload.raster.height, 1024);
});

test("a viewBox-only SVG and a unit-sized SVG report their natural size", { skip: NO_SHARP }, async () => {
  const viewBox = /** @type {SvgResult} */ (
    await svgRasterParser.parse(
      /** @type {SvgInput} */ ({
        name: "vb.svg",
        extension: ".svg",
        bytes: buffer(`<svg xmlns="${SVG_NS}" viewBox="0 0 400 200"><rect width="400" height="200"/></svg>`),
      }),
    )
  );
  assert.equal(viewBox.payload.raster.width, 400);
  assert.equal(viewBox.payload.raster.height, 200);
  const units = /** @type {SvgResult} */ (
    await svgRasterParser.parse(
      /** @type {SvgInput} */ ({
        name: "cm.svg",
        extension: ".svg",
        bytes: buffer(`<svg xmlns="${SVG_NS}" width="10cm" height="5cm"><rect width="30" height="30"/></svg>`),
      }),
    )
  );
  assert.ok(Math.abs(units.payload.raster.width - 283) <= 1);
});

test("an oversized SVG text is refused before parsing", { skip: NO_SHARP }, async () => {
  const filler = "<!-- ".concat("x".repeat(6 * 1024 * 1024), " -->");
  await assert.rejects(
    svgRasterParser.parse(
      /** @type {SvgInput} */ ({
        name: "big.svg",
        extension: ".svg",
        bytes: buffer(`<svg xmlns="${SVG_NS}" width="5" height="5">${filler}</svg>`),
      }),
    ),
    (/** @type {CodedError} */ error) => error.code === "too-large",
  );
});

test("the worker job records a parsed image with the svg parser id and no SVG bytes", { skip: NO_SHARP }, async () => {
  const derivative = await runParseJob({ materialId: "m1", name: "logo.svg", bytes: buffer(logo) });
  assert.equal(derivative.status, "ok");
  assert.equal(derivative.kind, "image");
  assert.equal(derivative.parser.id, "svg-raster-v1");
  assert.equal(derivative.source.detectedMime, "image/svg+xml");
  assert.doesNotMatch(JSON.stringify(derivative), /<svg|<circle/);
});

test("the worker job rejects the entity and huge fixtures with a Chinese reason", { skip: NO_SHARP }, async () => {
  for (const [name, text, code] of [
    ["svg-entity.svg", ENTITY, "unsupported-type"],
    ["svg-huge.svg", HUGE, "too-large"],
  ]) {
    await assert.rejects(
      runParseJob({ materialId: "m2", name, bytes: buffer(text) }),
      (/** @type {CodedError} */ error) => error.code === code && /[一-鿿]/.test(error.message),
      name,
    );
  }
});
