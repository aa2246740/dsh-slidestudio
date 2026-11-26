import { execFile } from "node:child_process";
import path from "node:path";

/**
 * @typedef {"systemd-scope+bwrap"|"bwrap"|"unshare"|"sandbox-exec"|"profile-only"|"none"} IsolationMode
 * @typedef {{bwrap?: string, unshare?: string, systemdRun?: string, systemctl?: string, sandboxExec?: string}} IsolationTools
 * @typedef {{ok: true, name: IsolationMode, tools: IsolationTools} |
 *   {ok: false, name: "none", reason: string}} IsolationPlan
 * @typedef {(command: string, args: string[]) => Promise<boolean>} RunProbe
 * @typedef {{command: string, args: string[], scopeUnit?: string, killScope?: {command: string, args: string[]}}} WrappedCommand
 */

const NO_ISOLATION_REASON = "当前系统没有可用的网络隔离（bwrap 或 unshare），为安全起见已停用旧版格式转换";
// The soffice launcher hands the job to soffice.bin over a unix socket in /tmp
// (OSL_PIPE_*); with every socket denied it exits 0 without converting anything.
const SANDBOX_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny network*)",
  '(allow network* (local unix-socket (subpath "/private/tmp")))',
  '(allow network* (remote unix-socket (subpath "/private/tmp")))',
  "",
].join("\n");
const SCOPE_TASKS_MAX = 128;
const BWRAP_BASE = ["--unshare-all", "--die-with-parent", "--new-session"];

/** Fixed directories only; the probe never searches PATH. */
const dirsFor = (/** @type {string} */ tool) =>
  ["/usr/bin", "/bin", "/usr/local/bin"].map((dir) => path.posix.join(dir, tool));

/**
 * Run a short isolation probe. Any failure, including a missing binary, counts
 * as "not available".
 * @type {RunProbe}
 */
export function execProbe(command, args) {
  const env = /** @type {Record<string, string>} */ ({ PATH: "/usr/bin:/bin" });
  for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: 5000, env, windowsHide: true }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

/**
 * @param {RunProbe} runProbe @param {string} tool
 * @param {(command: string) => string[]} args
 * @returns {Promise<string|undefined>} the first absolute path whose probe passes
 */
async function firstWorking(runProbe, tool, args) {
  for (const command of dirsFor(tool)) {
    if (await runProbe(command, args(command))) return command;
  }
  return undefined;
}

/** @param {number} maxRssMb */
const scopeProperties = (maxRssMb) => [
  "-p",
  `MemoryMax=${maxRssMb}M`,
  "-p",
  "MemorySwapMax=0",
  "-p",
  `TasksMax=${SCOPE_TASKS_MAX}`,
];

/**
 * Decide how soffice is isolated. Linux fails closed: without bwrap or
 * `unshare -rn` the converter stays unavailable, because a document parser with
 * network access is not acceptable. macOS uses sandbox-exec when it works and
 * otherwise relies on the hardened profile alone.
 * @param {{platform: string, mode: import("./legacy-convert-config.mjs").SandboxMode,
 *   runProbe: RunProbe, maxRssMb: number}} input
 * @returns {Promise<IsolationPlan>}
 */
export async function probeIsolation({ platform, mode, runProbe, maxRssMb }) {
  if (platform === "darwin") {
    if (mode === "none") return { ok: true, name: "profile-only", tools: {} };
    const sandboxExec = "/usr/bin/sandbox-exec";
    const works = await runProbe(sandboxExec, ["-p", SANDBOX_PROFILE, "/usr/bin/true"]);
    return works
      ? { ok: true, name: "sandbox-exec", tools: { sandboxExec } }
      : { ok: true, name: "profile-only", tools: {} };
  }
  if (platform !== "linux") return { ok: false, name: "none", reason: NO_ISOLATION_REASON };

  // The sandbox itself, never "none": that value is for macOS development only.
  const wanted = mode === "none" ? "auto" : mode;
  if (wanted !== "unshare") {
    const bwrap = await firstWorking(runProbe, "bwrap", (command) => [
      ...BWRAP_BASE,
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--",
      path.posix.join(path.posix.dirname(command), "true"),
    ]);
    if (bwrap) {
      const systemdRun = await firstWorking(runProbe, "systemd-run", (command) => [
        "--user",
        "--scope",
        "--quiet",
        ...scopeProperties(Math.min(maxRssMb, 256)),
        "--",
        path.posix.join(path.posix.dirname(command), "true"),
      ]);
      const systemctl = systemdRun ? path.posix.join(path.posix.dirname(systemdRun), "systemctl") : undefined;
      return systemdRun && systemctl
        ? { ok: true, name: "systemd-scope+bwrap", tools: { bwrap, systemdRun, systemctl } }
        : { ok: true, name: "bwrap", tools: { bwrap } };
    }
  }
  if (wanted !== "bwrap") {
    const unshare = await firstWorking(runProbe, "unshare", (command) => [
      "-rn",
      "--",
      path.posix.join(path.posix.dirname(command), "true"),
    ]);
    if (unshare) return { ok: true, name: "unshare", tools: { unshare } };
  }
  return { ok: false, name: "none", reason: NO_ISOLATION_REASON };
}

/**
 * The command that runs soffice under the chosen isolation. The sandbox gets
 * its environment through the wrapper's own flags, so it never sees the
 * parent's variables even if the wrapper were started with more.
 * @param {IsolationPlan} plan
 * @param {{soffice: string, args: string[], jobDir: string, env: Record<string, string>, maxRssMb: number,
 *   unit: string}} job
 * @returns {WrappedCommand}
 */
export function wrapSoffice(plan, { soffice, args, jobDir, env, maxRssMb, unit }) {
  if (!plan.ok) throw new Error("no isolation plan");
  const { tools } = plan;
  if (tools.sandboxExec) {
    return { command: tools.sandboxExec, args: ["-p", SANDBOX_PROFILE, soffice, ...args] };
  }
  if (tools.unshare) {
    return { command: tools.unshare, args: ["-rn", "--", soffice, ...args] };
  }
  if (!tools.bwrap) return { command: soffice, args };
  const bwrapArgs = [
    ...BWRAP_BASE,
    "--clearenv",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--bind",
    jobDir,
    jobDir,
    ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
    "--chdir",
    path.join(jobDir, "tmp"),
    "--",
    soffice,
    ...args,
  ];
  if (!tools.systemdRun || !tools.systemctl) return { command: tools.bwrap, args: bwrapArgs };
  const scope = `${unit}.scope`;
  return {
    command: tools.systemdRun,
    args: [
      "--user",
      "--scope",
      "--quiet",
      `--unit=${unit}`,
      ...scopeProperties(maxRssMb),
      "--",
      tools.bwrap,
      ...bwrapArgs,
    ],
    scopeUnit: scope,
    killScope: { command: tools.systemctl, args: ["--user", "kill", "--signal=SIGKILL", scope] },
  };
}
