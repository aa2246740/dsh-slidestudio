import assert from "node:assert/strict";
import { test } from "node:test";
import { publicStyleProfile } from "./public-style-profile.mjs";

/** Stored records carry more envelope fields than the projection reads. @typedef {Parameters<typeof publicStyleProfile>[0]} ProfileInput */

/** @param {Record<string, unknown>} fields */
const image = (fields) => ({ kind: "image", parser: { id: "image-sharp-v1" }, image: fields });

/** @param {number|undefined} pagesScanned */
const pdf = (pagesScanned) => ({
  kind: "document",
  parser: { id: "pdf-unpdf-v3" },
  document: {
    styleProfile: {
      schema: "style-profile/v1",
      source: "pdf-vector-ops",
      pagesScanned,
      accentColors: [],
      neutralColors: [],
      fonts: [],
    },
  },
});

test("a pre-M4 numeric EXIF orientation is published as the word of its stored size", () => {
  /** @param {number} orientation @param {number} width @param {number} height */
  const legacy = (orientation, width, height) =>
    publicStyleProfile(image({ format: "jpeg", width, height, orientation }));
  assert.deepEqual(legacy(1, 800, 600).imageMetadata, { orientation: "landscape" });
  assert.deepEqual(legacy(6, 600, 800).imageMetadata, { orientation: "portrait" });
  assert.deepEqual(legacy(1, 640, 640).imageMetadata, { orientation: "square" });
  for (const value of [1, 6]) {
    assert.doesNotMatch(
      JSON.stringify(legacy(value, 600, 800)),
      new RegExp(`"orientation":${value}\\b`),
      "a numeric orientation never leaves the server",
    );
  }
  assert.equal(
    publicStyleProfile(image({ format: "png", orientation: 6 })).imageMetadata,
    undefined,
    "without a stored size no word is published",
  );
});

test("current orientation words and their optional flags are published unchanged", () => {
  const current = publicStyleProfile(
    image({
      version: 2,
      width: 10,
      height: 20,
      orientation: "portrait",
      logoLike: true,
      screenshotLike: false,
      takenAt: "2026:09:23 10:11:12",
    }),
  );
  assert.deepEqual(current.imageMetadata, {
    orientation: "portrait",
    logoLike: true,
    screenshotLike: false,
    takenAt: "2026:09:23 10:11:12",
  });
  assert.equal(publicStyleProfile(image({ width: 10, height: 20, orientation: "sideways" })).imageMetadata, undefined);
});

test("a stored PDF style profile is published only when it measured 1 to 30 pages", () => {
  for (const pagesScanned of [1, 30]) {
    assert.ok(publicStyleProfile(pdf(pagesScanned)).styleProfile, `${pagesScanned} pages`);
  }
  for (const pagesScanned of [0, 31, 1.5, undefined]) {
    assert.equal(publicStyleProfile(pdf(pagesScanned)).styleProfile, undefined, `${pagesScanned} pages`);
  }
});

test("VAL-FMT-006: a Word theme profile is published as clue-only hints", () => {
  const profile = {
    schema: "style-profile/v1",
    source: "docx-theme",
    accentColors: [
      { hex: "#00589C", share: 0.2, roles: ["fill"] },
      { hex: "#B5573A", share: 0.2, roles: ["fill"] },
    ],
    fonts: [{ source: "思源宋体", share: 0.5, mapped: { latin: "Georgia", ea: "宋体" } }],
  };
  const record = {
    kind: "document",
    parser: { id: "docx-ooxml-v1" },
    document: { styleProfile: profile },
  };
  const projected = publicStyleProfile(record);
  assert.deepEqual(projected.styleProfile, profile);
  assert.equal(
    projected.styleHintLine,
    "风格线索：强调色 #00589C、#B5573A；字体 思源宋体 → 宋体（风格只作线索，不作为设计来源）",
  );
});

test("a PDF vector profile carries the freestyle palette wording", () => {
  const record = {
    kind: "document",
    parser: { id: "pdf-unpdf-v3" },
    document: {
      styleProfile: {
        schema: "style-profile/v1",
        source: "pdf-vector-ops",
        pagesScanned: 1,
        accentColors: [{ hex: "#C00000", share: 1, roles: ["fill"] }],
        neutralColors: [{ hex: "#000000" }],
        fonts: [{ source: "HYQiHei-EES", share: 1, mapped: { latin: "Arial", ea: "微软雅黑" } }],
      },
    },
  };
  assert.equal(
    publicStyleProfile(record).styleHintLine,
    "风格线索：强调色 #C00000；字体 HYQiHei-EES → 微软雅黑（风格参考；自由风格下可作配色来源）",
  );
});

