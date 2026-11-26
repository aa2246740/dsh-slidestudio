/** Synthetic OOXML only. 未用真实文件验证. Builds small PPTX packages for the template-kit parser tests. */
import { strToU8, zipSync } from "fflate";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS = `xmlns:a="${A}" xmlns:p="${P}" xmlns:r="${R}"`;

export const SLIDE_SIZE = { cx: 9144000, cy: 5143500 };

/** @typedef {{x: number, y: number, w: number, h: number, rot?: number, flipH?: boolean, flipV?: boolean}} Frame */

/** @param {string[][]} entries [id, type, target] */
const relsXml = (entries) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(
      ([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`,
    )
    .join("")}</Relationships>`;

/** @param {{rot?: number, flipH?: boolean, flipV?: boolean}} turn */
const turnAttrs = ({ rot, flipH, flipV }) =>
  `${rot ? ` rot="${Math.round(rot * 60000)}"` : ""}${flipH ? ' flipH="1"' : ""}${flipV ? ' flipV="1"' : ""}`;

/** @param {Frame} frame */
const frameXml = (frame) =>
  `<a:xfrm${turnAttrs(frame)}><a:off x="${frame.x}" y="${frame.y}"/><a:ext cx="${frame.w}" cy="${frame.h}"/></a:xfrm>`;

/** @param {{id: number, geom?: string, color: string} & Frame} spec */
export const shape = ({ id, geom = "rect", color, ...frame }) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="形状 ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${frameXml(frame)}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></p:spPr></p:sp>`;

/** @param {{id: number, text: string} & Frame} spec */
export const textBox = ({ id, text, ...frame }) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="文本 ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${frameXml(frame)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1800"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

/**
 * @param {{id: number, rid: string, effect?: string} & Frame} spec `effect` is raw blip child XML,
 * for example `<a:grayscl/>`.
 */
export const picture = ({ id, rid, effect = "", ...frame }) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="图片 ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}">${effect}</a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${frameXml(frame)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;

/** A straight connector with an arrow head at its end. @param {{id: number, color: string} & Frame} spec */
export const connector = ({ id, color, ...frame }) =>
  `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="连接线 ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${frameXml(frame)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="19050"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>`;

/** @param {{id: number, x: number, y: number, w: number, h: number}} spec */
export const tableFrame = ({ id, x, y, w, h }) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="表格 ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm><a:graphic><a:graphicData uri="${A}/table"><a:tbl><a:tblGrid><a:gridCol w="${w}"/></a:tblGrid><a:tr h="${h}"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>格</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

/**
 * @typedef {{id: number, children: string, off: {x: number, y: number}, ext: {w: number, h: number},
 *   chOff?: {x: number, y: number}, chExt?: {w: number, h: number},
 *   rot?: number, flipH?: boolean, flipV?: boolean}} GroupSpec
 * @param {GroupSpec} spec
 */
export const group = ({ id, children, off, ext, chOff = off, chExt = ext, ...turn }) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="组合 ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm${turnAttrs(turn)}><a:off x="${off.x}" y="${off.y}"/><a:ext cx="${ext.w}" cy="${ext.h}"/><a:chOff x="${chOff.x}" y="${chOff.y}"/><a:chExt cx="${chExt.w}" cy="${chExt.h}"/></a:xfrm></p:grpSpPr>${children}</p:grpSp>`;

const THEME_COLORS = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "hlink", "folHlink"];
const theme = `<a:theme ${NS} name="合成主题"><a:themeElements><a:clrScheme name="测试">${THEME_COLORS.map(
  (name, index) =>
    `<a:${name}><a:srgbClr val="${["000000", "FFFFFF", "1F2937", "F3F4F6", "C00000", "2563EB", "0563C1", "954F72"][index]}"/></a:${name}>`,
).join("")}</a:clrScheme></a:themeElements></a:theme>`;

const clrMap =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent1" accent4="accent1" accent5="accent1" accent6="accent1" hlink="hlink" folHlink="folHlink"/>';

/** @param {string} shapes */
const tree = (shapes) => `<p:cSld><p:spTree>${shapes}</p:spTree></p:cSld>`;

/**
 * One master, any number of layouts, and slides that each name their layout. `rels` of a part are
 * extra [id, type, target] relationships (typically `image`); `media` is written below ppt/media.
 * @param {{
 *   slides: {shapes: string, layout?: number, rels?: string[][]}[],
 *   layouts?: {shapes: string, rels?: string[][], showMasterSp?: boolean}[],
 *   master?: {shapes: string, rels?: string[][]},
 *   media?: Record<string, Uint8Array>,
 * }} spec
 */
export function kitPptx({
  slides,
  layouts = [{ shapes: "" }],
  master = { shapes: "" },
  media = {},
}) {
  /** @type {Record<string, string | Uint8Array>} */ const files = {};
  files["ppt/presentation.xml"] =
    `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rM"/></p:sldMasterIdLst><p:sldIdLst>${slides
      .map((_, index) => `<p:sldId id="${256 + index}" r:id="rS${index + 1}"/>`)
      .join(
        "",
      )}</p:sldIdLst><p:sldSz cx="${SLIDE_SIZE.cx}" cy="${SLIDE_SIZE.cy}"/></p:presentation>`;
  files["ppt/_rels/presentation.xml.rels"] = relsXml([
    ["rM", "slideMaster", "slideMasters/slideMaster1.xml"],
    ...slides.map((_, index) => [`rS${index + 1}`, "slide", `slides/slide${index + 1}.xml`]),
  ]);
  files["ppt/slideMasters/slideMaster1.xml"] =
    `<p:sldMaster ${NS}>${tree(master.shapes)}${clrMap}<p:sldLayoutIdLst>${layouts
      .map((_, index) => `<p:sldLayoutId id="${2147483649 + index}" r:id="rL${index + 1}"/>`)
      .join("")}</p:sldLayoutIdLst></p:sldMaster>`;
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = relsXml([
    ["rT", "theme", "../theme/theme1.xml"],
    ...layouts.map((_, index) => [
      `rL${index + 1}`,
      "slideLayout",
      `../slideLayouts/slideLayout${index + 1}.xml`,
    ]),
    ...(master.rels ?? []),
  ]);
  files["ppt/theme/theme1.xml"] = theme;
  layouts.forEach((layout, index) => {
    files[`ppt/slideLayouts/slideLayout${index + 1}.xml`] =
      `<p:sldLayout ${NS} type="obj"${layout.showMasterSp === false ? ' showMasterSp="0"' : ""}>${tree(layout.shapes)}</p:sldLayout>`;
    files[`ppt/slideLayouts/_rels/slideLayout${index + 1}.xml.rels`] = relsXml([
      ["rM", "slideMaster", "../slideMasters/slideMaster1.xml"],
      ...(layout.rels ?? []),
    ]);
  });
  slides.forEach((slide, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = `<p:sld ${NS}>${tree(slide.shapes)}</p:sld>`;
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = relsXml([
      ["rL", "slideLayout", `../slideLayouts/slideLayout${(slide.layout ?? 0) + 1}.xml`],
      ...(slide.rels ?? []),
    ]);
  });
  for (const [name, bytes] of Object.entries(media)) files[`ppt/media/${name}`] = bytes;
  files["[Content_Types].xml"] =
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>';
  files["_rels/.rels"] = relsXml([["main", "officeDocument", "ppt/presentation.xml"]]);
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, content]) => [
          name,
          typeof content === "string" ? strToU8(content) : content,
        ]),
      ),
      { level: 6, mtime: new Date("2026-01-01T00:00:00Z") },
    ),
  );
}
