import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { materialPartText } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { fixtureSha256, tempProject, writeMaterialFixture } from "./material-testkit.js";

test("the layouts part lists template rules and bars under their layout, with their boxes", (t) => {
  const root = tempProject("oss-layout-decorations-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeMaterialFixture(root, {
    id: "tpl",
    name: "模板.pptx",
    kind: "deck-template",
    parser: "pptx-ooxml-v2",
    originalBytes: Buffer.from("template-bytes"),
    derivative: {
      "deck-template": { slideSize: { cx: 12192000, cy: 6858000 }, masters: [], slides: [] },
    },
  });
  // Shaped like writeTemplateDesignSource output: decorations are boxes only, never text.
  const json = {
    logos: [],
    layouts: [
      {
        name: "正文版式",
        type: "blank",
        sourcePart: "ppt/slideLayouts/slideLayout2.xml",
        slideCount: 6,
        placeholders: [],
        decorations: [
          { kind: "line", box: { x: -0.0001, y: 0.1057, w: 1.001, h: 0 } },
          { kind: "shape", box: { x: 0, y: 0.9, w: 1, h: 0.005 } },
        ],
      },
      {
        name: "封面版式",
        type: "title",
        sourcePart: "ppt/slideLayouts/slideLayout1.xml",
        slideCount: 1,
        placeholders: [],
        decorations: [],
      },
    ],
  };
  const markdown = "【Layout Skeleton】\n";
  const jsonBytes = Buffer.from(`${JSON.stringify(json, null, 2)}\n`, "utf8");
  const dir = path.join(root, "_agent", "materials", "tpl");
  fs.writeFileSync(path.join(dir, "design-source.md"), markdown);
  fs.writeFileSync(path.join(dir, "design-source.json"), jsonBytes);
  const receiptFile = path.join(dir, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(
    receiptFile,
    `${JSON.stringify(
      {
        ...receipt,
        designSourceMdSha256: fixtureSha256(markdown),
        designSourceJsonSha256: fixtureSha256(jsonBytes),
      },
      null,
      2,
    )}\n`,
  );

  const text = materialPartText(verifyMaterial(root, "tpl"), "layouts");
  assert.match(
    text,
    /- 正文版式（blank）\n {2}- 装饰线（line）：左 -0\.01%、上 10\.57%、宽 100\.1%、高 0%\n {2}- 装饰形状（shape）：左 0%、上 90%、宽 100%、高 0\.5%/,
  );
  assert.match(text, /- 封面版式（title）\n(?! {2}- 装饰)/);
});
