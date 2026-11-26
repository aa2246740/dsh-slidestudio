import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadOptionalNative } from "../optional-native.mjs";

const CANVAS_UNAVAILABLE = "页面图片没有生成，看图模型无法查看页面；PDF 文字仍可读取";

/** @param {Uint8Array} bytes */
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

if (process.send) {
  process.on("message", (message) => {
    void handleMessage(message).then(
      (result) => send({ ok: true, result }),
      (error) => {
        const value = error && typeof error === "object" ? error : {};
        send({
          ok: false,
          code: typeof value.code === "string" ? value.code : "render-failed",
          message: typeof value.userMessage === "string" ? value.userMessage : "PDF 页面图片生成失败，文字内容仍可读取",
        });
      },
    );
  });
}

/**
 * The optional native add-ons a page render needs: `@napi-rs/canvas` to paint
 * and `sharp` to encode. Either one missing means no page images (text stays).
 * @returns {Promise<{canvas: any, sharp: any}|undefined>}
 */
async function renderAddOns() {
  const [canvas, sharp] = await Promise.all([loadOptionalNative("@napi-rs/canvas"), loadOptionalNative("sharp")]);
  return canvas && sharp ? { canvas, sharp } : undefined;
}

/** @param {any} message */
function validRenderMessage(message) {
  const config = message?.config;
  const pageIndex = message?.pageIndex;
  return Boolean(
    config &&
    config.width <= 960 &&
    config.maxPages <= 40 &&
    Number.isSafeInteger(pageIndex) &&
    pageIndex >= 1 &&
    pageIndex <= config.maxPages &&
    typeof message.filePath === "string" &&
    typeof message.tempDir === "string",
  );
}

/**
 * One page per child process. Native image memory is returned to the OS when
 * this process exits, so a long document cannot accumulate past the RSS cap.
 * @param {any} message
 */
async function handleMessage(message) {
  if (message?.type === "probe") return { available: Boolean(await renderAddOns()) };
  if (message?.type !== "render") throw new Error("unknown render message");
  if (!validRenderMessage(message)) throw new Error("invalid render configuration");
  const config = message.config;
  const pageIndex = message.pageIndex;
  // The canvas must load in this child for rendering to work; fail closed otherwise.
  const addOns = await renderAddOns();
  if (!addOns) throw renderFailure("canvas-unavailable", CANVAS_UNAVAILABLE);
  const { sharp } = addOns;
  const [unpdf, { extractImageStyle }, { extractPdfPageImageCoverage }] = await Promise.all([
    import("unpdf"),
    import("./image-style.mjs"),
    import("./pdf-style-hints.mjs"),
  ]);
  const { getDocumentProxy, renderPageAsImage } = unpdf;
  // unpdf rejects Node Buffers; pass a plain Uint8Array view of the same bytes.
  const bytes = new Uint8Array(fs.readFileSync(message.filePath));
  // Images must decode here: PDF_DOCUMENT_OPTIONS' maxImageSize:1 is only for vector inspection.
  // Passed through a variable so the unpdf option type does not reject isEvalSupported.
  const documentOptions = { fontExtraProperties: true, isEvalSupported: false };
  const proxy = await getDocumentProxy(bytes, documentOptions);
  try {
    if (pageIndex > proxy.numPages) {
      throw renderFailure("render-failed", "PDF 页码超出文档范围，文字内容仍可读取");
    }
    const page = await proxy.getPage(pageIndex);
    try {
      // Operator-list coverage decodes this page's images here, inside this child.
      const measured = await extractPdfPageImageCoverage({
        unpdf,
        proxy,
        pageNumbers: [pageIndex],
      });
      const rendered = await renderPageAsImage(proxy, pageIndex, {
        canvasImport: async () => addOns.canvas,
        width: config.width,
      });
      const image = Buffer.from(rendered);
      const jpeg = await sharp(image, { failOn: "error", limitInputPixels: 50_000_000 })
        .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
        .toBuffer();
      const metadata = await sharp(jpeg, {
        failOn: "error",
        limitInputPixels: 50_000_000,
      }).metadata();
      if (!metadata.width || !metadata.height || metadata.width > config.width) {
        throw renderFailure("render-failed", "PDF 页面尺寸校验失败，文字内容仍可读取");
      }
      const file = `page-${pageIndex}.jpg`;
      fs.writeFileSync(path.join(message.tempDir, file), jpeg, { flag: "wx" });
      const { styleProfile } = await extractImageStyle(jpeg, metadata);
      const coverage = measured.get(pageIndex);
      return {
        page: {
          index: pageIndex,
          file,
          sha256: digest(jpeg),
          px: { width: metadata.width, height: metadata.height },
        },
        ...(coverage === undefined
          ? {}
          : {
              pageImage: {
                index: pageIndex,
                hasImage: coverage >= 0.5,
                imageCoverage: Math.round(coverage * 1e6) / 1e6,
              },
            }),
        pixelProfile: { profile: styleProfile, pixels: metadata.width * metadata.height },
      };
    } finally {
      page.cleanup?.();
    }
  } finally {
    await /** @type {{loadingTask: {destroy: () => Promise<void>}}} */ (proxy).loadingTask.destroy();
  }
}

/** @param {string} code @param {string} userMessage */
function renderFailure(code, userMessage) {
  const error = new Error(userMessage);
  Object.assign(error, { code, userMessage });
  return error;
}

/** @param {Record<string, unknown>} message */
function send(message) {
  if (!process.send) return process.exit(1);
  process.send(message, () => process.exit(message.ok ? 0 : 1));
}
