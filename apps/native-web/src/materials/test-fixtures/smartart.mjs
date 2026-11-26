/** Synthetic OOXML only. 未用真实文件验证. No source documents are embedded. */
import { strToU8, zipSync } from "fflate";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const D = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
const DSP = "http://schemas.microsoft.com/office/drawing/2008/diagram";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const ns = `xmlns:a="${A}" xmlns:p="${P}" xmlns:r="${R}" xmlns:dgm="${D}" xmlns:dsp="${DSP}" xmlns:w="${W}"`;
/** @param {string} text */
const esc = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
/** @param {string[][]} entries */
const rels = (entries) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type === "diagramDrawing" ? "http://schemas.microsoft.com/office/2007/relationships" : R}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
/** @param {string} text @param {number} [lvl] */
const para = (text, lvl = 0) =>
  `<a:p><a:pPr lvl="${lvl}"/><a:r><a:rPr sz="1800" b="1"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p>`;
/** @param {string} id @param {string} text @param {string} [type] @param {string} [extra] */
const point = (id, text, type = "node", extra = "") =>
  `<dgm:pt modelId="${id}" type="${type}"><dgm:prSet ${extra}/>${text ? `<dgm:t>${para(text)}</dgm:t>` : ""}</dgm:pt>`;
/** @param {string} src @param {string} dest @param {number} [ord] */
const cxn = (src, dest, ord = 0) =>
  `<dgm:cxn modelId="c${src}-${dest}" type="parOf" srcId="${src}" destId="${dest}" srcOrd="${ord}"/>`;
const frameBox =
  '<p:xfrm><a:off x="1000000" y="1500000"/><a:ext cx="6000000" cy="3000000"/></p:xfrm>';
/** @param {number} n */
const frame = (n) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${n + 10}" name="图示 ${n}"/></p:nvGraphicFramePr>${frameBox}<a:graphic><a:graphicData uri="${D}"><dgm:relIds r:dm="dm${n}" r:lo="lo${n}" r:qs="qs${n}" r:cs="cs${n}"/></a:graphicData></a:graphic></p:graphicFrame>`;

/** Exact fixture geometry: first node = [.125,.347,.1969,.21] on 8M × 6M page.
 * @param {number} i @param {string} text @param {string} variant */
function shape(i, text, variant) {
  const connector = i >= 3;
  const id = connector ? `trans${i}` : variant === "modelid-direct" ? `n${i}` : `pres${i}`;
  const x = connector ? 1800000 + (i - 3) * 2100000 : i * 2100000;
  const custom = variant === "hierarchy" && i === 0;
  const geom = custom
    ? '<a:custGeom><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:lnTo><a:pt x="100" y="80"/></a:lnTo><a:quadBezTo><a:pt x="50" y="100"/><a:pt x="0" y="80"/></a:quadBezTo><a:close/></a:path></a:pathLst></a:custGeom>'
    : `<a:prstGeom prst="${connector ? "rightArrow" : variant === "unknown-preset" && i === 1 ? "zzNoSuchShape" : "roundRect"}"><a:avLst><a:gd name="adj" fmla="val 10000"/></a:avLst></a:prstGeom>`;
  const fill =
    variant === "style-ref-fill"
      ? ""
      : `<a:solidFill><a:schemeClr val="accent1">${connector ? '<a:tint val="60000"/>' : variant === "lummod" ? '<a:lumMod val="75000"/>' : ""}</a:schemeClr></a:solidFill>`;
  return `<dsp:sp modelId="${id}"><dsp:spPr><a:xfrm rot="0"><a:off x="${x}" y="582000"/><a:ext cx="${connector ? 300000 : 1575200}" cy="1260000"/></a:xfrm>${geom}${fill}<a:ln w="12700"><a:solidFill><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:solidFill></a:ln></dsp:spPr><dsp:style><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dsp:style>${!connector ? `<dsp:txBody><a:bodyPr anchor="ctr"/>${para(text)}${i === 0 && variant !== "hierarchy" ? para("访谈 12 家网点", 1) : ""}</dsp:txBody><dsp:txXfrm><a:off x="${x + 10000}" y="592000"/><a:ext cx="1500000" cy="1200000"/></dsp:txXfrm>` : ""}</dsp:sp>`;
}

