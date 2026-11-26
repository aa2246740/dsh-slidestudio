import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  type DeckLayout,
  type DeckMaster,
  type Fill,
  type Page,
  type PptdElement,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { layoutExportOf } from "./export-layouts.js";
import { assertWellFormedXml } from "./xml-lint.js";
import { exportProjectToPptx, validateExportReport } from "./export-pptd.js";

/*
 * M5b masters and layouts in the export (CAP-36). The committed layouts fixture covers the
 * deck-level structure (VAL-LAYOUT-009/010/011 and the exporter halves of VAL-TPL-017/018). The
 * small in-memory decks cover what the fixture does not reach: a layout image (VAL-RUN-019), the
 * static {pages} note, and one XPath structure on a page and on a layout. A deck without layouts
 * must still export exactly one slide layout.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const fixtureDir = path.join(repoRoot, "test-fixtures", "layouts-project");
export const logoPath = path.join(fixtureDir, "media", "logo-a.png");

export const GRADIENT_BACKGROUND: Fill = {
  type: "gradient",
  gradientType: "linear",
  angle: 135,
  stops: [
    { position: 0, color: "#1E3A8A" },
    { position: 1, color: "#0F766E" },
  ],
} as Fill;

export function lintXml(xml: string, label: string): void {
  assertWellFormedXml(xml, label);
}

export async function partText(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  assert.ok(file, `${name} is missing from the export`);
  return file.async("string");
}

export function partsMatching(zip: JSZip, pattern: RegExp): string[] {
  const number = (name: string) => Number(/(\d+)\.xml/.exec(name)?.[1] ?? 0);
  return Object.keys(zip.files)
    .filter((name) => pattern.test(name))
    .sort((a, b) => number(a) - number(b));
}

export function attribute(tag: string, name: string): string {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

export function relationships(xml: string): { id: string; type: string; target: string }[] {
  return [...xml.matchAll(/<Relationship\b[^>]*\/>/g)].map(([tag]) => ({
    id: attribute(tag, "Id"),
    type: attribute(tag, "Type"),
    target: attribute(tag, "Target"),
  }));
}

/** The part a relationship target names, resolved from the directory of the source part. */
export function resolveTarget(sourceDir: string, target: string): string {
  return path.posix.normalize(path.posix.join(sourceDir, target));
}

/** Every relationships part that targets this package part, by its own path. */
export async function referencesTo(zip: JSZip, part: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of Object.keys(zip.files).filter((item) => item.endsWith(".rels"))) {
    const sourceDir = path.posix.dirname(path.posix.dirname(name));
    for (const rel of relationships(await partText(zip, name))) {
      if (resolveTarget(sourceDir, rel.target) === part) found.push(name);
    }
  }
  return found;
}

export async function layoutOfSlide(zip: JSZip, slide: string): Promise<string> {
  const rels = relationships(
    await partText(zip, path.posix.join("ppt/slides/_rels", `${path.posix.basename(slide)}.rels`)),
  );
  const layout = rels.find((rel) => rel.type.endsWith("/slideLayout"));
  assert.ok(layout, `${slide} has a slideLayout relationship`);
  return resolveTarget("ppt/slides", layout.target);
}

export function cSldName(xml: string): string | undefined {
  return /<p:cSld name="([^"]*)"/.exec(xml)?.[1];
}

/** The `p:sp` or `p:pic` element whose cNvPr carries this name, as written. */
export function elementBlock(xml: string, name: string): string {
  const at = xml.indexOf(`name="${name}"`);
  assert.ok(at >= 0, `${name} is in the part`);
  const spStart = xml.lastIndexOf("<p:sp>", at);
  const picStart = xml.lastIndexOf("<p:pic>", at);
  const tag = picStart > spStart ? "pic" : "sp";
  const start = Math.max(spStart, picStart);
  const end = xml.indexOf(`</p:${tag}>`, at) + `</p:${tag}>`.length;
  return xml.slice(start, end);
}

/** The relationship id a named picture embeds. */
export function embedOf(xml: string, name: string): string {
  return /r:embed="([^"]+)"/.exec(elementBlock(xml, name))?.[1] ?? "";
}

export function backgroundBlock(xml: string): string {
  return /<p:bg>[\s\S]*?<\/p:bg>/.exec(xml)?.[0] ?? "";
}

/** The shape tree below the group properties, where every drawn element lives. */
export function spTreeOf(xml: string): string {
  const start = xml.indexOf("</p:grpSpPr>") + "</p:grpSpPr>".length;
  return xml.slice(start, xml.indexOf("</p:spTree>"));
}

/** A block with its ids and names removed, so two independently drawn copies can be compared. */
export function withoutIdentity(block: string): string {
  return block.replace(/ (id|name)="[^"]*"/g, "");
}

export function textElement(elementId: string, text: string): PptdElement {
  return {
    elementId,
    elementType: "text",
    bounds: [40, 500, 300, 24],
    content: { text, fontSize: 12, color: "#6B7280", align: ["left", "middle"] },
  } as PptdElement;
}

export function imageElement(elementId: string, src: string): PptdElement {
  return { elementId, elementType: "image", bounds: [24, 12, 120, 40], src } as PptdElement;
}

export function arcElement(elementId: string): PptdElement {
  return {
    elementId,
    elementType: "shape",
    shapeName: "custom",
    bounds: [640, 130, 280, 280],
    geometry: {
      viewBox: [100, 100],
      path: "M 0 100 C 0 45 22 0 50 0 C 78 0 100 45 100 100 L 84 100 C 84 56 70 16 50 16 C 30 16 16 56 16 100 Z",
    },
    fill: {
      type: "gradient",
      gradientType: "linear",
      angle: 90,
      stops: [
        { position: 0, color: "#F97316" },
        { position: 1, color: "#FDE68A", alpha: 0.85 },
      ],
    },
    shadow: { blur: 14, color: "#000000", offsetX: 6, offsetY: 8, opacity: 0.35 },
  } as PptdElement;
}

type DeckOptions = {
  pages: Page[];
  layouts?: DeckLayout[];
  masters?: DeckMaster[];
};

/** A saved project in a scratch directory, with the logo copied in as media/photo.png. */
export function deckOf(options: DeckOptions): PptdProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-layouts-"));
  const project = createEmptyProject(dir, { title: "版式导出" });
  fs.copyFileSync(logoPath, path.join(project.rootDir, "media", "photo.png"));
  if (options.masters) project.presentation.masters = options.masters;
  if (options.layouts) project.presentation.layouts = options.layouts;
  options.pages.forEach((page, index) => {
    listComposedPage(project, `pages/p${String(index + 1).padStart(2, "0")}.page`, page);
  });
  saveProject(project);
  return project;
}

export async function exportAndClean(project: PptdProject): Promise<JSZip> {
  try {
    const result = await exportProjectToPptx(project);
    return await JSZip.loadAsync(result.data);
  } finally {
    fs.rmSync(project.rootDir, { recursive: true, force: true });
  }
}

let fixtureExport: Promise<JSZip> | undefined;

/** The committed layouts fixture, exported once per test run from a scratch copy. */
export function fixtureZip(): Promise<JSZip> {
  fixtureExport ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-layouts-fixture-"));
    try {
      fs.cpSync(fixtureDir, dir, { recursive: true });
      const result = await exportProjectToPptx(dir);
      return await JSZip.loadAsync(result.data);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
  return fixtureExport;
}
