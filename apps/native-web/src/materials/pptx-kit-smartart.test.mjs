/** VAL-SMART-006. Synthetic fixtures only: 未用真实文件验证. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, test, mock } from "node:test";
import { eachTest } from "./test-fixtures/each.mjs";
import { parseCustomPath } from "@open-slidestudio/pptd-v2";
import { AttachmentStore, attachmentPublic } from "../attachments.mjs";
import { ingestAttachment } from "./intake.mjs";
import { parseXml } from "./parsers/ooxml.mjs";
import { resolveColor } from "./parsers/pptx-colors.mjs";
import { capTemplateKit, TEMPLATE_KIT_MAX_BYTES, TEMPLATE_KIT_VERSION } from "./parsers/pptx-kit.mjs";
import { runParseJob } from "./parse-worker.mjs";
import { smartartFixture } from "./test-fixtures/smartart.mjs";

const near = (/** @type {number[]} */ actual, /** @type {number[]} */ expected, tolerance = 1e-4) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) <= tolerance, `${actual} vs ${expected}`),
  );
};

/**
 * Parsed sections such as "deck-template" are open JSON that the assertions
 * walk dynamically, so they are typed loosely on top of the derivative envelope.
 * @typedef {import("./derivative.mjs").Derivative & {[section: string]: any}} ParsedDerivative
 * @typedef {Record<string, any>} KitComponent open kit component JSON read by the assertions
 */

/** @param {Uint8Array} bytes @returns {Promise<ParsedDerivative>} */
async function derivativeOf(bytes) {
  return runParseJob({ materialId: "synthetic-smartart-kit", name: "smartart.pptx", bytes });
}

/** @param {string} variant @param {object} [options] */
const parse = (variant, options) => derivativeOf(smartartFixture(variant, options));

/**
 * @param {Record<string, (xml: string) => string>} replacements
 * @param {string | undefined} variant
 */
async function parseChanged(variant, replacements) {
  const entries = unzipSync(smartartFixture(variant));
  for (const [part, replace] of Object.entries(replacements)) {
    entries[part] = strToU8(replace(strFromU8(entries[part])));
  }
  return derivativeOf(Buffer.from(zipSync(entries, { level: 6 })));
}

/** @param {{[section: string]: any}} derivative @returns {KitComponent[]} */
const smartArtComponents = (derivative) =>
  derivative["deck-template"].templateKit.components.filter((/** @type {KitComponent} */ c) =>
    c.id.startsWith("smartart."),
  );
const byRole = (/** @type {KitComponent} */ component, /** @type {string} */ role) =>
  component.elements.filter((/** @type {{ smartArt: { role: any; }; }} */ e) => e.smartArt?.role === role);