/**
 * Data, layout, style, colour and (when cached) drawing parts of diagram `n`, plus its host rels.
 * @param {Record<string,string>} files @param {string[][]} hostRels @param {number} n
 * @param {{variant: string, options: {diagrams?:number,nodes?:number,text?:string,chain?:boolean}, family: string, numNodes: number, base: string, docx: boolean}} cfg
 */
function addDiagram(files, hostRels, n, cfg) {
  const { variant, options, family, numNodes, base, docx } = cfg;
  const names = (
    family === "hierarchy"
      ? ["分行", "营业部", "支行", "后台"]
      : ["调研", "方案", "落地", "访谈 12 家网点"]
  ).map((name) => (n === 2 ? `第二图 ${name}` : name));
  let points = point("doc", "", "doc", `loTypeId="urn:layout/${family}1" loCatId="${family}"`);
  points += Array.from({ length: numNodes }, (_, i) =>
    point(
      `n${i}`,
      options.text ?? names[i] ?? `节点 ${i + 1}`,
      family === "hierarchy" && i === 3 ? "asst" : "node",
    ),
  ).join("");
  points += Array.from({ length: 3 }, (_, i) =>
    point(`pres${i}`, "", "pres", `presAssocID="n${i}" presName="node"`),
  ).join("");
  points += point("trans3", "", "sibTrans") + point("trans4", "", "sibTrans");
  const connections =
    Array.from({ length: numNodes }, (_, i) =>
      options.chain
        ? cxn(i === 0 ? "doc" : `n${i - 1}`, `n${i}`, i)
        : family === "hierarchy"
          ? cxn(i === 0 ? "doc" : "n0", `n${i}`, i)
          : cxn(i === 3 ? "n0" : "doc", `n${i}`, i),
    ).join("") + (variant === "cycle-cxn" ? cxn("n3", "n0") : "");
  const cache = !["nocache", "docx"].includes(variant);
  const ext =
    cache && variant !== "rel-type-only"
      ? `<dgm:extLst><a:ext uri="drawing"><dsp:dataModelExt relId="draw${n}"/></a:ext></dgm:extLst>`
      : "";
  if (variant !== "missing-data-part")
    files[`${base}/diagrams/data${n}.xml`] =
      `<dgm:dataModel ${ns}><dgm:ptLst>${points}</dgm:ptLst><dgm:cxnLst>${connections}</dgm:cxnLst>${ext}</dgm:dataModel>`;
  files[`${base}/diagrams/layout${n}.xml`] =
    `<dgm:layoutDef ${ns} uniqueId="urn:layout/${family}1"><dgm:catLst><dgm:cat type="${family}"/></dgm:catLst></dgm:layoutDef>`;
  files[`${base}/diagrams/quickStyle${n}.xml`] =
    `<dgm:styleDef ${ns}><dgm:styleLbl name="node"><a:style><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef></a:style></dgm:styleLbl></dgm:styleDef>`;
  files[`${base}/diagrams/colors${n}.xml`] =
    `<dgm:colorsDef ${ns}><dgm:styleLbl name="node"><dgm:fillClrLst><a:schemeClr val="accent1"/></dgm:fillClrLst></dgm:styleLbl></dgm:colorsDef>`;
  if (cache)
    files[`${base}/diagrams/drawing${n}.xml`] =
      `<dsp:drawing ${ns}><dsp:spTree>${Array.from({ length: variant === "huge" ? 500 : 5 }, (_, i) => shape(i, names[i] ?? "", variant)).join("")}</dsp:spTree></dsp:drawing>`;
  /** @type {[string,string,string][]} */
  const relations = [
    ["dm", "diagramData", "data"],
    ["lo", "diagramLayout", "layout"],
    ["qs", "diagramQuickStyle", "quickStyle"],
    ["cs", "diagramColors", "colors"],
  ];
  if (cache) relations.push(["draw", "diagramDrawing", "drawing"]);
  for (const [id, type, file] of relations) {
    hostRels.push([`${id}${n}`, type, `${docx ? "" : "../"}diagrams/${file}${n}.xml`]);
  }
}

