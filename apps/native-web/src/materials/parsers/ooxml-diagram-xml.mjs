/** Diagram errors must not print untrusted XML through xmldom's default logger. */
import { DOMParser } from "@xmldom/xmldom";
import { childElements, childrenOf, descendantsOf, localNameOf } from "./ooxml.mjs";

/** Data nodes and cached shapes share DrawingML paragraph/break semantics.
 * @param {import("./ooxml.mjs").DomNode|null} body */
export function diagramBodyText(body) {
  return body
    ? childrenOf(body, "p")
        .map((p) =>
          childElements(p)
            .filter((run) => ["r", "fld", "br"].includes(localNameOf(run)))
            .map((run) =>
              localNameOf(run) === "br"
                ? "\n"
                : descendantsOf(run, "t")
                    .map((t) => t.textContent ?? "")
                    .join(""),
            )
            .join(""),
        )
        .join("\n")
    : "";
}

/** @param {string} text @param {string} expected
 * @returns {import("./ooxml.mjs").DomNode|null} */
export function diagramXml(text, expected) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  let invalid = false;
  const reject = () => {
    invalid = true;
  };
  try {
    const doc = new DOMParser({
      errorHandler: { warning: reject, error: reject, fatalError: reject },
    }).parseFromString(text, "text/xml");
    const root = /** @type {import("./ooxml.mjs").DomNode|null} */ (/** @type {unknown} */ (doc.documentElement));
    if (invalid || !root || localNameOf(root) !== expected) return null;
    // Keep recursive OOXML consumers bounded even for a malformed cache.
    const stack = [{ node: root, depth: 0 }];
    while (stack.length) {
      const current = stack.pop();
      if (!current) break;
      if (current.depth > 64) return null;
      for (const node of childElements(current.node)) stack.push({ node, depth: current.depth + 1 });
    }
    return root;
  } catch {
    return null;
  }
}
