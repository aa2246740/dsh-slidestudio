/**
 * Hand-built PPTX and PNG bytes shared by parser and intake tests.
 * Not a product parser: the Office fixture stays here so tests do not
 * each carry a second copy of the package XML.
 */
import { strToU8, zipSync, zlibSync } from "fflate";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const rel = (/** @type {string} */ type) =>
  `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}`;

const SLIDE_W = 12192000;
const SLIDE_H = 6858000;

const themeXml = (/** @type {any[][]} */ colors, /** @type {{ major: any; minor: any; }} */ fonts) =>
  `${XML_DECL}<a:theme xmlns:a="${A_NS}" name="测试主题"><a:themeElements>` +
  `<a:clrScheme name="测试色板">${colors
    .map(([key, tag, attrs]) => `<a:${key}><${tag} ${attrs}/></a:${key}>`)
    .join("")}</a:clrScheme>` +
  `<a:fontScheme name="测试字体">` +
  `<a:majorFont><a:latin typeface="${fonts.major.latin}"/><a:ea typeface="${fonts.major.ea}"/><a:cs typeface=""/>` +
  (fonts.major.hans ? `<a:font script="Hans" typeface="${fonts.major.hans}"/>` : "") +
  `</a:majorFont>` +
  `<a:minorFont><a:latin typeface="${fonts.minor.latin}"/><a:ea typeface="${fonts.minor.ea}"/><a:cs typeface=""/>` +
  (fonts.minor.hans ? `<a:font script="Hans" typeface="${fonts.minor.hans}"/>` : "") +
  `</a:minorFont></a:fontScheme></a:themeElements></a:theme>`;

const srgb = (/** @type {string} */ key, /** @type {string} */ hex) => [key, "a:srgbClr", `val="${hex}"`];
const sys = (/** @type {string} */ key, /** @type {string} */ val, /** @type {string} */ lastClr) => [
  key,
  "a:sysClr",
  `val="${val}" lastClr="${lastClr}"`,
];

/**
 * Minimal deck: one master with a title placeholder, one layout whose
 * placeholders inherit the master box, two slides (the second hidden).
 * Each `media` picture is placed small on the master so it qualifies as a
 * logo candidate. `zipLevel` 0 keeps an already-large PNG from compressing
 * away, which is how the near-limit fixture stays near 18.9 MB.
 * @param {{withMedia?: boolean, media?: {name: string, bytes: Uint8Array}[], zipLevel?: import("fflate").DeflateOptions["level"]}} options
 */
