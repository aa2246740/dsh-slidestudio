import fs from "node:fs";
import path from "node:path";

/**
 * Run npm through the current Node binary so Windows never depends on resolving `npm`/`npm.cmd` from PATH.
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
export function npmInvocation(args) {
  const fromNpm = process.env.npm_execpath;
  const candidates = [
    fromNpm && /\.c?js$/i.test(fromNpm) ? fromNpm : undefined,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find((file) => file && fs.existsSync(file));
  return cli ? { command: process.execPath, args: [cli, ...args] } : { command: "npm", args };
}