describe("VAL-SMART-006: a cached process SmartArt becomes a smartart component", () => {
  test("3 node shapes, 3 empty text boxes and 2 connector shapes share one group", async () => {
    const derivative = await parse("process");
    const [component, ...rest] = smartArtComponents(derivative);
    assert.equal(rest.length, 0);
    assert.equal(component.id, "smartart.s1-1");
    assert.equal(component.role, "smartart");
    assert.equal(component.scopeHint, "page");
    assert.deepEqual(component.slides, [1]);
    assert.equal(component.elements.length, 8);
    assert.deepEqual(
      component.elements.map(
        (/** @type {{ elementType: any; smartArt: { role: any; }; }} */ e) => `${e.elementType}:${e.smartArt?.role}`,
      ),
      [
        "shape:node",
        "text:label",
        "shape:node",
        "text:label",
        "shape:node",
        "text:label",
        "shape:connector",
        "shape:connector",
      ],
    );
    assert.equal(new Set(component.elements.map((/** @type {{ groupId: any; }} */ e) => e.groupId)).size, 1);
    assert.ok(
      component.elements.every((/** @type {{ groupId: any; }} */ e) => typeof e.groupId === "string" && e.groupId),
    );
    assert.deepEqual(component.smartArt, {
      id: "s1-1",
      layout: "process",
      slots: 3,
      connectors: 2,
    });
    assert.equal(
      new Set(component.elements.map((/** @type {{ elementId: any; }} */ e) => e.elementId)).size,
      component.elements.length,
    );
  });

  test("node slots carry index, layout and pinned; labels and connectors keep their roles", async () => {
    const [component] = smartArtComponents(await parse("process"));
    const nodes = byRole(component, "node");
    assert.deepEqual(
      nodes.map((/** @type {{ smartArt: any; }} */ e) => e.smartArt),
      [0, 1, 2].map((index) => ({
        id: "s1-1",
        layout: "process",
        role: "node",
        index,
        pinned: true,
      })),
    );
    for (const element of nodes) {
      assert.equal(element.shapeName, "roundRect");
      assert.deepEqual(element.adjustments, [10000]);
    }
    assert.deepEqual(
      byRole(component, "label").map((/** @type {{ smartArt: { index: any; }; }} */ e) => e.smartArt.index),
      [0, 1, 2],
    );
    for (const element of byRole(component, "connector")) {
      assert.equal(element.elementType, "shape");
      assert.equal(element.shapeName, "rightArrow");
      assert.equal(element.smartArt.pinned, undefined);
    }
  });

  test("node boxes equal the M3 geometry and text boxes come from txXfrm", async () => {
    const derivative = await parse("process");
    const [component] = smartArtComponents(derivative);
    const nodes = byRole(component, "node");
    [
      [0.125, 0.347, 0.1969, 0.21],
      [0.3875, 0.347, 0.1969, 0.21],
      [0.65, 0.347, 0.1969, 0.21],
    ].forEach((expected, i) => near(nodes[i].bounds, expected));
    [
      [0.35, 0.347, 0.0375, 0.21],
      [0.6125, 0.347, 0.0375, 0.21],
    ].forEach((expected, i) => near(byRole(component, "connector")[i].bounds, expected));
    // The same boxes the M3 reader stored, not a second geometry computation.
    const stored = derivative["deck-template"].templateDetail.smartArts[0].shapes;
    nodes.forEach((/** @type {{ bounds: any; }} */ element, /** @type {string | number} */ i) =>
      near(element.bounds, stored[i].box),
    );
    // txXfrm off (10000, 592000) and ext (1500000, 1200000) inside the frame at (1000000, 1500000).
    near(byRole(component, "label")[0].bounds, [0.1263, 0.3487, 0.1875, 0.2]);
    near(byRole(component, "label")[1].bounds, [0.3888, 0.3487, 0.1875, 0.2]);
    near(component.box, [0.125, 0.347, 0.7219, 0.21]);
  });

  test("labels are empty text boxes that keep only the text style", async () => {
    const [component] = smartArtComponents(await parse("process"));
    for (const element of byRole(component, "label")) {
      assert.equal(element.elementType, "text");
      assert.equal(element.content.text, "");
      assert.equal(element.content.color, "#FFFFFF");
      assert.equal(element.content.bold, true);
      // 18 pt on an 8 000 000 EMU wide slide: 18 * 12700 * 960 / 8000000 = 27.432 px.
      assert.equal(element.content.fontSize, 27.4);
      assert.deepEqual(element.content.align, ["left", "middle"]);
    }
  });

  test("node fill is #C00000 and the connector fill is the tinted literal of the M3 test", async () => {
    const [component] = smartArtComponents(await parse("process"));
    for (const element of byRole(component, "node")) {
      assert.deepEqual(element.fill, { type: "solid", color: "#C00000" });
    }
    // Same literal as ooxml-diagram.test.mjs: tint 60000 keeps 60% of #C00000 and mixes 40% white,
    // round(192 * .6 + 255 * .4) = 217 = 0xD9 and round(0 * .6 + 255 * .4) = 102 = 0x66.
    for (const element of byRole(component, "connector")) {
      assert.deepEqual(element.fill, { type: "solid", color: "#D96666" });
    }
    // accent1 shade 50000 on the outline: round(192 * .5) = 96 = 0x60.
    for (const element of component.elements.filter(
      (/** @type {{ elementType: string; }} */ e) => e.elementType === "shape",
    )) {
      assert.equal(element.border.color, "#600000");
      // a:ln w=12700 EMU on 8 000 000 EMU is 12700 * 960 / 8000000 = 1.524 px of the page.
      assert.equal(element.border.width, 1.524);
    }
  });

  test("the connector colour comes from the shared modifier function, not a second formula", async () => {
    const [component] = smartArtComponents(await parse("process"));
    const root = parseXml(
      '<a:schemeClr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" val="accent1"><a:tint val="60000"/></a:schemeClr>',
      "synthetic-colour.xml",
    );
    const direct = resolveColor(root, { colors: { accent1: "#C00000" } });
    assert.equal(direct?.hex, "#D96666");
    assert.equal(byRole(component, "connector")[0].fill.color, direct?.hex);
  });

  eachTest(
    [
      ["style-ref-fill", "#C00000"],
      ["modelid-direct", "#C00000"],
      ["lummod", "#900000"],
    ],
    "%s keeps the theme-resolved node fill",
    async (variant, hex) => {
      const [component] = smartArtComponents(await parse(variant));
      assert.equal(byRole(component, "node")[0].fill.color, hex);
    },
  );

  test("the component is filed under its slide's archetype and counted in the receipt", async () => {
    const { templateKit: kit } = (await parse("process"))["deck-template"];
    const [component] = smartArtComponents({ "deck-template": { templateKit: kit } });
    const archetype = kit.archetypes.find((/** @type {{ kind: any; }} */ entry) => entry.kind === component.archetype);
    assert.deepEqual(archetype.components, [component.id]);
    assert.equal(
      Object.values(kit.receipt.counts).reduce((sum, n) => sum + n, 0),
      kit.components.length,
    );
    assert.deepEqual(kit.receipt.skipped, []);
  });
});

