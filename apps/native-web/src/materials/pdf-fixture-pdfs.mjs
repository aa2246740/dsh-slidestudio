/**
 * Test-only PDF builder: small, deterministic PDFs written byte by byte, so the PDF
 * tests need no generated sample set, no network and no native image add-on.
 * Pages may carry a heading, positioned text items, raw vector operators, a
 * full-page "scan" raster and extra RGB pictures (flat or seeded noise). A font
 * name other than Helvetica gets a single-byte ToUnicode map, so CJK text is
 * extractable without embedding a font. `encrypt` only writes the standard
 * security trailer reference the parsers reject on; the content stays plain.
 */
import { zlibSync } from "fflate";

/**
 * @typedef {{width: number, height: number, x: number, y: number,
 *   rgb: [number, number, number], noise?: number, seed?: number}} FixtureImage
 * @typedef {{text: string, x: number, y: number, size?: number}} FixtureTextItem
 * @typedef {{text?: string, items?: FixtureTextItem[], vectorContent?: string,
 *   vectorOnly?: boolean, raster?: FixtureImage, images?: FixtureImage[]}} FixturePage
 * @typedef {{pages: FixturePage[], encrypt?: boolean, fontName?: string}} FixturePdfSpec
 */

const FULL_PAGE_SCAN = /** @type {FixtureImage} */ ({
  width: 595,
  height: 842,
  x: 0,
  y: 0,
  rgb: [236, 236, 232],
});

/** Seeded PRNG (mulberry32), so noisy pictures are identical on every run. @param {number} seed */
export function fixtureRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Collects numbered objects; numbers are 1-based in insertion order. */
class ObjectTable {
  constructor() {
    /** @type {Buffer[]} */
    this.objects = [];
  }

  /** @returns {number} a reserved object number whose body is set later */
  reserve() {
    this.objects.push(Buffer.alloc(0));
    return this.objects.length;
  }

  /** @param {string|Buffer} body @returns {number} */
  add(body) {
    const number = this.reserve();
    this.set(number, body);
    return number;
  }

  /** @param {number} number @param {string|Buffer} body */
  set(number, body) {
    this.objects[number - 1] = typeof body === "string" ? Buffer.from(body, "latin1") : body;
  }

