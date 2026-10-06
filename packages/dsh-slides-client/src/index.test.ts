import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply } from "./index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("slides client plugin", () => {
  it("ships a ModuleLoader client bundle that claims root", () => {
    apply();
    const src = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
    assert.match(src, /@open-slidestudio\/dsh-slides-client/);
    assert.match(src, /name: "root"/);
    assert.match(src, /完整创建页/);
    assert.match(src, /\/app\/hub\.html/);
    assert.match(src, /boot-failure/);
    assert.match(src, /URLSearchParams/);
    assert.match(src, /未做视觉审查/);
    assert.match(src, /phase.kind === "paused"/);
    assert.match(src, /waiting/);
    assert.match(src, /document\.title/);
    assert.match(src, /claimProductTitle/);
    assert.doesNotMatch(src, /DeepSeek Harness/);
    assert.doesNotMatch(src, /AppFrame/);
    assert.match(src, /modelDirectories/);
    assert.match(src, /ctx\.provide\(/);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
      dsh: { client: { platform: string; immediately?: boolean } };
    };
    assert.equal(manifest.exports["./package.json"], "./package.json");
    assert.equal(manifest.dsh.client.platform, "web");
    assert.equal(manifest.dsh.client.immediately, true);
  });

  it("starts every Hub prompt as a fresh task; resume only via explicit in-run retry", () => {
    const hub = fs.readFileSync(
      path.resolve(ROOT, "../../apps/native-web/public/hub.js"),
      "utf8",
    );
    const capabilityState = fs.readFileSync(
      path.resolve(ROOT, "../../apps/native-web/public/hub-health-state.js"),
      "utf8",
    );
    const app = fs.readFileSync(
      path.resolve(ROOT, "../../apps/native-web/public/app.js"),
      "utf8",
    );
    const generationProcess = fs.readFileSync(
      path.resolve(ROOT, "../../apps/native-web/public/generation-process.js"),
      "utf8",
    );
    // No cross-session resume banner (multi-user shared URL would leak
    // checkpoints between people). Steering lives only inside the run.
    assert.doesNotMatch(hub, /oss\.generate\.resume/);
    assert.doesNotMatch(hub, /从断点继续/);
    assert.doesNotMatch(hub, /pending\.brief === text/);
    assert.doesNotMatch(hub, /同一句话再发送/);
    // The generation flow lives in the editor app; an explicit resumePath is
    // the only way a run continues instead of starting fresh.
    assert.match(app, /opts\.resumePath/);
    // In-conversation steering: pause/fail continue rides the same durable
    // session turn — steering text comes from the shared composer (#work-brief).
    assert.match(app, /generation-resume-row/);
    assert.match(app, /\$\("work-brief"\)\?\.value/);
    assert.match(generationProcess, /generationResumeInstruction/);
    // The paused "马上重试" still continues the same durable run in place.
    assert.match(app, /\/slides\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/turn/);
    assert.match(app, /resumeGeneration:\s*true/);
    // The picker lists whatever /slides/models returns; it keeps no list of
    // its own (the old grok-4.6 / MiniMax / DeepSeek fallbacks are gone).
    assert.match(hub, /还没有可用模型/);
    assert.doesNotMatch(hub, /grok-4\.6/);
    assert.match(hub, /capabilityViewModel\(card, extras\)/);
    assert.match(capabilityState, /联网检索 · 模型自带/);
    assert.match(capabilityState, /card\.imageSearch\?\.configured[\s\S]*搜图工具/);
    assert.match(capabilityState, /card\.imageGenerate\?\.configured[\s\S]*生图工具/);
    assert.match(capabilityState, /label: t\("看图"\)[\s\S]*label: t\("联网"\)[\s\S]*label: t\("搜图"\)[\s\S]*label: t\("生图"\)/);
    assert.match(hub, /serverCapability = data\.capability/);
  });

  it("wires the settings screen to real provider and tool endpoints", () => {
    const root = path.resolve(ROOT, "../../apps/native-web/public");
    const hub = fs.readFileSync(path.join(root, "hub.js"), "utf8");
    const html = fs.readFileSync(path.join(root, "hub.html"), "utf8");
    const capabilityState = fs.readFileSync(path.join(root, "hub-health-state.js"), "utf8");
    assert.match(html, /id="btn-settings"/);
    assert.match(html, /id="style-pop"/);
    assert.match(html, /id="project-list"/);
    assert.match(html, /继续协作/);
    assert.doesNotMatch(html, /id="project-menu"/);
    assert.doesNotMatch(html, /style-reference-area/);
    assert.match(html, /id="provider-list"/);
    assert.match(html, /id="byok-list"/);
    assert.match(html, /添加提供方/);
    assert.match(html, /添加自定义提供方/);
    assert.match(html, /data-settings-pane="models"/);
    assert.match(html, /id="search-url"/);
    assert.match(html, /data-settings-pane="tools"[^>]* hidden/);
    assert.match(html, /自定义工具（搜图\/生图）以后开发/);
    assert.doesNotMatch(html, /id="btn-pi-settings"/);
    assert.match(html, /class="capability-row"/);
    assert.match(html, /id="pi-model"[^>]*role="listbox"/);
    assert.match(html, /id="pi-effort"[^>]*role="radiogroup"/);
    assert.doesNotMatch(html, /<select id="pi-model"/);
    assert.match(html, /填入各提供方的 API 密钥/);
    assert.match(hub, /\/slides\/tool-settings/);
    assert.match(hub, /\/slides\/providers/);
    assert.match(hub, /btn-add-provider/);
    assert.match(hub, /renderProjects/);
    assert.match(hub, /proj-trash/);
    assert.match(hub, /\/api\/projects/);
    assert.match(hub, /preset:/);
    assert.match(hub, /providers\/\$\{encodeURIComponent\(provider/);
    assert.match(hub, /auth\/login/);
    assert.match(hub, /auth\/logout/);
    assert.match(hub, /auth\/complete/);
    assert.match(hub, /method:\s*"DELETE"/);
    assert.match(hub, /provider\.keyStored/);
    assert.match(hub, /provider\.nativeSearch/);
    assert.match(capabilityState, /模型自带/);
  });
});
