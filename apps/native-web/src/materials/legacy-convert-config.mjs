import fs from "node:fs";
import path from "node:path";

/**
 * Limits of the legacy converter. The queue cap and the concurrency are not
 * configurable; the timeout and the RSS cap come from environment variables.
 */
export const LEGACY_CONVERT_DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  maxRssMb: 1024,
  queueCap: 8,
  concurrency: 1,
  maxOutputBytes: 50 * 1024 * 1024,
  rssSampleMs: 250,
});

/**
 * @typedef {"ppt"|"doc"|"xls"} LegacyFamily
 * @typedef {{infilter: string, to: string, filter: string}} LegacyFamilySpec
 */

/** @type {Readonly<Record<LegacyFamily, LegacyFamilySpec>>} */
export const LEGACY_FAMILIES = Object.freeze({
  ppt: {
    infilter: "MS PowerPoint 97",
    to: "pptx",
    filter: "pptx:Impress MS PowerPoint 2007 XML",
  },
  doc: { infilter: "MS Word 97", to: "docx", filter: "docx:MS Word 2007 XML" },
  xls: { infilter: "MS Excel 97", to: "xlsx", filter: "xlsx:Calc MS Excel 2007 XML" },
});

// The child never inherits the parent's PATH: the launcher script only needs
// the base utilities, and nothing else should be reachable by name.
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * The only environment a soffice child gets. HOME and TMPDIR sit inside the job
 * directory so nothing the child writes outlives the job.
 * @param {string} jobDir
 * @returns {Record<string, string>}
 */
export function legacyJobEnv(jobDir) {
  return {
    HOME: jobDir,
    TMPDIR: path.join(jobDir, "tmp"),
    PATH: CHILD_PATH,
    LANG: "zh_CN.UTF-8",
    SAL_USE_VCLPLUGIN: "svp",
  };
}

/**
 * Fixed locations only: PATH is never searched, so a planted `soffice` earlier
 * on PATH cannot be picked up.
 * @param {(dir: string) => string[]} [readdir]
 * @returns {string[]}
 */
export function fixedSofficeCandidates(readdir = (dir) => fs.readdirSync(dir)) {
  /** @type {string[]} */
  let installs;
  try {
    installs = readdir("/opt").filter((name) => /^libreoffice/i.test(name));
  } catch {
    installs = [];
  }
  const version = (/** @type {string} */ name) =>
    name
      .replace(/^libreoffice/i, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .filter(Number.isFinite);
  installs.sort((a, b) => {
    const left = version(a);
    const right = version(b);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const delta = (right[i] ?? -1) - (left[i] ?? -1);
      if (delta) return delta;
    }
    return 0;
  });
  return [
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    ...installs.map((name) => `/opt/${name}/program/soffice`),
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ];
}

/**
 * @typedef {"auto"|"bwrap"|"unshare"|"none"} SandboxMode
 * @typedef {{level: "warn", event: "legacy-convert.config", key: string, message: string}} ConfigWarning
 * @typedef {{mode: "auto"|"off", timeoutMs: number, maxRssMb: number, concurrency: 1,
 *   sandbox: SandboxMode, sofficePath: string|undefined}} LegacyConfig
 */

/**
 * Read the documented variables. A value that cannot be used falls back to the
 * default with one warning; the warning names the variable and never repeats
 * what was set.
 * @param {Record<string, string|undefined>} env
 * @param {(warning: ConfigWarning) => void} warn
 * @returns {LegacyConfig}
 */
