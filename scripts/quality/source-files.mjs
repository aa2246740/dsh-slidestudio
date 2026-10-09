import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APPS = ["apps/native-web", "apps/server", "apps/web", "dsh-slidestudio"];

export function sourceFiles(root = ROOT) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0");
  return [...new Set(files)].filter(
    (file) =>
      /^(?:apps\/|packages\/[^/]+\/src\/|dsh-slidestudio\/(?:src|scripts)\/|scripts\/)/.test(file) &&
      /\.(?:[cm]?js|tsx?)$/.test(file) &&
      !/(?:^|\/)(?:node_modules|dist|lib\/types|coverage|build)\//.test(file) &&
      !file.startsWith("packages/pptd-v2/src/data/"),
  );
}

export function appFor(file) {
  return APPS.find((app) => file.startsWith(`${app}/`));
}
