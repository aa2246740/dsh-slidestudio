import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { eachDescribe, eachTest } from "./test-fixtures/each.mjs";
import { connector, group, kitPptx, picture, shape, SLIDE_SIZE } from "./test-fixtures/kit-pptx.mjs";
import { sharp, NO_SHARP, parseDeck, kitOf, imagesOf, textLine } from "./test-fixtures/pptx-kit-test-kit.mjs";

/** @typedef {number[]} Point an [x, y] pair: EMU, or fractions of a box */
/** @typedef {{rot?: number, flipH?: boolean, flipV?: boolean}} Turn */
/** @typedef {import("./test-fixtures/kit-pptx.mjs").Frame} Frame */
/** @typedef {Omit<import("./test-fixtures/kit-pptx.mjs").GroupSpec, "id" | "children">} GroupFrame a chain group before wrapInGroups numbers it */
/** @typedef {{spec: GroupFrame, box: Frame}} PlacedGroup */
/** @typedef {{bounds: number[], rotation?: number, flipH?: boolean, flipV?: boolean}} DrawnElement an emitted frame in slide fractions */

const SW = SLIDE_SIZE.cx;
const SH = SLIDE_SIZE.cy;
/**
 * The template kit of a parsed deck.
 * @param {import("./derivative.mjs").Derivative} derivative
 */
const kitFrom = (derivative) => kitOf(/** @type {Parameters<typeof kitOf>[0]} */ (/** @type {unknown} */ (derivative)));
/**
 * Screen space is y-down, so a positive angle turns clockwise.
 * @param {Point} point
 * @param {number} degrees
 * @returns {Point}
 */
function turnBy([x, y], degrees) {
  const [cos, sin] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
  return [cos * x - sin * y, sin * x + cos * y];
}
/**
 * DrawingML order: flip in the shape's own frame, then rotate, both about the centre.
 * @param {Point} point
 * @param {Point} centre
 * @param {Turn} turn
 */
function aboutCentre(point, centre, { rot = 0, flipH = false, flipV = false }) {
  const offset = [(point[0] - centre[0]) * (flipH ? -1 : 1), (point[1] - centre[1]) * (flipV ? -1 : 1)];
  const [x, y] = turnBy(offset, rot);
  return [centre[0] + x, centre[1] + y];
}
/**
 * The PowerPoint / LibreOffice group rule, written out by hand and independent of the parser
 * (mission research/drawingml-group-child-transform.md; it matches LibreOffice oox and Apache POI,
 * PowerPoint itself was not verified directly). A group scales its children per axis, so a shape
 * is never sheared: only the child's centre follows the scale exactly, and its size takes the
 * scale of the swapped axes while its own turn lies in [45, 135) or [225, 315) degrees.
 */
const swapsAxes = (/** @type {number} */ degrees) => {
  const turn = ((degrees % 360) + 360) % 360;
  return (turn >= 45 && turn < 135) || (turn >= 225 && turn < 315);
};
/**
 * A node (group or leaf) as a placed box; a point given from its centre goes to its host's centre.
 * @param {GroupFrame} spec
 * @returns {Frame}
 */
const boxOf = ({ off, ext, ...turn }) => ({ x: off.x, y: off.y, w: ext.w, h: ext.h, ...turn });
const fromCentre = (/** @type {Turn} */ box, /** @type {Point} */ centre) => (/** @type {Point} */ point) => {
  const flipped = [box.flipH ? -point[0] : point[0], box.flipV ? -point[1] : point[1]];
  const [x, y] = turnBy(flipped, box.rot ?? 0);
  return [centre[0] + x, centre[1] + y];
};
/**
 * Where a point of the child's own box (fractions u, v) lands once the group chain is applied.
 * `chain` lists the groups innermost first, as wrapInGroups builds them.
 * @param {GroupFrame[]} chain
 * @param {Frame} child
 * @param {number} u
 * @param {number} v
 */
