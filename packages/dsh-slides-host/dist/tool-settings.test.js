import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyToolSettingsToEnv, emptyToolSettings, parseToolSettingsPatch, readToolSettings, toToolSettingsView, writeToolSettings, } from "./tool-settings.js";
describe("tool settings", () => {
    it("keeps an existing API key when the patch sends a blank key", () => {
        const previous = parseToolSettingsPatch({
            imageGenerate: {
                kind: "custom",
                url: "https://img.example/v1",
                apiKey: "secret-key",
                model: "flux",
            },
        }, emptyToolSettings());
        const next = parseToolSettingsPatch({
            imageGenerate: {
                kind: "custom",
                url: "https://img.example/v1",
                apiKey: "",
                model: "flux",
            },
        }, previous);
        assert.equal(next.imageGenerate.kind, "custom");
        if (next.imageGenerate.kind !== "custom")
            return;
        assert.equal(next.imageGenerate.apiKey, "secret-key");
        const view = toToolSettingsView(next).imageGenerate;
        assert.equal(view.kind, "custom");
        if (view.kind !== "custom")
            return;
        assert.equal(view.apiKeySet, true);
    });
    it("rejects non-http tool URLs", () => {
        assert.throws(() => parseToolSettingsPatch({ imageSearch: { kind: "custom", url: "file:///tmp/search" } }, emptyToolSettings()), /http\(s\)/);
    });
    it("applies custom image generate onto env and can turn it off", () => {
        const env = { SLIDESTUDIO_IMAGE_BASE_URL: "https://old.example/v1" };
        applyToolSettingsToEnv(env, {
            research: { kind: "off" },
            imageSearch: { kind: "off" },
            imageGenerate: {
                kind: "custom",
                url: "https://img.example/v1",
                apiKey: "k",
                model: "flux",
            },
        });
        assert.equal(env.SLIDESTUDIO_IMAGE_BASE_URL, "https://img.example/v1");
        assert.equal(env.SLIDESTUDIO_IMAGE, "1");
        applyToolSettingsToEnv(env, emptyToolSettings());
        assert.equal(env.SLIDESTUDIO_IMAGE_BASE_URL, undefined);
        assert.equal(env.SLIDESTUDIO_IMAGE, undefined);
    });
    it("round-trips a stored settings file without exposing the key in the view", () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "oss-tool-settings-"));
        const settings = parseToolSettingsPatch({
            imageSearch: { kind: "custom", url: "https://search.example/images", apiKey: "seek" },
        }, emptyToolSettings());
        writeToolSettings(home, settings);
        const read = readToolSettings(home, {});
        const view = toToolSettingsView(read);
        assert.equal(read.imageSearch.kind, "custom");
        if (read.imageSearch.kind !== "custom")
            return;
        assert.equal(read.imageSearch.apiKey, "seek");
        assert.equal(view.imageSearch.kind, "custom");
        if (view.imageSearch.kind !== "custom")
            return;
        assert.equal(view.imageSearch.apiKeySet, true);
        assert.equal("apiKey" in view.imageSearch, false);
    });
});
describe("tool settings presets", () => {
    it("keeps preset + template through parse/view/env round-trip", () => {
        const settings = parseToolSettingsPatch({
            imageGenerate: {
                kind: "custom",
                url: "https://dashscope.aliyuncs.com",
                apiKey: "sk-x",
                model: "qwen-image-3.0",
                preset: "dashscope-sync",
            },
            imageSearch: {
                kind: "custom",
                url: "https://photos.corp/api",
                preset: "template",
                template: {
                    method: "POST",
                    headers: { "X-Token": "{{key}}" },
                    body: '{"term":"{{query}}"}',
                    imagePath: "data.hits.0.src",
                    attribution: "内网图库",
                },
            },
        }, emptyToolSettings());
        if (settings.imageGenerate.kind !== "custom")
            throw new Error("expected custom");
        assert.equal(settings.imageGenerate.preset, "dashscope-sync");
        if (settings.imageSearch.kind !== "custom")
            throw new Error("expected custom");
        assert.equal(settings.imageSearch.preset, "template");
        assert.equal(settings.imageSearch.template?.imagePath, "data.hits.0.src");
        const view = toToolSettingsView(settings);
        if (view.imageSearch.kind !== "custom")
            throw new Error("view custom");
        assert.equal(view.imageSearch.preset, "template");
        assert.equal(view.imageSearch.template?.body, '{"term":"{{query}}"}');
        const env = applyToolSettingsToEnv({}, settings);
        assert.equal(env.SLIDESTUDIO_IMAGE_PRESET, "dashscope-sync");
        assert.equal(env.SLIDESTUDIO_IMAGE_SEARCH_PRESET, "template");
        const tmpl = JSON.parse(env.SLIDESTUDIO_IMAGE_SEARCH_TEMPLATE ?? "{}");
        assert.equal(tmpl.imagePath, "data.hits.0.src");
        assert.equal(tmpl.attribution, "内网图库");
    });
    it("rejects an unknown preset", () => {
        assert.throws(() => parseToolSettingsPatch({
            imageGenerate: {
                kind: "custom",
                url: "https://x.example",
                preset: "sd-webui",
            },
        }, emptyToolSettings()), /imageGenerate\.preset/);
    });
    it("keeps preset undefined when the endpoint turns off", () => {
        const settings = parseToolSettingsPatch({ imageGenerate: { kind: "off" } }, emptyToolSettings());
        assert.equal(settings.imageGenerate.kind, "off");
    });
});
//# sourceMappingURL=tool-settings.test.js.map