import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  LEGACY_CONVERT_DEFAULTS,
  LEGACY_FAMILIES,
  WARMUP_DOCUMENT,
  WARMUP_SPEC,
  fixedSofficeCandidates,
  legacyJobEnv,
  resolveLegacyConfig,
} from "./legacy-convert-config.mjs";
import { execProbe, probeIsolation, wrapSoffice } from "./legacy-convert-isolation.mjs";
import {
  collectOutput,
  createJobDir,
  prepareProfile,
  promoteTemplate,
  readyTemplate,
  removeJobDir,
  sweepStaleJobs,
} from "./legacy-convert-job.mjs";
import { createProcessRunner } from "./legacy-convert-process.mjs";
import { sampleGroupRssMb } from "./legacy-convert-rss.mjs";

/**
 * @typedef {import("./legacy-convert-config.mjs").LegacyFamily} LegacyFamily
 * @typedef {import("./legacy-convert-isolation.mjs").IsolationMode} IsolationMode
 * @typedef {"corrupt"|"timeout"|"out-of-memory"|"convert-failed"|"convert-busy"|"too-large"} ConvertCode
 * @typedef {{available: boolean, isolation: IsolationMode, reason?: string, engineVersion?: string}} LegacyConvertInfo
 * @typedef {{ok: true, bytes: Buffer, durationMs: number, peakRssMb: number, engineVersion?: string,
 *   isolation: IsolationMode, to: string}} ConvertSuccess
 * @typedef {{ok: false, code: ConvertCode, message: string, peakRssMb?: number}} ConvertFailure
 * @typedef {{outcome: "success"|ConvertCode, code: ConvertCode|null, durationMs: number}} ConvertEvent
 * @typedef {{env?: Record<string, string|undefined>, platform?: string,
 *   isolation?: import("./legacy-convert-config.mjs").SandboxMode, sofficePath?: string, candidates?: string[],
 *   dataDir?: string, jobRoot?: string,
 *   spawn?: typeof nodeSpawn, kill?: (pid: number, signal: NodeJS.Signals) => unknown,
 *   sampleRssMb?: (pgid: number) => Promise<number>,
 *   runProbe?: import("./legacy-convert-isolation.mjs").RunProbe,
 *   log?: (entry: Record<string, unknown>) => void, onEvent?: (event: ConvertEvent) => void,
 *   timeoutMs?: number, maxRssMb?: number, maxOutputBytes?: number}} LegacyConverterOptions
 */

const MIN_WARMUP_TIMEOUT_MS = 120_000;
const STARTING = "旧版格式转换正在启动";
const NOT_FOUND = "未找到 LibreOffice（soffice），旧版 .ppt、.doc、.xls 的转换不可用";
const WARMUP_FAILED = "LibreOffice 预热转换失败，旧版格式转换不可用";
const OFF = "旧版格式转换已关闭（SLIDESTUDIO_LEGACY_CONVERT=off）";

