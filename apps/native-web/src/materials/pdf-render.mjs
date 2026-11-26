import crypto from "node:crypto";
import { execFileSync, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childProcessEnv } from "./child-env.mjs";
import { MAX_PDF_STYLE_PAGES } from "./pdf-style-hints.mjs";

export const PDF_RENDER_CONFIG = Object.freeze({
  childProcess: true,
  concurrency: 1,
  queueCap: 8,
  sampledRssCapMb: 1024,
  pageTimeoutMs: 30_000,
  documentTimeoutMs: 180_000,
  maxPages: 40,
  width: 960,
});

/**
 * @typedef {{peakRssMb: number, durationMs: number}} PdfRenderMetrics
 * @typedef {{index: number, file: string, sha256: string, px: {width: number, height: number}, data?: string}} PdfRenderedPage
 * @typedef {{index: number, hasImage: boolean, imageCoverage: number}} PdfRenderPageImage
 * @typedef {{renderedPages: PdfRenderedPage[], pageImages?: PdfRenderPageImage[],
 *   pixelStyleProfile?: Record<string, any>, metrics?: PdfRenderMetrics}} PdfRenderOutcome
 * @typedef {{page: PdfRenderedPage, pageImage?: PdfRenderPageImage,
 *   pixelProfile?: {profile: Record<string, any>, pixels: number}}} PdfRenderChildResult
 * @typedef {{id: string, run: () => Promise<unknown>, start?: () => unknown,
 *   complete?: (value: PdfRenderOutcome) => unknown,
 *   fail?: (error: {code: string, message: string, peakRssMb?: number}) => unknown}} PdfRenderJob
 * @typedef {{sampledRssCapMb?: number, pageTimeoutMs?: number,
 *   documentTimeoutMs?: number}} PdfRenderLimits
 * @typedef {{limits?: PdfRenderLimits, sampleRssMb?: (pid: number|undefined) => number,
 *   sampleIntervalMs?: number, childPath?: string}} PdfRenderOverrides
 * `childPath` is a test-only stand-in render child (one that needs no canvas).
 */

const CHILD_PATH = fileURLToPath(new URL("./pdf-render-child.mjs", import.meta.url));
const CANVAS_UNAVAILABLE = "页面图片没有生成，看图模型无法查看页面；PDF 文字仍可读取";
const RSS_SAMPLE_INTERVAL_MS = 500;

/** @param {number} ms */
const documentTimeoutMessage = (ms) => `PDF 文档图片生成超过 ${ms / 1000} 秒上限，文字内容仍可读取`;
/** @param {number} ms */
const pageTimeoutMessage = (ms) => `单页 PDF 图片生成超过 ${ms / 1000} 秒上限，文字内容仍可读取；请稍后重试`;
/** @param {number} mb */
const rssLimitMessage = (mb) => `PDF 页面渲染超过 ${mb} MB 内存上限，已停止；文字内容仍可读取`;

/**
 * Only the three kill limits can be replaced, and only by a caller that passes
 * them in; width and page count stay fixed because the child validates them.
 * @param {PdfRenderLimits|undefined} limits
 */
function effectiveLimits(limits) {
  return {
    sampledRssCapMb: limits?.sampledRssCapMb ?? PDF_RENDER_CONFIG.sampledRssCapMb,
    pageTimeoutMs: limits?.pageTimeoutMs ?? PDF_RENDER_CONFIG.pageTimeoutMs,
    documentTimeoutMs: limits?.documentTimeoutMs ?? PDF_RENDER_CONFIG.documentTimeoutMs,
  };
}

/** @param {number} pageCount */
export function renderedPageIndexes(pageCount) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return [];
  return Array.from({ length: Math.min(pageCount, PDF_RENDER_CONFIG.maxPages) }, (_, i) => i + 1);
}

/**
 * One-at-a-time PDF queue. The cap counts the active document plus queued
 * documents, so at most eight jobs can own render memory at once.
 */
