import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { capTemplateKit, TEMPLATE_KIT_MAX_BYTES } from "./parsers/pptx-kit.mjs";
import { runParseJob } from "./parse-worker.mjs";
import { generateSamples, readSample, SAMPLES_SKIP } from "./sample-fixtures.mjs";
import { kitPptx } from "./test-fixtures/kit-pptx.mjs";
import {
  parseDeck,
  kitOf,
  expandReference,
  BODY_TEXT,
  textLine,
  tableBlock,
  decoration,
} from "./test-fixtures/pptx-kit-test-kit.mjs";

/** @typedef {import("./test-fixtures/pptx-kit-test-kit.mjs").DeckDerivative} DeckDerivative */
/** @typedef {{color: string}} SolidFill fill of an expanded decoration */

/** @type {DeckDerivative} */
let derivative;
/**
 * @type {any}
 */
let kit;
before(async () => {
  if (SAMPLES_SKIP) return;
  const bytes = readSample(await generateSamples(), "tpl-fidelity.pptx");
  derivative = /** @type {DeckDerivative} */ (
    await runParseJob({
      materialId: "11111111-1111-1111-1111-111111111111-tpl-fidelity.pptx",
      name: "tpl-fidelity.pptx",
      bytes,
    })
  );
  kit = derivative["deck-template"].templateKit;
});

describe("VAL-KIT-003: privacy, pointer, receipt, cap and chip line", { skip: SAMPLES_SKIP }, () => {
  test("capTemplateKit leaves a small kit untouched and reports nothing", () => {
    const result = capTemplateKit(structuredClone(kit), TEMPLATE_KIT_MAX_BYTES);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.kit, kit);
  });
});

describe("M6-SCR-001: component ids stay unique across the archetypes of one group", () => {
  /** body-table (slides 2-4) and body-text (5-7) each carry their own shared decoration. */
  const twoBodyArchetypes = () =>
    kitPptx({
      slides: [
        { shapes: textLine(2, "封面") },
        ...[0, 1, 2].map(() => ({ shapes: tableBlock + decoration("AA0000") })),
        ...[0, 1, 2].map(() => ({ shapes: textLine(4, BODY_TEXT) + decoration("0000BB") })),
      ],
    });

  test("two body archetypes that each share a decoration get distinct component ids", async () => {
    const templateKit = kitOf(await parseDeck(twoBodyArchetypes()));
    assert.deepEqual(
      templateKit.archetypes.map((/** @type {{ kind: any; slides: any; }} */ entry) => [entry.kind, entry.slides]),
      [
        ["cover", [1]],
        ["body-table", [2, 3, 4]],
        ["body-text", [5, 6, 7]],
      ],
    );
    const ids = templateKit.components.map((/** @type {{ id: any; }} */ component) => component.id);
    assert.equal(new Set(ids).size, ids.length, ids.join(", "));
    const shared = templateKit.components.filter((/** @type {{ id: string; }} */ component) =>
      /^body\.deco-/.test(component.id),
    );
    assert.deepEqual(
      shared.map((/** @type {{ id: any; archetype: any; elements: { fill: { color: any; }; }[]; }} */ component) => [
        component.id,
        component.archetype,
        component.elements[0].fill.color,
      ]),
      [
        ["body.deco-1", "body-table", "#AA0000"],
        ["body.deco-2", "body-text", "#0000BB"],
      ],
    );
    const listed = (/** @type {string} */ kind) =>
      templateKit.archetypes.find((/** @type {{ kind: any; }} */ entry) => entry.kind === kind).components;
    assert.ok(listed("body-table").includes("body.deco-1"));
    assert.ok(!listed("body-table").includes("body.deco-2"));
    assert.ok(listed("body-text").includes("body.deco-2"));
    assert.ok(!listed("body-text").includes("body.deco-1"));
  });

  test("each reference expands its own decoration through the Host expansion path", async () => {
    const derivative = await parseDeck(twoBodyArchetypes());
    for (const [id, color] of [
      ["body.deco-1", "#AA0000"],
      ["body.deco-2", "#0000BB"],
    ]) {
      const expanded = expandReference(derivative, id);
      assert.equal(expanded.length, 1, id);
      assert.equal(/** @type {SolidFill} */ (expanded[0].fill).color, color, id);
    }
  });

  test("a decoration shared across archetypes becomes one component per archetype", async () => {
    const shared = decoration("00AA00");
    const derivative = await parseDeck(
      kitPptx({
        slides: [
          { shapes: textLine(2, "封面") },
          { shapes: tableBlock + shared },
          { shapes: tableBlock + shared },
          { shapes: textLine(4, BODY_TEXT) + shared },
        ],
      }),
    );
    const templateKit = kitOf(derivative);
    const ids = templateKit.components.map((/** @type {{ id: any; }} */ component) => component.id);
    assert.equal(new Set(ids).size, ids.length, ids.join(", "));
    const green = templateKit.components.filter((/** @type {{ elements: any[]; }} */ component) =>
      component.elements.some(
        (/** @type {{ fill: { color: string; }; }} */ element) => element.fill?.color === "#00AA00",
      ),
    );
    assert.deepEqual(
      green.map((/** @type {{ id: any; archetype: any; slides: any; }} */ component) => [
        component.id,
        component.archetype,
        component.slides,
      ]),
      [
        ["body.deco-1", "body-table", [2, 3]],
        ["body.deco-2", "body-text", [4]],
      ],
    );
    for (const component of green) {
      assert.deepEqual(
        expandReference(derivative, component.id).map((element) => /** @type {SolidFill} */ (element.fill).color),
        ["#00AA00"],
      );
    }
  });
});