test("the hint line survives messy stored values and absent pieces", () => {
  const projected = publicStyleProfile(
    /** @type {ProfileInput} */ ({
      kind: "document",
      parser: { id: "docx-ooxml-v1" },
      document: {
        styleProfile: {
          schema: "style-profile/v1",
          source: "docx-theme",
          accentColors: [
            { hex: "#00589C", share: 0.2, roles: ["fill"] },
            { hex: "nope", share: 0.2, roles: ["fill"] },
            "junk",
          ],
          fonts: [{ source: " 思源\n宋体 ", share: 0.5, mapped: { latin: "Georgia", ea: "宋体" } }],
        },
      },
    }),
  );
  assert.match(projected.styleHintLine ?? "", /^风格线索：强调色 #00589C；字体 思源 宋体 → 宋体/);
  const fontsOnly = publicStyleProfile(
    /** @type {ProfileInput} */ ({
      kind: "document",
      parser: { id: "docx-ooxml-v1" },
      document: {
        styleProfile: {
          schema: "style-profile/v1",
          source: "docx-theme",
          accentColors: [{ hex: "nope", share: 1, roles: ["fill"] }],
          fonts: [{ source: "思源宋体", share: 1, mapped: { latin: "Georgia", ea: "宋体" } }],
        },
      },
    }),
  );
  assert.match(fontsOnly.styleHintLine ?? "", /^风格线索：字体 思源宋体/);
  const empty = publicStyleProfile(
    /** @type {ProfileInput} */ ({
      kind: "document",
      parser: { id: "docx-ooxml-v1" },
      document: {
        styleProfile: {
          schema: "style-profile/v1",
          source: "docx-theme",
          accentColors: [],
          fonts: [],
        },
      },
    }),
  );
  assert.equal(empty.styleHintLine, undefined);
});

test("an image pixel profile publishes no hint line — the metadata line owns that chip", () => {
  const profile = {
    schema: "style-profile/v1",
    source: "image-pixels",
    accentColors: [],
    neutralColors: [],
    background: "#FFFFFF",
    contrastPairs: [],
  };
  const projected = publicStyleProfile(image({ orientation: "square", width: 4, height: 4, styleProfile: profile }));
  assert.deepEqual(projected.styleProfile, profile);
  assert.equal(projected.styleHintLine, undefined);
});

test("VAL-FMT-006: a Word record without a readable theme publishes no style profile", () => {
  const record = /** @type {ProfileInput} */ ({
    kind: "document",
    parser: { id: "docx-ooxml-v1" },
    document: { charts: [] },
  });
  assert.equal(publicStyleProfile(record).styleProfile, undefined);
});

test("VAL-FMT-006: a Word theme profile missing accents or fonts is not published", () => {
  const base = (
    /** @type {{ fonts?: { source: string; share: number; mapped: { latin: string; ea: string; }; }[]; accentColors?: { hex: string; share: number; roles: string[]; }[]; }} */ profileFields,
  ) => ({
    kind: "document",
    parser: { id: "docx-ooxml-v1" },
    document: {
      styleProfile: { schema: "style-profile/v1", source: "docx-theme", ...profileFields },
    },
  });
  assert.equal(
    publicStyleProfile(base({ fonts: [{ source: "思源宋体", share: 1, mapped: { latin: "Georgia", ea: "宋体" } }] }))
      .styleProfile,
    undefined,
    "no accent colors",
  );
  assert.equal(
    publicStyleProfile(base({ accentColors: [{ hex: "#00589C", share: 0.2, roles: ["fill"] }] })).styleProfile,
    undefined,
    "no fonts",
  );
});

test("an image pixel profile counts no pages and is published", () => {
  const profile = {
    schema: "style-profile/v1",
    source: "image-pixels",
    accentColors: [],
    neutralColors: [],
    background: "#FFFFFF",
    contrastPairs: [],
  };
  const projected = publicStyleProfile(image({ orientation: "square", width: 4, height: 4, styleProfile: profile }));
  assert.deepEqual(projected.styleProfile, profile);
});

test("projecting a stored record leaves the record itself unchanged", () => {
  const record = pdf(0);
  const before = JSON.stringify(record);
  publicStyleProfile(record);
  assert.equal(JSON.stringify(record), before);
});
