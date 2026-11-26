import { outputOverLimit } from "./legacy-convert-job.mjs";
import { LEGACY_CONVERT_DEFAULTS } from "./legacy-convert-config.mjs";

/**
 * @typedef {{kind: "exit", code: number|null}|{kind: "error"}|{kind: "timeout"|"out-of-memory"|"too-large"}} ProcessEnd
 * @typedef {{command: string, args: string[], cwd: string, env: Record<string, string>,
 *   timeoutMs: number, outDir?: string, killScope?: {command: string, args: string[]}}} ProcessSpec
 */

/**
 * Runs soffice and its helpers as their own process groups. The deadline and
 * the memory poll are separate timers, so a poll that never answers cannot
 * delay the kill, and a group kill follows every outcome.
 * @param {{spawn: typeof import("node:child_process").spawn, kill: (pid: number, signal: NodeJS.Signals) => unknown,
 *   sampleRssMb: (pgid: number) => Promise<number>, maxRssMb: number, maxOutputBytes: number}} deps
 */
export function createProcessRunner({ spawn, kill, sampleRssMb, maxRssMb, maxOutputBytes }) {
  /** @type {Set<number>} */
  const liveGroups = new Set();

  /** @param {number} pgid */
  function killGroup(pgid) {
    if (!Number.isInteger(pgid) || pgid <= 1) return;
    try {
      kill(-pgid, "SIGKILL");
    } catch {
      // The group already exited.
    }
  }

  return {
    /**
     * @param {ProcessSpec} spec
     * @returns {Promise<ProcessEnd & {peakRssMb: number, killed: boolean}>}
     */
    run(spec) {
      return new Promise((resolve) => {
        let settled = false;
        let killed = false;
        let sampling = false;
        let peakRssMb = 0;
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        let deadline;
        /** @type {ReturnType<typeof setInterval>|undefined} */
        let poll;
        let pgid = 0;
        /** @param {ProcessEnd} end */
        const finish = (end) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          clearInterval(poll);
          killGroup(pgid);
          liveGroups.delete(pgid);
          resolve({ ...end, peakRssMb, killed });
        };
        /** @param {"timeout"|"out-of-memory"|"too-large"} kind */
        const stop = (kind) => {
          if (settled) return;
          killed = true;
          if (spec.killScope) {
            try {
              const scope = spawn(spec.killScope.command, spec.killScope.args, {
                stdio: "ignore",
                env: spec.env,
              });
              scope.on("error", () => undefined);
              scope.unref?.();
            } catch {
              // The group kill in finish still runs.
            }
          }
          finish({ kind });
        };
        const tick = async () => {
          if (sampling || settled) return;
          sampling = true;
          try {
            const mb = await sampleRssMb(pgid);
            if (settled) return;
            peakRssMb = Math.max(peakRssMb, Number.isFinite(mb) ? mb : 0);
            if (mb > maxRssMb) stop("out-of-memory");
            else if (spec.outDir && outputOverLimit(spec.outDir, maxOutputBytes)) stop("too-large");
          } catch {
            // A failed sample is not a failed conversion.
          } finally {
            sampling = false;
          }
        };
        let child;
        try {
          child = spawn(spec.command, spec.args, {
            cwd: spec.cwd,
            env: spec.env,
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
            windowsHide: true,
          });
        } catch {
          resolve({ kind: "error", peakRssMb, killed });
          return;
        }
        pgid = child.pid ?? 0;
        if (pgid > 1) liveGroups.add(pgid);
        child.once("error", () => finish({ kind: "error" }));
        child.once("exit", (code) => finish({ kind: "exit", code }));
        deadline = setTimeout(() => stop("timeout"), spec.timeoutMs);
        poll = setInterval(() => void tick(), LEGACY_CONVERT_DEFAULTS.rssSampleMs);
        void tick();
      });
    },

    /**
     * `soffice --version`, which prints and exits without starting the office.
     * @param {string} command @param {{cwd: string, env: Record<string, string>}} where
     * @returns {Promise<string|undefined>}
     */
    readVersion(command, { cwd, env }) {
      return new Promise((resolve) => {
        let text = "";
        let child;
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        let deadline;
        const done = () => {
          clearTimeout(deadline);
          resolve(/LibreOffice\s+(\d+(?:\.\d+)*)/.exec(text)?.[1]);
        };
        try {
          child = spawn(command, ["--version"], {
            cwd,
            env,
            detached: true,
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
          });
        } catch {
          resolve(undefined);
          return;
        }
        const pgid = child.pid ?? 0;
        child.stdout?.on("data", (/** @type {Buffer|string} */ chunk) => {
          if (text.length < 4096) text += String(chunk);
        });
        child.once("error", done);
        // "close" follows the last byte of output; "exit" can precede it.
        child.once("close", done);
        deadline = setTimeout(() => {
          killGroup(pgid);
          done();
        }, 15_000);
      });
    },

    /** Kill every group still running, synchronously, for a parent that is exiting. */
    killLive() {
      for (const pgid of liveGroups) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
  };
}
