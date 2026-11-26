import os from "node:os";
import path from "node:path";

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

/**
 * The DSH home the Host itself uses (`resolveDshHome` in DSH 0.2.2-rc.5): a
 * non-blank `DSH_HOME` (with `~` expanded), otherwise `~/.dsh`. Plugins read
 * it from the environment, so the server surface needs no `profileContext`.
 */
export function resolveUserDshHome(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  const raw = env.DSH_HOME?.trim();
  return path.resolve(raw ? expandHome(raw, homeDir) : path.join(homeDir, ".dsh"));
}
