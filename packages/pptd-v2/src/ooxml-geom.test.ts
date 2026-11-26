import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ooxmlPresetNames, ooxmlShapePath, ooxmlShapeGeometry } from "./ooxml-geom.js";
import { SHAPE_CATALOG } from "./shape-catalog.js";
import { shapePath } from "./shape-path.js";

describe("OOXML preset geometry", () => {
  it("loads every official catalog shape", () => {
    const names = new Set(ooxmlPresetNames());
    assert.ok(names.size >= 177);
    for (const s of SHAPE_CATALOG) {
      assert.ok(names.has(s.name), s.name);
      const d = ooxmlShapePath(s.name, s.defaults);
      assert.ok(d && d.length > 4, s.name);
    }
  });

  it("roundRect adj changes path and uses arcs", () => {
    const a = shapePath("roundRect", [5000]);
    const b = shapePath("roundRect", [40000]);
    assert.notEqual(a, b);
    assert.match(a, /A /);
    assert.match(shapePath("ellipse"), /A /);
  });

  it("roundRect exposes a yellow-diamond handle on the top edge", () => {
    const g = ooxmlShapeGeometry("roundRect", [16667]);
    assert.ok(g);
    assert.equal(g.handles.length, 1);
    assert.equal(g.handles[0]!.kind, "xy");
    assert.equal(g.handles[0]!.adjIndexX, 0);
    assert.ok(g.handles[0]!.y < 5);
    assert.ok(g.handles[0]!.x > 5 && g.handles[0]!.x < 40);
  });

  it("callout splits fill body from stroke leader", () => {
    const g = ooxmlShapeGeometry("accentBorderCallout1");
    assert.ok(g);
    assert.match(g.fill, /Z/);
    assert.ok(g.stroke.length > 4);
    assert.ok(g.handles.length >= 2);
  });

  it("representative presets emit real OOXML outlines", () => {
    const names = ["rect", "roundRect", "ellipse", "triangle", "rightArrow", "accentBorderCallout1"];
    for (const name of names) {
      const g = ooxmlShapeGeometry(name);
      assert.ok(g && g.fill.length > 4, name);
      assert.match(g.fill, /^M /);
    }
    assert.match(ooxmlShapeGeometry("roundRect")!.fill, /A /);
    assert.match(ooxmlShapeGeometry("ellipse")!.fill, /A /);
    assert.match(ooxmlShapeGeometry("rect")!.fill, /Z/);
    assert.ok(ooxmlShapeGeometry("accentBorderCallout1")!.stroke.length > 4);
  });

  it("ahLst count matches XML including polar handles", () => {
    const xml = fs.readFileSync(new URL("../src/data/presetShapeDefinitions.xml", import.meta.url), "utf8");
    const countAh = (name: string) => {
      const block = xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`))?.[0] ?? "";
      return [...block.matchAll(/<(ahXY|ahPolar)\b/g)].length;
    };
    for (const name of ["roundRect", "triangle", "accentBorderCallout1", "circularArrow"]) {
      const g = ooxmlShapeGeometry(name);
      assert.ok(g, name);
      assert.equal(g.handles.length, countAh(name), name);
    }
    assert.ok(ooxmlShapeGeometry("circularArrow")!.handles.some((h) => h.kind === "polar"));
  });
});
