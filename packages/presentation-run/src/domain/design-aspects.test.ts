import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DESIGN_ASPECTS, designAspectRefusal, type DesignAspect } from "./design-aspects.js";
import type { MaterialKind } from "./material-pack.js";

function source(kind: MaterialKind, parser: string, name: string) {
  return { kind, parser, name };
}

describe("design aspect source policy", () => {
  it("allows every declared aspect for a PPTX template", () => {
    assert.equal(
      designAspectRefusal(source("deck-template", "pptx-ooxml-v2", "brand.pptx"), DESIGN_ASPECTS),
      undefined,
    );
  });

  it("allows only palette for images and names an unsupported aspect in Chinese", () => {
    const image = source("image", "image-sharp-v1", "x.png");
    assert.equal(designAspectRefusal(image, ["palette"]), undefined);
    assert.equal(designAspectRefusal(image, ["layouts"]), "图片「x.png」只能作为配色来源（palette），不能用于 layouts");
  });

  it("allows PDF palette only in Freestyle, plus content and data", () => {
    const pdf = source("document", "pdf-unpdf-v3", "report.pdf");
    const aspects: readonly DesignAspect[] = ["palette", "content", "data"];
    assert.equal(designAspectRefusal(pdf, aspects), undefined);
    assert.match(designAspectRefusal(pdf, ["palette"], true) ?? "", /designAuthority/);
    assert.match(designAspectRefusal(pdf, ["fonts"]) ?? "", /report\.pdf.*字体（fonts）/);
  });

  it("keeps document, table, and text materials non-visual", () => {
    const docx = source("document", "docx-ooxml-v2", "report.docx");
    const table = source("table", "xlsx-ooxml-v1", "metrics.xlsx");
    const text = source("text", "txt-utf8-v1", "notes.txt");
    assert.equal(designAspectRefusal(docx, ["content", "data"]), undefined);
    assert.match(designAspectRefusal(docx, ["fonts"]) ?? "", /report\.docx.*字体（fonts）/);
    assert.equal(designAspectRefusal(table, ["data"]), undefined);
    assert.match(designAspectRefusal(table, ["photos"]) ?? "", /metrics\.xlsx.*照片（photos）/);
    assert.equal(designAspectRefusal(text, ["content", "data"]), undefined);
    assert.match(designAspectRefusal(text, ["palette"]) ?? "", /notes\.txt.*配色（palette）/);
  });
});
