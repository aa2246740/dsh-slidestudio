import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { flagEnvName, loadFeatureFlags } from "../lib/feature-flags.mjs";

const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rootWith(flags) {
  const dir = mkdtempSync(path.join(tmpdir(), "slidestudio-flags-"));
  scratch.push(dir);
  mkdirSync(path.join(dir, "config"), { recursive: true });
  writeFileSync(path.join(dir, "config/feature-flags.json"), JSON.stringify({ flags }));
  return dir;
}

describe("feature flags", () => {
  it("serves config defaults and lets env override them", () => {
    const root = rootWith({
      project_retention_days: { default: 0 },
      image_generate: { default: true },
    });
    const flags = loadFeatureFlags(root, {});
    assert.equal(flags.get("project_retention_days"), 0);
    assert.equal(flags.get("image_generate"), true);
    assert.equal(flags.get("undefined_flag"), undefined);
    assert.ok(flags.defined("image_generate"));

    const overridden = loadFeatureFlags(root, { SLIDESTUDIO_FLAG_IMAGE_GENERATE: "0" });
    assert.equal(overridden.get("image_generate"), false);
    const numeric = loadFeatureFlags(root, { SLIDESTUDIO_FLAG_PROJECT_RETENTION_DAYS: "14" });
    assert.equal(numeric.get("project_retention_days"), 14);
    const wordy = loadFeatureFlags(root, { SLIDESTUDIO_FLAG_IMAGE_GENERATE: "off" });
    assert.equal(wordy.get("image_generate"), false);
  });

  it("env names are screaming snake of the flag id", () => {
    assert.equal(flagEnvName("image-generate"), "SLIDESTUDIO_FLAG_IMAGE_GENERATE");
  });
});
