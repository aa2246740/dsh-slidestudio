/**
 * Unit geometry/normalization table for template-smartart-texts (VAL-SMART-007): the plan gate
 * against the drawable slot count (ruling166), and the process re-layout — arithmetic-progression
 * centres, connectors at facing-edge midpoints, labels keeping their per-node offset, cloned ids
 * unique, groupId stripped (DECISIONS #47). End-to-end behaviour is in the host suite.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExpandedElement } from "./template-component-expand.js";
import type { KitComponent } from "./template-kit.js";
import { applySmartArtTexts, planSmartArtTexts } from "./template-smartart-texts.js";

type Bounds = [number, number, number, number];

const GROUP = "smartart-s1-1";

function component(layout: string, slots: number, extra: Record<string, unknown> = {}): KitComponent {
  return {
    id: "smartart.s1-1",
    archetype: "body",
    role: "smartart",
    scopeHint: "page",
    slides: [1],
    box: [0, 0, 1, 1],
    elements: [],
    smartArt: { id: "s1-1", layout, slots, connectors: Math.max(0, slots - 1) },
    ...extra,
  };
}

/** A horizontal 3-node process: node centres (150,240) (350,240) (550,240), arrows in 100px gaps. */
function horizontalProcess(): ExpandedElement[] {
  const node = (index: number, x: number): ExpandedElement => ({
    elementId: `tpl-smartart-s1-1-e${index * 2 + 1}`,
    elementType: "shape",
    shapeName: "roundRect",
    bounds: [x, 200, 100, 80],
    fill: { type: "solid", color: "#C00000" },
    layoutRole: "decoration",
    groupId: GROUP,
    smartArt: { id: "s1-1", layout: "process", role: "node", index, pinned: true },
  });
  const label = (index: number, x: number): ExpandedElement => ({
    elementId: `tpl-smartart-s1-1-e${index * 2 + 2}`,
    elementType: "text",
    bounds: [x + 5, 210, 90, 40],
    content: { text: "", fontSize: 24, bold: true, color: "#FFFFFF", align: ["center", "middle"] },
    layoutRole: "decoration",
    groupId: GROUP,
    smartArt: { id: "s1-1", layout: "process", role: "label", index },
  });
  const connector = (n: number, x: number): ExpandedElement => ({
    elementId: `tpl-smartart-s1-1-e${n}`,
    elementType: "shape",
    shapeName: "rightArrow",
    bounds: [x, 234, 30, 12],
    fill: { type: "solid", color: "#992525" },
    layoutRole: "decoration",
    groupId: GROUP,
    smartArt: { id: "s1-1", layout: "process", role: "connector" },
  });
  return [
    node(0, 100),
    label(0, 100),
    node(1, 300),
    label(1, 300),
    node(2, 500),
    label(2, 500),
    connector(7, 235),
    connector(8, 435),
  ];
}

const role = (elements: readonly ExpandedElement[], name: string): ExpandedElement[] =>
  elements
    .filter((element) => (element.smartArt as { role?: string })?.role === name)
    .sort(
      (a, b) => ((a.smartArt as { index?: number })?.index ?? 0) - ((b.smartArt as { index?: number })?.index ?? 0),
    );
const centre = (element: ExpandedElement): [number, number] => {
  const [x, y, w, h] = element.bounds as Bounds;
  return [x + w / 2, y + h / 2];
};
const closeTo = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= 0.51, `${label}: ${actual} vs ${expected}`);

