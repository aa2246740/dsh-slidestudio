import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { writeDomainRuntime } from "./domain-hands.js";
import {
  SEMANTIC_STATUS_PALETTE_HEXES,
  modelPolicyExtraPaletteHexes,
  resolveModelPolicyProfile,
} from "./model-policy-profile.js";
import { packColorWriteContext } from "./theme-pack.js";

test("semantic status palette is 20 frozen uppercase #RRGGBB colors", () => {
  assert.equal(SEMANTIC_STATUS_PALETTE_HEXES.length, 20);
  assert.equal(new Set(SEMANTIC_STATUS_PALETTE_HEXES).size, 20);
  for (const hex of SEMANTIC_STATUS_PALETTE_HEXES) {
    assert.match(hex, /^#[0-9A-F]{6}$/);
  }
  const strict = resolveModelPolicyProfile({});
  assert.equal(strict.mode, "strict");
  assert.deepEqual(strict.extraAllowedPaletteHexes, []);
  assert.equal(resolveModelPolicyProfile({ SLIDESTUDIO_MODEL_POLICY: "strict" }).mode, "strict");
  const permissive = resolveModelPolicyProfile({ SLIDESTUDIO_MODEL_POLICY: "permissive" });
  assert.equal(permissive.mode, "permissive");
  assert.deepEqual(permissive.extraAllowedPaletteHexes, SEMANTIC_STATUS_PALETTE_HEXES);
  assert.deepEqual(
    modelPolicyExtraPaletteHexes({ SLIDESTUDIO_MODEL_POLICY: "permissive" }),
    SEMANTIC_STATUS_PALETTE_HEXES,
  );
});

test("extra palette hexes are optional, uppercase, and merged in both modes", () => {
  const strict = resolveModelPolicyProfile({
    SLIDESTUDIO_EXTRA_PALETTE_HEXES: " #abcdef, not-a-color, #123456 ,#ABCDEF",
  });
  assert.equal(strict.mode, "strict");
  assert.deepEqual(strict.extraAllowedPaletteHexes, ["#ABCDEF", "#123456"]);
  const permissive = resolveModelPolicyProfile({
    SLIDESTUDIO_MODEL_POLICY: "permissive",
    SLIDESTUDIO_EXTRA_PALETTE_HEXES: "#ABCDEF,#00FF00",
  });
  assert.equal(permissive.extraAllowedPaletteHexes[0], "#FFFFFF");
  assert.equal(permissive.extraAllowedPaletteHexes.at(-1), "#00FF00");
  assert.equal(permissive.extraAllowedPaletteHexes.length, 22);
  assert.equal(permissive.extraAllowedPaletteHexes.filter((hex) => hex === "#ABCDEF").length, 1);
});

test("packColorWriteContext merges semantic hexes only in permissive mode when a palette is already adopted", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-policy-palette-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "色板测试" });
  const packId = "consulting/pine-green-strategy";
  writeDomainRuntime(root, { brief: "季度经营复盘", designSystemId: packId });

  const prevPolicy = process.env.SLIDESTUDIO_MODEL_POLICY;
  const prevExtra = process.env.SLIDESTUDIO_EXTRA_PALETTE_HEXES;
  try {
    delete process.env.SLIDESTUDIO_MODEL_POLICY;
    delete process.env.SLIDESTUDIO_EXTRA_PALETTE_HEXES;
    const defaultCtx = packColorWriteContext([packId], root);
    assert.ok(defaultCtx.adoptedPackHexes && defaultCtx.adoptedPackHexes.size > 0);
    assert.equal(defaultCtx.adoptedPackHexes.has("#DC2626"), false);
    assert.equal(defaultCtx.adoptedPackHexes.has("#16A34A"), false);

    process.env.SLIDESTUDIO_MODEL_POLICY = "permissive";
    const permissiveCtx = packColorWriteContext([packId], root);
    assert.ok(permissiveCtx.adoptedPackHexes);
    for (const hex of SEMANTIC_STATUS_PALETTE_HEXES) {
      assert.equal(permissiveCtx.adoptedPackHexes.has(hex), true, `missing semantic hex ${hex}`);
    }

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-policy-palette-empty-"));
    t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));
    createEmptyProject(emptyRoot, { title: "未采纳色板" });
    writeDomainRuntime(emptyRoot, { brief: "无风格包测试", designDirection: "self-directed" });
    const unadoptedCtx = packColorWriteContext([], emptyRoot);
    assert.equal(unadoptedCtx.adoptedPackHexes, undefined);
  } finally {
    if (prevPolicy === undefined) delete process.env.SLIDESTUDIO_MODEL_POLICY;
    else process.env.SLIDESTUDIO_MODEL_POLICY = prevPolicy;
    if (prevExtra === undefined) delete process.env.SLIDESTUDIO_EXTRA_PALETTE_HEXES;
    else process.env.SLIDESTUDIO_EXTRA_PALETTE_HEXES = prevExtra;
  }
});