function expectedPoint(chain, child, u, v) {
  const groups = chain.map((spec) => ({ spec, box: boxOf(spec) })).reverse();
  const outermost = groups[0].box;
  let toSlide = fromCentre(outermost, [outermost.x + outermost.w / 2, outermost.y + outermost.h / 2]);
  let rendered = [outermost.w, outermost.h];
  /** @param {PlacedGroup} placed @param {Frame} box */
  const enter = ({ spec: host }, box) => {
    const { chOff = host.off, chExt = host.ext } = host;
    const scale = [chExt.w ? rendered[0] / chExt.w : 1, chExt.h ? rendered[1] / chExt.h : 1];
    const centre = [
      (box.x + box.w / 2 - chOff.x) * scale[0] - rendered[0] / 2,
      (box.y + box.h / 2 - chOff.y) * scale[1] - rendered[1] / 2,
    ];
    const outer = toSlide;
    const own = fromCentre(box, centre);
    toSlide = (point) => outer(own(point));
    rendered = swapsAxes(box.rot ?? 0) ? [box.w * scale[1], box.h * scale[0]] : [box.w * scale[0], box.h * scale[1]];
  };
  groups.slice(1).forEach((group, level) => enter(groups[level], group.box));
  enter(/** @type {PlacedGroup} */ (groups.at(-1)), child);
  return toSlide([(u - 0.5) * rendered[0], (v - 0.5) * rendered[1]]);
}
/**
 * Groups around a leaf, innermost spec first.
 * @param {GroupFrame[]} chain
 * @param {string} leaf
 * @param {number} id
 * @returns {string}
 */
const wrapInGroups = (chain, leaf, id) =>
  chain.reduce((children, spec, level) => group({ ...spec, id: id + 100 + level, children }), leaf);
/**
 * Where the same fractions land when the emitted element is drawn from its bounds, rotation and flips.
 * @param {DrawnElement} element
 * @param {number} u
 * @param {number} v
 */
function renderedPoint(element, u, v) {
  const [bx, by, bw, bh] = element.bounds;
  const box = { x: bx * SW, y: by * SH, w: bw * SW, h: bh * SH };
  return aboutCentre([box.x + u * box.w, box.y + v * box.h], [box.x + box.w / 2, box.y + box.h / 2], {
    rot: element.rotation ?? 0,
    flipH: element.flipH,
    flipV: element.flipV,
  });
}
/**
 * A line carries its flips in the path, so only the rotation remains to apply.
 * @param {DrawnElement & {points: string, viewBox: number[]}} element
 */
function renderedLineEnds(element) {
  const [x0, y0, x1, y1] = /** @type {RegExpMatchArray} */ (element.points.match(/-?[\d.]+/g)).map(Number);
  const [vw, vh] = element.viewBox;
  const plain = { ...element, flipH: false, flipV: false };
  return [renderedPoint(plain, x0 / vw, y0 / vh), renderedPoint(plain, x1 / vw, y1 / vh)];
}
const assertSamePlace = (/** @type {Point} */ actual, /** @type {Point} */ expected, /** @type {string} */ label) =>
  assert.ok(
    Math.abs(actual[0] - expected[0]) / SW < 3e-4 && Math.abs(actual[1] - expected[1]) / SH < 3e-4,
    `${label}: drawn at ${actual.map(Math.round)}, the composed matrix puts it at ${expected.map(Math.round)}`,
  );
const POINTS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [1, 0.5],
];
const orientationOf = (/** @type {{flipH?: boolean, flipV?: boolean, rotation?: number}} */ element) => ({
  flipH: Boolean(element.flipH),
  flipV: Boolean(element.flipV),
  rotation: element.rotation ?? 0,
});

