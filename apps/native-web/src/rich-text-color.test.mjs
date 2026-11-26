import assert from "node:assert/strict";
import { test } from "node:test";
import { toRgbHex } from "@open-slidestudio/pptd-v2";
import { CSS_NAMED_COLOR_HEX, cssColorToHex } from "../public/rich-text-color.js";

/** CSS colour strings a browser can hand to the editor, with the #RRGGBB they must become. */
const PARSEABLE = [
  ["red", "#FF0000"],
  ["RED", "#FF0000"],
  [" rebeccapurple ", "#663399"],
  ["grey", "#808080"],
  ["rgb(255, 0, 0)", "#FF0000"],
  ["rgb(100%, 0%, 0%)", "#FF0000"],
  ["rgb(50%, 50%, 50%)", "#808080"],
  ["rgb(12.4, 99.6, 0)", "#0C6400"],
  ["rgb(300, -5, 0)", "#FF0000"],
  ["rgba(0,0,255,.5)", "#0000FF"],
  ["rgba(0, 0, 255, 0.5)", "#0000FF"],
  ["rgb(0 0 255 / 50%)", "#0000FF"],
  ["rgb(0 0 255 / 0.5)", "#0000FF"],
  ["#f00", "#FF0000"],
  ["#F00", "#FF0000"],
  ["#f008", "#FF0000"],
  ["#ff0000", "#FF0000"],
  ["#FF000080", "#FF0000"],
  ["#00ff0080", "#00FF00"],
];

/** Values with no sRGB reading in the supported forms. The text keeps its inherited colour. */
const UNPARSEABLE = [
  "",
  "   ",
  "transparent",
  "currentcolor",
  "inherit",
  "var(--accent)",
  "oklch(0.6 0.2 30)",
  "lab(50 40 30)",
  "color(srgb 1 0 0)",
  "#12",
  "#12345",
  "#zzzzzz",
  "rgb(1,2)",
  "rgb(1,2,3,4,5)",
  "rgb(a,b,c)",
  "rgb(1,2,3,x)",
  "rgb(1 2 3 / 0.5 / 0.5)",
  "notacolour",
];

test("CSS colour forms normalize to uppercase #RRGGBB with alpha dropped", () => {
  for (const [input, hex] of PARSEABLE) {
    assert.equal(cssColorToHex(input), hex, input);
  }
});

test("colour strings with no supported sRGB reading normalize to the empty string", () => {
  for (const input of UNPARSEABLE) {
    assert.equal(cssColorToHex(input), "", JSON.stringify(input));
  }
});

test("every normalized colour is accepted by the strict PPTD colour parser", () => {
  for (const [input] of PARSEABLE) {
    const hex = cssColorToHex(input);
    assert.equal(toRgbHex(hex), hex, input);
  }
});

test("the named colour table holds the 148 CSS named colours", () => {
  assert.equal(Object.keys(CSS_NAMED_COLOR_HEX).length, 148);
  assert.equal(CSS_NAMED_COLOR_HEX.rebeccapurple, "#663399");
  assert.equal(CSS_NAMED_COLOR_HEX.gray, CSS_NAMED_COLOR_HEX.grey);
});