describe("planSmartArtTexts", () => {
  it("fills a same-count process and re-lays out a resized one", () => {
    const process = component("process", 3);
    assert.deepEqual(planSmartArtTexts(process, ["甲", "乙", "丙"]), {
      ok: true,
      plan: { kind: "fill", texts: [["甲"], ["乙"], ["丙"]] },
    });
    assert.deepEqual(planSmartArtTexts(process, ["甲", ["乙", "明细"], "丙", "丁"]), {
      ok: true,
      plan: { kind: "relayout", texts: [["甲"], ["乙", "明细"], ["丙"], ["丁"]] },
    });
    const grown = planSmartArtTexts(process, ["甲", "乙"]);
    assert.ok(grown.ok && grown.plan.kind === "relayout", "fewer entries shrink the process");
  });

  it("refuses count mismatches on fixed-count kinds with the drawable slot count", () => {
    const cycle = planSmartArtTexts(component("cycle", 3), ["甲", "乙"]);
    assert.ok(!cycle.ok);
    assert.match(cycle.detail, /组件 smartart\.s1-1 有 3 个节点，texts 需要 3 项（流程类组件可以增减节点）/);
    const hierarchy = planSmartArtTexts(component("hierarchy", 4), ["甲", "乙", "丙", "丁", "戊"]);
    assert.ok(!hierarchy.ok);
    assert.match(hierarchy.detail, /有 4 个节点，texts 需要 4 项/);
  });

  it("refuses unslotted components and malformed entries in Chinese", () => {
    const unslotted = component("process", 0);
    const verdict = planSmartArtTexts(unslotted, ["甲"]);
    assert.ok(!verdict.ok);
    assert.match(verdict.detail, /对应不齐，不能用 texts 改写/);
    const single = planSmartArtTexts(component("process", 1), ["甲", "乙"]);
    assert.ok(!single.ok && /对应不齐/.test(single.detail), "a one-slot process cannot re-lay out");
    for (const bad of [[], "甲", ["甲", 7], ["甲", []], [["甲", 2]]]) {
      const refused = planSmartArtTexts(component("process", 3), bad);
      assert.ok(!refused.ok, JSON.stringify(bad));
      assert.match(refused.detail, /texts/);
    }
  });
});

