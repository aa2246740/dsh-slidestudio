/**
 * Parse pool: runs each material parse in a fresh worker thread with a hard
 * heap cap, a wall-clock timeout and a concurrency limit of 2 with a queue.
 * A timed-out or OOM job is answered as a failed record; the pool and the
 * sidecar process survive it.
 */
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export const PARSE_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
});

export const PARSE_TIMEOUT_MS = 10_000;
export const PARSE_MAX_CONCURRENT = 2;

const TIMEOUT_MESSAGE = "文件解析时间过长，已停止；请拆分或简化文件后重试";

let sequence = 0;

export class ParsePool {
  /**
   * @param {{maxConcurrent?: number, timeoutMs?: number, workerPath?: string,
   *   resourceLimits?: import("node:worker_threads").ResourceLimits}} [options]
   */
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent ?? PARSE_MAX_CONCURRENT;
    this.timeoutMs = options.timeoutMs ?? PARSE_TIMEOUT_MS;
    this.resourceLimits = options.resourceLimits ?? PARSE_RESOURCE_LIMITS;
    this.workerPath = options.workerPath ?? fileURLToPath(new URL("./parse-worker.mjs", import.meta.url));
    /** @type {(() => void)[]} */
    this.queue = [];
    this.activeCount = 0;
    this.closed = false;
  }

  /**
   * Parse one attachment. Resolves with the derivative envelope on success or
   * a failure envelope ({status:"failed"|"unsupported", errorCode, message}).
   * @param {{materialId: string, name: string, bytes: Uint8Array, declaredMime?: string}} job
   */
  run(job) {
    if (this.closed) return Promise.reject(new Error("解析池已关闭"));
    return new Promise((resolve, reject) => {
      const task = async () => {
        try {
          resolve(await this.runJob(job));
        } catch (error) {
          reject(error);
        }
      };
      this.queue.push(task);
      this.pump();
    });
  }

  /** @returns {number} */
  get pending() {
    return this.queue.length;
  }

  /** @private */
  pump() {
    while (this.activeCount < this.maxConcurrent && this.queue.length) {
      const task = this.queue.shift();
      this.activeCount += 1;
      void task?.();
    }
  }

  /** @private @param {{materialId: string, name: string, bytes: Uint8Array, declaredMime?: string}} job */
  runJob(job) {
    const jobId = `job-${++sequence}`;
    return new Promise((resolve) => {
      const worker = new Worker(this.workerPath, {
        resourceLimits: this.resourceLimits,
      });
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, code: "timeout", message: TIMEOUT_MESSAGE }), this.timeoutMs);

      /** @param {any} outcome */
      function finish(outcome) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(outcome);
      }

      worker.on("message", (message) => {
        if (message?.jobId !== jobId) return;
        if (message.ok) finish({ ok: true, derivative: message.derivative });
        else finish({ ok: false, code: message.code, message: message.message });
      });
      worker.on("error", (error) => {
        // An aborted isolate (heap overrun, uncaught throw) must not crash the
        // sidecar: answer with a failed record and a fresh worker next time.
        const message = String(error?.message || "");
        if (/allocation|out of memory|heap/i.test(message)) {
          finish({
            ok: false,
            code: "out-of-memory",
            message: "文件解析占用内存过大，无法完成；请拆分或压缩后重试",
          });
        } else {
          finish({
            ok: false,
            code: "corrupt",
            message: "文件解析失败：文件已损坏或内容不完整，无法解析；请重新导出后上传",
          });
        }
      });
      worker.on("exit", (code) => {
        if (!settled && code !== 0)
          finish({ ok: false, code: "corrupt", message: "文件解析失败：解析进程异常退出；请重试" });
      });
      // Structured clone copies the bytes; transfer lists fight Node Buffer
      // pooling and the payloads are bounded by the 20 MiB upload cap.
      worker.postMessage({
        jobId,
        name: job.name,
        bytes: job.bytes,
        declaredMime: job.declaredMime,
        materialId: job.materialId,
      });
    }).finally(() => {
      this.activeCount -= 1;
      this.pump();
    });
  }

  /** Stop the pool and wait for in-flight workers to terminate. */
  async close() {
    this.closed = true;
    this.queue.length = 0;
  }
}

/** Shared sidecar pool: at most 2 parses at once, 10 s per job. */
export const sharedParsePool = new ParsePool();
