/**
 * Parent side of PDF embedded-image extraction: one child process per document,
 * one document at a time, with a sampled RSS cap and a wall-clock limit. Hitting
 * either limit stops the child and returns the pictures it had already sent
 * (flagged `stopped`), so a heavy PDF degrades to a warning, never to a failed
 * upload or a grown sidecar.
 */
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childProcessEnv } from "./child-env.mjs";
import { emptyPdfImageSkips } from "./pdf-images.mjs";
import { childRssMb } from "./pdf-render.mjs";

const PDF_IMAGE_RUN = Object.freeze({
  concurrency: 1,
  queueCap: 8,
  sampledRssCapMb: 1024,
  timeoutMs: 25_000,
});

const CHILD_PATH = fileURLToPath(new URL("./pdf-images-child.mjs", import.meta.url));
const SAMPLE_INTERVAL_MS = 250;

/**
 * @typedef {import("./pdf-images.mjs").PdfImage} PdfImage
 * @typedef {{images: PdfImage[], qualifying: number, countComplete: boolean,
 *   pagesScanned: number, pageCount: number, skipped: import("./pdf-images.mjs").PdfImageSkips,
 *   timedOut: boolean, stopped?: "memory"|"time"}} PdfImageRunResult
 * Test-only injection: kill limits, the RSS sampler and a stand-in child script. Production
 * callers pass none of it.
 * @typedef {{limits?: {concurrency?: number, queueCap?: number, sampledRssCapMb?: number,
 *   timeoutMs?: number}, sampleRssMb?: (pid: number|undefined) => number,
 *   sampleIntervalMs?: number, childPath?: string}} PdfImageRunOverrides
 * `onImages` receives the pictures of each finished page as they arrive, in page order, so a
 * caller can start on them while later pages are still being read; the final result still
 * lists every picture.
 * `signal` abandons the run: a queued run never starts, a running child is killed, and the
 * promise rejects with code `aborted`.
 * @typedef {(input: {bytes: Uint8Array, overrides?: PdfImageRunOverrides,
 *   onImages?: (images: PdfImage[]) => void, signal?: AbortSignal}) => Promise<PdfImageRunResult>} PdfImageRunner
 */

function abortedError() {
  return Object.assign(new Error("图片提取已取消"), { code: "aborted" });
}

/**
 * @param {{bytes: Uint8Array, overrides?: PdfImageRunOverrides,
 *   onImages?: (images: PdfImage[]) => void, signal?: AbortSignal}} input
 * @returns {Promise<PdfImageRunResult>}
 */
export function runPdfImagesChild({ bytes, overrides, onImages, signal }) {
  if (signal?.aborted) return Promise.reject(abortedError());
  const limits = { ...PDF_IMAGE_RUN, ...overrides?.limits };
  const sampleRssMb = overrides?.sampleRssMb ?? childRssMb;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-pdf-images-"));
  const file = path.join(dir, "input.pdf");
  try {
    fs.writeFileSync(file, bytes, { flag: "wx" });
  } catch (error) {
    // Nothing else owns the directory yet, so a failed write must not leave it behind.
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return new Promise((resolve, reject) => {
    const childPath = overrides?.childPath ?? CHILD_PATH;
    let child;
    try {
      child = fork(childPath, [], {
        cwd: path.dirname(childPath),
        env: childProcessEnv(),
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      reject(error);
      return;
    }
    /** @type {PdfImage[]} */
    const images = [];
    let qualifying = 0;
    let pagesScanned = 0;
    let skipped = emptyPdfImageSkips();
    let settled = false;
    /** @param {Error|undefined} error @param {Partial<PdfImageRunResult>} [summary] */
    const finish = (error, summary) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(sampler);
      child.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true });
      if (error) reject(error);
      else {
        resolve({
          images,
          qualifying,
          countComplete: false,
          pagesScanned,
          pageCount: 0,
          skipped,
          timedOut: false,
          ...summary,
        });
      }
    };
    const timer = setTimeout(() => finish(undefined, { stopped: "time", timedOut: true }), limits.timeoutMs);
    signal?.addEventListener("abort", () => finish(abortedError()), { once: true });
    const sampler = setInterval(() => {
      const rssMb = sampleRssMb(child.pid);
      if (Number.isFinite(rssMb) && rssMb > limits.sampledRssCapMb) {
        finish(undefined, { stopped: "memory" });
      }
    }, overrides?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS);
    sampler.unref?.();
    child.on("message", (/** @type {any} */ message) => {
      if (message?.type === "page") {
        /** @type {PdfImage[]} */
        const arrived = message.images.map((/** @type {PdfImage} */ image) => ({
          ...image,
          bytes: Buffer.from(image.bytes),
        }));
        images.push(...arrived);
        try {
          onImages?.(arrived);
        } catch {
          // A listener that fails must not take the extraction down with it.
        }
        qualifying = message.qualifying;
        pagesScanned = message.pagesScanned;
        skipped = message.skipped;
      } else if (message?.type === "done") {
        finish(undefined, message.summary);
      } else if (message?.type === "error") {
        finish(Object.assign(new Error(message.message), { code: message.code }));
      }
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      finish(new Error(`图片提取子进程异常退出（${signal || code || "unknown"}）`));
    });
    child.send({ type: "extract", filePath: file }, (error) => {
      if (error) finish(error);
    });
  });
}

/**
 * Serialize extraction jobs (one child at a time) behind a bounded queue.
 * @param {{run?: PdfImageRunner, queueCap?: number}} [options]
 * @returns {PdfImageRunner}
 */
export function createPdfImageRunner({ run = runPdfImagesChild, queueCap = PDF_IMAGE_RUN.queueCap } = {}) {
  let tail = Promise.resolve();
  let outstanding = 0;
  return (input) => {
    if (outstanding >= queueCap) {
      return Promise.reject(Object.assign(new Error("图片提取队列已满，请稍后重新上传"), { code: "queue-full" }));
    }
    outstanding += 1;
    const result = tail.then(() => run(input));
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      outstanding -= 1;
    });
  };
}

export const sharedPdfImages = createPdfImageRunner();
