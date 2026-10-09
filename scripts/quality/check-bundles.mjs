import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ROOT } from "./source-files.mjs";

function files(dir, recurse) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? recurse
        ? files(path.join(dir, entry.name), true)
        : []
      : /\.(?:js|css)$/.test(entry.name)
        ? [path.join(dir, entry.name)]
        : [],
  );
}
const budgets = JSON.parse(readFileSync(path.join(ROOT, "config/bundle-budgets.json"), "utf8"));
const reports = [];
for (const [dir, budget] of Object.entries(budgets)) {
  if (process.argv.includes("--web-only") && dir.startsWith("dsh-slidestudio/")) continue;
  const assets = files(path.join(ROOT, dir), !budget.topLevelOnly).map((file) => ({
    file: path.relative(ROOT, file),
    gzipBytes: gzipSync(readFileSync(file)).byteLength,
  }));
  if (!assets.length) throw new Error(`No built assets in ${dir}; build this app first`);
  assets.sort((a, b) => b.gzipBytes - a.gzipBytes);
  const total = assets.reduce((sum, asset) => sum + asset.gzipBytes, 0);
  reports.push({ dir, assets, total, budget: budget.gzipBytes, ok: total <= budget.gzipBytes });
  console.log(`${dir}: ${total} gzip bytes / ${budget.gzipBytes}; largest ${assets[0].file}`);
}
mkdirSync(path.join(ROOT, "output/quality"), { recursive: true });
writeFileSync(path.join(ROOT, "output/quality/bundles.json"), `${JSON.stringify(reports, null, 2)}\n`);
process.exitCode = reports.every((report) => report.ok) ? 0 : 1;
