import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readOpenKimiSource, verifyOpenKimiPack } from "./openkimi-source-pack.js";

/**
 * The reference pack is mandatory reading for the design agent, so anything the
 * vendored skill text says is something the model may tell the end user. This
 * product owns the editor and the exporter, so its reference material must never
 * send a user to a shell, a local server, an external domain, or a disk path —
 * and must never promise a local toolchain it does not need.
 *
 * The scan runs over the manifest-verified chunk bytes: exactly what the model
 * reads. A desktop-era instruction re-entering the skill fails here.
 */
const FORBIDDEN_IN_REFERENCE: readonly (readonly [string, RegExp])[] = [
  ["shell invocation", /\bnpx\b/],
  ["npm invocation", /\bnpm\b/],
  ["node version probe", /node --version/],
  ["python toolchain", /\bpython3\b|export_pptx\.py|export_images\.py|export_host\.html/],
  ["loopback address", /127\.0\.0\.1|localhost:\d/],
  ["external host", /www\.kimi\.com|statics\.moonshot/],
  ["embedded public editor", /\biframe\b|browser-side OOXML writer|public editor/i],
  ["browser install ask", /Chromium|Chrome \/ Chromium/],
  ["absolute delivery paths", /\/abs\/path|absolute path/i],
];

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

describe("vendored reference pack stays native", () => {
  it("never sends the user to a command, a local server, an external domain, or a disk path", () => {
    const pack = verifyOpenKimiPack(ROOT);
    assert.ok(pack.manifest.files.length > 0, "the pack must expose reference files");
    for (const file of pack.manifest.files) {
      const text = readOpenKimiSource(pack, file.sourceId);
      for (const [label, pattern] of FORBIDDEN_IN_REFERENCE) {
        assert.doesNotMatch(
          text,
          pattern,
          `${file.relativePath} must not carry ${label} into the model's reference (${pattern})`,
        );
      }
    }
  });

  it("keeps the product's own editor and exporter as the only delivery path", () => {
    const pack = verifyOpenKimiPack(ROOT);
    const skill = readOpenKimiSource(pack, "openkimi:SKILL.md");
    assert.match(skill, /export_deck/, "the skill must name the native export tool");
    assert.match(skill, /render_page/, "the skill must use the native render tool");
    assert.match(skill, /review_pages/, "the skill must use the native structural gate");
    assert.match(skill, /export menu/, "the skill must point at the product's export menu");
    assert.match(skill, /comment/i, "the skill must point at the product's comment panel");
  });

  it("no longer ships the desktop export scripts", () => {
    const pack = verifyOpenKimiPack(ROOT);
    for (const removed of ["scripts/export_pptx.py", "scripts/export_images.py", "scripts/export_host.html"]) {
      assert.equal(
        pack.entriesByPath.has(removed),
        false,
        `${removed} is a desktop-era artifact and must not be served as reference material`,
      );
    }
  });
});
