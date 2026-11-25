import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type ChartElement,
  type Fill,
  type PptdElement,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";

/*
 * M5-SCR-001 in the export. A full-page custom triangle must not change the page background,
 * and it must not choose the ink of a chart that sits on the page. The visible surface is the
 * white page the triangle leaves open.
 */
const triangle: PptdElement = {
  elementId: "triangle",
  elementType: "shape",
  shapeName: "custom",
  bounds: [0, 0, 960, 540],
  geometry: { viewBox: [960, 540], path: "M 0 0 L 960 0 L 0 540 Z" },
  fill: { type: "solid", color: "#FF0000" },
};

const bar = {
  elementId: "bar",
  elementType: "chart",
  bounds: [40, 40, 420, 200],
  data: {
    cols: ["类别", "甲"],
    rows: [
      ["一月", 30],
      ["二月", 40],
    ],
  },
  series: [{ type: "bar", name: "甲", encode: { x: "类别", y: "甲" } }],
} as unknown as ChartElement;

function deck(elements: PptdElement[]): PptdProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-page-backdrop-"));
  const project = createEmptyProject(dir, { title: "页面底色" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("页面底色"));
  project.pages[0]!.page.elements = elements;
  saveProject(project);
  return project;
}

async function slideXml(elements: PptdElement[]): Promise<string> {
  const result = await exportProjectToPptx(deck(elements));
  const zip = await JSZip.loadAsync(result.data);
  const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
  assert.ok(xml);
  return xml;
}

/** Every colour the exported chart part writes, in document order (its ink and grid). */
async function chartColours(elements: PptdElement[], project = deck(elements)): Promise<string[]> {
  const result = await exportProjectToPptx(project);
  const zip = await JSZip.loadAsync(result.data);
  const parts = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  assert.equal(parts.length, 1);
  const xml = await zip.file(parts[0]!)!.async("string");
  return [...xml.matchAll(/srgbClr val="([0-9A-Fa-f]{6})"/g)].map((match) => match[1]!.toUpperCase());
}

const pageBackground = (xml: string) => xml.match(/<p:bg>[\s\S]*?<\/p:bg>/)?.[0];

describe("export page surface ignores a full-page custom triangle (M5-SCR-001)", () => {
  it("writes the same white page background with or without the triangle, and keeps the triangle", async () => {
    const plain = await slideXml([]);
    const withTriangle = await slideXml([triangle]);

    assert.ok(pageBackground(plain), "the page background is exported");
    assert.match(pageBackground(withTriangle) ?? "", /FFFFFF/);
    assert.equal(pageBackground(withTriangle), pageBackground(plain));
    assert.equal((withTriangle.match(/<a:custGeom>/g) ?? []).length, 1);
  });

  it("gives a chart on the page the ink of the visible white page, not of the triangle", async () => {
    const plain = await chartColours([bar]);
    const underTriangle = await chartColours([triangle, bar]);

    assert.ok(plain.length > 0, "the chart writes colours");
    assert.deepEqual(underTriangle, plain);
  });
});

/*
 * A chart takes its ink from the plain panel it sits on, as the editor does (the shared chart
 * surface rule in pptd-v2). The panels here cover the chart only, so a full-page backdrop cannot
 * answer for them.
 */
const PANEL_BOUNDS: [number, number, number, number] = [20, 20, 460, 240];

function panel(id: string, color: string, overrides: Record<string, unknown> = {}): PptdElement {
  return {
    elementId: id,
    elementType: "shape",
    shapeName: "rect",
    bounds: PANEL_BOUNDS,
    fill: { type: "solid", color },
    ...overrides,
  } as unknown as PptdElement;
}