describe("hierarchy, cycle and other families", () => {
  test("a hierarchy keeps its custom root path as an M/L/C/Q/Z shape and is slotted", async () => {
    const [component] = smartArtComponents(await parse("hierarchy"));
    const root = byRole(component, "node")[0];
    assert.equal(root.shapeName, "custom");
    assert.deepEqual(root.geometry.viewBox, [100, 100]);
    assert.equal(root.geometry.path, "M 0 0 L 100 0 L 100 80 Q 50 100 0 80 Z");
    assert.ok("segments" in parseCustomPath(root.geometry.path));
    assert.equal(root.smartArt.layout, "hierarchy");
    assert.equal(root.smartArt.pinned, true);
    assert.equal(component.smartArt.layout, "hierarchy");
    assert.equal(component.smartArt.slots, 3);
    assert.equal(byRole(component, "label").length, 3);
  });

  test("a cycle is slotted like a process", async () => {
    const [component] = smartArtComponents(await parse("cycle"));
    assert.equal(component.smartArt.layout, "cycle");
    assert.equal(component.smartArt.slots, 3);
    assert.ok(
      byRole(component, "node").every(
        (/** @type {{ smartArt: { layout: string; }; }} */ e) => e.smartArt.layout === "cycle",
      ),
    );
  });

  test("another family only gets the shared group, with no slot metadata", async () => {
    const [component] = smartArtComponents(await parse("list"));
    assert.equal(component.smartArt.layout, "list");
    assert.equal(component.smartArt.slots, 0);
    assert.equal(component.elements.filter((/** @type {{ smartArt: any; }} */ e) => e.smartArt).length, 0);
    assert.equal(new Set(component.elements.map((/** @type {{ groupId: any; }} */ e) => e.groupId)).size, 1);
    assert.equal(
      component.elements.filter((/** @type {{ elementType: string; }} */ e) => e.elementType === "text").length,
      3,
    );
  });

  test("a shape that no longer matches a node leaves the component without slot metadata", async () => {
    const derivative = await parseChanged("process", {
      "ppt/diagrams/data1.xml": (xml) => xml.replace('presAssocID="n1"', 'presAssocID="absent"'),
      "ppt/diagrams/drawing1.xml": (xml) =>
        xml.replace('modelId="pres2"', 'modelId="unknown"').replace("<a:t>落地</a:t>", "<a:t>装饰</a:t>"),
    });
    const [component] = smartArtComponents(derivative);
    assert.equal(component.smartArt.slots, 0);
    assert.equal(component.elements.filter((/** @type {{ smartArt: any; }} */ e) => e.smartArt).length, 0);
    assert.equal(new Set(component.elements.map((/** @type {{ groupId: any; }} */ e) => e.groupId)).size, 1);
    assert.equal(
      component.elements.filter((/** @type {{ elementType: string; }} */ e) => e.elementType === "text").length,
      2,
      "only the two matched nodes keep a text box",
    );
  });

  test("two diagrams on one slide are separate components with their own groups", async () => {
    const components = smartArtComponents(await parse("two-diagrams"));
    assert.deepEqual(
      components.map((c) => c.id),
      ["smartart.s1-1", "smartart.s1-2"],
    );
    assert.notEqual(components[0].elements[0].groupId, components[1].elements[0].groupId);
  });
});

