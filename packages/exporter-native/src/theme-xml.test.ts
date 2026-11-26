import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";
import { assertWellFormedXml } from "./xml-lint.js";

/** Uncompressed ppt/theme/theme1.xml from the exporter before scheme tokens existed. */
const DEFAULT_THEME_XML_SHA256 = "4c4d228fe0ed2577e90bcda2a7ebdd9c0227d8f84c9777419f2d6b8ccc137dd3";

const SCHEME_ORDER = [
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
] as const;

const T1_COLORS: Record<(typeof SCHEME_ORDER)[number], string> = {
  dk1: "#1A1A1A",
  lt1: "#FFFFFF",
  dk2: "#2B2B2B",
  lt2: "#F2F2F2",
  accent1: "#C8102E",
  accent2: "#002855",
  accent3: "#F2A900",
  accent4: "#5B6770",
  accent5: "#7A9A01",
  accent6: "#00A3AD",
  hlink: "#0563C1",
  folHlink: "#954F72",
};

async function themeXml(project: PptdProject): Promise<string> {
  const result = await exportProjectToPptx(project);
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(result.data);
  const xml = await zip.file("ppt/theme/theme1.xml")?.async("string");
  assert.ok(xml);
  return xml;
}

function cover(title: string): PptdProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "theme-xml-"));
  const project = createEmptyProject(dir, { title });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage(title));
  saveProject(project);
  return project;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

describe("theme1.xml scheme", () => {
  it("leaves the default theme XML byte-for-byte unchanged when no scheme tokens exist", async () => {
    const plain = await themeXml(cover("默认"));
    const recolored = cover("仅主色");
    recolored.presentation.theme = {
      ...recolored.presentation.theme,
      colors: { ...recolored.presentation.theme?.colors, primary: "#C8102E" },
    };
    const other = await themeXml(recolored);
    assert.equal(plain, other);
    assert.equal(sha256(plain), DEFAULT_THEME_XML_SHA256);
    assert.match(plain, /<a:accent1><a:srgbClr val="4472C4"\/><\/a:accent1>/);
    assert.match(plain, /<a:latin typeface="Calibri Light"/);
    assert.match(plain, /<a:dk1><a:sysClr val="windowText" lastClr="000000"\/><\/a:dk1>/);
  });

  it("writes clrScheme and mapped fontScheme from presentation theme tokens", async () => {
    const project = cover("品牌");
    project.pages[0]!.page.elements.push({
      elementId: "brand-mark",
      elementType: "text",
      bounds: [80, 80, 400, 60],
      content: { text: "品牌", fontSize: 28, color: "#C8102E" },
    });
    project.presentation.theme = {
      ...project.presentation.theme,
      colors: { ...project.presentation.theme?.colors, ...T1_COLORS },
      textStyles: {
        ...project.presentation.theme?.textStyles,
        schemeMajor: { fontFamily: { latin: "Arial", ea: "微软雅黑" } },
        schemeMinor: { fontFamily: { latin: "Georgia", ea: "宋体" } },
      },
    };
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/theme/theme1.xml")?.async("string");
    assert.ok(xml);
    const scheme = xml.match(/<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/)?.[1] ?? "";
    const names = [...scheme.matchAll(/<a:([A-Za-z0-9]+)>/g)].map((match) => match[1]);
    assert.deepEqual(names, [...SCHEME_ORDER]);
    for (const key of SCHEME_ORDER) {
      assert.match(xml, new RegExp(`<a:${key}><a:srgbClr val="${T1_COLORS[key].slice(1)}"\\/></a:${key}>`));
    }
    const major = xml.match(/<a:majorFont>([\s\S]*?)<\/a:majorFont>/)?.[1] ?? "";
    const minor = xml.match(/<a:minorFont>([\s\S]*?)<\/a:minorFont>/)?.[1] ?? "";
    assert.deepEqual(
      [...major.matchAll(/<a:(latin|ea|cs|font)\b/g)].slice(0, 3).map((match) => match[1]),
      ["latin", "ea", "cs"],
    );
    assert.deepEqual(
      [...minor.matchAll(/<a:(latin|ea|cs|font)\b/g)].slice(0, 3).map((match) => match[1]),
      ["latin", "ea", "cs"],
    );
    const majorFaces = major.slice(0, major.indexOf("<a:cs"));
    const minorFaces = minor.slice(0, minor.indexOf("<a:cs"));
    assert.match(majorFaces, /<a:latin typeface="Arial"/);
    assert.match(majorFaces, /<a:ea typeface="微软雅黑"/);
    assert.match(minorFaces, /<a:latin typeface="Georgia"/);
    assert.match(minorFaces, /<a:ea typeface="宋体"/);
    assert.doesNotMatch(majorFaces, /Montserrat|思源黑体|Calibri/);
    assert.doesNotMatch(minorFaces, /Calibri|等线|Montserrat/);
    const slide = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(slide);
    assert.match(slide, /<a:srgbClr val="C8102E"\/>/);
    assert.doesNotMatch(slide, /<a:schemeClr val="accent1"/);
    assertWellFormedXml(xml, "theme1.xml");
  });

  it("patches only the scheme slots that are present and ignores non-whitelist faces", async () => {
    const project = cover("部分");
    project.presentation.theme = {
      ...project.presentation.theme,
      colors: { ...project.presentation.theme?.colors, accent1: "#c8102e" },
      textStyles: {
        ...project.presentation.theme?.textStyles,
        schemeMajor: { fontFamily: { latin: "Montserrat", ea: "思源黑体" } },
      },
    };
    const xml = await themeXml(project);
    assert.match(xml, /<a:accent1><a:srgbClr val="C8102E"\/><\/a:accent1>/);
    assert.match(xml, /<a:accent2><a:srgbClr val="ED7D31"\/><\/a:accent2>/);
    assert.match(xml, /<a:dk1><a:sysClr val="windowText" lastClr="000000"\/><\/a:dk1>/);
    assert.match(xml, /<a:latin typeface="Calibri Light"/);
    assertWellFormedXml(xml, "theme1.xml");
  });

  it("writes accent slots seeded from an adopted image or PDF palette and keeps the other slots", async () => {
    const project = cover("图片配色");
    // An image or Freestyle PDF palette fills accent1..accentN only; dk1/lt1/hlink stay Office defaults.
    project.presentation.theme = {
      ...project.presentation.theme,
      colors: {
        ...project.presentation.theme?.colors,
        accent1: "#C00000",
        accent2: "#7A1F1F",
        accent3: "#1F4E9A",
      },
    };
    const xml = await themeXml(project);
    assert.match(xml, /<a:accent1><a:srgbClr val="C00000"\/><\/a:accent1>/);
    assert.match(xml, /<a:accent2><a:srgbClr val="7A1F1F"\/><\/a:accent2>/);
    assert.match(xml, /<a:accent3><a:srgbClr val="1F4E9A"\/><\/a:accent3>/);
    assert.match(xml, /<a:accent4><a:srgbClr val="FFC000"\/><\/a:accent4>/);
    assert.match(xml, /<a:dk1><a:sysClr val="windowText" lastClr="000000"\/><\/a:dk1>/);
    const scheme = xml.match(/<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/)?.[1] ?? "";
    assert.deepEqual(
      [...scheme.matchAll(/<a:([A-Za-z0-9]+)>/g)].map((match) => match[1]),
      [...SCHEME_ORDER],
    );
    assertWellFormedXml(xml, "theme1.xml");
  });
});
