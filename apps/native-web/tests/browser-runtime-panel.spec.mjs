/// <reference path="./jsdom.d.ts" />

import assert from "node:assert/strict";
import { test, onTestFinished } from "vitest";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { mountBrowserRuntimePanel } from "../public/browser-runtime-panel.js";

/** @param {NonNullable<Parameters<typeof mountBrowserRuntimePanel>[1]>} options */
function fixture(options) {
  const dom = new JSDOM("<section></section>");
  const rootElement = dom.window.document.querySelector("section");
  if (!rootElement) throw new Error("runtime panel root is missing");
  const root = /** @type {HTMLElement} */ (rootElement);
  const panel = mountBrowserRuntimePanel(root, options);
  onTestFinished(() => {
    panel.dispose();
    dom.window.close();
  });
  return { root, panel };
}

test("runtime failure displays diagnostics as text and retry posts to the installer", async () => {
  /** @type {Array<[string, string | undefined]>} */
  const calls = [];
  const { root } = fixture({
    request: async (url, options) => {
      calls.push([String(url), options?.method]);
      return Response.json(
        options?.method === "GET"
          ? { phase: "failed", error: "download failed <img src=x onerror=alert(1)>" }
          : { phase: "installing" },
      );
    },
  });
  await setImmediate();
  assert.equal(root.dataset.phase, "failed");
  assert.equal(root.hidden, false);
  assert.equal(root.querySelector("img"), null);
  assert.match(root.textContent, /download failed <img/);
  assert.match(root.textContent, /npm run setup:browser/);
  assert.match(root.textContent, /SLIDESTUDIO_PLAYWRIGHT_RUNTIME/);
  const retry = root.querySelector("button");
  if (!retry) throw new Error("runtime retry button is missing");
  retry.click();
  await setImmediate();
  assert.deepEqual(calls, [
    ["/slides/runtime", "GET"],
    ["/slides/runtime", "POST"],
  ]);
  assert.equal(root.dataset.phase, "installing");
  assert.equal(root.hidden, false);
  assert.equal(retry.hidden, true);
});

test("runtime readiness removes recovery actions and refreshes capabilities once", async () => {
  let phase = "installing";
  let notified = 0;
  const { root, panel } = fixture({
    request: async () => Response.json({ phase }),
    onReady: () => {
      notified += 1;
    },
  });
  await setImmediate();
  assert.equal(root.dataset.phase, "installing");
  assert.equal(root.hidden, false);
  phase = "ready";
  await panel.refresh();
  await panel.refresh();
  assert.equal(root.dataset.phase, "ready");
  assert.equal(root.hidden, true);
  assert.equal(root.querySelector("details")?.hidden, true);
  assert.equal(root.querySelector("button")?.hidden, true);
  assert.equal(notified, 1);
});

test("runtime requests cannot overlap and transport failures remain retryable", async () => {
  /** @type {(error: Error) => void} */
  let rejectRequest = () => {};
  let requests = 0;
  const { root, panel } = fixture({
    request: () => {
      requests += 1;
      return new Promise((_resolve, fail) => {
        rejectRequest = fail;
      });
    },
  });
  await panel.refresh(true);
  assert.equal(requests, 1);
  assert.equal(root.hidden, true);
  rejectRequest(new Error("connection interrupted"));
  await setImmediate();
  assert.equal(root.dataset.phase, "failed");
  assert.equal(root.hidden, false);
  const retry = root.querySelector("button");
  if (!retry) throw new Error("runtime retry button is missing");
  assert.equal(retry.disabled, false);
  assert.equal(retry.hidden, false);
});