export class PdfRenderQueue {
  /** @param {{probe?:()=>Promise<boolean>, onMetrics?:(metrics:PdfRenderMetrics)=>void}} [options] */
  constructor({ probe = probePdfRenderChild, onMetrics = () => {} } = {}) {
    this.available = null;
    /** @type {PdfRenderJob[]} */
    this.pending = [];
    this.activeCount = 0;
    this.closed = false;
    /** @type {Map<string, PdfRenderJob>} */
    this.jobs = new Map();
    this.pumping = false;
    /** @type {((value?: any) => void)[]} */
    this.waiters = [];
    this.onMetrics = onMetrics;
    this.probePromise = Promise.resolve()
      .then(probe)
      .then((available) => {
        this.available = available === true;
        return this.available;
      })
      .catch(() => {
        this.available = false;
        return false;
      });
  }

  /** @returns {Promise<boolean>} */
  ready() {
    return this.probePromise;
  }

  /** @returns {number} */
  get outstanding() {
    return this.pending.length + this.activeCount;
  }

  /** @param {PdfRenderJob} job */
  enqueue(job) {
    if (this.closed || !job?.id || typeof job.run !== "function") return false;
    if (this.jobs.has(job.id)) return true;
    if (this.outstanding >= PDF_RENDER_CONFIG.queueCap) return false;
    this.jobs.set(job.id, job);
    this.pending.push(job);
    void this.pump();
    return true;
  }

  /** Wait for all currently accepted documents to finish. */
  drain() {
    if (!this.outstanding && !this.pumping) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close() {
    this.closed = true;
  }

  /** @private */
  async pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      const available = await this.ready();
      if (!available) {
        while (this.pending.length) {
          const job = this.pending.shift();
          if (!job) continue;
          await settleCallback(job.fail, {
            code: "canvas-unavailable",
            message: CANVAS_UNAVAILABLE,
          });
          this.jobs.delete(job.id);
        }
        return;
      }
      while (!this.closed && this.pending.length) {
        const job = this.pending.shift();
        if (!job) continue;
        this.activeCount = 1;
        try {
          await settleCallback(job.start);
          const result = await job.run();
          await settleCallback(job.complete, result);
        } catch (error) {
          await settleCallback(job.fail, normalizeRenderError(error));
        } finally {
          this.activeCount = 0;
          this.jobs.delete(job.id);
        }
      }
    } finally {
      this.pumping = false;
      if (!this.outstanding) this.waiters.splice(0).forEach((resolve) => resolve());
      else if (!this.closed && this.pending.length) void this.pump();
    }
  }
}

export const sharedPdfRenderQueue = new PdfRenderQueue();

/** @param {((value:any)=>unknown)|undefined} callback @param {any} [value] */
async function settleCallback(callback, value) {
  try {
    await callback?.(value);
  } catch {
    // A derivative write failure must not escape into parsing or the HTTP route.
  }
}

/** @param {unknown} error */
function normalizeRenderError(error) {
  const value = /** @type {{code?:string,message?:string,peakRssMb?:number}} */ (error);
  return {
    code: typeof value?.code === "string" ? value.code : "render-failed",
    message: typeof value?.message === "string" ? value.message : "PDF 页面图片生成失败，文字内容仍可读取",
    ...(Number.isFinite(value?.peakRssMb) ? { peakRssMb: value.peakRssMb } : {}),
  };
}

/**
 * Render each page in its own child process inside one document budget. A page
 * that exceeds its timeout or the RSS cap fails the whole document, which then
 * keeps its text and has no page images.
 * `overrides` exists so tests can force each kill path; production callers omit
 * it and run with PDF_RENDER_CONFIG and the real process sampler.
 * @param {{filePath:string,pageCount:number,onMetrics?:(metrics:PdfRenderMetrics)=>void,
 *   overrides?:PdfRenderOverrides}} input
 */
