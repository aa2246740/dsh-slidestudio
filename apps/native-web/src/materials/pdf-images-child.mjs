/**
 * Child process for PDF embedded-image extraction. Pictures of each finished
 * page are streamed to the parent as they are found, so a kill at the memory or
 * time limit still leaves the parent holding everything extracted so far.
 */
import fs from "node:fs";
import { runPdfImagesJob } from "./pdf-images.mjs";

if (process.send) {
  process.on("message", (message) => {
    void handle(message).then(
      (summary) => send({ type: "done", summary }, true),
      (error) => {
        const value = error && typeof error === "object" ? error : {};
        send(
          {
            type: "error",
            code: typeof value.code === "string" ? value.code : "corrupt",
            message:
              typeof value.message === "string" && value.message
                ? value.message
                : "文件已损坏或内容不完整，无法解析；请重新导出后上传",
          },
          true,
        );
      },
    );
  });
}

/** @param {any} message */
async function handle(message) {
  if (message?.type !== "extract" || typeof message.filePath !== "string") {
    throw new Error("invalid extract message");
  }
  const bytes = new Uint8Array(fs.readFileSync(message.filePath));
  const result = await runPdfImagesJob(bytes, {
    onPage: ({ images, ...progress }) => {
      if (images.length) send({ type: "page", images, ...progress });
    },
  });
  const { images: _streamed, ...summary } = result;
  return summary;
}

/** @param {Record<string, unknown>} message @param {boolean} [last] */
function send(message, last = false) {
  if (!process.send) return process.exit(1);
  if (!last) {
    process.send(message);
    return;
  }
  process.send(message, () => process.exit(message.type === "done" ? 0 : 1));
}
