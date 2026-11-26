import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOptionalNative, optionalNativeAvailable, setOptionalNativeOverride } from "./optional-native.mjs";

test("an override replaces the module and undefined restores the real lookup", async (t) => {
  const real = await loadOptionalNative("sharp");
  t.after(() => setOptionalNativeOverride("sharp", undefined));
  const stub = () => "stub";
  setOptionalNativeOverride("sharp", stub);
  assert.equal(await loadOptionalNative("sharp"), stub);
  assert.equal(await optionalNativeAvailable("sharp"), true);
  setOptionalNativeOverride("sharp", null);
  assert.equal(await loadOptionalNative("sharp"), null);
  assert.equal(await optionalNativeAvailable("sharp"), false);
  setOptionalNativeOverride("sharp", undefined);
  assert.equal(await loadOptionalNative("sharp"), real);
});

test("a missing add-on resolves to null instead of throwing, and the answer is cached", async () => {
  const first = loadOptionalNative("@napi-rs/canvas");
  const second = loadOptionalNative("@napi-rs/canvas");
  assert.equal(first, second);
  const resolved = await first;
  assert.ok(resolved === null || typeof resolved === "object" || typeof resolved === "function");
  assert.equal(await optionalNativeAvailable("@napi-rs/canvas"), resolved !== null);
});