export function buildPptx({ withMedia = false, media, zipLevel = 6 } = {}) {
  const pictures = media ?? (withMedia ? [{ name: "logo.png", bytes: tinyPng() }] : []);
  const placeholder = (
    /** @type {number} */ id,
    /** @type {string} */ name,
    /** @type {string} */ phAttrs,
    /** @type {boolean} */ withBox,
  ) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><p:ph ${phAttrs}/></p:cNvSpPr></p:nvSpPr>` +
    (withBox
      ? `<p:spPr><a:xfrm><a:off x="${SLIDE_W * 0.05}" y="${SLIDE_H * 0.05}"/><a:ext cx="${SLIDE_W * 0.4}" cy="${SLIDE_H * 0.12}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
      : "<p:spPr/>") +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>`;

  const master =
    `${XML_DECL}<p:sldMaster xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>` +
    placeholder(2, "标题占位符", 'type="title"', true) +
    pictures
      .map(
        (pic, index) =>
          `<p:pic><p:nvPicPr><p:cNvPr id="${10 + index}" name="角标${index}"/><p:cNvPicPr/></p:nvPicPr>` +
          `<p:blipFill><a:blip r:embed="rIdImg${index}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
          `<p:spPr><a:xfrm><a:off x="${182880 + index * 200000}" y="182880"/><a:ext cx="914400" cy="457200"/></a:xfrm>` +
          `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
      )
      .join("") +
    `</p:spTree></p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdL1"/></p:sldLayoutIdLst></p:sldMaster>`;

  const layout =
    `${XML_DECL}<p:sldLayout xmlns:p="${P_NS}" xmlns:a="${A_NS}" type="title" name="继承版式">` +
    `<p:cSld name="继承版式"><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>` +
    placeholder(2, "标题占位符", 'type="title"', false) +
    placeholder(3, "内容占位符", 'type="body" idx="1"', false) +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

  const slide = (/** @type {string} */ text, /** @type {boolean} */ hidden) =>
    `${XML_DECL}<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"${hidden ? ' show="0"' : ""}>` +
    `<p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr><p:ph type="title"/></p:cNvSpPr></p:nvSpPr>` +
    `<p:spPr/>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

  const slideEntry = (/** @type {string} */ id, /** @type {string} */ target) =>
    `<Relationship Id="${id}" Type="${rel("slide")}" Target="${target}"/>`;
  /** @type {Record<string, Uint8Array>} */
  const files = {
    "[Content_Types].xml": strToU8(
      `${XML_DECL}<Types xmlns="${RELS_NS}">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        (pictures.length ? `<Default Extension="png" ContentType="image/png"/>` : "") +
        `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
        `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
        `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
        `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
        `<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
        `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${rel("officeDocument")}" Target="ppt/presentation.xml"/></Relationships>`,
    ),
    "ppt/presentation.xml": strToU8(
      `${XML_DECL}<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}">` +
        `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst>` +
        `<p:sldIdLst><p:sldId id="256" r:id="rIdS1"/><p:sldId id="257" r:id="rIdS2"/></p:sldIdLst>` +
        `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rIdM" Type="${rel("slideMaster")}" Target="slideMasters/slideMaster1.xml"/>` +
        slideEntry("rIdS1", "slides/slide1.xml") +
        slideEntry("rIdS2", "slides/slide2.xml") +
        `</Relationships>`,
    ),
    "ppt/slideMasters/slideMaster1.xml": strToU8(master),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rIdL1" Type="${rel("slideLayout")}" Target="../slideLayouts/slideLayout1.xml"/>` +
        `<Relationship Id="rIdT" Type="${rel("theme")}" Target="../theme/theme1.xml"/>` +
        pictures
          .map(
            (pic, index) => `<Relationship Id="rIdImg${index}" Type="${rel("image")}" Target="../media/${pic.name}"/>`,
          )
          .join("") +
        `</Relationships>`,
    ),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(layout),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${rel("slideMaster")}" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    ),
    "ppt/theme/theme1.xml": strToU8(
      themeXml(
        [
          sys("dk1", "windowText", "000000"),
          sys("lt1", "window", "FFFFFF"),
          srgb("dk2", "2B2B2B"),
          srgb("lt2", "F2F2F2"),
          srgb("accent1", "C8102E"),
          srgb("accent2", "002855"),
          srgb("accent3", "F2A900"),
          srgb("accent4", "5B6770"),
          srgb("accent5", "7A9A01"),
          srgb("accent6", "00A3AD"),
          srgb("hlink", "0563C1"),
          srgb("folHlink", "954F72"),
        ],
        {
          major: { latin: "思源宋体", ea: "思源黑体", hans: "思源黑体" },
          minor: { latin: "Calibri", ea: "等线", hans: "等线" },
        },
      ),
    ),
    "ppt/slides/slide1.xml": strToU8(slide("第一页文字", false)),
    "ppt/slides/slide2.xml": strToU8(slide("第二页隐藏", true)),
  };
  for (const pic of pictures) files[`ppt/media/${pic.name}`] = pic.bytes;
  return Buffer.from(zipSync(files, { level: zipLevel }));
}

/**
 * RGB PNG. Default is the 4×4 red mark. A large solid image uses deflate
 * level 0 so the file stays near width×height×3 and can stand in for the
 * 2520×2500 logo that previously blew the derivative cap.
 * @param {{width?: number, height?: number, rgb?: [number, number, number], level?: import("fflate").DeflateOptions["level"],
 *   fill?: (raw: Buffer, width: number) => void}} [options]
 */
export function solidPng({ width = 4, height = 4, rgb = [0xc8, 0x10, 0x2e], level = 9, fill } = {}) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  if (fill) fill(raw, width);
  else {
    for (let y = 0; y < height; y += 1) {
      raw[y * (1 + width * 3)] = 0;
      for (let x = 0; x < width; x += 1) {
        const base = y * (1 + width * 3) + 1 + x * 3;
        raw[base] = rgb[0];
        raw[base + 1] = rgb[1];
        raw[base + 2] = rgb[2];
      }
    }
  }
  const idat = zlibSync(new Uint8Array(raw), { level });
  const crcTable = buildCrcTable();
  const crc32 = (/** @type {Buffer<ArrayBuffer>} */ buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    Buffer.from(type, "ascii").copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.from(idat)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 4×4 red PNG (valid signature, minimal chunks via fflate zlib). */
export function tinyPng() {
  return solidPng();
}

/** Minimal CRC-32 table (poly 0xEDB88320) for hand-written PNG chunks. */
function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