describe("export chart ink follows the plain panel under the chart (M5-SCR-002)", () => {
  it("writes the light ink of a dark plain panel under the chart, as the editor paints it", async () => {
    const colours = await chartColours([panel("dark-panel", "#111111"), bar]);
    assert.ok(colours.includes("CBD5E1"), `dark-surface ink: ${colours}`);
    assert.ok(colours.includes("475569"), `dark-surface grid: ${colours}`);
    assert.ok(!colours.includes("626976"), `no dark ink on the dark panel: ${colours}`);
  });

  it("reads a mid-grey panel as dark, with the same YIQ rule the editor uses", async () => {
    const colours = await chartColours([panel("grey-panel", "#888888"), bar]);
    assert.ok(colours.includes("CBD5E1"), `dark-surface ink on #888888: ${colours}`);
  });

  it("reads a dark one-stop gradient panel as its solid colour, as the editor and the file paint it", async () => {
    const oneStop = panel("one-stop-panel", "#111111", {
      fill: {
        type: "gradient",
        gradientType: "linear",
        angle: 0,
        stops: [{ position: 0, color: "#111111" }],
      },
    });
    const colours = await chartColours([oneStop, bar]);
    assert.ok(colours.includes("CBD5E1"), `dark-surface ink from a one-stop gradient: ${colours}`);
    assert.ok(!colours.includes("626976"), `no dark ink on the dark panel: ${colours}`);
  });

  it("keeps the dark ink of a chart on the white page", async () => {
    const colours = await chartColours([bar]);
    assert.ok(colours.includes("626976"), `light-surface ink: ${colours}`);
    assert.ok(colours.includes("E5E7EB"), `light-surface grid: ${colours}`);
    assert.ok(!colours.includes("CBD5E1"), `no light ink on the white page: ${colours}`);
  });

  it("ignores a dark panel painted above the chart", async () => {
    const colours = await chartColours([bar, panel("dark-panel", "#111111")]);
    assert.ok(colours.includes("626976"), `panel above does not set the ink: ${colours}`);
  });

  it("ignores hidden, translucent, gradient and custom panels under the chart", async () => {
    const excluded: PptdElement[] = [
      panel("hidden-panel", "#111111", { hidden: true }),
      panel("translucent-panel", "#11111180"),
      panel("gradient-panel", "#111111", {
        fill: {
          type: "gradient",
          angle: 0,
          stops: [
            { position: 0, color: "#111111" },
            { position: 1, color: "#FFFFFF" },
          ],
        },
      }),
      panel("custom-panel", "#111111", {
        shapeName: "custom",
        geometry: { viewBox: [460, 240], path: "M 0 0 L 460 0 L 0 240 Z" },
      }),
    ];
    for (const element of excluded) {
      const colours = await chartColours([element, bar]);
      assert.ok(colours.includes("626976"), `${element.elementId} does not set the ink: ${colours}`);
    }
  });

  it("lets the chart's own dark background win over a light panel under it", async () => {
    const onDark = { ...bar, background: { type: "solid", color: "#111111" } } as ChartElement;
    const colours = await chartColours([panel("light-panel", "#FFFFFF"), onDark]);
    assert.ok(colours.includes("CBD5E1"), `the chart background sets the ink: ${colours}`);
  });
});

/*
 * Ruling 131: the page surface is one rule for the editor and the export (pptd-v2 `pageSurface`).
 * A picture page background is the #111111 placeholder surface, so a chart on it takes the light
 * ink the editor paints. A picture backdrop is no surface, so the white page keeps the dark ink.
 */
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PHOTO_SRC = "media/photo.png";

/**
 * A deck with the photo in `media/`. Its cover page takes the given background, or keeps the white
 * template background when none is given.
 */
function photoDeck(elements: PptdElement[], background?: Fill): PptdProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-page-surface-picture-"));
  const project = createEmptyProject(dir, { title: "图片底色" });
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, PHOTO_SRC), PHOTO);
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图片底色"));
  project.pages[0]!.page.elements = elements;
  if (background) project.pages[0]!.page.background = background;
  saveProject(project);
  return project;
}

describe("export page surface reads a picture page background as the placeholder surface", () => {
  it("gives a chart on a picture page background the light ink of the dark surface", async () => {
    const project = photoDeck([bar], { type: "image", src: PHOTO_SRC });
    const colours = await chartColours([bar], project);
    assert.ok(colours.includes("CBD5E1"), `light ink on the picture surface: ${colours}`);
    assert.ok(!colours.includes("626976"), `no dark ink on the picture surface: ${colours}`);
  });

  it("guard: a picture backdrop is no surface, so a white page keeps the dark ink", async () => {
    const photoBackdrop = {
      elementId: "photo-backdrop",
      elementType: "shape",
      shapeName: "rect",
      bounds: [0, 0, 960, 540],
      fill: { type: "image", src: PHOTO_SRC },
    } as unknown as PptdElement;
    const colours = await chartColours([photoBackdrop, bar], photoDeck([photoBackdrop, bar]));
    assert.ok(colours.includes("626976"), `dark ink on the white page: ${colours}`);
    assert.ok(!colours.includes("CBD5E1"), `no light ink from a picture backdrop: ${colours}`);
  });
});
