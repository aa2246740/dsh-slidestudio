import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Feature flags for SlideStudio.
 * Defaults live in config/feature-flags.json. Operators and agents override a
 * flag per checkout with SLIDESTUDIO_FLAG_<FLAG_NAME> (screaming snake of the
 * flag id): "1"/"true"/"on" -> true, "0"/"false"/"off" -> false, any other
 * non-empty string -> the literal value.
 */
export function flagEnvName(name) {
  return `SLIDESTUDIO_FLAG_${name.toUpperCase().replace(/-/g, "_")}`;
}

/** Matches config/feature-flags.json. Used only when that file was not packaged. */
const SAFE_FLAG_DEFAULTS = {
  project_retention_days: { default: 0 },
  image_generate: { default: true },
};

function flagDefinitions(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "config/feature-flags.json"), "utf8")).flags ?? {};
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === "ENOENT") return SAFE_FLAG_DEFAULTS;
    throw error;
  }
}

export function loadFeatureFlags(root, env = process.env) {
  const defs = flagDefinitions(root);
  return {
    defined: (name) => name in defs,
    get(name) {
      const raw = env[flagEnvName(name)];
      if (raw != null && String(raw).trim() !== "") {
        const value = String(raw).trim();
        if (/^(1|true|on|yes)$/i.test(value)) return true;
        if (/^(0|false|off|no)$/i.test(value)) return false;
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : value;
      }
      return defs[name]?.default;
    },
  };
}