/** @param {string} [variant] @param {{diagrams?:number,nodes?:number,text?:string,chain?:boolean}} [options] */
export function smartartFixture(variant = "process", options = {}) {
  const docx = variant === "docx";
  const base = docx ? "word" : "ppt";
  const host = docx ? "word/document.xml" : "ppt/slides/slide1.xml";
  const family = ["hierarchy", "cycle", "list"].includes(variant) ? variant : "process";
  const count = options.diagrams ?? (variant === "two-diagrams" ? 2 : 1);
  const numNodes = options.nodes ?? (variant === "huge" ? 500 : 4);
  const theme = `<a:theme ${ns} name="合成主题"><a:themeElements><a:clrScheme name="测试"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="C00000"/></a:accent1></a:clrScheme><a:fmtScheme><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  /** @type {Record<string,string>} */ const files = {};
  const hostRels = [["theme", "theme", docx ? "theme/theme1.xml" : "../theme/theme1.xml"]];
  for (let n = 1; n <= count; n++) {
    addDiagram(files, hostRels, n, { variant, options, family, numNodes, base, docx });
  }
  files[`${base}/theme/theme1.xml`] = theme;
  const frames = Array.from({ length: count }, (_, i) => frame(i + 1)).join("");
  if (docx) {
    files[host] =
      `<w:document ${ns}><w:body><w:p><w:r><w:t>之前段落</w:t></w:r></w:p><w:p><w:r><w:drawing>${frames}</w:drawing></w:r></w:p><w:p><w:r><w:t>之后段落</w:t></w:r></w:p></w:body></w:document>`;
  } else {
    files[host] =
      `<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:txBody>${para("普通页面文字")}</p:txBody></p:sp>${frames}</p:spTree></p:cSld></p:sld>`;
    files["ppt/presentation.xml"] =
      `<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId r:id="master"/></p:sldMasterIdLst><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst><p:sldSz cx="8000000" cy="6000000"/></p:presentation>`;
    files["ppt/_rels/presentation.xml.rels"] = rels([
      ["slide", "slide", "slides/slide1.xml"],
      ["master", "slideMaster", "slideMasters/slideMaster1.xml"],
    ]);
    files["ppt/slideMasters/slideMaster1.xml"] =
      `<p:sldMaster ${ns}><p:cSld><p:spTree/></p:cSld></p:sldMaster>`;
    files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = rels([
      ["theme", "theme", "../theme/theme1.xml"],
    ]);
  }
  const slash = host.lastIndexOf("/");
  files[`${host.slice(0, slash)}/_rels/${host.slice(slash + 1)}.rels`] = rels(hostRels);
  files["[Content_Types].xml"] =
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${docx ? host : "ppt/presentation.xml"}" ContentType="application/vnd.openxmlformats-officedocument.${docx ? "wordprocessingml.document" : "presentationml.presentation"}.main+xml"/></Types>`;
  files["_rels/.rels"] = rels([["main", "officeDocument", docx ? host : "ppt/presentation.xml"]]);
  // Large repeated text is stored, not deflated: the archive-ratio gate must
  // still reject zip bombs independently of the SmartArt tree-text limit.
  return Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])), {
      level: options.text ? 0 : 6,
      mtime: new Date("2026-01-01T00:00:00Z"),
    }),
  );
}
