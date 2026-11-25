import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type PptdElement,
} from "@open-slidestudio/pptd-v2";
import { fillCss } from "./fill-css.js";
import { openSession, renderModel, selectElement, setSelectedShadow } from "./index.js";

const ALLOW = ["element.shadow.set"];
const CJK = /[\u4e00-\u9fff]/;

function coverProject(dir: string, elements: PptdElement[]) {
  const project = createEmptyProject(dir, { title: "阴影与渐变" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("阴影与渐变"));
  project.pages[0]!.page.elements = elements;
  saveProject(project);
  return project;
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-effects-"));
}

const rect = (elementId: string, extra: Partial<PptdElement> = {}): PptdElement =>
  ({
    elementId,
    elementType: "shape",
    shapeName: "rect",
    bounds: [60, 80, 300, 150],
    fill: { type: "solid", color: "#2563EB" },
    ...extra,
  }) as PptdElement;

describe("gradient stop alpha in the editor", () => {
  it("paints a stop with alpha as rgba and keeps an opaque stop as hex", () => {
    const css = fillCss(
      {
        type: "gradient",
        gradientType: "linear",
        angle: 90,
        stops: [
          { position: 0, color: "#FFF4F4", alpha: 0.5 },
          { position: 1, color: "#C00000" },
        ],
      } as never,
      undefined,
    );
    assert.equal(css, "linear-gradient(180deg, rgba(255, 244, 244, 0.5) 0%, #C00000 100%)");
  });

  it("multiplies a stop alpha with the alpha of an 8-digit colour", () => {
    const css = fillCss(
      {
        type: "gradient",
        gradientType: "linear",
        angle: 90,
        stops: [
          { position: 0, color: "#FFF4F480", alpha: 0.5 },
          { position: 1, color: "#C00000" },
        ],
      } as never,
      undefined,
    );
    assert.equal(css, "linear-gradient(180deg, rgba(255, 244, 244, 0.251) 0%, #C00000 100%)");
  });

  it("keeps the pre-M5 gradient paint when no stop has an alpha", () => {
    const css = fillCss(
      {
        type: "gradient",
        gradientType: "linear",
        angle: 90,
        stops: [
          { position: 0, color: "#FFF4F4" },
          { position: 1, color: "#C00000" },
        ],
      } as never,
      undefined,
    );
    assert.equal(css, "linear-gradient(180deg, #FFF4F4 0%, #C00000 100%)");
  });
});

describe("element shadows in the render model", () => {
  it("folds opacity into one rgba colour with the blur and offsets", () => {
    const dir = tmp();
    coverProject(dir, [
      rect("shadowed", {
        shadow: { blur: 8, color: "#000000", offsetX: 3, offsetY: 3, opacity: 0.35 },
      }),
    ]);
    const session = openSession(dir);
    const element = renderModel(session).elements.find((item) => item.id === "shadowed")!;
    assert.deepEqual(element.shadow, {
      blur: 8,
      offsetX: 3,
      offsetY: 3,
      color: "rgba(0, 0, 0, 0.35)",
    });
  });

  it("uses the editor defaults only for fields that are absent", () => {
    const dir = tmp();
    coverProject(dir, [
      rect("defaults", { shadow: { blur: 6 } }),
      rect("zero-offset", { shadow: { blur: 6, color: "#101010", offsetX: 0, offsetY: 0 } }),
    ]);
    const session = openSession(dir);
    const model = renderModel(session).elements;
    assert.deepEqual(model.find((item) => item.id === "defaults")!.shadow, {
      blur: 6,
      offsetX: 0,
      offsetY: 4,
      color: "rgba(0, 0, 0, 0.25)",
    });
    assert.deepEqual(model.find((item) => item.id === "zero-offset")!.shadow, {
      blur: 6,
      offsetX: 0,
      offsetY: 0,
      color: "#101010",
    });
  });

  it("refuses a negative blur or an opacity above 1 in Chinese and keeps the old shadow", () => {
    const dir = tmp();
    coverProject(dir, [rect("target", { shadow: { blur: 4, color: "#000000" } })]);
    const session = openSession(dir, { allowedControlIds: ALLOW });
    selectElement(session, "target");
    assert.throws(
      () => setSelectedShadow(session, "element.shadow.set", { blur: -1 }),
      (error: unknown) => error instanceof Error && error.message.includes("blur") && CJK.test(error.message),
    );
    assert.throws(
      () =>
        setSelectedShadow(session, "element.shadow.set", {
          blur: 4,
          color: "#000000",
          opacity: 1.5,
        }),
      (error: unknown) => error instanceof Error && error.message.includes("opacity") && CJK.test(error.message),
    );
    const kept = renderModel(session).elements.find((item) => item.id === "target")!;
    assert.equal(kept.shadow?.blur, 4);
  });
});