export async function runPdfRenderChild({ filePath, pageCount, onMetrics, overrides }) {
  const limits = effectiveLimits(overrides?.limits);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-pdf-render-"));
  const startedAt = Date.now();
  let peakRssMb = 0;
  /** @type {PdfRenderedPage[]} */
  const renderedPages = [];
  /** @type {PdfRenderPageImage[]} */
  const pageImages = [];
  /** @type {{profile: Record<string, any>, pixels: number}[]} */
  const pixelProfiles = [];
  try {
    for (const index of renderedPageIndexes(pageCount)) {
      const remainingMs = limits.documentTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw renderError("render-timeout", documentTimeoutMessage(limits.documentTimeoutMs));
      }
      const pageBudgetMs = Math.min(limits.pageTimeoutMs, remainingMs);
      const outcome = await runChildMessage(
        {
          type: "render",
          filePath,
          tempDir,
          pageIndex: index,
          pageCount,
          config: PDF_RENDER_CONFIG,
        },
        {
          timeoutMs: pageBudgetMs,
          timeoutMessage:
            pageBudgetMs < limits.pageTimeoutMs
              ? documentTimeoutMessage(limits.documentTimeoutMs)
              : pageTimeoutMessage(limits.pageTimeoutMs),
          rssCapMb: limits.sampledRssCapMb,
          sampleRssMb: overrides?.sampleRssMb,
          sampleIntervalMs: overrides?.sampleIntervalMs,
          childPath: overrides?.childPath,
        },
      ).catch((/** @type {{peakRssMb?: number}} */ failure) => {
        peakRssMb = Math.max(peakRssMb, failure.peakRssMb ?? 0);
        throw failure;
      });
      peakRssMb = Math.max(peakRssMb, outcome.peakRssMb);
      const { page, pageImage, pixelProfile } = /** @type {PdfRenderChildResult} */ (outcome.value);
      const bytes = fs.readFileSync(path.join(tempDir, page.file));
      if (digest(bytes) !== page.sha256) {
        throw renderError("render-failed", "PDF 页面图片校验失败，文字内容仍可读取");
      }
      renderedPages.push({ ...page, data: bytes.toString("base64") });
      if (pageImage) pageImages.push(pageImage);
      if (pixelProfile) pixelProfiles.push(pixelProfile);
    }
  } catch (error) {
    const failure = /** @type {{code?:unknown,message?:unknown,peakRssMb?:number}} */ (error);
    throw {
      ...normalizeRenderError(failure),
      peakRssMb: Math.max(peakRssMb, failure.peakRssMb ?? 0),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  onMetrics?.({ peakRssMb, durationMs: Date.now() - startedAt });
  return { renderedPages, pageImages, pixelStyleProfile: combinePixelProfiles(pixelProfiles) };
}

/**
 * Probe the optional canvas (and image encoder) in the same isolated child-process
 * environment as rendering. Resolves false, never rejects, when either is missing.
 * @param {{childPath?: string}} [options] test-only stand-in child
 */
export function probePdfRenderChild({ childPath } = {}) {
  return runChildMessage(
    { type: "probe" },
    { timeoutMs: 30_000, timeoutMessage: "PDF 页面图片能力检查超时", childPath },
  )
    .then((outcome) => outcome.value?.available === true)
    .catch(() => false);
}

/**
 * @param {Record<string,unknown>} message
 * @param {{timeoutMs:number, timeoutMessage:string, rssCapMb?:number,
 *   sampleRssMb?:(pid:number|undefined)=>number, sampleIntervalMs?:number,
 *   childPath?:string}} limit
 * @returns {Promise<{value:any, peakRssMb:number, durationMs:number}>}
 */
function runChildMessage(
  message,
  {
    timeoutMs,
    timeoutMessage,
    rssCapMb = PDF_RENDER_CONFIG.sampledRssCapMb,
    sampleRssMb = childRssMb,
    sampleIntervalMs = RSS_SAMPLE_INTERVAL_MS,
    childPath = CHILD_PATH,
  },
) {
  return new Promise((resolve, reject) => {
    const child = fork(childPath, [], {
      cwd: path.dirname(childPath),
      env: childProcessEnv(),
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    });
    let settled = false;
    let peakRssMb = 0;
    const startedAt = Date.now();
    /** @param {unknown} error @param {any} [value] */
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(sampler);
      const durationMs = Date.now() - startedAt;
      if (error) {
        child.kill("SIGKILL");
        reject({ ...normalizeRenderError(error), peakRssMb, durationMs });
      } else {
        resolve({ value, peakRssMb, durationMs });
      }
    };
    const timer = setTimeout(() => finish(renderError("render-timeout", timeoutMessage)), timeoutMs);
    const sampler = setInterval(() => {
      const rssMb = sampleRssMb(child.pid);
      if (!Number.isFinite(rssMb) || rssMb <= 0) return;
      peakRssMb = Math.max(peakRssMb, rssMb);
      if (rssMb > rssCapMb) {
        finish(renderError("render-limit", rssLimitMessage(rssCapMb)));
      }
    }, sampleIntervalMs);
    sampler.unref?.();
    child.once("message", (/** @type {any} */ reply) => {
      if (reply?.ok === true) finish(undefined, reply.result ?? {});
      else finish(renderError(reply?.code, reply?.message));
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(
          renderError(
            "render-failed",
            `PDF 页面图片子进程异常退出（${signal || code || "unknown"}），文字内容仍可读取`,
          ),
        );
      }
    });
    child.send(message, (error) => {
      if (error) finish(error);
    });
  });
}