export function resolveLegacyConfig(env, warn) {
  /** @param {string} key @param {string} message */
  const fallback = (key, message) => warn({ level: "warn", event: "legacy-convert.config", key, message });
  /** @param {string} key */
  const raw = (key) => env[key]?.trim() ?? "";
  /**
   * @param {string} key @param {number} min @param {number} max @param {number} initial
   */
  const integer = (key, min, max, initial) => {
    const text = raw(key);
    if (!text) return initial;
    const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
    fallback(key, `${key} 取值无效，已使用默认值 ${initial}`);
    return initial;
  };

  const modeText = raw("SLIDESTUDIO_LEGACY_CONVERT").toLowerCase();
  // There is no "on": the converter is attempted whenever it is not off.
  const mode = modeText === "off" ? "off" : "auto";
  if (modeText && modeText !== "off" && modeText !== "auto") {
    fallback("SLIDESTUDIO_LEGACY_CONVERT", "SLIDESTUDIO_LEGACY_CONVERT 只接受 auto 或 off，已按 auto 处理");
  }

  const concurrencyText = raw("SLIDESTUDIO_SOFFICE_CONCURRENCY");
  if (concurrencyText && concurrencyText !== "1") {
    fallback("SLIDESTUDIO_SOFFICE_CONCURRENCY", "旧版格式转换的并发固定为 1，已忽略该设置");
  }

  const sandboxText = raw("SLIDESTUDIO_SOFFICE_SANDBOX").toLowerCase();
  /** @type {SandboxMode} */
  let sandbox = "auto";
  if (["auto", "bwrap", "unshare", "none"].includes(sandboxText)) {
    sandbox = /** @type {SandboxMode} */ (sandboxText);
  } else if (sandboxText) {
    fallback("SLIDESTUDIO_SOFFICE_SANDBOX", "SLIDESTUDIO_SOFFICE_SANDBOX 取值无效，已按 auto 处理");
  }

  return {
    mode,
    timeoutMs: integer("SLIDESTUDIO_SOFFICE_TIMEOUT_MS", 1000, 600_000, LEGACY_CONVERT_DEFAULTS.timeoutMs),
    maxRssMb: integer("SLIDESTUDIO_SOFFICE_MAX_RSS_MB", 64, 65_536, LEGACY_CONVERT_DEFAULTS.maxRssMb),
    concurrency: 1,
    sandbox,
    sofficePath: raw("SLIDESTUDIO_SOFFICE_PATH") || undefined,
  };
}

const SCRIPTING = "/org.openoffice.Office.Common/Security/Scripting";
const VBA = (/** @type {string} */ app) => `/org.openoffice.Office.${app}/Filter/Import/VBA`;
/** @type {Array<[path: string, name: string, value: string]>} */
const HARDENED = [
  [SCRIPTING, "MacroSecurityLevel", "3"],
  [SCRIPTING, "DisableMacrosExecution", "true"],
  [SCRIPTING, "BlockUntrustedRefererLinks", "true"],
  [SCRIPTING, "DisableActiveContent", "true"],
  [SCRIPTING, "DisableOLEAutomation", "true"],
  ...["Calc", "Writer", "Impress"].flatMap((app) =>
    ["Load", "Executable", "Save"].map((name) => /** @type {[string, string, string]} */ ([VBA(app), name, "false"])),
  ),
  ["/org.openoffice.Office.Calc/Content/Update", "Link", "2"],
  ["/org.openoffice.Office.Writer/Content/Update", "Link", "2"],
  ["/org.openoffice.Office.Common/Misc", "CrashReport", "false"],
  ["/org.openoffice.Office.Common/Misc", "UseLocking", "false"],
  ["/org.openoffice.Office.Recovery/AutoSave", "Enabled", "false"],
  [
    "/org.openoffice.Office.Jobs/Jobs/org.openoffice.Office.Jobs:Job['UpdateCheck']/Arguments",
    "AutoCheckEnabled",
    "false",
  ],
  ["/org.openoffice.Inet/Settings", "ooInetProxyType", "0"],
];

const XCU_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry" ' +
  'xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n';
const XCU_TAIL = "</oor:items>\n";

const hardenedItems = () =>
  HARDENED.map(
    ([itemPath, name, value]) =>
      `<item oor:path="${itemPath}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>\n`,
  );

/**
 * The profile registry with every hardening item present exactly once. Items
 * soffice wrote earlier are kept unless they set one of ours, so a template
 * whose hardening was lost or edited is repaired rather than trusted.
 * @param {string} [existing]
 */
export function hardenedRegistry(existing = "") {
  const owned = new Set(HARDENED.map(([itemPath, name]) => `${itemPath}\u0000${name}`));
  const body = /<oor:items[^>]*>([\s\S]*)<\/oor:items>/.exec(existing)?.[1] ?? "";
  const kept = [...body.matchAll(/<item oor:path="([^"]*)">[\s\S]*?<\/item>\s*/g)]
    .filter((item) => {
      const names = [...item[0].matchAll(/<prop oor:name="([^"]*)"/g)].map((prop) => prop[1]);
      return !names.some((name) => owned.has(`${item[1]}\u0000${name}`));
    })
    .map((item) => `${item[0].trimEnd()}\n`);
  return XCU_HEAD + kept.join("") + hardenedItems().join("") + XCU_TAIL;
}

// A tiny flat ODF text document; converting it proves the engine, the profile
// and the output path work before any user file reaches them.
export const WARMUP_DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text><text:p>warm-up</text:p></office:text></office:body></office:document>
`;

export const WARMUP_SPEC = Object.freeze({
  infilter: "OpenDocument Text Flat XML",
  to: "docx",
  filter: "docx:MS Word 2007 XML",
});