/** @param {Record<string, unknown>} entry */
function stderrLog(entry) {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: "info", ...entry })}\n`);
}

/** @param {string} to */
const saveAs = (to) => `请在 WPS 或 Office 中另存为 .${to} 后重新上传`;

/**
 * @param {ConvertCode} code @param {string} to
 * @param {{timeoutMs: number, maxRssMb: number}} limits
 * @returns {string}
 */
function failureMessage(code, to, limits) {
  switch (code) {
    case "timeout":
      return `转换超过 ${Math.round(limits.timeoutMs / 1000)} 秒，已停止；${saveAs(to)}`;
    case "out-of-memory":
      return `转换占用内存超过 ${limits.maxRssMb} MB，已停止；${saveAs(to)}`;
    case "corrupt":
      return `文件无法转换，可能已损坏；${saveAs(to)}`;
    case "too-large":
      return `转换后的文件超过 50 MB 上限；${saveAs(to)}`;
    case "convert-busy":
      return "旧版格式转换队列已满，请稍后重试";
    default:
      return `转换失败；${saveAs(to)}`;
  }
}

/**
 * The converter for legacy .ppt/.doc/.xls files: one soffice child at a time,
 * in its own job directory, with an independent deadline, a memory cap and a
 * network-isolated sandbox where the platform has one. Warm-up starts at
 * construction and never blocks the caller.
 * @param {LegacyConverterOptions} [options]
 */
export function createLegacyConverter(options = {}) {
  const platform = options.platform ?? process.platform;
  const log = (/** @type {Record<string, unknown>} */ entry) => {
    try {
      (options.log ?? stderrLog)(entry);
    } catch {
      // A failing log sink must not stop a conversion.
    }
  };
  const config = resolveLegacyConfig(options.env ?? process.env, log);
  const limits = Object.freeze({
    timeoutMs: options.timeoutMs ?? config.timeoutMs,
    maxRssMb: options.maxRssMb ?? config.maxRssMb,
    queueCap: LEGACY_CONVERT_DEFAULTS.queueCap,
    concurrency: LEGACY_CONVERT_DEFAULTS.concurrency,
  });
  const maxOutputBytes = options.maxOutputBytes ?? LEGACY_CONVERT_DEFAULTS.maxOutputBytes;
  const spawn = options.spawn ?? nodeSpawn;
  const sampleRssMb = options.sampleRssMb ?? ((/** @type {number} */ pgid) => sampleGroupRssMb(pgid, platform));
  const runProbe = options.runProbe ?? execProbe;
  const jobRoot = options.jobRoot ?? os.tmpdir();
  const dataDir = options.dataDir ?? path.join(os.tmpdir(), "slidestudio-legacy-convert");
  const kill =
    options.kill ?? ((/** @type {number} */ pid, /** @type {NodeJS.Signals} */ signal) => process.kill(pid, signal));

  /** @type {LegacyConvertInfo} */
  let state = { available: false, isolation: "none", reason: STARTING };
  /** @type {import("./legacy-convert-isolation.mjs").IsolationPlan | undefined} */
  let plan;
  /** @type {string|undefined} */
  let soffice;
  const processes = createProcessRunner({
    spawn,
    kill,
    sampleRssMb,
    maxRssMb: limits.maxRssMb,
    maxOutputBytes,
  });
  // A parent that exits mid-conversion must not leave soffice running.
  if (!options.kill) process.once("exit", () => processes.killLive());

  /**
   * One soffice conversion inside a prepared job directory.
   * @param {import("./legacy-convert-job.mjs").JobDir} job
   * @param {{infilter: string, to: string, filter: string}} spec
   * @param {string} inputName @param {number} timeoutMs
   */
  function convertInJob(job, spec, inputName, timeoutMs) {
    if (!plan?.ok || !soffice) throw new Error("converter is not ready");
    const env = legacyJobEnv(job.dir);
    const args = [
      `-env:UserInstallation=${pathToFileURL(job.profile).href}`,
      "--headless",
      "--invisible",
      "--norestore",
      "--nolockcheck",
      "--nodefault",
      "--nologo",
      `--infilter=${spec.infilter}`,
      "--convert-to",
      spec.filter,
      "--outdir",
      job.out,
      path.join(job.input, inputName),
    ];
    const wrapped = wrapSoffice(plan, {
      soffice,
      args,
      jobDir: job.dir,
      env,
      maxRssMb: limits.maxRssMb,
      unit: `oss-lo-${crypto.randomBytes(6).toString("hex")}`,
    });
    // Scope tools need the user bus; the soffice inside never sees these.
    const childEnv = wrapped.scopeUnit ? { ...env, ...userBusEnv(options.env ?? process.env) } : env;
    return processes.run({
      command: wrapped.command,
      args: wrapped.args,
      cwd: job.tmp,
      env: childEnv,
      timeoutMs,
      outDir: job.out,
      killScope: wrapped.killScope,
    });
  }

  /** @param {Omit<LegacyConvertInfo, "isolation"> & {isolation?: IsolationMode}} next */
  function settle(next) {
    state = {
      available: next.available,
      isolation: next.available ? (next.isolation ?? "none") : "none",
      ...(next.reason ? { reason: next.reason } : {}),
      ...(next.engineVersion ? { engineVersion: next.engineVersion } : {}),
    };
    // Off is the operator's choice, not a warm-up outcome: health says so and the log stays quiet.
    if (next.reason !== OFF) log({ event: "legacy-convert.state", ...state });
    return info();
  }

  /** @returns {{path?: string, reason?: string}} */
  function locateSoffice() {
    const configured = options.sofficePath ?? config.sofficePath;
    // A configured path is the only candidate: nothing else is tried when it is wrong.
    const candidates = configured ? [configured] : (options.candidates ?? fixedSofficeCandidates());
    for (const candidate of candidates) {
      try {
        if (path.isAbsolute(candidate) && fs.statSync(candidate).isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return { path: candidate };
        }
      } catch {
        // Try the next candidate.
      }
    }
    return {
      reason: configured
        ? "SLIDESTUDIO_SOFFICE_PATH 指定的 soffice 不存在或不可执行，旧版格式转换不可用（不会回退到自动查找）"
        : NOT_FOUND,
    };
  }

  async function warmUp() {
    const job = await createJobDir(jobRoot);
    try {
      const template = await readyTemplate(dataDir);
      await prepareProfile(template, job.profile);
      await fs.promises.writeFile(path.join(job.input, "input.fodt"), WARMUP_DOCUMENT, {
        mode: 0o600,
      });
      const end = await convertInJob(job, WARMUP_SPEC, "input.fodt", Math.max(limits.timeoutMs, MIN_WARMUP_TIMEOUT_MS));
      const output =
        end.kind === "exit" && end.code === 0
          ? await collectOutput(job.out, WARMUP_SPEC.to, maxOutputBytes)
          : undefined;
      if (!output?.ok) return settle({ available: false, reason: WARMUP_FAILED });
      const engineVersion = soffice
        ? await processes.readVersion(soffice, { cwd: job.tmp, env: legacyJobEnv(job.dir) })
        : undefined;
      if (!template) await promoteTemplate(dataDir, job.profile);
      return settle({ available: true, isolation: plan?.name, engineVersion });
    } finally {
      await removeJobDir(job.dir);
    }
  }

  async function start() {
    try {
      if (config.mode === "off") return settle({ available: false, reason: OFF });
      const found = locateSoffice();
      soffice = found.path;
      if (!soffice) return settle({ available: false, reason: found.reason });
      plan = await probeIsolation({
        platform,
        mode: options.isolation ?? config.sandbox,
        runProbe,
        maxRssMb: limits.maxRssMb,
      });
      if (!plan.ok) return settle({ available: false, reason: plan.reason });
      await sweepStaleJobs(jobRoot);
      return await warmUp();
    } catch {
      return settle({ available: false, reason: WARMUP_FAILED });
    }
  }

  function info() {
    return { ...state };
  }

  const startup = start();
  /** @type {Array<{input: {bytes: Uint8Array, family: string, vendor?: string}, queuedAt: number,
   *   resolve: (result: ConvertSuccess|ConvertFailure) => void}>} */
  const queue = [];
  let active = 0;

  /**
   * @param {{bytes: Uint8Array, family: string, vendor?: string}} input
   * @param {{result: ConvertSuccess|ConvertFailure, durationMs: number, peakRssMb: number, killed: boolean,
   *   queueWaitMs: number}} outcome
   */
  function report(input, { result, durationMs, peakRssMb, killed, queueWaitMs }) {
    const outcome = result.ok ? "success" : result.code;
    const vendor = typeof input.vendor === "string" && /^[a-z0-9-]{1,16}$/.test(input.vendor) ? input.vendor : null;
    log({
      event: "material.legacy-convert",
      sha256Prefix: crypto
        .createHash("sha256")
        .update(input.bytes ?? new Uint8Array())
        .digest("hex")
        .slice(0, 8),
      bytes: input.bytes?.byteLength ?? 0,
      family: typeof input.family === "string" && input.family in LEGACY_FAMILIES ? input.family : "unknown",
      vendor,
      outcome,
      code: result.ok ? null : result.code,
      durationMs,
      peakRssMb,
      killed,
      isolation: state.isolation,
      engineVersion: state.engineVersion ?? null,
      queueWaitMs,
    });
    try {
      options.onEvent?.({ outcome, code: result.ok ? null : result.code, durationMs });
    } catch {
      // Metrics are best effort.
    }
    return result;
  }

  /**
   * Resolves true once startup has settled within the bound, false when the
   * bound expires first. The shared warm-up is never cancelled by a waiting
   * upload: it keeps running and late arrivals only stop waiting.
   * @param {number} [boundMs] @returns {Promise<boolean>}
   */
  function waitReady(boundMs = limits.timeoutMs) {
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const expiry = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, boundMs));
    });
    return Promise.race([startup.then(() => true), expiry]).finally(() => clearTimeout(timer));
  }

  /**
   * @param {{input: {bytes: Uint8Array, family: string, vendor?: string}, queuedAt: number}} job
   * @returns {Promise<ConvertSuccess|ConvertFailure>}
   */
  async function execute({ input, queuedAt }) {
    const queueWaitMs = Math.round(performance.now() - queuedAt);
    const spec = LEGACY_FAMILIES[/** @type {LegacyFamily} */ (input.family)];
    /** @param {ConvertCode} code @param {number} [peakRssMb] */
    const refuse = (code, peakRssMb = 0) =>
      /** @type {ConvertFailure} */ ({
        ok: false,
        code,
        message: failureMessage(code, spec.to, limits),
        ...(peakRssMb ? { peakRssMb } : {}),
      });
    // Warm-up is asynchronous and shared: an upload arriving during it waits
    // at most timeoutMs (architecture §3.24), then gets the existing
    // retryable timeout while warm-up keeps running.
    if (!(await waitReady())) {
      return report(input, {
        result: refuse("timeout"),
        durationMs: 0,
        peakRssMb: 0,
        killed: false,
        queueWaitMs,
      });
    }
    if (!state.available) {
      const result = refuse("convert-failed");
      result.message = `${state.reason ?? WARMUP_FAILED}；${saveAs(spec.to)}`;
      return report(input, { result, durationMs: 0, peakRssMb: 0, killed: false, queueWaitMs });
    }
    const started = performance.now();
    let peakRssMb = 0;
    let killed = false;
    /** @type {ConvertSuccess|ConvertFailure} */
    let result;
    /** @type {import("./legacy-convert-job.mjs").JobDir|undefined} */
    let job;
    try {
      job = await createJobDir(jobRoot);
      await prepareProfile(await readyTemplate(dataDir), job.profile);
      await fs.promises.writeFile(path.join(job.input, `input.${input.family}`), input.bytes, {
        mode: 0o600,
      });
      const end = await convertInJob(job, spec, `input.${input.family}`, limits.timeoutMs);
      ({ peakRssMb, killed } = end);
      if (end.kind === "timeout" || end.kind === "out-of-memory" || end.kind === "too-large") {
        result = refuse(end.kind, peakRssMb);
      } else if (end.kind !== "exit" || end.code !== 0) {
        result = refuse("convert-failed", peakRssMb);
      } else {
        const output = await collectOutput(job.out, spec.to, maxOutputBytes);
        result = output.ok
          ? {
              ok: true,
              bytes: output.bytes,
              durationMs: Math.round(performance.now() - started),
              peakRssMb,
              engineVersion: state.engineVersion,
              isolation: state.isolation,
              to: spec.to,
            }
          : refuse(output.code, peakRssMb);
      }
    } catch {
      result = refuse("convert-failed", peakRssMb);
    } finally {
      // The job's own pipes live under TMPDIR inside the job dir, so removing
      // it is the whole cleanup; shared-temp sockets are never touched.
      if (job) await removeJobDir(job.dir);
    }
    return report(input, {
      result,
      durationMs: Math.round(performance.now() - started),
      peakRssMb,
      killed,
      queueWaitMs,
    });
  }

  function pump() {
    while (active < limits.concurrency && queue.length) {
      const next = queue.shift();
      if (!next) break;
      active += 1;
      void execute(next)
        .then(next.resolve)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return {
    limits,
    ready: () => startup,
    waitReady,
    info,
    get available() {
      return state.available;
    },
    get outstanding() {
      return queue.length + active;
    },
    /**
     * Convert one legacy file. Never rejects: every outcome is a result.
     * @param {{bytes: Uint8Array, family: string, vendor?: string}} input
     * @returns {Promise<ConvertSuccess|ConvertFailure>}
     */
    run(input) {
      const queuedAt = performance.now();
      const family = /** @type {LegacyFamily} */ (input?.family);
      if (!Object.hasOwn(LEGACY_FAMILIES, family) || !(input.bytes instanceof Uint8Array)) {
        return Promise.resolve(
          report(input ?? { bytes: new Uint8Array(), family: "unknown" }, {
            result: {
              ok: false,
              code: "convert-failed",
              message: "不支持的旧版文件类型；请另存为 .pptx、.docx 或 .xlsx 后重新上传",
            },
            durationMs: 0,
            peakRssMb: 0,
            killed: false,
            queueWaitMs: 0,
          }),
        );
      }
      if (queue.length + active >= limits.queueCap) {
        return Promise.resolve(
          report(input, {
            result: {
              ok: false,
              code: "convert-busy",
              message: failureMessage("convert-busy", LEGACY_FAMILIES[family].to, limits),
            },
            durationMs: 0,
            peakRssMb: 0,
            killed: false,
            queueWaitMs: 0,
          }),
        );
      }
      return new Promise((resolve) => {
        queue.push({ input, queuedAt, resolve });
        pump();
      });
    },
  };
}

/**
 * One converter per process, created on first use so importing a module that
 * holds it starts nothing.
 * @param {LegacyConverterOptions} options
 */
export function lazyLegacyConverter(options) {
  /** @type {ReturnType<typeof createLegacyConverter>|undefined} */
  let converter;
  return () => (converter ??= createLegacyConverter(options));
}

/** @param {Record<string, string|undefined>} source */
function userBusEnv(source) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = source[key] ?? process.env[key];
    if (value) env[key] = value;
  }
  return env;
}