describe("degradation, skips and limits", () => {
  test("an unknown preset degrades to rect with a Chinese degradation note", async () => {
    const [component] = smartArtComponents(await parse("unknown-preset"));
    assert.equal(component.degradations.length, 1);
    const [note] = component.degradations;
    const element = component.elements.find((/** @type {{ elementId: any; }} */ e) => e.elementId === note.elementId);
    assert.equal(element.shapeName, "rect");
    assert.equal(element.adjustments, undefined);
    assert.equal(element.smartArt.role, "node");
    assert.equal(element.smartArt.index, 1);
    assert.match(note.reason, /形状「zzNoSuchShape」不在可用形状库中，已改用矩形/);
    const known = byRole(component, "node").filter((/** @type {any} */ e) => e !== element);
    assert.ok(known.every((/** @type {{ shapeName: string; }} */ e) => e.shapeName === "roundRect"));
  });

  test("a clean diagram carries no degradation list", async () => {
    const [component] = smartArtComponents(await parse("process"));
    assert.equal(component.degradations, undefined);
  });

  test("SmartArt without a drawing cache is skipped with a Chinese reason and no component", async () => {
    const derivative = await parse("nocache");
    const { templateKit: kit } = derivative["deck-template"];
    assert.equal(smartArtComponents(derivative).length, 0);
    assert.deepEqual(kit.receipt.skipped, [
      {
        slide: 1,
        smartArt: "s1-1",
        reason: "缺少预览图形，只能读取文字，无法照原样复用",
      },
    ]);
    // The text is still readable, and the one existing chip line is not doubled by the kit line.
    const summary = /** @type {{zh: string}} */ (derivative.summary);
    assert.match(summary.zh, /其中 1 个只能读取文字/);
    assert.doesNotMatch(summary.zh, /可复用装饰组件|无法读取，已跳过/);
  });

  test("a cached SmartArt with too many drawing shapes is skipped, not half copied", async () => {
    const derivative = await parse("huge");
    const { templateKit: kit } = derivative["deck-template"];
    assert.equal(smartArtComponents(derivative).length, 0);
    assert.equal(kit.receipt.skipped.length, 1);
    assert.match(kit.receipt.skipped[0].reason, /图形超过 120 个，无法照原样复用/);
  });

  test("a cache with no readable drawing shape is skipped with its own reason", async () => {
    const derivative = await parseChanged("process", {
      "ppt/diagrams/drawing1.xml": (xml) => xml.replace(/<dsp:sp [\s\S]*<\/dsp:sp>/, ""),
    });
    const { templateKit: kit } = derivative["deck-template"];
    assert.equal(smartArtComponents(derivative).length, 0);
    assert.match(kit.receipt.skipped[0].reason, /预览图形无法读取，只能读取文字，无法照原样复用/);
  });
});