describe("M6-SCR-002: a reflection inherited from a flipped group is kept", () => {
  const IDENTITY = { off: { x: 1800000, y: 900000 }, ext: { w: 3600000, h: 2200000 } };
  const SCALED = {
    off: { x: 1800000, y: 900000 },
    ext: { w: 3000000, h: 1800000 },
    chOff: { x: 1200000, y: 600000 },
    chExt: { w: 4800000, h: 1800000 },
  };
  const OUTER = { off: { x: 1000000, y: 500000 }, ext: { w: 5600000, h: 3400000 } };
  const CHILD = { x: 2400000, y: 1500000, w: 1400000, h: 800000 };
  const wrap = wrapInGroups;
  const CASES = [
    {
      name: "an ancestor flipH (scaled unevenly)",
      color: "E01000",
      chain: [{ ...SCALED, flipH: true }],
      expect: { flipH: true, flipV: false, rotation: 0 },
    },
    {
      name: "an ancestor flipV",
      color: "E02000",
      chain: [{ ...IDENTITY, flipV: true }],
      expect: { flipH: false, flipV: true, rotation: 0 },
    },
    {
      name: "two nested flipH groups cancel",
      color: "E03000",
      chain: [
        { ...IDENTITY, flipH: true },
        { ...OUTER, flipH: true },
      ],
      expect: { flipH: false, flipV: false, rotation: 0 },
    },
    {
      name: "a flipH group inside a flipV group is a half turn, not a mirror",
      color: "E04000",
      chain: [
        { ...IDENTITY, flipH: true },
        { ...OUTER, flipV: true },
      ],
      expect: { flipH: false, flipV: false, rotation: 180 },
    },
    {
      name: "an asymmetric child with its own rotation and flipV in a flipH group",
      color: "E05000",
      chain: [{ ...IDENTITY, flipH: true }],
      child: { rot: 30, flipV: true },
    },
    {
      name: "a rotated and mirrored group",
      color: "E06000",
      chain: [{ ...IDENTITY, rot: 90, flipH: true }],
      child: { rot: 20 },
    },
  ];
  const LINE = {
    name: "a directed line with its own flipH in a flipV group",
    chain: [{ ...SCALED, flipV: true }],
    child: { flipH: true },
  };
  const PICTURE_CHAIN = [{ ...IDENTITY, flipV: true }];

  async function reflectionDeck() {
    const image = await sharp({
      create: { width: 40, height: 24, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    const arrows = CASES.map((entry, index) =>
      wrap(
        entry.chain,
        shape({ id: 10 + index, geom: "rightArrow", color: entry.color, ...CHILD, ...entry.child }),
        10 + index,
      ),
    ).join("");
    const line = wrap(LINE.chain, connector({ id: 30, color: "0F8F00", ...CHILD, ...LINE.child }), 30);
    const bytes = kitPptx({
      slides: [{ shapes: arrows + line }],
      layouts: [
        {
          shapes: wrap(PICTURE_CHAIN, picture({ id: 40, rid: "rPic", ...CHILD }), 40),
          rels: [["rPic", "image", "../media/flag.png"]],
        },
      ],
      media: { "flag.png": image },
    });
    return kitFrom(await parseDeck(bytes));
  }
  const allElements = (/** @type {{ components: any[]; }} */ templateKit) =>
    templateKit.components.flatMap((/** @type {{ elements: any; }} */ entry) => entry.elements);

  eachTest(CASES, "$name keeps the orientation of the composed matrix", async (entry) => {
    const element = allElements(await reflectionDeck()).find(
      (/** @type {{ fill: { color: string; }; }} */ candidate) => candidate.fill?.color === `#${entry.color}`,
    );
    assert.ok(element, entry.name);
    assert.equal(element.shapeName, "rightArrow");
    if (entry.expect) assert.deepEqual(orientationOf(element), entry.expect);
    for (const [u, v] of POINTS) {
      assertSamePlace(
        renderedPoint(element, u, v),
        expectedPoint(entry.chain, { ...CHILD, ...entry.child }, u, v),
        `${entry.name} at (${u}, ${v})`,
      );
    }
  });

  test("a directed line starts and ends where the composed matrix puts its ends", async () => {
    const element = allElements(await reflectionDeck()).find(
      (/** @type {{ elementType: string; }} */ candidate) => candidate.elementType === "line",
    );
    assert.ok(element);
    assert.deepEqual(element.arrow, [null, "arrow"]);
    const [start, end] = renderedLineEnds(element);
    const child = { ...CHILD, ...LINE.child };
    assertSamePlace(start, expectedPoint(LINE.chain, child, 0, 0), "line start");
    assertSamePlace(end, expectedPoint(LINE.chain, child, 1, 1), "line end");
  });

  test("a picture in a flipped layout group is drawn mirrored", async () => {
    const [picked] = imagesOf(await reflectionDeck());
    assert.ok(picked);
    assert.deepEqual(orientationOf(picked), { flipH: false, flipV: true, rotation: 0 });
    for (const [u, v] of POINTS) {
      assertSamePlace(
        renderedPoint(picked, u, v),
        expectedPoint(PICTURE_CHAIN, CHILD, u, v),
        `picture at (${u}, ${v})`,
      );
    }
  });
});

const mod360 = (/** @type {number} */ degrees) => ((degrees % 360) + 360) % 360;
const hex2 = (/** @type {{ toString: (arg0: number) => string; }} */ value) =>
  value.toString(16).padStart(2, "0").toUpperCase();

describe("M6-SCR-002 (round 2): a rotated child in an unevenly scaled group is never sheared", () => {
  // The research worked examples in units of 500000 EMU: a 5 x 8 group over an 8 x 8 child space
  // (scale 0.625 by 1) holding a 4 x 2 child at (2, 2). Matches the LibreOffice / POI rule.
  const U = 500_000;
  const AT_ORIGIN = {
    off: { x: 0, y: 0 },
    ext: { w: 5 * U, h: 8 * U },
    chOff: { x: 0, y: 0 },
    chExt: { w: 8 * U, h: 8 * U },
  };
  const SHIFTED = { ...AT_ORIGIN, off: { x: 3 * U, y: U } };
  const CHILD = { x: 2 * U, y: 2 * U, w: 4 * U, h: 2 * U };
  const UPRIGHT = [2.5 * U, 2 * U];
  const SWAPPED = [4 * U, 1.25 * U];
  const INNER = {
    off: { x: 2 * U, y: 2 * U },
    ext: { w: 4 * U, h: 2 * U },
    chOff: { x: 0, y: 0 },
    chExt: { w: 4 * U, h: 2 * U },
    rot: 90,
  };
  const LEAF = { x: 0, y: 0, w: 2 * U, h: 2 * U };

  /**
   * Spreads shapes over slides (a slide holds at most 40 decorations); every shape has its own colour.
   * @param {any[]} slides
   */
  async function kitWith(slides) {
    const bytes = kitPptx({
      slides: slides.map(
        (/** @type {{ chain: any; child: any; line: any; }[]} */ entries, /** @type {any} */ slideIndex) => ({
          shapes: entries
            .map(({ chain, child, line }, /** @type {number} */ index) => {
              const color = colourOf(slideIndex, index).slice(1);
              const leaf = line
                ? connector({ id: 10 + index, color, ...child })
                : shape({ id: 10 + index, geom: "rightArrow", color, ...child });
              return wrapInGroups(chain, leaf, 10 + index);
            })
            .join(""),
        }),
      ),
    });
    return kitFrom(await parseDeck(bytes));
  }
  const colourOf = (/** @type {number} */ slide, /** @type {number} */ index) =>
    `#${hex2(0x30 + slide)}${hex2(0x10 + index)}77`;
  const find = (
    /** @type {{ components: any[]; }} */ templateKit,
    /** @type {number} */ slide,
    /** @type {number} */ index,
  ) =>
    templateKit.components
      .flatMap((/** @type {{ elements: any; }} */ entry) => entry.elements)
      .find((/** @type {{ fill: { color: any; }; border: { color: any; }; }} */ element) =>
        [element.fill?.color, element.border?.color].includes(colourOf(slide, index)),
      );
  /**
   * @param {DrawnElement | undefined} element
   * @param {{centre: Point, size: Point, rotation: number}} expected
   * @param {string} label
   */
  const assertFrame = (element, { centre, size, rotation }, label) => {
    assert.ok(element, label);
    const [x, y, w, h] = element.bounds;
    assertSamePlace([(x + w / 2) * SW, (y + h / 2) * SH], centre, `${label} centre`);
    assertSamePlace([w * SW, h * SH], size, `${label} size`);
    assert.ok(
      Math.abs(mod360(element.rotation ?? 0) - mod360(rotation)) < 1e-3,
      `${label}: turned ${element.rotation ?? 0}, expected ${rotation}`,
    );
  };

  const TURNS = [
    [0, UPRIGHT],
    [30, UPRIGHT],
    [60, SWAPPED],
    [90, SWAPPED],
    [120, SWAPPED],
    [180, UPRIGHT],
    [270, SWAPPED],
    // The decision uses the written turn: 45 and 225 swap, 135 and 315 do not.
    [44, UPRIGHT],
    [45, SWAPPED],
    [134, SWAPPED],
    [135, UPRIGHT],
    [224, UPRIGHT],
    [225, SWAPPED],
    [314, SWAPPED],
    [315, UPRIGHT],
    [-90, SWAPPED],
    [450, SWAPPED],
  ];
  let literal;
  const literalKit = () =>
    (literal ??= kitWith([
      TURNS.map(([rot]) => ({ chain: [AT_ORIGIN], child: { ...CHILD, rot } })),
      [
        { chain: [{ ...AT_ORIGIN, flipH: true }], child: { ...CHILD, rot: 30 } },
        { chain: [{ ...AT_ORIGIN, flipH: true }], child: { ...CHILD, rot: 60 } },
        { chain: [INNER, AT_ORIGIN], child: LEAF },
      ],
    ]));

  eachTest(
    TURNS.map((entry, index) => [...entry, index]),
    "a child turned %i degrees keeps its centre and takes the right scale",
    async (rot, size, index) => {
      assertFrame(find(await literalKit(), 0, index), { centre: [2.5 * U, 3 * U], size, rotation: rot }, `rot ${rot}`);
    },
  );

  test("a flipH group negates the child's rotation and keeps the portrait decision of the written turn", async () => {
    const templateKit = await literalKit();
    const upright = find(templateKit, 1, 0);
    assertFrame(upright, { centre: [2.5 * U, 3 * U], size: UPRIGHT, rotation: 330 }, "flipH, 30");
    assert.equal(upright.flipH, true);
    const portrait = find(templateKit, 1, 1);
    assertFrame(portrait, { centre: [2.5 * U, 3 * U], size: SWAPPED, rotation: 300 }, "flipH, 60");
    assert.equal(portrait.flipH, true);
  });

  test("a portrait group inside the scaled group lays its children out in its own rendered frame", async () => {
    // The intermediate group renders 4 x 1.25 around (2.5, 3); its leaf is the top half of it.
    const leaf = find(await literalKit(), 1, 2);
    assertFrame(leaf, { centre: [2.5 * U, 2 * U], size: [2 * U, 1.25 * U], rotation: 90 }, "leaf");
  });

  const ANGLES = [0, 20, 44, 45, 80, 134, 135, 200, 225, 300, 314, 315];
  const VARIANTS = [
    { name: "plain", chain: [SHIFTED], child: CHILD },
    { name: "flipH", chain: [{ ...SHIFTED, flipH: true }], child: CHILD },
    { name: "flipV", chain: [{ ...SHIFTED, flipV: true }], child: CHILD },
    { name: "a quarter turn", chain: [{ ...SHIFTED, rot: 90 }], child: CHILD },
    { name: "a turned mirror", chain: [{ ...SHIFTED, rot: 30, flipH: true }], child: CHILD },
    {
      name: "nested, portrait inner group",
      chain: [{ ...INNER, flipV: true }, SHIFTED],
      child: { x: U, y: 0.5 * U, w: 2 * U, h: U },
    },
  ];
  /** The child's own mirror varies with the angle, so own flips are exercised under every group. */
  const childAt = (
    /** @type {{ name: string; chain: { flipH: boolean; off: { x: number; y: number; }; ext: { w: number; h: number; }; chOff: { x: number; y: number; }; chExt: { w: number; h: number; }; }[]; child: { x: number; y: number; w: number; h: number; }; } | { name: string; chain: { rot: number; flipH: boolean; off: { x: number; y: number; }; ext: { w: number; h: number; }; chOff: { x: number; y: number; }; chExt: { w: number; h: number; }; }[]; child: { x: number; y: number; w: number; h: number; }; } | { name: string; chain: ({ off: { x: number; y: number; }; ext: { w: number; h: number; }; chOff: { x: number; y: number; }; chExt: { w: number; h: number; }; } | { flipV: boolean; off: { x: number; y: number; }; ext: { w: number; h: number; }; chOff: { x: number; y: number; }; chExt: { w: number; h: number; }; rot: number; })[]; child: { x: number; y: number; w: number; h: number; }; }} */ variant,
    /** @type {number} */ rot,
  ) => ({
    ...variant.child,
    rot,
    flipH: rot === 300,
    flipV: rot === 200,
  });
  let swept;
  const sweptKit = () =>
    (swept ??= kitWith(
      VARIANTS.map((variant) => ANGLES.map((rot) => ({ chain: variant.chain, child: childAt(variant, rot) }))),
    ));

  eachDescribe(
    VARIANTS.map((variant, slide) => [variant.name, variant, slide]),
    "%s",
    (_name, variant, slide) => {
      eachTest(
        ANGLES.map((rot, index) => [rot, index]),
        "turned %i degrees it is drawn where the group rule puts it",
        async (rot, index) => {
          const element = find(await sweptKit(), slide, index);
          assert.ok(element, `${variant.name} ${rot}`);
          const child = childAt(variant, rot);
          for (const [u, v] of POINTS) {
            assertSamePlace(
              renderedPoint(element, u, v),
              expectedPoint(variant.chain, child, u, v),
              `${variant.name}, ${rot} degrees, (${u}, ${v})`,
            );
          }
        },
      );
    },
  );

  const LINES = [
    { name: "a directed line turned 30", child: { ...CHILD, rot: 30 } },
    { name: "a directed line turned 60", child: { ...CHILD, rot: 60 } },
    { name: "a flat line turned 30", child: { ...CHILD, h: 0, rot: 30 } },
    { name: "a flat line turned 90", child: { ...CHILD, h: 0, rot: 90 } },
    { name: "a flipped line turned 120", child: { ...CHILD, rot: 120, flipV: true } },
  ];
  const lineChain = (/** @type {number} */ index) => [{ ...SHIFTED, flipH: index === 4 }];
  let lined;
  const lineKit = () =>
    (lined ??= kitWith([LINES.map((entry, index) => ({ chain: lineChain(index), child: entry.child, line: true }))]));
  eachTest(
    LINES.map((entry, index) => [entry.name, entry, index]),
    "%s starts and ends where the group rule puts its ends",
    async (name, entry, index) => {
      const element = find(await lineKit(), 0, index);
      assert.equal(element?.elementType, "line", name);
      assert.deepEqual(element.arrow, [null, "arrow"]);
      const [start, end] = renderedLineEnds(element);
      assertSamePlace(start, expectedPoint(lineChain(index), entry.child, 0, 0), `${name} start`);
      assertSamePlace(end, expectedPoint(lineChain(index), entry.child, 1, 1), `${name} end`);
    },
  );

  test("a picture in a scaled layout group is placed by the same rule", { skip: NO_SHARP }, async () => {
    const image = await sharp({
      create: { width: 40, height: 24, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    const chain = [SHIFTED];
    const child = { ...CHILD, rot: 60 };
    const templateKit = kitFrom(
      await parseDeck(
        kitPptx({
          slides: [{ shapes: textLine(2, "封面") }],
          layouts: [
            {
              shapes: wrapInGroups(chain, picture({ id: 40, rid: "rPic", ...child }), 40),
              rels: [["rPic", "image", "../media/flag.png"]],
            },
          ],
          media: { "flag.png": image },
        }),
      ),
    );
    const [picked] = imagesOf(templateKit);
    assert.ok(picked);
    for (const [u, v] of POINTS) {
      assertSamePlace(renderedPoint(picked, u, v), expectedPoint(chain, child, u, v), `picture at (${u}, ${v})`);
    }
  });
});
