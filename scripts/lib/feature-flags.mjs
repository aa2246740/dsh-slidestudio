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

export function loadFeatureFlags(root, env = process.env) {
  const defs = JSON.parse(readFileSync(path.join(root, "config/feature-flags.json"), "utf8")).flags ?? {};
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
