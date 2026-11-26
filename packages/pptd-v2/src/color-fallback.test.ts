import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readableColor, sanitizeDeckColors } from "./color-fallback.js";
import { parseRichText, resolveTextStyle } from "./theme.js";
import type { Page, PptdElement, Theme } from "./types.js";

/*
 * Stored colours that cannot resolve become the colour the element would inherit without that
 * value (or the documented default). The stored input is never mutated, and an element with
 * only valid colours comes back as the same object.
 */

const THEME: Theme = {
  colors: { a: "$b", b: "$a", ok: "#112233", primary: "#2563EB" },
  textStyles: {
    body: { color: "$accent9", fontSize: 14 },
    ok: { color: "#445566" },
  },
};

const CLEAN_THEME: Theme = {
  colors: { ok: "#112233", primary: "#2563EB" },
  textStyles: { ok: { color: "#445566" } },
};

function page(elements: PptdElement[], background?: Page["background"]): Page {
  return { elements, ...(background ? { background } : {}) };
}

describe("sanitizeDeckColors", () => {
  it("returns the same page and theme objects when every colour resolves", () => {
    const input = page([
      {
        elementId: "ok",
        elementType: "text",
        bounds: [0, 0, 10, 10],
        content: { text: "好", color: "#112233", backgroundColor: "$ok" },
      },
    ] as PptdElement[]);
    const result = sanitizeDeckColors([input], CLEAN_THEME);
    assert.equal(result.pages[0], input);
    assert.equal(result.theme, CLEAN_THEME);
    assert.deepEqual(result.fallbacks, []);
  });

  it("drops an unresolvable text colour and highlight, one fallback per element", () => {
    const input = page([
      {
        elementId: "t",
        elementType: "text",
        bounds: [0, 0, 10, 10],
        content: { text: "标题", color: "$accent9", backgroundColor: "$a" },
      },
    ] as PptdElement[]);
    const result = sanitizeDeckColors([input], THEME);
    const content = (result.pages[0]!.elements[0] as { content: Record<string, unknown> }).content;
    assert.equal(content.color, undefined);
    assert.equal(content.backgroundColor, undefined);
    assert.deepEqual(result.fallbacks, [{ pageIndex: 0, elementId: "t" }]);
    const original = (input.elements[0] as { content: Record<string, unknown> }).content;
    assert.equal(original.color, "$accent9", "stored input is not mutated");
  });

  it("rewrites unresolvable run colours and keeps the valid runs", () => {
    const input = page([
      {
        elementId: "runs",
        elementType: "text",
        bounds: [0, 0, 10, 10],
        content: {
          text: '<p><span style="color:red">红</span><span style="color:#AABBCC">绿</span>字</p>',
        },
      },
    ] as PptdElement[]);
    const result = sanitizeDeckColors([input], THEME);
    const text = (result.pages[0]!.elements[0] as { content: { text: string } }).content.text;
    const runs = parseRichText(text);
    assert.deepEqual(
      runs.map((run) => [run.text, run.color ?? null]),
      [
        ["红", null],
        ["绿", "#AABBCC"],
        ["字", null],
      ],
    );
    assert.deepEqual(result.fallbacks, [{ pageIndex: 0, elementId: "runs" }]);
  });

  it("takes the colour the text inherits: the first run, then black", () => {
    const input = page([
      {
        elementId: "lead",
        elementType: "text",
        bounds: [0, 0, 10, 10],
        content: { text: '<p><span style="color:#FF0000">红</span>字</p>', color: "$accent9" },
      },
      {
        elementId: "plain",
        elementType: "text",
        bounds: [0, 0, 10, 10],
        content: { text: "字", color: "$accent9" },
      },
    ] as PptdElement[]);
    const result = sanitizeDeckColors([input], THEME);
    const inherited = result.pages[0]!.elements.map(
      (element) =>
        resolveTextStyle((element as { content: Parameters<typeof resolveTextStyle>[0] }).content, result.theme)
          .colorHex,
    );
    assert.deepEqual(inherited, ["#FF0000", "#000000"]);
    assert.deepEqual(result.fallbacks, [
      { pageIndex: 0, elementId: "lead" },
      { pageIndex: 0, elementId: "plain" },
    ]);
  });

  it("inherits a bad theme text style colour and records each element that uses it", () => {
    const input = page([
      {
        elementId: "inherits",
        elementType: "text",
        bounds: [0, 0, 10, 10],
        content: { text: "甲", style: "$body" },
      },
      {
        elementId: "own",
        elementType: "text",
        bounds: [0, 0, 10, 10],
        content: { text: "乙", style: "body", color: "#112233" },
      },
    ] as PptdElement[]);
    const result = sanitizeDeckColors([input], THEME);
    assert.equal(result.theme?.textStyles?.body?.color, undefined);
    assert.equal(result.theme?.textStyles?.body?.fontSize, 14);
    assert.equal(result.theme?.textStyles?.ok?.color, "#445566");
    assert.deepEqual(result.fallbacks, [{ pageIndex: 0, elementId: "inherits" }]);
  });

  it("removes an unresolvable solid fill and filters unresolvable gradient stops", () => {
    const input = page([
      {
        elementId: "solid",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 10, 10],
        fill: { type: "solid", color: "$a" },
      },
      {
        elementId: "gradient",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 10, 10],
        fill: {
          type: "gradient",
          angle: 0,
          stops: [
            { position: 0, color: "$a" },
            { position: 1, color: "#112233" },
          ],
        },
      },
      {
        elementId: "emptyGradient",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 10, 10],
        fill: { type: "gradient", angle: 0, stops: [{ position: 0, color: "0E0807" }] },
      },
    ] as PptdElement[]);
    const elements = sanitizeDeckColors([input], THEME).pages[0]!.elements as Array<{
      fill?: unknown;
    }>;
    assert.equal(elements[0]!.fill, undefined);
    assert.deepEqual(elements[1]!.fill, { type: "solid", color: "#112233" });
    // A six-digit stop without `#` is a colour now: the gradient keeps its one stop, as `#0E0807`.
    assert.deepEqual(elements[2]!.fill, {
      type: "gradient",
      angle: 0,
      stops: [{ position: 0, color: "#0E0807" }],
    });
  });

  it("paints a gradient left with one valid stop as that stop's solid fill, and drops one with none", () => {
    const gradient = (stops: { position: number; color: string }[]) => ({
      type: "gradient",
      gradientType: "linear",
      angle: 0,
      stops,
    });
    const input = page([
      {
        elementId: "one",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 10, 10],
        fill: gradient([
          { position: 0, color: "$a" },
          { position: 1, color: "#112233" },
        ]),
      },
      {
        elementId: "none",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 10, 10],
        fill: gradient([
          { position: 0, color: "$a" },
          { position: 1, color: "$b" },
        ]),
      },
    ] as PptdElement[]);
    const result = sanitizeDeckColors([input], THEME);
    const [one, none] = result.pages[0]!.elements as Array<{ fill?: unknown }>;
    assert.deepEqual(one!.fill, { type: "solid", color: "#112233" });
    assert.equal(none!.fill, undefined);
    assert.deepEqual(result.fallbacks, [
      { pageIndex: 0, elementId: "one" },
      { pageIndex: 0, elementId: "none" },
    ]);
    const stored = input.elements[0] as { fill?: { type?: string; stops?: unknown[] } };
    assert.equal(stored.fill?.type, "gradient", "stored input keeps its gradient");
    assert.equal(stored.fill?.stops?.length, 2, "stored input keeps both stops");
  });

  it("gives a shape or line border with an unresolvable colour the unstyled line colour", () => {
    const input = page([
      {
        elementId: "box",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 10, 10],
        border: { width: 3, color: "$accent9" },
      },
      {
        elementId: "rule",
        elementType: "line",
        bounds: [0, 0, 10, 10],
        viewBox: [10, 10],
        points: "0,0 10,10",
        border: { width: 2, color: "$a" },
      },
    ] as PptdElement[]);
    const elements = sanitizeDeckColors([input], THEME).pages[0]!.elements as Array<{
      border?: { width?: number; color?: string };
    }>;
    assert.deepEqual(elements[0]!.border, { width: 3, color: "#2563EB" });
    assert.deepEqual(elements[1]!.border, { width: 2, color: "#2563EB" });
  });

  it("reads a six-digit unprefixed hex as #RRGGBB, with no fallback, and keeps the stored value", () => {
    const input = page([
      {
        elementId: "bare",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 10, 10],
        fill: { type: "solid", color: "0E0807" },
      },
      {
        elementId: "lower",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 10, 10],
        fill: { type: "solid", color: "e8ded7" },
      },
    ] as PptdElement[]);
    const result = sanitizeDeckColors([input], THEME);
    const [bare, lower] = result.pages[0]!.elements as Array<{ fill?: unknown }>;
    assert.deepEqual(bare!.fill, { type: "solid", color: "#0E0807" });
    assert.deepEqual(lower!.fill, { type: "solid", color: "#E8DED7" });
    assert.deepEqual(result.fallbacks, []);
    const stored = input.elements[0] as { fill?: { color?: string } };
    assert.equal(stored.fill?.color, "0E0807", "stored input keeps the unprefixed value");
  });

  it("reads a six-digit unprefixed hex in every colour slot and in the theme, with no fallback", () => {
    const theme: Theme = {
      colors: { accent: "0e0807" },
      textStyles: { body: { color: "E8DED7", fontSize: 14 } },
    };
    const input = page(
      [
        {
          elementId: "label",
          elementType: "text",
          bounds: [0, 0, 10, 10],
          content: { text: "标题", color: "$accent", backgroundColor: "0E0807" },
        },
        {
          elementId: "runs",
          elementType: "text",
          bounds: [0, 0, 10, 10],
          content: { text: '<p><span style="color:AABBCC">红</span>字</p>', style: "body" },
        },
        {
          elementId: "box",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 10, 10],
          fill: {
            type: "gradient",
            gradientType: "linear",
            angle: 0,
            stops: [
              { position: 0, color: "0E0807" },
              { position: 1, color: "e8ded7" },
            ],
          },
          border: { width: 2, color: "123ABC" },
          shadow: { blur: 4, color: "0E0807" },
        },
        {
          elementId: "grid",
          elementType: "table",
          bounds: [0, 0, 10, 10],
          columnWidths: [5],
          rows: [[{ text: "甲", color: "E8DED7", fill: { type: "solid", color: "0E0807" } }]],
        },
        {
          elementId: "bars",
          elementType: "chart",
          bounds: [0, 0, 10, 10],
          data: { cols: ["项", "甲"], rows: [["a", 1]] },
          series: [{ type: "bar", name: "甲", fill: "123ABC" }],
          colors: ["0E0807"],
          background: { type: "solid", color: "E8DED7" },
        },
        {
          elementId: "badge",
          elementType: "icon",
          iconName: "star",
          bounds: [0, 0, 10, 10],
          fill: { type: "solid", color: "0E0807" },
        },
      ] as PptdElement[],
      { type: "solid", color: "0E0807" },
    );
    const result = sanitizeDeckColors([input], theme);
    const byId = (id: string) =>
      result.pages[0]!.elements.find((el) => el.elementId === id) as unknown as Record<string, unknown>;
    const label = byId("label").content as Record<string, unknown>;
    assert.equal(label.color, "$accent", "a token stays a token");
    assert.equal(label.backgroundColor, "#0E0807");
    assert.equal(
      resolveTextStyle(label as Parameters<typeof resolveTextStyle>[0], result.theme).colorHex,
      "#0E0807",
      "the token resolves to the colour its palette entry spells",
    );
    const runs = (byId("runs").content as { text: string }).text;
    assert.equal(parseRichText(runs)[0]!.color, "#AABBCC");
    const box = byId("box") as {
      fill: { stops: Array<{ color: string }> };
      border: { color: string };
      shadow: { color: string };
    };
    assert.deepEqual(
      box.fill.stops.map((stop) => stop.color),
      ["#0E0807", "#E8DED7"],
    );
    assert.equal(box.border.color, "#123ABC");
    assert.equal(box.shadow.color, "#0E0807");
    const cell = (byId("grid").rows as Array<Array<Record<string, unknown>>>)[0]![0]!;
    assert.equal(cell.color, "#E8DED7");
    assert.deepEqual(cell.fill, { type: "solid", color: "#0E0807" });
    const chart = byId("bars") as { colors: string[]; series: Array<{ fill: unknown }> };
    assert.deepEqual(chart.colors, ["#0E0807"]);
    assert.equal(chart.series[0]!.fill, "#123ABC");
    assert.deepEqual((byId("bars") as { background: unknown }).background, {
      type: "solid",
      color: "#E8DED7",
    });
    assert.deepEqual(byId("badge").fill, { type: "solid", color: "#0E0807" });
    assert.deepEqual(result.pages[0]!.background, { type: "solid", color: "#0E0807" });
    assert.equal(result.theme?.colors?.accent, "#0E0807");
    assert.equal(result.theme?.textStyles?.body?.color, "#E8DED7");
    assert.deepEqual(result.fallbacks, []);
  });

  it("keeps the fallback for a colour that is not six hex digits, with its degradation", () => {
    const fill = (color: unknown) => ({ type: "solid", color });
    const shape = (elementId: string, color: unknown) => ({
      elementId,
      elementType: "shape",
      shapeName: "rect",
      bounds: [0, 0, 10, 10],
      fill: fill(color),
    });
    const input = page([
      shape("number", 123456),
      shape("named", "red"),
      shape("short", "ABC"),
      shape("long", "0E0807FF"),
      shape("padded", " 0E0807 "),
    ] as unknown as PptdElement[]);
    const result = sanitizeDeckColors([input], CLEAN_THEME);
    for (const element of result.pages[0]!.elements as Array<{ fill?: unknown }>) {
      assert.equal(element.fill, undefined);
    }
    assert.deepEqual(result.fallbacks, [
      { pageIndex: 0, elementId: "number" },
      { pageIndex: 0, elementId: "named" },
      { pageIndex: 0, elementId: "short" },
      { pageIndex: 0, elementId: "long" },
      { pageIndex: 0, elementId: "padded" },
    ]);
  });

  it("reads a bare run colour only for a stored-text read; the default parse still drops it", () => {
    const html = '<p><span style="color:E8DED7">红</span>字</p>';
    assert.equal(parseRichText(html)[0]!.color, undefined);
    assert.equal(parseRichText(html, { readBareHex: true })[0]!.color, "E8DED7");
  });

  it("drops unresolvable table cell colours and fills", () => {
    const input = page([
      {
        elementId: "grid",
        elementType: "table",
        bounds: [0, 0, 10, 10],
        columnWidths: [5, 5],
        rows: [[{ text: "甲", color: "$accent9", fill: { type: "solid", color: "$a" } }, { text: "乙" }]],
      },
    ] as PptdElement[]);
    const result = sanitizeDeckColors([input], THEME);
    const cell = (result.pages[0]!.elements[0] as { rows: Array<Array<Record<string, unknown>>> }).rows[0]![0]!;
    assert.equal(cell.color, undefined);
    assert.equal(cell.fill, undefined);
    assert.equal(cell.text, "甲");
    assert.deepEqual(result.fallbacks, [{ pageIndex: 0, elementId: "grid" }]);
  });

  it("blanks unresolvable chart swatches and drops unresolvable series and chart fills", () => {
    const input = page([
      {
        elementId: "bars",
        elementType: "chart",
        bounds: [0, 0, 10, 10],
        data: { cols: ["项", "甲", "乙"], rows: [["a", 1, 2]] },
        series: [
          { type: "bar", name: "甲", fill: "$a" },
          { type: "bar", name: "乙", fill: "#10B981" },
        ],
        colors: ["$accent9", "#10B981"],
        background: { type: "solid", color: "$a" },
      },
    ] as PptdElement[]);
    const chart = sanitizeDeckColors([input], THEME).pages[0]!.elements[0] as {
      colors: string[];
      series: Array<{ fill?: unknown }>;
      background?: unknown;
    };
    assert.deepEqual(chart.colors, ["", "#10B981"]);
    assert.equal(chart.series[0]!.fill, undefined);
    assert.equal(chart.series[1]!.fill, "#10B981");
    assert.equal(chart.background, undefined);
  });

  it("drops an unresolvable icon fill and shadow colour", () => {
    const input = page([
      {
        elementId: "badge",
        elementType: "icon",
        iconName: "star",
        bounds: [0, 0, 10, 10],
        fill: { type: "solid", color: "$a" },
        shadow: { blur: 4, color: "$accent9", opacity: 0.5 },
      },
    ] as PptdElement[]);
    const element = sanitizeDeckColors([input], THEME).pages[0]!.elements[0] as {
      fill?: unknown;
      shadow?: { color?: string; blur?: number };
    };
    assert.equal(element.fill, undefined);
    assert.equal(element.shadow?.color, undefined);
    assert.equal(element.shadow?.blur, 4);
  });

  it("records a page-level fallback without an element id, and the page index", () => {
    const input = page([], { type: "solid", color: "$a" });
    const second = page([
      {
        elementId: "late",
        elementType: "text",
        bounds: [0, 0, 10, 10],
        content: { text: "后", color: "$accent9" },
      },
    ] as PptdElement[]);
    const result = sanitizeDeckColors([page([]), input, second], THEME);
    assert.deepEqual(result.pages[1]!.background, { type: "solid", color: "#FFFFFF" });
    assert.deepEqual(result.fallbacks, [{ pageIndex: 1 }, { pageIndex: 2, elementId: "late" }]);
  });
});

describe("readableColor", () => {
  it("spells a six-digit unprefixed colour as #RRGGBB and leaves other values unchanged", () => {
    assert.equal(readableColor("d97757"), "#D97757");
    assert.equal(readableColor("D97757"), "#D97757");
    assert.equal(readableColor("#D97757"), "#D97757");
    assert.equal(readableColor("$accent9"), "$accent9");
    assert.equal(readableColor("D9775"), "D9775");
  });
});
