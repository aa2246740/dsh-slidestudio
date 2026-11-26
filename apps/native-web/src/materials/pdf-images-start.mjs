/**
 * Starting a PDF's picture reading is separate from awaiting it, so the text parse and the
 * picture reading can overlap and registration can follow the pages as they come.
 */
/** @typedef {import("./pdf-images.mjs").PdfImage} PdfImage */

/**
 * Begin reading a PDF's pictures now and let whoever needs them follow along: the pictures
 * found so far are replayed to a late follower, then each later page's as it arrives. The
 * run's failure is judged where `result` is awaited, never as an unhandled rejection.
 * @param {import("./pdf-images-run.mjs").PdfImageRunner} runner @param {Uint8Array} bytes @param {AbortSignal} [signal]
 * @returns {{result: Promise<import("./pdf-images-run.mjs").PdfImageRunResult>,
 *   follow: (listener: (images: PdfImage[]) => void) => () => void}}
 */
export function startPdfImages(runner, bytes, signal) {
  /** @type {PdfImage[]} */
  const arrived = [];
  /** @type {Set<(images: PdfImage[]) => void>} */
  const listeners = new Set();
  /** @type {Promise<import("./pdf-images-run.mjs").PdfImageRunResult>} */
  let result;
  try {
    result = runner({
      bytes,
      signal,
      onImages: (images) => {
        arrived.push(...images);
        for (const listener of listeners) listener(images);
      },
    });
  } catch (error) {
    result = Promise.reject(error);
  }
  result.catch(() => undefined);
  return {
    result,
    follow(listener) {
      if (arrived.length) listener([...arrived]);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
