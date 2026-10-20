import assert from "node:assert/strict";
import { it } from "node:test";
import { createRuntimeProvisionController } from "./runtime-provision.js";
import { provisionManagedRuntime, resolvePlaywrightRuntime } from "@open-slidestudio/presentation-run";

const roots = { repoRoot: "/repo", homeDir: "/home", stateDir: "/state" };
const managedPath = "/state/playwright-runtime";

it("shares startup provisioning with retries and clears diagnostics after recovery", async () => {
  const env: NodeJS.ProcessEnv = {};
  let ready = false;
  let attempts = 0;
  const controller = createRuntimeProvisionController({
    env,
    roots,
    stateDir: "/state",
    explicitOverride: "",
    provisionOptions: { log: () => undefined },
    resolve: (() => ({
      ready: ready && env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME === managedPath,
      path: managedPath,
    })) as typeof resolvePlaywrightRuntime,
    isReady: (runtimeFile) => ready && runtimeFile === managedPath,
    provision: (async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("runtime download failed");
      ready = true;
      return { path: managedPath };
    }) as typeof provisionManagedRuntime,
  });

  const startup = controller.start();
  assert.equal(startup, controller.start());
  assert.equal(controller.snapshot().phase, "installing");
  await startup;
  assert.deepEqual(controller.snapshot(), { phase: "failed", error: "runtime download failed" });
  assert.equal(env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME, undefined);

  await controller.start();
  assert.deepEqual(controller.snapshot(), { phase: "ready" });
  assert.equal(env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME, managedPath);
  assert.equal(attempts, 2);

  ready = false;
  const missing = controller.snapshot();
  assert.equal(missing.phase, "failed");
  assert.match(missing.error ?? "", /browser executable is missing/);
});

it("preserves an invalid explicit runtime path and recognizes it after repair", async () => {
  const explicitPath = "/manual/runtime.mjs";
  const env: NodeJS.ProcessEnv = { SLIDESTUDIO_PLAYWRIGHT_RUNTIME: explicitPath };
  let ready = false;
  let attempts = 0;
  const controller = createRuntimeProvisionController({
    env,
    roots,
    stateDir: "/state",
    explicitOverride: explicitPath,
    provisionOptions: { log: () => undefined },
    resolve: (() => ({ ready, path: explicitPath })) as typeof resolvePlaywrightRuntime,
    isReady: (runtimeFile) => ready && runtimeFile === explicitPath,
    provision: (async () => {
      attempts += 1;
      return { path: explicitPath };
    }) as typeof provisionManagedRuntime,
  });

  assert.equal(controller.snapshot().phase, "manual");
  await controller.start();
  assert.match(controller.snapshot().error ?? "", /SLIDESTUDIO_PLAYWRIGHT_RUNTIME/);
  assert.equal(env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME, explicitPath);
  assert.equal(attempts, 0);

  ready = true;
  await controller.start();
  assert.deepEqual(controller.snapshot(), { phase: "ready" });
  assert.equal(env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME, explicitPath);
  assert.equal(attempts, 0);
});

it("keeps a single installer in flight when a snapshot observes readiness", async () => {
  const env: NodeJS.ProcessEnv = {};
  let ready = false;
  let attempts = 0;
  let finishProvision!: () => void;
  const provisionGate = new Promise<void>((resolve) => {
    finishProvision = resolve;
  });
  const controller = createRuntimeProvisionController({
    env,
    roots,
    stateDir: "/state",
    explicitOverride: "",
    provisionOptions: { log: () => undefined },
    resolve: (() => ({
      ready: ready && env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME === managedPath,
      path: managedPath,
    })) as typeof resolvePlaywrightRuntime,
    isReady: (runtimeFile) => ready && runtimeFile === managedPath,
    provision: (async () => {
      attempts += 1;
      await provisionGate;
      return { path: managedPath };
    }) as typeof provisionManagedRuntime,
  });

  const startup = controller.start();
  await Promise.resolve();
  ready = true;
  assert.deepEqual(controller.snapshot(), { phase: "ready" });
  assert.equal(controller.start(), startup);
  finishProvision();
  await startup;
  assert.equal(attempts, 1);
});
