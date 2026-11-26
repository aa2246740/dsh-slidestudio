/** Bounded pixel statistics, not a claim that the model has viewed the image. */
import { dateTimeOriginal } from "./image-taken-at.mjs";
import { requireSharp } from "./optional-decoder.mjs";

/** @typedef {[number, number, number]} Triple */
/** @typedef {{rgb: Triple, lab: Triple, count: number}} Point */
export const IMAGE_DERIVATIVE_VERSION = 2;
const SAMPLE_EDGE = 160;
const K = 8;

/** @param {number} value */
const rounded = (value) => Math.round(value * 1e6) / 1e6;
/** @param {number} value */
const linear = (value) => {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** D65 sRGB -> CIE Lab. @param {Triple} rgb @returns {Triple} */
function labOf([r, g, b]) {
  const red = linear(r),
    green = linear(g),
    blue = linear(b);
  /** @param {number} v */
  const f = (v) => (v > 216 / 24389 ? Math.cbrt(v) : ((24389 / 27) * v + 16) / 116);
  const x = f((0.4124564 * red + 0.3575761 * green + 0.1804375 * blue) / 0.95047);
  const y = f(0.2126729 * red + 0.7151522 * green + 0.072175 * blue);
  const z = f((0.0193339 * red + 0.119192 * green + 0.9503041 * blue) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** @param {Triple} a @param {Triple} b */
const distance = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
/** @param {Triple} rgb */
const hexOf = (rgb) =>
  `#${rgb
    .map((c) => Math.round(c).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
/** @param {Triple} rgb */
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
/** @param {Triple} lab */
const neutral = (lab) => Math.hypot(lab[1], lab[2]) < 12 || lab[0] > 96 || lab[0] < 8;

/** @param {string} hex @returns {Triple} */
function rgbOfHex(hex) {
  const value = Number.parseInt(hex.replace(/^#/, ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** @param {number} y @param {number} x  hue angle in degrees, 0..360 */
const hueAngle = (y, x) => {
  if (x === 0 && y === 0) return 0;
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
};

/**
 * CIEDE2000 colour difference (kL = kC = kH = 1) between two `#RRGGBB` colours.
 * Used to check that a page-pixel colour matches an expected colour (DECISIONS #13).
 * @param {string} hexA @param {string} hexB
 */
export function deltaE2000(hexA, hexB) {
  const [l1, a1, b1] = labOf(rgbOfHex(hexA));
  const [l2, a2, b2] = labOf(rgbOfHex(hexB));
  /** @param {number} degrees */
  const rad = (degrees) => (degrees * Math.PI) / 180;
  /** @param {number} value */
  const pow7 = (value) => value ** 7;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(pow7(cBar) / (pow7(cBar) + pow7(25))));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp) / 2);
  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2;
    else hBarP = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(rad(hBarP - 30)) +
    0.24 * Math.cos(rad(2 * hBarP)) +
    0.32 * Math.cos(rad(3 * hBarP + 6)) -
    0.2 * Math.cos(rad(4 * hBarP - 63));
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rC = 2 * Math.sqrt(pow7(cBarP) / (pow7(cBarP) + pow7(25)));
  const sL = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;
  const rT = -Math.sin(rad(2 * dTheta)) * rC;
  const termL = dLp / sL;
  const termC = dCp / sC;
  const termH = dHp / sH;
  return Math.sqrt(termL ** 2 + termC ** 2 + termH ** 2 + rT * termC * termH);
}

/** Weighted k-means++ in Lab, k=8 even for fewer distinct pixel colors.
 * Empty clusters are discarded, not invented. Seed and tie order never vary.
 * @param {Point[]} points */
function cluster(points) {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const first = points[Math.floor(random() * points.length)];
  if (!first) throw new Error("No image pixels");
  /** @type {Triple[]} */
  let centers = [[...first.lab]];
  while (centers.length < K) {
    const weights = points.map((p) => Math.min(...centers.map((c) => distance(p.lab, c))) * p.count);
    let remaining = random() * weights.reduce((sum, w) => sum + w, 0);
    let chosen = first;
    for (let i = 0; i < points.length; i += 1) {
      remaining -= weights[i] ?? 0;
      if (remaining < 0) {
        chosen = points[i] ?? first;
        break;
      }
    }
    centers.push([...chosen.lab]);
  }
  /** @type {Point[]} */
  let groups = [];
  for (let iteration = 0; iteration < 32; iteration += 1) {
    groups = centers.map(() => ({ rgb: [0, 0, 0], lab: [0, 0, 0], count: 0 }));
    for (const point of points) {
      let best = 0,
        closest = Infinity;
      centers.forEach((center, index) => {
        const d = distance(point.lab, center);
        if (d < closest) {
          closest = d;
          best = index;
        }
      });
      const group = groups[best];
      if (!group) continue;
      group.count += point.count;
      for (const axis of /** @type {const} */ ([0, 1, 2])) {
        group.rgb[axis] += point.rgb[axis] * point.count;
        group.lab[axis] += point.lab[axis] * point.count;
      }
    }
    for (const g of groups) {
      if (!g.count) continue;
      for (const axis of /** @type {const} */ ([0, 1, 2])) {
        g.rgb[axis] /= g.count;
        g.lab[axis] /= g.count;
      }
    }
    const next = groups.map((g, i) => (g.count ? g.lab : (centers[i] ?? first.lab)));
    const movement = next.reduce((sum, c, i) => sum + distance(c, centers[i] ?? first.lab), 0);
    centers = next;
    if (movement < 1e-6) break;
  }
  return groups.filter((g) => g.count).sort((a, b) => b.count - a.count || (hexOf(a.rgb) < hexOf(b.rgb) ? -1 : 1));
}

/**
 * One pass over the flattened RGBA sample: the colour histogram plus the
 * transparency, white, flat and edge counts the classifiers read.
 * @param {Uint8Array} data @param {number} width
 */
function samplePixels(data, width) {
  /** @type {Map<string, Point>} */
  const histogram = new Map();
  /** @type {Triple[]} */
  const pixels = [];
  const counts = { transparent: 0, white: 0, flat: 0, edges: 0, pairs: 0 };
  for (let i = 0; i < data.length; i += 4) {
    const alpha = (data[i + 3] ?? 255) / 255;
    if (alpha < 0.95) counts.transparent += 1;
    const rgb = /** @type {Triple} */ (
      [0, 1, 2].map((c) => Math.round((data[i + c] ?? 0) * alpha + 255 * (1 - alpha)))
    );
    pixels.push(rgb);
    if (rgb.every((channel) => channel >= 244)) counts.white += 1;
    const key = rgb.join(",");
    const p = histogram.get(key);
    if (p) p.count += 1;
    else histogram.set(key, { rgb, lab: labOf(rgb), count: 1 });
    const index = pixels.length - 1;
    for (const neighbor of [index % width ? pixels[index - 1] : undefined, pixels[index - width]]) {
      if (!neighbor) continue;
      const delta = Math.max(...rgb.map((v, c) => Math.abs(v - (neighbor[c] ?? 0))));
      if (delta <= 2) counts.flat += 1;
      if (delta > 40) counts.edges += 1;
      counts.pairs += 1;
    }
  }
  return { histogram, total: pixels.length, ...counts };
}

/** @param {ReturnType<typeof cluster>} groups @param {number} total */
function paletteProfile(groups, total) {
  const colors = groups.map((g) => ({ hex: hexOf(g.rgb), share: rounded(g.count / total) }));
  const isNeutral = (/** @type {number} */ i) => neutral(groups[i]?.lab ?? [0, 0, 0]);
  const background = colors[0]?.hex ?? "#FFFFFF";
  const bg = groups[0]?.rgb ?? [255, 255, 255];
  const contrastPairs = groups.slice(1).map((g) => {
    const a = luminance(g.rgb),
      b = luminance(bg);
    return { fg: hexOf(g.rgb), bg: background, ratio: rounded((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) };
  });
  return {
    schema: "style-profile/v1",
    source: "image-pixels",
    accentColors: colors.filter((_, i) => !isNeutral(i)).slice(0, 5),
    neutralColors: colors.filter((_, i) => isNeutral(i)).map(({ hex }) => ({ hex })),
    background,
    contrastPairs,
  };
}

/**
 * @param {ReturnType<typeof samplePixels>} sample @param {ReturnType<typeof cluster>} groups
 * @param {import("./optional-decoder.mjs").SharpMetadata} meta
 */
function pictureClass(sample, groups, meta) {
  const { total, transparent, white, flat, edges, pairs } = sample;
  const neutralShare = groups.filter((g) => neutral(g.lab)).reduce((sum, g) => sum + g.count, 0) / total;
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const flatShare = flat / pairs;
  const logoLike =
    Boolean(meta.hasAlpha) &&
    transparent / total > 0.05 &&
    Math.max(width, height) <= 1024 &&
    flatShare > 0.8 &&
    sample.histogram.size < total * 0.15;
  const screenshotLike =
    !logoLike &&
    transparent / total < 0.01 &&
    width >= 600 &&
    height >= 400 &&
    neutralShare > 0.55 &&
    white / total > 0.35 &&
    flatShare > 0.8 &&
    edges / pairs > 0.015;
  return { logoLike, screenshotLike };
}

/** @param {Uint8Array} bytes @param {import("./optional-decoder.mjs").SharpMetadata} meta */
export async function extractImageStyle(bytes, meta) {
  const sharp = await requireSharp("image");
  const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error", animated: false })
    .rotate()
    .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: "inside", withoutEnlargement: true, kernel: "nearest" })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sample = samplePixels(data, info.width);
  const groups = cluster([...sample.histogram.values()]);
  return { styleProfile: paletteProfile(groups, sample.total), ...pictureClass(sample, groups, meta) };
}

/** @param {number} width @param {number} height @param {Buffer|undefined} exif */
export function imageMetadata(width, height, exif) {
  const takenAt = dateTimeOriginal(exif);
  return {
    orientation: width === height ? "square" : width > height ? "landscape" : "portrait",
    ...(takenAt ? { takenAt } : {}),
  };
}
