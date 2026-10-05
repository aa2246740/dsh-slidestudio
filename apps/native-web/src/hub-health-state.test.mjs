import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capabilityViewModel,
  createHealthRequestGate,
  healthSelectionMatches,
  selectedHealthReady,
} from "../public/hub-health-state.js";

const FULL_CARD = {
  research: { configured: true },
  imageSearch: { configured: true },
  imageGenerate: { configured: true },
  vision: { mode: "main-model" },
  render: true,
  runtime: { piAvailable: true },
};

describe("Hub health selection state", () => {
  it("rejects an older response after the model selection changes", () => {
    const gate = createHealthRequestGate();
    const flash = gate.begin({ provider: "amd", model: "DeepSeek-V4-Flash" });
    const vision = gate.begin({ provider: "amd", model: "DeepSeek-V4-Flash-Vision-Exp" });

    assert.equal(gate.isCurrent(flash, vision.selection), false);
    assert.equal(gate.isCurrent(vision, vision.selection), true);
  });

  it("also rejects a response when the visible selection changed without a newer request", () => {
    const gate = createHealthRequestGate();
    const request = gate.begin({ provider: "amd", model: "DeepSeek-V4-Flash" });

    assert.equal(gate.isCurrent(request, { provider: "amd", model: "DeepSeek-V4-Flash-Vision-Exp" }), false);
  });

  it("requires the health response to describe the requested provider and model", () => {
    const requested = { provider: "amd", model: "DeepSeek-V4-Flash-Vision-Exp" };

    assert.equal(healthSelectionMatches(requested, { providerId: "amd", model: "DeepSeek-V4-Flash-Vision-Exp" }), true);
    assert.equal(healthSelectionMatches(requested, { providerId: "amd", model: "DeepSeek-V4-Flash" }), false);
    assert.equal(healthSelectionMatches(requested, { providerId: "minimax-cn", model: "DeepSeek-V4-Flash-Vision-Exp" }), false);
  });

  it("uses only selection.ready for the currently selected model", () => {
    assert.equal(selectedHealthReady({
      selection: { providerId: "amd", model: "DeepSeek-V4-Flash-Vision-Exp", ready: false },
      connection: { providerId: "minimax-cn", model: "MiniMax-M3", ready: true },
    }), false);
    assert.equal(selectedHealthReady({
      selection: { providerId: "amd", model: "DeepSeek-V4-Flash-Vision-Exp", ready: true },
      connection: { ready: false },
    }), true);
    assert.equal(selectedHealthReady({ connection: { ready: true } }), false);
  });
});

function chip(view, id) {
  return view.chips.find((row) => row.id === id);
}

describe("Hub capability strip", () => {
  it("lights the four chips a fully configured multimodal run can use", () => {
    const view = capabilityViewModel(FULL_CARD, { piAuthReady: true });

    assert.deepEqual(view.chips.map((row) => row.label), ["看图", "联网", "搜图", "生图"]);
    assert.equal(chip(view, "vision").on, true);
    assert.equal(chip(view, "search").on, true);
    assert.equal(chip(view, "generate").on, true);
    assert.match(chip(view, "generate").hint, /生图工具 · 已配置/);
  });

  it("lights available search and distinguishes model-native from configured tools", () => {
    const native = capabilityViewModel(
      { ...FULL_CARD, research: { configured: true, via: "native" } },
      {},
    );
    const envPort = capabilityViewModel(
      { ...FULL_CARD, research: { configured: true, via: "env" } },
      {},
    );

    assert.equal(chip(native, "research").on, true);
    assert.match(chip(native, "research").hint, /模型自带/);
    assert.equal(chip(envPort, "research").on, true);
    assert.match(chip(envPort, "research").hint, /工具 · 已配置/);
  });

  it("explains which vision path is on", () => {
    const reviewer = capabilityViewModel({ ...FULL_CARD, vision: { mode: "reviewer" } });
    const signedOut = capabilityViewModel(
      { ...FULL_CARD, vision: { mode: "none", modelAcceptsImages: true } },
      { piAuthReady: false },
    );

    assert.equal(chip(reviewer, "vision").on, true);
    assert.match(chip(reviewer, "vision").hint, /独立审阅模型/);
    assert.equal(chip(signedOut, "vision").on, false);
    assert.match(chip(signedOut, "vision").hint, /还没登录/);
  });

  it("shows nothing while the capability answer is not ready", () => {
    for (const state of ["loading", "error", "mismatch"]) {
      const view = capabilityViewModel(FULL_CARD, { state });
      assert.deepEqual(view.chips, []);
    }
  });

  it("does not label an image-capable model as text-only when the renderer is missing", () => {
    const view = capabilityViewModel({
      ...FULL_CARD, render: false,
      vision: { mode: "none", modelAcceptsImages: true, unavailableReason: "raster-unavailable" },
    }, { piAuthReady: true });
    assert.equal(chip(view, "vision").on, false);
    assert.match(chip(view, "vision").hint, /渲染环境未就绪/);
    assert.doesNotMatch(chip(view, "vision").hint, /模型不支持/);
  });
});