/**
 * Average the per-page pixel palettes, weighting accents and background by
 * page area. Each page is measured in its own child, so only the merge is here.
 * Only the first MAX_PDF_STYLE_PAGES pages count, the same window as the vector
 * scan, so pagesScanned stays inside the published 1..30 bound.
 * @param {{profile: Record<string, any>, pixels: number}[]} pages
 */
export function combinePixelProfiles(pages) {
  const entries = pages.slice(0, MAX_PDF_STYLE_PAGES);
  if (!entries.length) return undefined;
  const accents = new Map();
  const neutrals = new Set();
  let background;
  let backgroundWeight = -1;
  for (const { profile, pixels } of entries) {
    for (const color of profile.accentColors ?? []) {
      const weight = pixels * color.share;
      const existing = accents.get(color.hex) ?? 0;
      accents.set(color.hex, existing + weight);
    }
    for (const color of profile.neutralColors ?? []) neutrals.add(color.hex);
    const currentBackground = profile.background;
    const currentWeight = pixels * (profile.backgroundShare ?? 1);
    if (currentBackground && currentWeight > backgroundWeight) {
      background = currentBackground;
      backgroundWeight = currentWeight;
    }
  }
  const total = [...accents.values()].reduce((sum, value) => sum + value, 0);
  return {
    schema: "style-profile/v1",
    source: "pdf-page-pixels",
    pagesScanned: entries.length,
    accentColors: [...accents.entries()]
      .sort(([hexA, a], [hexB, b]) => b - a || hexA.localeCompare(hexB))
      .slice(0, 5)
      .map(([hex, weight]) => ({ hex, share: Math.round((weight / total) * 1e6) / 1e6 })),
    neutralColors: [...neutrals]
      .sort()
      .slice(0, 12)
      .map((hex) => ({ hex })),
    ...(background ? { background } : {}),
  };
}

/** Resident memory of a child process in MB (0 when it cannot be read).
 * @param {number|undefined} pid */
export function childRssMb(pid) {
  if (!pid) return 0;
  try {
    if (process.platform === "linux") {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1];
      return rss ? Number(rss) / 1024 : 0;
    }
    const rss = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return Number(rss) / 1024;
  } catch {
    return 0;
  }
}

/** @param {unknown} code @param {unknown} message */
function renderError(code, message) {
  const error = new Error(typeof message === "string" ? message : "PDF 页面图片生成失败，文字内容仍可读取");
  Object.assign(error, {
    code: typeof code === "string" ? code : "render-failed",
  });
  return error;
}

/** @param {Uint8Array} bytes */
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Preserve the M2 vector profile and add page-pixel statistics as a separate
 * source so both palettes remain attributable and independently bounded.
 * Without vector hints the top level describes the pixel pages it measured.
 * @param {Record<string,any>|undefined} vector
 * @param {Record<string,any>|undefined} pixels
 */
export function mergePdfPixelStyle(vector, pixels) {
  if (!pixels || pixels.source !== "pdf-page-pixels") return vector;
  const base =
    vector && vector.schema === "style-profile/v1"
      ? vector
      : {
          schema: "style-profile/v1",
          source: "pdf-page-pixels",
          pagesScanned: pixels.pagesScanned,
          accentColors: [],
          neutralColors: [],
          fonts: [],
        };
  return { ...base, pagePixels: pixels };
}
