import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCustomPath } from "./custom-geometry.js";
import { ooxmlCustomGeometry, type OoxmlCustomGeometry } from "./ooxml-custom-geom.js";

const cd2 = "10800000";
const ok = (extent: { w: number; h: number }, geometry: OoxmlCustomGeometry) => {
  const out = ooxmlCustomGeometry(extent, geometry);
  assert.ok("path" in out, "issue" in out ? out.issue : "");
  return out;
};
const numbers = (path: string) => (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe("ooxmlCustomGeometry", () => {
  it("evaluates gdLst formulas in order in the path coordinate space", () => {
    const out = ok(
      { w: 4000, h: 2000 },
      {
        avLst: [{ name: "adj", fmla: "val 25000" }],
        gdLst: [
          { name: "x1", fmla: "*/ w adj 100000" },
          { name: "x2", fmla: "+- r 0 x1" },
          { name: "yc", fmla: "?: x1 vc h" },
          { name: "m", fmla: "max x1 x2" },
        ],
        paths: [
          {
            w: 1000,
            h: 500,
            cmds: [
              { k: "M", x: "x1", y: "t" },
              { k: "L", x: "x2", y: "t" },
              { k: "L", x: "r", y: "yc" },
              { k: "L", x: "m", y: "b" },
              { k: "Z" },
            ],
          },
        ],
      },
    );
    // Guides use the 1000×500 path space: w=1000, x1=250, x2=750, yc=vc=250, m=750.
    assert.deepEqual(out.viewBox, [1000, 500]);
    assert.deepEqual(numbers(out.path), [250, 0, 750, 0, 1000, 250, 750, 500]);
    assert.ok(out.path.endsWith("Z"));
  });

  it("converts arcTo to cubics whose endpoints match the analytic arc", () => {
    const out = ok(
      { w: 100, h: 50 },
      {
        paths: [
          {
            w: 100,
            h: 50,
            cmds: [
              { k: "M", x: "0", y: "50" },
              { k: "A", wr: "50", hr: "50", st: cd2, sw: cd2 },
            ],
          },
        ],
      },
    );
    assert.doesNotMatch(out.path, /A/);
    const segments = out.path.split(/(?=[A-Z])/).map((s) => numbers(s));
    assert.equal(segments.length, 3);
    // Half circle about (50,50): quarter ends at the top (50,0), then (100,50).
    assert.ok(Math.abs(segments[1]![4]! - 50) < 1e-3 && Math.abs(segments[1]![5]! - 0) < 1e-3);
    assert.ok(Math.abs(segments[2]![4]! - 100) < 1e-3 && Math.abs(segments[2]![5]! - 50) < 1e-3);
  });

  it("treats arcTo angles as visual angles on an ellipse and honours negative sweeps", () => {
    const wr = 60;
    const hr = 30;
    const st = (45 * Math.PI) / 180;
    const sw = (90 * Math.PI) / 180;
    const parametric = (a: number) => Math.atan2(wr * Math.sin(a), hr * Math.cos(a));
    const [t0, t1] = [parametric(st), parametric(st + sw)];
    const start = { x: 200, y: 100 };
    const centre = { x: start.x - wr * Math.cos(t0), y: start.y - hr * Math.sin(t0) };
    const end = { x: centre.x + wr * Math.cos(t1), y: centre.y + hr * Math.sin(t1) };
    const forward = ok(
      { w: 400, h: 200 },
      {
        paths: [
          {
            w: 400,
            h: 200,
            cmds: [
              { k: "M", x: "200", y: "100" },
              { k: "A", wr: "60", hr: "30", st: "2700000", sw: "5400000" },
            ],
          },
        ],
      },
    );
    const last = numbers(forward.path.split(/(?=[A-Z])/).at(-1)!);
    assert.ok(Math.abs(last[4]! - end.x) < 1e-3 && Math.abs(last[5]! - end.y) < 1e-3);
    // Sweeping back by the same angle returns to the start point.
    const back = ok(
      { w: 400, h: 200 },
      {
        paths: [
          {
            w: 400,
            h: 200,
            cmds: [
              { k: "M", x: String(end.x), y: String(end.y) },
              { k: "A", wr: "60", hr: "30", st: "8100000", sw: "-5400000" },
            ],
          },
        ],
      },
    );
    const returned = numbers(back.path.split(/(?=[A-Z])/).at(-1)!);
    assert.ok(Math.abs(returned[4]! - start.x) < 1e-2 && Math.abs(returned[5]! - start.y) < 1e-2);
  });

  it("scales later paths into the first path's space and skips fill:none strokes", () => {
    const out = ok(
      { w: 100, h: 100 },
      {
        paths: [
          {
            w: 100,
            h: 100,
            fill: "none",
            cmds: [
              { k: "M", x: "0", y: "0" },
              { k: "L", x: "100", y: "100" },
            ],
          },
          {
            w: 200,
            h: 200,
            cmds: [{ k: "M", x: "0", y: "0" }, { k: "L", x: "200", y: "100" }, { k: "Z" }],
          },
        ],
      },
    );
    assert.deepEqual(out.viewBox, [200, 200]);
    assert.deepEqual(numbers(out.path), [0, 0, 200, 100]);
  });

  it("only emits paths that the PPTD custom-shape parser accepts", () => {
    const out = ok(
      { w: 3000, h: 1000 },
      {
        gdLst: [{ name: "q", fmla: "*/ w 1 3" }],
        paths: [
          {
            w: 3000,
            h: 1000,
            cmds: [
              { k: "M", x: "0", y: "0" },
              { k: "C", x1: "q", y1: "0", x2: "q", y2: "h", x: "r", y: "b" },
              { k: "Q", x1: "hc", y1: "vc", x: "0", y: "b" },
              { k: "Z" },
            ],
          },
        ],
      },
    );
    const parsed = parseCustomPath(out.path);
    assert.ok("segments" in parsed, JSON.stringify(parsed));
    assert.deepEqual(
      parsed.segments.map((s) => s.command),
      ["M", "C", "Q", "Z"],
    );
  });

  it("accepts the hundreds of scaling guides a converted vector shape carries, up to a cap", () => {
    const guides = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ name: `g${i}`, fmla: `*/ w ${i + 1} 100000` }));
    const paths = [
      {
        w: 1000,
        h: 1000,
        cmds: [{ k: "M", x: "0", y: "0" } as const, { k: "L", x: "g99", y: "g749" } as const],
      },
    ];
    const out = ok({ w: 1000, h: 1000 }, { gdLst: guides(752), paths });
    assert.deepEqual(numbers(out.path), [0, 0, 1, 7.5]);
    const refused = ooxmlCustomGeometry({ w: 1000, h: 1000 }, { gdLst: guides(4097), paths });
    assert.ok("issue" in refused && /公式过多/.test(refused.issue));
  });

  it("refuses unresolved guides, unknown operators and empty paths with a Chinese issue", () => {
    const base = {
      w: 100,
      h: 100,
      cmds: [{ k: "M", x: "0", y: "0" } as const, { k: "L", x: "10", y: "10" } as const],
    };
    const bad: OoxmlCustomGeometry[] = [
      { gdLst: [{ name: "a", fmla: "*/ nope 1 2" }], paths: [base] },
      { gdLst: [{ name: "a", fmla: "bogus 1 2" }], paths: [base] },
      { gdLst: [{ name: "a", fmla: "*/ w constructor 2" }], paths: [base] },
      { paths: [{ ...base, cmds: [{ k: "M", x: "abc", y: "0" }] }] },
      { paths: [{ ...base, cmds: [{ k: "L", x: "1", y: "1" }] }] },
      { paths: [] },
    ];
    for (const geometry of bad) {
      const out = ooxmlCustomGeometry({ w: 100, h: 100 }, geometry);
      assert.ok("issue" in out && /[\u4e00-\u9fff]/.test(out.issue), JSON.stringify(geometry));
    }
  });
});
