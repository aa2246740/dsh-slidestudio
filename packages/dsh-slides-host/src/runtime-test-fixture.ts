import fs from "node:fs";
import path from "node:path";

export function addPlaywrightRuntimeLayout(runtimeFile: string): void {
  const root = path.dirname(runtimeFile);
  fs.mkdirSync(path.join(root, "node_modules", "playwright"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "node_modules", "playwright", "package.json"),
    JSON.stringify({ version: "1.61.1" }),
  );
  const browserDir = path.join(root, "browsers", "chromium_headless_shell-1228");
  fs.mkdirSync(browserDir, { recursive: true });
  fs.writeFileSync(path.join(browserDir, "chrome-headless-shell.exe"), "");
}
