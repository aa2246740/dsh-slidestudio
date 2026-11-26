/**
 * `text-utf8-v1` — plain UTF-8 text material (txt/md/json). Files that are not
 * valid UTF-8, are empty, or are actually binary are rejected with a Chinese
 * reason; nothing is ever stored as garbled text.
 */
import { MaterialRejection } from "../zip-guard.mjs";
import { buildSummaryZh } from "../summary.mjs";

export const textParser = {
  id: "text-utf8-v1",
  engine: "TextDecoder utf-8",
  /** @type {"text"} */
  kind: "text",

  /**
   * @param {{name: string, bytes: Uint8Array}} input
   * @returns {import("../derivative.mjs").ParserResult<{text: string, chars: number}>}
   */
  parse({ name, bytes }) {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new MaterialRejection("unsupported-encoding", "无法识别文件编码，请另存为 UTF-8 后再上传");
    }
    if (!text.trim()) throw new MaterialRejection("empty", "文件为空");
    // Count code points: an astral char is one 字, not two UTF-16 units.
    const chars = Array.from(text).length;
    return {
      payload: { text, chars },
      summary: buildSummaryZh({
        parserId: this.id,
        chars,
        extension: extensionOf(name),
      }),
      warnings: [],
    };
  },
};

/** @param {string} name */
export function extensionOf(name) {
  const dot = name.toLowerCase().lastIndexOf(".");
  return dot > 0 ? name.toLowerCase().slice(dot) : "";
}
