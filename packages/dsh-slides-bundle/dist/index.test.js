import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSlidesRowLaw, DSH_PIN, OAUTH_LOGIN_NOTE, OFFICIAL_VISUAL_ROW_IDS, writeSlidesProfile, } from "./index.js";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
describe("slides bundle pin", () => {
    it("locks 0.2.0 rc.2 and refuses a dirty oauth tree", () => {
        assert.equal(DSH_PIN.version, "0.2.0-rc.2");
        assert.equal(DSH_PIN.tag, "dsh-v0.2.0-rc.2");
        // Real upstream SHA for tag dsh-v0.2.0-rc.2 (git ls-remote deepseek-harness).
        assert.match(DSH_PIN.commit, /^[0-9a-f]{40}$/);
        // Registry pin evidence must match the lockfile integrity field.
        const lock = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "../..", "package-lock.json"), "utf8"));
        const locked = lock.packages["node_modules/@deepseek-ai/dsh"];
        assert.equal(locked?.integrity, DSH_PIN.integrity);
        assert.equal(locked?.resolved, DSH_PIN.tarball);
        assert.equal(OAUTH_LOGIN_NOTE.pin, false);
        const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
        const rootManifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "../..", "package.json"), "utf8"));
        assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
        assert.equal(rootManifest.dependencies["@deepseek-ai/dsh"], "0.2.0-rc.2");
        assert.equal("@deepseek-ai/dsh" in manifest.dependencies, false);
    });
    it("disables every official visual row in the patch file", () => {
        const patch = fs.readFileSync(path.join(PACKAGE_ROOT, "cordis.patch.yml"), "utf8");
        for (const id of OFFICIAL_VISUAL_ROW_IDS) {
            assert.match(patch, new RegExp(`id: ${id}\\n  disabled: true`));
        }
        assert.match(patch, /name: '@open-slidestudio\/dsh-slides-client'/);
        assert.match(patch, /name: '@open-slidestudio\/dsh-slides-host'/);
        assert.match(patch, /apiKeyEnv: MINIMAX_CN_API_KEY/);
        assert.match(patch, /provider: minimax-cn/);
        assert.match(patch, /model: MiniMax-M3/);
        assert.match(patch, /minimax-cn:/);
        assert.doesNotMatch(patch, /antigravity/);
        assert.match(patch, /id: oss-oauth-login/);
        assert.match(patch, /@open-slidestudio\/oss-oauth-login/);
        assert.doesNotMatch(patch, /OPENROUTER_ONLYUSE_FREEMODEL_API_KEY/);
        assert.match(patch, /After adopt, every write_page color MUST/);
        assert.match(patch, /#06223F/);
        assert.match(patch, /#FDC356/);
        assert.match(patch, /#2563EB/);
        assert.match(patch, /omitted\s+fill is no paint/);
        assert.match(patch, /assertion-sentence/);
        assert.match(patch, /chapter breadcrumb/);
        assert.match(patch, /Host will not paint YAML or Theme\.colors/);
        assert.match(patch, /declared fields directly at the top level/);
        assert.match(patch, /never wrap\s+them in an arguments object/);
        assert.match(patch, /Use inspect_capabilities/);
        assert.doesNotMatch(patch, /Grok produce already has/);
        assert.match(patch, /search_image and generate_image remain product tools/);
        assert.match(patch, /BATCH search_image and\s+generate_image/);
        assert.match(patch, /unique ids\s+BEFORE write_page/);
        assert.match(patch, /Do not stop after the cover image/);
        assert.match(patch, /data\.cols \+ data\.rows/);
        assert.doesNotMatch(patch, /claim,\s*dataRef,\s*and whyChart/);
        assert.doesNotMatch(patch, /whyChart/);
        assert.doesNotMatch(patch, /Do not treat web_search as a disabled DSH native tool/);
        assert.doesNotMatch(patch, /nativeTools:\s*false/);
        assert.doesNotMatch(patch, /categoryId/);
        assert.doesNotMatch(patch, /designSystemId/);
    });
    it("enforces the row law on a composed list", () => {
        const entries = [
            ...OFFICIAL_VISUAL_ROW_IDS.map((id) => ({ id, disabled: true })),
            { id: "webserver" },
            { id: "web-runtime" },
            { id: "modules" },
            { id: "connection" },
            { id: "file-upload" },
            { id: "api-remotes" },
            { id: "cordis-client-runner" },
            { id: "ui-renderer" },
            { id: "ui-session" },
            { id: "resources" },
            { id: "ui-theme" },
            { id: "ui-settings" },
            { id: "locale" },
            { id: "client-hmr" },
            { id: "agent-preset-registry" },
            { id: "session-projection" },
            { id: "slides-host", name: "@open-slidestudio/dsh-slides-host" },
            { id: "slides-client", name: "@open-slidestudio/dsh-slides-client" },
            { id: "agent-default-model", config: { provider: "minimax-cn", model: "MiniMax-M3" } },
            {
                id: "llm-pi-ai",
                config: {
                    providers: {
                        "minimax-cn": { apiKeyEnv: "MINIMAX_CN_API_KEY" },
                        amd: { apiKeyEnv: "AMD_API_KEY" },
                    },
                },
            },
            { id: "agent-preset-registry", config: { default: "slides" } },
            {
                id: "preset-slides",
                name: "@deepseek-ai/dsh-agent-preset",
                config: { id: "slides" },
            },
        ];
        assert.doesNotThrow(() => assertSlidesRowLaw(entries));
        assert.throws(() => assertSlidesRowLaw(entries.map((row) => row.id === "agent-default-model"
            ? { ...row, config: { provider: "agy-google-antigravity", model: "gemini-3.8-flash" } }
            : row)), /Antigravity/);
        assert.throws(() => assertSlidesRowLaw(entries.map((row) => (row.id === "ui-layout" ? { ...row, disabled: false } : row))), /ui-layout must be disabled/);
    });
    it("writes a slides profile that names the three product packages", () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
        const repo = path.resolve(PACKAGE_ROOT, "../..");
        const dir = writeSlidesProfile(home, repo);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
        assert.deepEqual(manifest.dsh.profile.bundles, [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
            "@open-slidestudio/dsh-slides-bundle",
        ]);
        // 0.1.7 dropped $DSH_HOME/.agent-presets/*: the preset now lives as a
        // preset-slides declaration row inside the bundle cordis.patch.yml.
        const patch = fs.readFileSync(path.join(PACKAGE_ROOT, "cordis.patch.yml"), "utf8");
        assert.match(patch, /id: preset-slides\n {6}name: '@deepseek-ai\/dsh-agent-preset'/);
        assert.match(patch, /id: agent-preset-registry\n {2}config:\n {4}default: slides/);
        assert.equal(manifest.dependencies["@open-slidestudio/presentation-run"]?.startsWith("file:"), true);
        assert.equal("@open-slidestudio/agent-harness" in manifest.dependencies, false);
        assert.equal(manifest.dependencies["@open-slidestudio/oss-oauth-login"]?.startsWith("file:"), true);
    });
    it("freezes a dump where ui-layout is disabled and slides-client owns the product row", () => {
        const dump = fs.readFileSync(path.join(PACKAGE_ROOT, "profile.baseline.yaml"), "utf8");
        assert.match(dump, /id: ui-layout\n {2}name: '@deepseek-ai\/dsh-client-ui-layout'\n {2}disabled: true/);
        assert.match(dump, /id: ui-settings\n {2}name: '@deepseek-ai\/dsh-client-ui-settings'/);
        assert.doesNotMatch(dump, /id: ui-settings\n {2}name: '@deepseek-ai\/dsh-client-ui-settings'\n {2}disabled: true/);
        assert.match(dump, /id: slides-client\n {2}name: '@open-slidestudio\/dsh-slides-client'/);
        assert.match(dump, /id: slides-host\n {2}name: '@open-slidestudio\/dsh-slides-host'/);
        assert.match(dump, /provider: minimax-cn\n {4}model: MiniMax-M3/);
        assert.match(dump, /apiKeyEnv: MINIMAX_CN_API_KEY/);
        assert.doesNotMatch(dump, /antigravity/);
        assert.match(dump, /default: slides/);
        assert.match(dump, /After adopt, every write_page color\s+MUST/);
        assert.match(dump, /#06223F/);
        assert.match(dump, /assertion-sentence/);
        assert.match(dump, /declared fields\s+directly at the top level/);
        assert.match(dump, /never wrap them in an arguments object/);
        assert.doesNotMatch(dump, /categoryId/);
        assert.doesNotMatch(dump, /designSystemId/);
        assert.doesNotMatch(dump, /MINIMAX_CN_API_KEY=.+/);
        assert.doesNotMatch(dump, /GEMINI_API_KEY=.+/);
        assert.doesNotMatch(dump, /gemini-3\.5-flash/);
    });
});
//# sourceMappingURL=index.test.js.map