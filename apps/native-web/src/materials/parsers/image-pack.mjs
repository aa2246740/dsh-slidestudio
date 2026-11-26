import { buildSummaryZh } from "../summary.mjs";
import { inspectImagePack, ignoredImagePackWarning } from "../image-pack.mjs";

export const imagePackParser = {
  id: "image-pack-v1",
  engine: "zip-image-pack",
  /** @type {"image"} */
  kind: "image",

  /**
   * Inspect archive metadata only. Intake extracts each selected image
   * separately and submits it to the ordinary image parser worker queue.
   * @param {{name: string, bytes: Uint8Array}} input
   * @returns {Promise<import("../derivative.mjs").ParserResult<object>>}
   */
  async parse({ bytes }) {
    const inspected = inspectImagePack(bytes);
    const warning = ignoredImagePackWarning(inspected.ignoredNames);
    const imageCount = inspected.images.length;
    return {
      payload: {
        pack: {
          imageCount,
          entryNames: inspected.images.map(({ name }) => name),
          ignoredNames: inspected.ignoredNames,
        },
      },
      summary: buildSummaryZh({ parserId: this.id, imageCount }),
      warnings: warning ? [warning] : [],
      truncated: { applied: false },
    };
  },
};
