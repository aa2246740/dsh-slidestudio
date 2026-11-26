/**
 * Cheap test for decoded PDF bitmaps that are page decoration, not material: long thin
 * strips (rules, banners), pictures that are practically invisible, and one colour under a
 * fading transparency (the shadows, glows and bars a slide export turns into pictures). It
 * reads a sparse grid of the raw pixels pdf.js already decoded, so nothing is encoded or
 * hashed for a bitmap that is going to be dropped. A single-colour logo has a hard-edged
 * mask and stays, and so does an opaque picture, however plain: only these three shapes were
 * seen as noise in real exports.
 */

const DECORATION_LIMITS = Object.freeze({
  /** Longer edge over shorter edge above which a picture is a strip. */
  maxAspect: 8,
  /** Samples per axis; 64 × 64 is plenty to tell a fill from a picture. */
  grid: 64,
  /** Mean alpha (of 255) below which the picture is practically invisible. */
  faintAlphaMean: 8,
  /** Alpha at or above this counts as painted when measuring colour spread. */
  paintedAlpha: 32,
  /** Alpha at or above this is opaque. */
  opaqueAlpha: 240,
  /** Share of partly transparent samples at which a mask is a fade rather than a shape. */
  softShare: 0.5,
  /** Highest per-channel standard deviation (of 255) of the painted pixels still read as
   * one colour. */
  fadeSpread: 12,
});

/** @typedef {{[K in keyof typeof DECORATION_LIMITS]: number}} DecorationLimits */

/**
 * @typedef {{data: Uint8ClampedArray|Uint8Array, width: number, height: number,
 *   channels: number}} RawBitmap
 * @typedef {"strip"|"faint"|"flat"} DecorationReason
 */

/**
 * @param {RawBitmap} bitmap
 * @param {DecorationLimits} limits
 */
function bitmapProfile({ data, width, height, channels }, limits = DECORATION_LIMITS) {
  const stepX = Math.max(1, Math.floor(width / limits.grid));
  const stepY = Math.max(1, Math.floor(height / limits.grid));
  const colourChannels = Math.min(channels, 3);
  const sum = [0, 0, 0];
  const squares = [0, 0, 0];
  let samples = 0;
  let painted = 0;
  let alphaSum = 0;
  let soft = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const offset = (y * width + x) * channels;
      const alpha = channels === 4 ? (data[offset + 3] ?? 0) : 255;
      samples += 1;
      alphaSum += alpha;
      if (alpha >= 16 && alpha < limits.opaqueAlpha) soft += 1;
      if (alpha < limits.paintedAlpha) continue;
      painted += 1;
      for (let channel = 0; channel < colourChannels; channel += 1) {
        const value = data[offset + channel] ?? 0;
        sum[channel] = (sum[channel] ?? 0) + value;
        squares[channel] = (squares[channel] ?? 0) + value * value;
      }
    }
  }
  let spread = 0;
  for (let channel = 0; channel < colourChannels && painted; channel += 1) {
    const mean = (sum[channel] ?? 0) / painted;
    const variance = (squares[channel] ?? 0) / painted - mean * mean;
    spread = Math.max(spread, Math.sqrt(Math.max(0, variance)));
  }
  return {
    spread,
    alphaMean: samples ? alphaSum / samples : 255,
    softShare: samples ? soft / samples : 0,
  };
}

/**
 * @param {RawBitmap} bitmap
 * @param {Partial<DecorationLimits>} [override]
 * @returns {DecorationReason|undefined}
 */
export function decorationReason(bitmap, override) {
  const limits = { ...DECORATION_LIMITS, ...override };
  const long = Math.max(bitmap.width, bitmap.height);
  const short = Math.min(bitmap.width, bitmap.height);
  if (short > 0 && long / short > limits.maxAspect) return "strip";
  // Without transparency there is no fade, and an opaque picture is a picture.
  if (bitmap.channels !== 4) return undefined;
  const measured = bitmapProfile(bitmap, limits);
  if (measured.alphaMean < limits.faintAlphaMean) return "faint";
  return measured.softShare >= limits.softShare && measured.spread <= limits.fadeSpread ? "flat" : undefined;
}
