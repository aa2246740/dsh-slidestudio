import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./source-files.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/.test(value))) {
  throw new Error("Usage: npm run release:notes -- <base-ref> <head-ref>. Writes a local draft only.");
}
for (const ref of args)
  execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: ROOT, stdio: "ignore" });
const entries = execFileSync("git", ["log", "--format=%h %s", `${args[0]}..${args[1]}`], {
  cwd: ROOT,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);
const output = path.join(ROOT, "output/release-notes.md");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(
  output,
  `# Changes ${args[0]} → ${args[1]}\n\n${entries.map((entry) => `- ${entry}`).join("\n") || "No commits in range."}\n`,
);
console.log(`Local release-note draft: ${output}. Review before publishing.`);
