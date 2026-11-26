import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { test } from "node:test";
import { linePaintMarkup } from "../public/line-paint.js";
/** @import { RenderElement } from "@open-slidestudio/canvas-session" */

/** @template T @param {T | null | undefined} value @returns {T} */
function must(value) {
  assert.ok(value);
  return value;
}

/** @param {string} [id] @returns {RenderElement} */
const line = (id = "line") => ({
  id,
  type: "line",
  bounds: [10, 20, 320, 100],
  rotation: 0,
  opacity: 1,
  linePoints: "0,10 160,50 320,90",
  lineArrow: ["diamond", "arrow"],
  border: { width: 3, color: "#111", style: "solid" },
});

test("different native element identities cannot borrow each other's arrow marker", () => {
  const dom = new JSDOM("<main></main>");
  try {
    const host = must(dom.window.document.querySelector("main"));
    host.innerHTML = linePaintMarkup(line("a:b")) + linePaintMarkup(line("ab"));
    const markers = [...host.querySelectorAll("marker")].map((node) => node.id);
    assert.equal(new Set(markers).size, 4);
    for (const svg of host.querySelectorAll("svg")) {
      const path = must(svg.querySelector(":scope > path"));
      const end = must(path.getAttribute("marker-end")).slice(5, -1);
      assert.equal(svg.querySelectorAll(`[id="${end}"]`).length, 1);
    }
  } finally {
    dom.window.close();
  }
});

test("repeated paints of one element in canvas, rail and versions own distinct markers", () => {
  const dom = new JSDOM(linePaintMarkup(line()) + linePaintMarkup(line()));
  try {
    const ids = [...dom.window.document.querySelectorAll("marker")].map((node) => node.id);
    assert.equal(new Set(ids).size, 4);
  } finally {
    dom.window.close();
  }
});

test("native SVG commands preserve relative positions, curves, arcs and finite exponents", () => {
  const paths = [
    ["M0 10 L320 90", "M 0 10 L 320 90"],
    ["m0,10 320,80", "m 0 10 320 80"],
    ["M0 10 H320 V90 h-20 v-10 Z", "M 0 10 H 320 V 90 h -20 v -10 Z"],
    ["M0 10 C20 10 30 90 320 90", "M 0 10 C 20 10 30 90 320 90"],
    ["M0 10 Q20 10 320 90 T320 10", "M 0 10 Q 20 10 320 90 T 320 10"],
    ["M0 10 S30 90 320 90", "M 0 10 S 30 90 320 90"],
    ["M0 10 A20 30 0 0 1 320 90", "M 0 10 A 20 30 0 0 1 320 90"],
    ["M0 10 L3.2e2 9e1", "M 0 10 L 3.2e2 9e1"],
  ];
  for (const [input, expected] of paths) {
    const dom = new JSDOM(linePaintMarkup({ ...line(), linePoints: input }, { showHandles: true }));
    try {
      assert.equal(must(dom.window.document.querySelector("svg > path")).getAttribute("d"), expected);
      assert.equal(dom.window.document.querySelectorAll(".bez").length, 0);
    } finally {
      dom.window.close();
    }
  }
});

test("malformed SVG paths never become a fabricated horizontal rule or executable markup", () => {
  for (const linePoints of [
    "M0 10 L1",
    "M0 10 LNaN 90",
    "M0 10 L1e999 90",
    "M0 10 X320 90",
    "M0 10 A-20 30 0 0 1 320 90",
    "M0 10 A20 30 0 3 1 320 90",
    "M0 10 Z20",
    'M0 10 L320 90"><script>window.compromised=true</script>',
  ]) {
    assert.equal(linePaintMarkup({ ...line(), linePoints }), "");
  }
  assert.equal(linePaintMarkup({ ...line(), bounds: [0, 0, Infinity, 10] }), "");
});

test("editor point-pair curves keep original safe handle indices", () => {
  const dom = new JSDOM(
    linePaintMarkup(
      {
        ...line(),
        linePoints: "0,10 160,invalid 320,90",
      },
      { showHandles: true },
    ),
  );
  try {
    const handles = [...dom.window.document.querySelectorAll(".bez")];
    assert.deepEqual(
      handles.map((node) => node.getAttribute("data-i")),
      ["0", "2"],
    );
    assert.deepEqual(
      handles.map((node) => node.getAttribute("cy")),
      ["10", "90"],
    );
    assert.equal(must(dom.window.document.querySelector("svg > path")).getAttribute("d"), "M 0 10 L 320 90");
  } finally {
    dom.window.close();
  }
  assert.match(linePaintMarkup({ ...line(), lineCurve: "smooth" }), /d="M 0 10 Q 160 50 320 90"/);
  assert.match(
    linePaintMarkup({
      ...line(),
      lineCurve: "smooth",
      linePoints: "0,10 80,30 160,50 320,90",
    }),
    /d="M 0 10 C 80 30 160 50 320 90"/,
  );
});

test("an unstyled line paints at 2 px, the width the export writes as 19050 EMU (ruling 112)", () => {
  const dom = new JSDOM(linePaintMarkup({ ...line(), border: undefined }));
  try {
    assert.equal(must(dom.window.document.querySelector("svg > path")).getAttribute("stroke-width"), "2");
  } finally {
    dom.window.close();
  }
});

test("line labels and styles remain inert while explicit zero stroke stays zero", () => {
  const unsafe = '"><script>window.compromised=true</script>';
  const dom = new JSDOM(
    linePaintMarkup({
      ...line(),
      lineLabel: unsafe,
      border: { width: 0, style: "dash", color: unsafe },
    }),
  );
  try {
    const document = dom.window.document;
    assert.equal(document.querySelector("script"), null);
    assert.equal(must(document.querySelector(".line-label")).textContent, unsafe);
    assert.equal(must(document.querySelector("svg > path")).getAttribute("stroke-width"), "0");
    assert.equal(must(document.querySelector("svg > path")).getAttribute("stroke-dasharray"), "12 8");
  } finally {
    dom.window.close();
  }
});