describe("privacy, determinism and the kit cap", () => {
  test("the kit has no OOXML and none of the diagram's sample text", async () => {
    for (const variant of ["process", "hierarchy", "cycle", "nocache"]) {
      const text = JSON.stringify((await parse(variant))["deck-template"].templateKit, null, 2);
      assert.doesNotMatch(text, /<a:|<p:|<c:|<dgm:|<dsp:|p:sp/, variant);
      for (const sentinel of ["调研", "方案", "落地", "访谈 12 家网点", "分行", "营业部"]) {
        assert.equal(text.includes(sentinel), false, `${variant}: ${sentinel}`);
      }
    }
  });

  test("template-kit.json is byte-identical across runs and keeps the pointer hash", async () => {
    const first = await parse("process");
    const second = await parse("process");
    const bytes = (/** @type {ParsedDerivative} */ derivative) =>
      JSON.stringify(derivative["deck-template"].templateKit);
    assert.equal(bytes(first), bytes(second));
    assert.equal(first["deck-template"].kit.sha256, second["deck-template"].kit.sha256);
  });

  test("the kit cap can drop a SmartArt component and the receipt stays consistent", async () => {
    const { templateKit: kit } = (await parse("process"))["deck-template"];
    assert.equal(capTemplateKit(structuredClone(kit), TEMPLATE_KIT_MAX_BYTES).truncated, false);
    const cut = capTemplateKit(structuredClone(kit), 10);
    assert.equal(cut.truncated, true);
    assert.deepEqual(cut.kit.components, []);
    assert.deepEqual(cut.kit.receipt.truncated, { kept: 0, dropped: 1 });
    assert.equal(
      Object.values(cut.kit.receipt.counts).every((n) => n === 0),
      true,
    );
  });
});

describe("through the real intake", () => {
  test("the stored kit sidecar carries the component, stays private and a re-upload dedupes", async (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oss-smartart-kit-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const store = new AttachmentStore(path.join(temporary, "uploads"));
    const pool = {
      run: mock.fn(async ({ materialId, name, bytes }) => ({
        ok: true,
        derivative: await runParseJob({ materialId, name, bytes }),
      })),
    };
    const upload = () =>
      ingestAttachment(
        { store, pool },
        {
          name: "smartart.pptx",
          bytes: Buffer.from(smartartFixture("process")),
        },
      );
    const first = await upload();
    const sidecar = JSON.parse(fs.readFileSync(store.paths(first.record.meta.id).kit, "utf8"));
    assert.equal(sidecar.version, TEMPLATE_KIT_VERSION);
    assert.deepEqual(
      sidecar.components.map((/** @type {{ id: any; role: any; elements: string | any[]; }} */ c) => [
        c.id,
        c.role,
        c.elements.length,
      ]),
      [["smartart.s1-1", "smartart", 8]],
    );
    const stored = /** @type {{derivative: ParsedDerivative} | undefined} */ (store.read(first.record.meta.id));
    assert.deepEqual(stored?.derivative["deck-template"].templateKit, sidecar);
    assert.equal(JSON.stringify(attachmentPublic(first.record)).includes("smartart.s1-1"), false);
    const second = await upload();
    assert.equal(second.duplicateOf, first.record.meta.id);
    assert.equal(pool.run.mock.calls.length, 1, "the current kit record is reused");
  });
});