describe("applySmartArtTexts", () => {
  it("fill: texts land on labels in order, geometry untouched, groupId stripped", () => {
    const input = horizontalProcess();
    const used = new Set(input.map((element) => element.elementId));
    const verdict = planSmartArtTexts(component("process", 3), [["调研", "访谈 12 家网点"], "方案", "落地"]);
    assert.ok(verdict.ok);
    const out = applySmartArtTexts(input, component("process", 3), verdict.plan, used);
    assert.equal(out.length, 8);
    assert.deepEqual(
      out.map((element) => element.bounds),
      input.map((element) => element.bounds),
      "fill keeps every bounds",
    );
    assert.ok(
      out.every((element) => element.groupId === undefined),
      "no groupId survives",
    );
    assert.ok(
      input.every((element) => element.groupId === GROUP),
      "the input expansion is not mutated",
    );
    const labels = role(out, "label");
    assert.deepEqual(
      labels.map((label) => (label.content as { text: string }).text),
      ['<p>调研</p>\n<p data-lvl="1">• 访谈 12 家网点</p>', "<p>方案</p>", "<p>落地</p>"],
    );
    assert.equal(role(out, "connector").length, 2, "same-count fill keeps the connectors");
  });

  it("relayout 3→4: arithmetic-progression centres, arrows at gap midpoints, labels follow", () => {
    const input = horizontalProcess();
    const used = new Set(input.map((element) => element.elementId));
    const verdict = planSmartArtTexts(component("process", 3), ["调研", "方案", "落地", "复盘"]);
    assert.ok(verdict.ok && verdict.plan.kind === "relayout");
    const out = applySmartArtTexts(input, component("process", 3), verdict.plan, used);
    assert.equal(out.length, 11, "4 nodes + 4 labels + 3 arrows");
    assert.equal(new Set(out.map((element) => element.elementId)).size, 11, "ids unique");

    const nodes = role(out, "node");
    const scale = 2 / 3;
    const centres = nodes.map(centre);
    // Centres 150 → 550 in three equal steps on the original axis; nodes shrink by 2/3.
    [150, 150 + 400 / 3, 150 + 800 / 3, 550].forEach((expected, k) => {
      closeTo(centres[k]![0], expected, `node ${k} centre x`);
      closeTo(centres[k]![1], 240, `node ${k} centre y`);
      assert.deepEqual((nodes[k]!.smartArt as { index: number }).index, k);
      assert.equal((nodes[k]!.smartArt as { pinned: boolean }).pinned, true);
    });
    for (const node of nodes) {
      const [, , w, h] = node.bounds as Bounds;
      closeTo(w, 100 * scale, "node width");
      closeTo(h, 80 * scale, "node height");
    }
    for (let k = 0; k < 3; k += 1) {
      const [x, , w] = nodes[k]!.bounds as Bounds;
      const [nextX] = nodes[k + 1]!.bounds as Bounds;
      assert.ok(x + w < nextX, `nodes ${k}/${k + 1} do not overlap`);
    }
    const connectors = role(out, "connector");
    assert.equal(connectors.length, 3);
    connectors.forEach((connector, k) => {
      const [x, , w] = nodes[k]!.bounds as Bounds;
      const [nextX] = nodes[k + 1]!.bounds as Bounds;
      closeTo(centre(connector)[0], (x + w + nextX) / 2, `arrow ${k} gap midpoint`);
      closeTo(centre(connector)[1], 240, `arrow ${k} on the axis`);
    });
    const labels = role(out, "label");
    labels.forEach((label, k) => {
      // The template label sat 10px above its node's centre; the offset scales with the nodes.
      closeTo(centre(label)[0], centres[k]![0], `label ${k} centre x`);
      closeTo(centre(label)[1], centres[k]![1] - 10 * scale, `label ${k} offset`);
      assert.equal((label.content as { fontSize: number }).fontSize, 24 * scale);
      assert.equal((label.content as { bold: boolean }).bold, true, "label style preserved");
    });
    assert.deepEqual(
      labels.map((label) => (label.content as { text: string }).text),
      ["<p>调研</p>", "<p>方案</p>", "<p>落地</p>", "<p>复盘</p>"],
    );
    // Cloned elements carry fresh ids that join the used set.
    const clones = out.filter((element) => /-x\d+$/.test(element.elementId));
    assert.equal(clones.length, 3, "one new node, one new label, one new arrow");
    for (const clone of clones) assert.ok(used.has(clone.elementId));
  });

  it("relayout 3→2 keeps the node size and centres one arrow in the wide gap", () => {
    const input = horizontalProcess();
    const used = new Set(input.map((element) => element.elementId));
    const verdict = planSmartArtTexts(component("process", 3), ["调研", "复盘"]);
    assert.ok(verdict.ok && verdict.plan.kind === "relayout");
    const out = applySmartArtTexts(input, component("process", 3), verdict.plan, used);
    const nodes = role(out, "node");
    assert.equal(nodes.length, 2);
    closeTo(centre(nodes[0]!)[0], 150, "first node keeps the first centre");
    closeTo(centre(nodes[1]!)[0], 550, "last node keeps the last centre");
    for (const node of nodes) {
      const [, , w, h] = node.bounds as Bounds;
      assert.deepEqual([w, h], [100, 80], "shrinking the count never grows the nodes");
    }
    const connectors = role(out, "connector");
    assert.equal(connectors.length, 1);
    closeTo(centre(connectors[0]!)[0], 350, "the one arrow sits in the middle of the gap");
    closeTo(centre(connectors[0]!)[1], 240, "the arrow stays on the axis");
  });

  it("relayout on a vertical axis spaces the nodes top to bottom", () => {
    const vertical = horizontalProcess().map((element) => {
      const meta = element.smartArt as { role?: string; index?: number };
      const [x, y] = element.bounds as Bounds;
      // Rotate the fixture: nodes stacked at centres (250, 140/290/440), arrows horizontal gaps.
      if (meta.role === "node") return { ...element, bounds: [200, 100 + (meta.index ?? 0) * 150, 100, 80] };
      if (meta.role === "label") return { ...element, bounds: [205, 110 + (meta.index ?? 0) * 150, 90, 40] };
      return { ...element, bounds: [235, 190 + (y === 234 ? (x === 235 ? 0 : 150) : 0), 30, 12] };
    });
    const used = new Set(vertical.map((element) => element.elementId));
    const verdict = planSmartArtTexts(component("process", 3), ["上", "下"]);
    assert.ok(verdict.ok);
    const out = applySmartArtTexts(vertical, component("process", 3), verdict.plan, used);
    const nodes = role(out, "node");
    assert.deepEqual(
      nodes.map((node) => centre(node).map((value) => Number(value.toFixed(2)))),
      [
        [250, 140],
        [250, 440],
      ],
    );
    const connectors = role(out, "connector");
    assert.equal(connectors.length, 1);
    assert.deepEqual(
      centre(connectors[0]!).map((value) => Number(value.toFixed(2))),
      [250, 290],
      "the arrow is centred between the facing horizontal edges",
    );
  });
});