  /** @param {string|Buffer} dictionary @param {Buffer} data @returns {number} */
  addStream(dictionary, data) {
    return this.add(
      Buffer.concat([Buffer.from(`${dictionary}\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]),
    );
  }
}

/** @param {FixtureImage} image @returns {Buffer} raw RGB pixels */
function imagePixels({ width, height, rgb, noise = 0, seed = 1 }) {
  const random = fixtureRandom(seed);
  const pixels = Buffer.alloc(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset += 1) {
    const jitter = noise ? Math.floor((random() - 0.5) * 2 * noise) : 0;
    pixels[offset] = Math.max(0, Math.min(255, (rgb[offset % 3] ?? 0) + jitter));
  }
  return pixels;
}

/** @param {ObjectTable} table @param {FixtureImage} image @returns {number} */
function addImage(table, image) {
  // FlateDecode needs a zlib header; raw deflate is not a valid PDF stream.
  const data = Buffer.from(zlibSync(imagePixels(image), { level: 6 }));
  return table.addStream(
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`,
    data,
  );
}

/** @param {string} value */
function pdfLiteral(value) {
  const latin = Buffer.from(value, "utf8").toString("latin1");
  return `(${latin.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

/** @param {FixturePage[]} pages @returns {Map<string, number>} */
function unicodeCodes(pages) {
  /** @type {Map<string, number>} */
  const codes = new Map();
  for (const page of pages) {
    const texts = [page.text ?? "", ...(page.items ?? []).map((item) => item.text)];
    for (const character of texts.flatMap((text) => Array.from(text))) {
      if (codes.has(character)) continue;
      if (codes.size >= 255) throw new Error("PDF fixture text uses too many code points");
      codes.set(character, codes.size + 1);
    }
  }
  return codes;
}

/** @param {string} character */
function unicodeHex(character) {
  const codePoint = character.codePointAt(0) ?? 0;
  const units =
    codePoint <= 0xffff
      ? [codePoint]
      : [0xd800 + ((codePoint - 0x10000) >> 10), 0xdc00 + ((codePoint - 0x10000) & 0x3ff)];
  return units
    .map((unit) => unit.toString(16).padStart(4, "0"))
    .join("")
    .toUpperCase();
}

/** @param {Map<string, number>} codes @returns {Buffer} */
function toUnicodeCmap(codes) {
  const hex = (/** @type {number} */ code) => code.toString(16).padStart(2, "0");
  const mappings = [...codes.entries()]
    .map(([character, code]) => `<${hex(code)}> <${unicodeHex(character)}>`)
    .join("\n");
  return Buffer.from(
    `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n` +
      `/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n` +
      `1 begincodespacerange\n<01> <FF>\nendcodespacerange\n` +
      `${codes.size} beginbfchar\n${mappings}\nendbfchar\n` +
      `endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`,
    "latin1",
  );
}

/** @param {Map<string, number>} codes */
const cmapDictionary = (codes) => `<< /Length ${toUnicodeCmap(codes).length} >>`;

/**
 * @param {Map<string, number>|undefined} codes
 * @returns {(text: string) => string} a PDF string token for `Tj`
 */
function textEncoder(codes) {
  if (!codes) return pdfLiteral;
  return (text) =>
    `<${Array.from(text)
      .map((character) => (codes.get(character) ?? 0).toString(16).padStart(2, "0"))
      .join("")}>`;
}

/**
 * @param {ObjectTable} table @param {FixturePage} page @param {number} index
 * @param {(text: string) => string} encode
 * @returns {{stream: string, xobjects: string[]}}
 */
function pageContent(table, page, index, encode) {
  const parts = page.vectorContent ? [page.vectorContent] : [];
  /** @type {string[]} */
  const xobjects = [];
  const scan = page.raster ?? (page.vectorOnly ? FULL_PAGE_SCAN : undefined);
  // Scanned-style pages are one full-page image, well above the 50 % image threshold.
  const pictures = [...(scan ? [scan] : []), ...(page.images ?? [])];
  pictures.forEach((image, order) => {
    const name = `Im${index + 1}x${order}`;
    xobjects.push(`/${name} ${addImage(table, image)} 0 R`);
    parts.push(`q ${image.width} 0 0 ${image.height} ${image.x} ${image.y} cm /${name} Do Q`);
  });
  if (page.text) parts.push(`BT /F1 18 Tf 56 760 Td ${encode(page.text)} Tj ET`);
  for (const item of page.items ?? []) {
    parts.push(`BT /F1 ${item.size ?? 11} Tf ${item.x} ${item.y} Td ${encode(item.text)} Tj ET`);
  }
  return { stream: parts.join("\n"), xobjects };
}

/** @param {ObjectTable} table @param {string} trailer @returns {Buffer} */
function serialize(table, trailer) {
  /** @type {Buffer[]} */
  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
  let length = chunks[0]?.length ?? 0;
  /** @type {number[]} */
  const offsets = [];
  table.objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "latin1"),
      object,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const size = table.objects.length + 1;
  const xref =
    `xref\n0 ${size}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  chunks.push(
    Buffer.from(`${xref}trailer\n<< /Size ${size} /Root 1 0 R${trailer} >>\nstartxref\n${length}\n%%EOF\n`, "latin1"),
  );
  return Buffer.concat(chunks);
}

/**
 * @param {FixturePdfSpec} spec
 * @returns {Buffer}
 */
export function buildPdf({ pages, encrypt = false, fontName = "Helvetica" }) {
  const table = new ObjectTable();
  const catalog = table.reserve();
  const pagesObject = table.reserve();
  const codes = fontName === "Helvetica" ? undefined : unicodeCodes(pages);
  const cmapObject = codes ? table.addStream(cmapDictionary(codes), toUnicodeCmap(codes)) : 0;
  const toUnicode = codes ? ` /Encoding /WinAnsiEncoding /ToUnicode ${cmapObject} 0 R` : "";
  const font = table.add(`<< /Type /Font /Subtype /Type1 /BaseFont /${fontName}${toUnicode} >>`);
  const encode = textEncoder(codes);
  const kids = pages.map((page, index) => {
    const { stream, xobjects } = pageContent(table, page, index, encode);
    const contents = table.add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const xobject = xobjects.length ? `/XObject << ${xobjects.join(" ")} >> ` : "";
    return table.add(
      `<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 595 842] /Contents ${contents} 0 R ` +
        `/Resources << /Font << /F1 ${font} 0 R >> ${xobject}>> >>`,
    );
  });
  table.set(catalog, `<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);
  table.set(
    pagesObject,
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  let trailer = "";
  if (encrypt) {
    const id = Buffer.from("attachment-fixture-id-0001", "latin1").toString("hex");
    const dictionary = table.add("<< /Filter /Standard /V 1 /R 2 /O (fixture) /P -1 >>");
    trailer = ` /Encrypt ${dictionary} 0 R /ID [<${id}> <${id}>]`;
  }
  return serialize(table, trailer);
}

/** Minimal multi-page PDF with one text operator per page. @param {number} pageCount @param {(index: number) => string} [textOf] */
export function buildMultiPagePdf(pageCount, textOf = (index) => `Page ${index + 1} cap check text.`) {
  return buildPdf({ pages: Array.from({ length: pageCount }, (_, index) => ({ text: textOf(index) })) });
}
