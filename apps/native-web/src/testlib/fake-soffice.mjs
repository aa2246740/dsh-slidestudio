import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

export const FAKE_ENGINE_VERSION = "7.6.4.1";
const OUTPUT_MAGIC = Buffer.from("PK\u0003\u0004fake-soffice-output");

/**
 * Read the pieces of a soffice argv that a fake needs, whether or not a
 * sandbox wrapper precedes it.
 * @param {string[]} args
 */
export function parseSofficeArgs(args) {
  const outIndex = args.indexOf("--outdir");
  const convertIndex = args.indexOf("--convert-to");
  const profileArg = args.find((arg) => arg.startsWith("-env:UserInstallation="));
  const input = args.at(-1) ?? "";
  const convertTo = convertIndex >= 0 ? (args[convertIndex + 1] ?? "") : "";
  return {
    version: args.includes("--version"),
    outDir: outIndex >= 0 ? args[outIndex + 1] : undefined,
    input,
    to: convertTo.split(":")[0],
    profileDir: profileArg ? fileURLToPath(profileArg.slice("-env:UserInstallation=".length)) : undefined,
    isWarmup: input.endsWith("input.fodt"),
    isRun: /input\.(?:ppt|doc|xls)$/.test(input),
  };
}

/**
 * @typedef {ReturnType<typeof describeCall>} DescribedCall
 * @typedef {{stdio?: unknown[], env: Record<string, string>, cwd?: string, detached?: boolean,
 *   shell?: boolean, windowsHide?: boolean}} FakeSpawnOptions
 * @typedef {DescribedCall & {options: FakeSpawnOptions, pid: number}} RecordedCall
 * @typedef {EventEmitter & {pid: number, stdout: PassThrough | null}} FakeChild
 * @typedef {RecordedCall & {child: FakeChild,
 *   exit: (code?: number|null, signal?: string|null) => void,
 *   writeOutput: (bytes?: Uint8Array, name?: string) => string,
 *   stdout: (text: string) => void, error: (error: Error) => void}} FakeCall
 */

/**
 * A stand-in for child_process.spawn. The handler decides what each fake
 * soffice does; without one it converts successfully. Nothing here starts a
 * real process.
 * @param {(call: FakeCall) => void} [handler]
 */
export function createFakeSpawn(handler) {
  /** @type {RecordedCall[]} */
  const calls = [];
  let nextPid = 41_000;
  /** @param {string} command @param {string[]} args @param {FakeSpawnOptions} options */
  function spawn(command, args, options) {
    const pid = nextPid++;
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdout: options?.stdio?.[1] === "pipe" ? new PassThrough() : null,
    });
    const described = describeCall(command, args);
    const call = { ...described, options, pid };
    calls.push(call);
    const finish = (/** @type {number|null} */ code = 0, /** @type {string|null} */ signal = null) => {
      const emitExit = () => {
        child.emit("exit", code, signal);
        child.emit("close", code, signal);
      };
      // A real child's pipe is drained before it closes; the reader sees every byte first.
      if (child.stdout) {
        child.stdout.once("end", emitExit);
        child.stdout.end();
      } else emitExit();
    };
    /** @type {FakeCall} */
    const context = {
      ...call,
      child,
      exit: finish,
      error: (/** @type {Error} */ error) => child.emit("error", error),
      stdout: (text) => {
        child.stdout?.write(text);
      },
      writeOutput(bytes = OUTPUT_MAGIC, name = `input.${call.to}`) {
        if (!call.outDir) throw new Error("fake soffice: no --outdir");
        const file = path.join(call.outDir, name);
        fs.writeFileSync(file, bytes);
        return file;
      },
    };
    setImmediate(() => (handler ?? defaultHandler)(context));
    return child;
  }
  return { spawn, calls };
}

/** @param {string} command @param {string[]} args */
function describeCall(command, args) {
  return { command, args: [...args], ...parseSofficeArgs(args) };
}

/** @param {FakeCall} call */
export function defaultHandler(call) {
  if (call.version) call.stdout(`LibreOffice ${FAKE_ENGINE_VERSION} 60(Build:1)\n`);
  else if (call.outDir) call.writeOutput();
  call.exit(0);
}

/** @param {string} dir a throw-away executable the converter accepts as soffice. */
export function writeFakeSofficeFile(dir, name = "soffice") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
}

/** @param {string} jobRoot */
export function jobDirsIn(jobRoot) {
  return fs.readdirSync(jobRoot).filter((name) => name.startsWith("oss-lo-"));
}

export function makeScratch(prefix = "oss-legacy-convert-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const jobRoot = path.join(root, "jobs");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(jobRoot);
  fs.mkdirSync(dataDir);
  return {
    root,
    jobRoot,
    dataDir,
    soffice: writeFakeSofficeFile(root),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Spin on setImmediate, which fake timers leave alone, until real I/O settles.
 * @param {() => boolean} condition @param {number} [limitMs]
 */
export async function until(condition, limitMs = 5000) {
  const deadline = process.hrtime.bigint() + BigInt(limitMs) * 1_000_000n;
  while (!condition()) {
    if (process.hrtime.bigint() > deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
