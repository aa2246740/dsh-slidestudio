/**
 * Table-driven node:test helpers: one test (or suite) per case, titled with
 * the case's values (`%s`/`%i`/`%d` take positional values in order, `$name`
 * takes a property of an object case).
 */
import { describe, test } from "node:test";

/** @param {string} title @param {unknown} entry @param {unknown[]} args */
function caseTitle(title, entry, args) {
  let position = 0;
  const record = /** @type {Record<string, unknown>} */ (entry && typeof entry === "object" ? entry : {});
  return title
    .replace(/%[sid]/g, () => String(args[position++]))
    .replace(/\$([A-Za-z_]\w*)/g, (_whole, key) => String(record[key]));
}

/** @param {unknown} entry @returns {any[]} */
const argsOf = (entry) => (Array.isArray(entry) ? entry : [entry]);

/**
 * @param {readonly unknown[]} cases @param {string} title
 * @param {(...args: any[]) => unknown} fn
 */
export function eachTest(cases, title, fn) {
  for (const entry of cases) {
    const args = argsOf(entry);
    test(caseTitle(title, entry, args), () => /** @type {void | Promise<void>} */ (fn(...args)));
  }
}

/**
 * @param {readonly unknown[]} cases @param {string} title
 * @param {(...args: any[]) => void} fn
 */
export function eachDescribe(cases, title, fn) {
  for (const entry of cases) {
    const args = argsOf(entry);
    describe(caseTitle(title, entry, args), () => fn(...args));
  }
}
