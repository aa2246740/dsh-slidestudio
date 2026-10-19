import { REPO_ROOT, coverPage, invokeSlides } from "./host-test-fixtures.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request } from "node:http";
import { inspectCapabilities, inspectProjectCapabilities, persistPresentationRunProvider, hostedProduceToolNames, } from "@open-slidestudio/presentation-run";
import { decideWritePage, normalizeWritePageArgs } from "./write-page.js";
import { aiReviewPageVersionConflict, autoRenderWriteOutcome, formatWritePageOutcome, produceToolAllowlist, readPageFromProject, sessionProduceCapabilities, sliceToolGuard, } from "./tools.js";
import { acquireProjectLease, readProjectLease } from "./lease.js";
import { writeSliceRuntime, readSliceRuntimeFile, briefForOpenProject } from "./runtime.js";
import { DROPPED_CHART_DETAIL, initializeRunLedger, parseSkillPage, PRODUCE_GATE_REL_FILES, packColorWriteContextFrom, stableSha256, } from "@open-slidestudio/presentation-run";
import { loadProject, saveProject, normalizeWritePageDialect } from "@open-slidestudio/pptd-v2";
import { addPlaywrightRuntimeLayout } from "./runtime-test-fixture.js";
import { commandHash, lookupToolReceipt, recordToolReceipt } from "./receipts.js";
import { coerceSlidePlan, resolveSlidesLlmRoute, assertMinimaxCnGenerateReady, assertSlidesGenerateReady, bindMinimaxCnKey, markOpenRouterHardFailed, resetGenerateRouteState, OPENROUTER_MINIMAX_FREE_MODEL, } from "./args.js";
import { classifyAgentError, friendlyProviderCause, isHardProviderFault, isMinimaxCnFailoverFault, isMinimaxTokenPlanExhausted, isOpenRouterFailoverFault, isWaitAndResumeFault, parseRetryAfterMs, rateLimitWaitMs, RATE_LIMIT_BACKOFF_CAP_MS, RATE_LIMIT_BACKOFF_MS, recordAgentError, writeRateLimitWait, } from "./agent-fault.js";
import { RateLimitResumeController } from "./rate-limit-resume.js";
import { pagesHintForBrief, directorBrief } from "./director-brief.js";
import { inspectHubProduceGates, assertHubProduceGatesReady, emptyWriteIsRejectedByLoadedHost, emptyCreateHasNoSeedFromLoadedPptd, StaleProduceGatesError, } from "./produce-gates.js";
import { editorReviewScopesFromEdit, turnTextWithReviewScope, } from "./routes.js";
import { bindHomeKeys, connectionState, deleteHomeKey, saveHomeKey, slidesProviderHasModel, slidesProviders, hostedProviders, } from "./providers.js";
import { routeHasNativeSearch } from "./oauth-login.js";
import { PRODUCT_HOME, proxyToEditor, redirectRootToProductHome, shouldProxyToEditor } from "./product-proxy.js";
import { deckTitleFromBrief, displayDeckTitle, pickCoverRevision, pickRasterFile, pickRequestedRasterFile, SliceSessionStore, slugTitle, } from "./slice-session.js";
import { SLICE_TOOL_NAMES } from "./protocol.js";
import { readConversation, recordConversationMessage } from "./assistant-conversation.js";
describe("read_page", () => {
    it("returns the complete persisted page body as a write_page baseline without changing it", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-page-"));
        fs.mkdirSync(path.join(root, "pages"));
        fs.writeFileSync(path.join(root, "deck.pptd"), JSON.stringify({ version: "v2", title: "Read page", size: [960, 540], pages: ["pages/03_kpi.page"] }));
        const page = {
            pageType: "content",
            background: { type: "solid", color: "#F7F3EA" },
            elements: [
                {
                    elementId: "headline",
                    elementType: "text",
                    bounds: [80, 72, 800, 72],
                    content: { text: "人工编辑后的标题", fontSize: 34, color: "#14324F" },
                },
            ],
            notes: "keep this page body exactly",
        };
        const pagePath = path.join(root, "pages", "03_kpi.page");
        const persisted = `${JSON.stringify(page)}\n`;
        fs.writeFileSync(pagePath, persisted);
        const before = fs.readFileSync(pagePath, "utf8");
        const result = readPageFromProject(root, "3_kpi");
        assert.deepEqual(result, {
            ...page,
            id: "3_kpi",
            pageSha256: stableSha256({ ...page, id: "3_kpi" }),
        });
        assert.equal(fs.readFileSync(pagePath, "utf8"), before);
        assert.equal(fs.existsSync(path.join(root, "_agent", "tool-receipts.jsonl")), false);
    });
    it("fails closed for missing or ambiguous page ids and is allowlisted", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-page-ambiguous-"));
        fs.mkdirSync(path.join(root, "pages"));
        fs.writeFileSync(path.join(root, "deck.pptd"), JSON.stringify({
            version: "v2",
            title: "Ambiguous read",
            size: [960, 540],
            pages: ["pages/01_cover.page", "pages/1_cover.page"],
        }));
        for (const file of ["01_cover.page", "1_cover.page"]) {
            fs.writeFileSync(path.join(root, "pages", file), JSON.stringify({ pageType: "cover", elements: [] }));
        }
        assert.equal(readPageFromProject(root, "missing").outcome, "not-found");
        assert.equal(readPageFromProject(root, "1_cover").outcome, "ambiguous");
        assert.ok(SLICE_TOOL_NAMES.includes("read_page"));
        assert.ok(SLICE_TOOL_NAMES.includes("web_search"));
        assert.ok(SLICE_TOOL_NAMES.includes("search_image"));
        assert.ok(SLICE_TOOL_NAMES.includes("generate_image"));
        assert.equal(sliceToolGuard(new Set(SLICE_TOOL_NAMES))({ name: "read_page" }), undefined);
        assert.equal(sliceToolGuard(new Set(SLICE_TOOL_NAMES))({ name: "web_search" }), undefined);
    });
    it("requires the read hash while a live editor review lock targets the page", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-page-review-lock-"));
        fs.mkdirSync(path.join(root, "pages"));
        fs.mkdirSync(path.join(root, "_agent"));
        fs.writeFileSync(path.join(root, "deck.pptd"), JSON.stringify({ version: "v2", title: "Locked read", size: [960, 540], pages: ["pages/03_kpi.page"] }));
        const page = {
            pageType: "content",
            elements: [
                {
                    elementId: "title",
                    elementType: "text",
                    bounds: [60, 60, 800, 60],
                    content: { text: "人工更新", fontSize: 30 },
                },
            ],
        };
        fs.writeFileSync(path.join(root, "pages", "03_kpi.page"), JSON.stringify(page));
        fs.writeFileSync(path.join(root, "_agent", "ai-review-lock.v1.json"), JSON.stringify({
            token: "test",
            pagePath: "pages/03_kpi.page",
            elementId: "title",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        const read = readPageFromProject(root, "3_kpi");
        assert.equal(aiReviewPageVersionConflict(root, "3_kpi", undefined)?.startsWith("stale-page:"), true);
        assert.equal(aiReviewPageVersionConflict(root, "3_kpi", "stale")?.startsWith("stale-page:"), true);
        assert.equal(aiReviewPageVersionConflict(root, "3_kpi", read.pageSha256), undefined);
    });
});
describe("Grok produce tool allowlist", () => {
    it("derives the conditional tools from capabilities alone", () => {
        const none = inspectCapabilities({
            env: {},
            providerId: "minimax-cn",
            ready: true,
            rasterReady: true,
            modelInputModalities: ["text"],
        });
        assert.deepEqual(["review_page", "search_image", "generate_image"].filter((name) => produceToolAllowlist(none).has(name)), []);
        const vision = inspectCapabilities({
            env: {},
            providerId: "amd",
            ready: true,
            rasterReady: true,
            modelInputModalities: ["text", "image"],
        });
        assert.deepEqual(["review_page", "search_image", "generate_image"].filter((name) => produceToolAllowlist(vision).has(name)), ["review_page"]);
        const media = inspectCapabilities({
            env: {
                SLIDESTUDIO_IMAGE_SEARCH_URL: "http://127.0.0.1:49001",
                SLIDESTUDIO_IMAGE: "1",
                SLIDESTUDIO_IMAGE_BASE_URL: "http://127.0.0.1:49002/v1",
                SLIDESTUDIO_IMAGE_API_KEY: "test-only",
            },
            providerId: "minimax-cn",
            ready: true,
            rasterReady: true,
            modelInputModalities: ["text"],
        });
        assert.deepEqual(["review_page", "search_image", "generate_image"].filter((name) => produceToolAllowlist(media).has(name)), ["search_image", "generate_image"]);
    });
    it("lists hosted search and image-generate tools when pi-xai is ready", () => {
        const grok = inspectCapabilities({
            env: {
                SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
                SLIDESTUDIO_PLAYWRIGHT_RUNTIME: path.join(os.tmpdir(), "missing-host-runtime.mjs"),
            },
            providerId: "pi-xai",
            ready: true,
            rasterReady: true,
            modelInputModalities: ["text", "image"],
        });
        const allowed = produceToolAllowlist(grok);
        assert.equal(allowed.has("web_search"), true);
        assert.equal(allowed.has("review_page"), true);
        assert.equal(allowed.has("search_image"), true);
        assert.equal(allowed.has("generate_image"), true);
        assert.equal(allowed.has("view_design_reference"), false);
        assert.equal(allowed.has("render_deck"), false);
        assert.equal(allowed.has("review_deck"), false);
        assert.equal(sliceToolGuard(allowed)({ name: "web_search" }), undefined);
    });
    it("does not treat MiniMax env-off research as hosted Grok web_search", () => {
        const mini = inspectCapabilities({
            env: { MINIMAX_CN_API_KEY: "sk-test-cn" },
            providerId: "minimax-cn",
            ready: true,
        });
        const allowed = produceToolAllowlist(mini);
        assert.equal(SLICE_TOOL_NAMES.includes("web_search"), true);
        assert.equal(allowed.has("web_search"), true);
        assert.equal(allowed.has("review_page"), false);
        assert.equal(allowed.has("view_design_reference"), false);
        assert.equal(allowed.has("render_deck"), false);
        assert.equal(allowed.has("review_deck"), false);
        assert.equal(allowed.has("search_image"), false);
        assert.equal(allowed.has("generate_image"), false);
        assert.equal(allowed.has("render_page"), true);
        assert.equal(allowed.has("review_pages"), true);
        assert.equal(allowed.has("compose_deck"), true);
        assert.equal(hostedProduceToolNames(mini).includes("web_search"), false);
        assert.equal(sliceToolGuard(allowed)({ name: "web_search" }), undefined);
    });
    it("inspects Grok produce caps from the Hub session binding, not leftover MiniMax env", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "sess-caps-"));
        fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
        fs.writeFileSync(path.join(root, "_agent", "presentation-run.v1.json"), `${JSON.stringify({ provider: { providerId: "pi-xai", modelId: "grok-4.6" } })}\n`);
        const runtime = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sess-pw-")), "runtime.mjs");
        fs.writeFileSync(runtime, `export function verifyPinnedRuntime() { return true; }
export async function launchPinnedChromium() { throw new Error("stub"); }
`);
        addPlaywrightRuntimeLayout(runtime);
        const prevEditor = process.env.SLIDESTUDIO_EDITOR_URL;
        const prevPw = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
        process.env.SLIDESTUDIO_EDITOR_URL = "http://127.0.0.1:55200";
        process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = runtime;
        try {
            const store = {
                bindingFor: () => ({
                    projectRoot: root,
                    provider: { providerId: "pi-xai", modelId: "grok-4.6" },
                }),
                resolveRoot: () => root,
            };
            const caps = sessionProduceCapabilities({
                store,
                provider: {
                    providerId: "pi-xai",
                    modelId: "grok-4.6",
                    ready: true,
                    modelInputModalities: ["text", "image"],
                },
            }, "cc4bece0-c193-4d0e-af81-da00459921e5");
            assert.equal(caps.web, true);
            assert.equal(caps.research.configured, true);
            assert.equal(caps.imageSearch.configured, true);
            assert.equal(caps.imageGenerate.configured, true);
            assert.equal(caps.research.via, "pi-xai-hosted");
            assert.equal(caps.vision.mode, "main-model");
        }
        finally {
            if (prevEditor === undefined)
                delete process.env.SLIDESTUDIO_EDITOR_URL;
            else
                process.env.SLIDESTUDIO_EDITOR_URL = prevEditor;
            if (prevPw === undefined)
                delete process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
            else
                process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = prevPw;
        }
    });
    it("persists Hub Grok onto presentation-run.v1.json so produce inspect is not env-only", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "sess-persist-"));
        fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
        fs.writeFileSync(path.join(root, "_agent", "presentation-run.v1.json"), `${JSON.stringify({
            sessionId: "cc4bece0-c193-4d0e-af81-da00459921e5",
            brief: "封面需要今年航天新闻和一张封面底图",
            design: { kind: "self-directed" },
        })}\n`);
        const store = {
            bindingFor: () => ({
                projectRoot: root,
                provider: { providerId: "pi-xai", modelId: "grok-4.6" },
            }),
            resolveRoot: (binding) => binding.projectRoot,
        };
        const caps = sessionProduceCapabilities({
            store,
            provider: {
                providerId: "pi-xai",
                modelId: "grok-4.6",
                ready: true,
                modelInputModalities: [],
            },
        }, "cc4bece0-c193-4d0e-af81-da00459921e5");
        assert.equal(caps.research.via, "pi-xai-hosted");
        assert.equal(caps.web, true);
        const rec = JSON.parse(fs.readFileSync(path.join(root, "_agent", "presentation-run.v1.json"), "utf8"));
        assert.equal(rec.provider?.providerId, "pi-xai");
        const produce = inspectProjectCapabilities(root, process.env);
        assert.equal(produce.research.configured, true);
        assert.equal(produce.imageSearch.configured, true);
        assert.equal(produce.imageGenerate.configured, true);
        assert.equal(persistPresentationRunProvider(root, { providerId: "pi-xai", modelId: "grok-4.6" }), true);
    });
});
describe("write_page skip", () => {
    it("skips an identical body and refuses skip after revise", () => {
        const first = decideWritePage(coverPage, undefined);
        assert.equal(first.action, "write");
        const sha = first.action === "write" ? first.pageSha256 : "";
        const skip = decideWritePage(coverPage, {
            pageId: "cover",
            revision: 1,
            pageSha256: sha,
            yamlExists: true,
        });
        assert.equal(skip.action, "skip");
        if (skip.action === "skip")
            assert.equal(skip.outcome.outcome, "skipped-identical");
        const revise = decideWritePage(coverPage, {
            pageId: "cover",
            revision: 1,
            pageSha256: sha,
            lastVerdict: "revise",
            yamlExists: true,
        });
        assert.equal(revise.action, "reject");
        if (revise.action === "reject") {
            assert.equal(revise.outcome.outcome, "revise-requires-change");
        }
    });
});
describe("write_page reused full-bleed src", () => {
    const coverSrc = "media/aerial-lifeline-cover.png";
    const disk = {
        pageCount: 1,
        lastBasename: "cover",
        imageSrcs: [{ pageId: "cover", src: coverSrc }],
    };
    function photoPage(id, pageType, src, bounds) {
        return {
            id,
            pageType,
            elements: [
                {
                    elementId: "title",
                    elementType: "text",
                    bounds: [40, 40, 400, 40],
                    content: { text: "低空医疗物流规模", fontSize: 22, color: "#111111" },
                },
                {
                    elementId: "hero",
                    elementType: "image",
                    bounds,
                    src,
                },
            ],
        };
    }
    it("writes a cover full-bleed and rejects a section that reuses that src", () => {
        const cover = decideWritePage(photoPage("cover", "cover", coverSrc, [0, 0, 960, 540]), undefined, disk);
        assert.equal(cover.action, "write");
        const reused = decideWritePage(photoPage("section", "content", coverSrc, [0, 0, 960, 540]), undefined, disk);
        assert.equal(reused.action, "reject");
        if (reused.action === "reject" && reused.outcome.outcome === "rejected") {
            assert.match(reused.outcome.detail, /reused/);
            assert.match(reused.outcome.detail, /aerial-lifeline-cover/);
            assert.match(reused.outcome.detail, /cover/);
        }
        const unique = decideWritePage(photoPage("section", "content", "media/section-corridor.png", [0, 0, 960, 540]), undefined, disk);
        assert.equal(unique.action, "write");
        const thumb = decideWritePage(photoPage("section", "content", coverSrc, [20, 20, 64, 64]), undefined, disk);
        assert.equal(thumb.action, "write");
    });
});
describe("write_page nested chart dialect", () => {
    const marketPage = {
        id: "market",
        pageType: "content",
        elements: [
            {
                elementType: "text",
                bounds: [40, 40, 400, 40],
                content: { text: "低空医疗物流规模", fontSize: 22, color: "#111111" },
            },
            {
                elementType: "chart",
                bounds: [600, 212, 320, 240],
                chart: {
                    type: "bar",
                    rows: [
                        ["2024", 181],
                        ["2028E", 483],
                    ],
                    encode: { x: "年份", y: "规模" },
                    series: [{ type: "bar", fill: "#007ACC" }],
                },
            },
        ],
    };
    it("writes nested chart.rows+encode instead of dropping the figure", () => {
        const decision = decideWritePage(marketPage, undefined);
        assert.equal(decision.action, "write");
        const parsed = parseSkillPage(marketPage, 0);
        const chart = parsed?.elements.find((el) => el.elementType === "chart");
        assert.equal(chart?.elementType, "chart");
        assert.deepEqual(chart?.data.cols, ["年份", "规模"]);
    });
    it("rejects a chart-typed element that still cannot parse after normalize", () => {
        const decision = decideWritePage({
            id: "market",
            pageType: "content",
            elements: [
                {
                    elementType: "text",
                    bounds: [40, 40, 400, 40],
                    content: { text: "低空医疗物流规模", fontSize: 22, color: "#111111" },
                },
                {
                    elementType: "chart",
                    bounds: [600, 212, 320, 240],
                    chart: { type: "bar" },
                },
            ],
        }, undefined);
        assert.equal(decision.action, "reject");
        if (decision.action === "reject" && decision.outcome.outcome === "rejected") {
            assert.equal(decision.outcome.detail, DROPPED_CHART_DETAIL);
        }
    });
});
describe("write_page deterministic auto-render", () => {
    it("renders exactly the written page and returns its layout evidence", async () => {
        const calls = [];
        const outcome = await autoRenderWriteOutcome({
            outcome: "written",
            pageId: "4_quarter_trend",
            revision: 2,
            pageSha256: "a".repeat(64),
        }, "4_quarter_trend", async (pageId) => {
            calls.push(pageId);
            return {
                ok: true,
                detail: "native render",
                payload: {
                    layoutStatus: "fail",
                    layoutIssues: [{ code: "text-overflow-y" }],
                },
            };
        });
        assert.deepEqual(calls, ["4_quarter_trend"]);
        assert.equal(outcome.outcome, "written");
        if (outcome.outcome === "written") {
            assert.equal(outcome.layoutStatus, "fail");
            assert.deepEqual(outcome.layoutIssues, [{ code: "text-overflow-y" }]);
        }
    });
    it("keeps the page written but reports unavailable when rastering fails", async () => {
        const outcome = await autoRenderWriteOutcome({
            outcome: "written",
            pageId: "cover",
            revision: 1,
            pageSha256: "b".repeat(64),
        }, "cover", async () => ({
            ok: false,
            detail: "editor unavailable",
            payload: {},
        }));
        assert.equal(outcome.outcome, "written");
        if (outcome.outcome === "written") {
            assert.equal(outcome.layoutStatus, "unavailable");
            assert.match(outcome.renderNote ?? "", /editor unavailable/);
        }
    });
    it("surfaces deterministic layout evidence when an identical page is skipped", () => {
        const failed = formatWritePageOutcome({
            outcome: "skipped-identical",
            pageId: "cover",
            revision: 3,
            pageSha256: "c".repeat(64),
            layoutStatus: "fail",
            layoutIssues: [{ code: "text-contrast" }, { kind: "text-overflow-y" }],
        });
        assert.match(failed, /deterministicLayoutStatus=fail/);
        assert.match(failed, /text-contrast, text-overflow-y/);
        assert.match(failed, /Rewrite this page/);
        const unavailable = formatWritePageOutcome({
            outcome: "skipped-identical",
            pageId: "cover",
            revision: 3,
            pageSha256: "c".repeat(64),
            layoutStatus: "unavailable",
            renderNote: "editor unavailable",
        });
        assert.match(unavailable, /deterministicLayoutStatus=unavailable/);
        assert.match(unavailable, /Retry render_page/);
        assert.match(unavailable, /do not compose yet/);
    });
});
describe("kernel lease", () => {
    it("refuses a live foreign owner", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "lease-"));
        fs.mkdirSync(path.join(root, "_agent"));
        fs.writeFileSync(path.join(root, "_agent", "kernel.lock"), JSON.stringify({ kernel: "pi", pid: process.pid, startedAt: new Date().toISOString() }));
        assert.throws(() => acquireProjectLease(root, "dsh"), /leased by pi/);
    });
    it("steals a stale pid", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "lease-"));
        fs.mkdirSync(path.join(root, "_agent"));
        fs.writeFileSync(path.join(root, "_agent", "kernel.lock"), JSON.stringify({ kernel: "pi", pid: 999999, startedAt: new Date().toISOString() }));
        const lease = acquireProjectLease(root, "dsh", "sess-1");
        assert.equal(lease.kernel, "dsh");
        assert.equal(readProjectLease(root)?.sessionId, "sess-1");
    });
});
describe("slice runtime", () => {
    it("writes no category or design preset on the self-directed path", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
        writeSliceRuntime(root, {
            brief: "一张封面：光合作用",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        const runtime = readSliceRuntimeFile(root);
        assert.equal(runtime.designDirection, "self-directed");
        assert.equal("categoryId" in runtime, false);
        assert.equal("designSystemId" in runtime, false);
        initializeRunLedger(root);
        const ledger = JSON.parse(fs.readFileSync(path.join(root, "_agent", "run-ledger.v1.json"), "utf8"));
        assert.equal(ledger.sourcePack.tasteGate, undefined);
        assert.ok(ledger.sourcePack.requirements.length >= 3);
    });
    it("keeps the user brief when open_project supplies a shorter title", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
        writeSliceRuntime(root, {
            brief: "为《澄光生活》做一页月报封面",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        assert.equal(briefForOpenProject(root, "澄光生活月报封面"), "为《澄光生活》做一页月报封面");
        assert.equal(readSliceRuntimeFile(root).brief, "为《澄光生活》做一页月报封面");
    });
});
describe("tool receipt hash", () => {
    it("conflicts when the same call id carries different arguments", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-"));
        const first = commandHash("write_page", coverPage);
        recordToolReceipt(root, { toolCallId: "call-1", commandHash: first, outcome: { outcome: "written" } });
        const prior = lookupToolReceipt(root, "call-1");
        assert.equal(prior?.commandHash, first);
        const other = commandHash("write_page", { ...coverPage, id: "other" });
        assert.notEqual(other, first);
    });
});
describe("commit_design plan shape", () => {
    it("unwraps {items: [...]} the way Gemini sends it", () => {
        const items = coerceSlidePlan({
            items: [{ pageId: "cover", title: "澄光生活月报封面" }],
        });
        assert.equal(items.length, 1);
        assert.deepEqual(coerceSlidePlan([{ pageId: "cover" }]), [{ pageId: "cover" }]);
        const minimax = coerceSlidePlan({
            items: { item: { pageId: "1_cover", title: "封面", layoutFamily: "cover", exhibits: [] } },
        });
        assert.equal(minimax.length, 1);
        assert.equal(minimax[0].pageId, "1_cover");
    });
});
describe("write_page Gemini dialect", () => {
    it("accepts rect/value elements as a cover write", () => {
        const geminiPage = {
            id: "cover",
            pageType: "cover",
            elements: [
                {
                    id: "background",
                    type: "shape",
                    rect: { left: 0, top: 0, width: 1280, height: 720 },
                    value: { fill: "#FAF8F5", shapeType: "rect" },
                },
                {
                    id: "title_main",
                    type: "text",
                    rect: { left: 80, top: 210, width: 800, height: 120 },
                    value: { text: "澄光生活", fontSize: 72, isBold: true, color: "#2C3E50" },
                },
            ],
        };
        const decision = decideWritePage(geminiPage, undefined);
        assert.equal(decision.action, "write");
    });
});
describe("write_page MiniMax dialect", () => {
    it("unwraps {item: [...]} bounds and string numbers", () => {
        const minimaxPage = {
            id: "cover",
            pageType: "cover",
            elements: {
                item: [
                    {
                        elementId: "bg",
                        elementType: "shape",
                        bounds: { item: ["0", "0", "960", "540"] },
                        fill: { type: "solid", color: "#F7F2E8" },
                    },
                    {
                        elementId: "title-cn",
                        elementType: "text",
                        bounds: { item: { item: ["90", "120", "820", "100"] } },
                        content: {
                            fontSize: "72",
                            color: "#0F4C5C",
                            bold: "true",
                            text: "澄光生活",
                        },
                    },
                    {
                        elementId: "kpi",
                        elementType: "text",
                        bounds: { item: ["90", "324", "250", "40"] },
                        content: { text: "营收 1,860 万", fontSize: "22", color: "#0F4C5C" },
                    },
                ],
            },
        };
        const decision = decideWritePage(minimaxPage, undefined);
        assert.equal(decision.action, "write");
    });
    it("keeps a MiniMax table that leads with columnWidths and {item:} rows", () => {
        const page = {
            id: "stockout-sku",
            pageType: "content",
            elements: {
                item: [
                    {
                        elementId: "ss-bg",
                        elementType: "shape",
                        bounds: { item: ["0", "0", "960", "540"] },
                        fill: { type: "solid", color: "#FFFFFF" },
                        shapeName: "rect",
                    },
                    {
                        columnWidths: { item: ["0.06", "0.18", "0.18", "0.18", "0.1", "0.14", "0.16"] },
                        bounds: { item: ["44", "178", "872", "190"] },
                        rows: {
                            item: [
                                {
                                    item: [
                                        { text: "#" },
                                        { text: "SKU 名称" },
                                        { text: "系列" },
                                        { text: "主销渠道" },
                                        { text: "缺货天数" },
                                        { text: "优先级" },
                                        { text: "8 月计划" },
                                    ],
                                },
                                {
                                    item: [
                                        { text: "1" },
                                        { text: "青瓷杯套装 6 件" },
                                        { text: "茶器" },
                                        { text: "自营 App" },
                                        { text: "18" },
                                        { text: "P0" },
                                        { text: "8/10 到货 2,400 套" },
                                    ],
                                },
                            ],
                        },
                    },
                ],
            },
        };
        const decision = decideWritePage(page, undefined);
        assert.equal(decision.action, "write");
        const parsed = parseSkillPage(normalizeWritePageArgs(page), 0);
        const table = parsed?.elements.find((el) => el.elementType === "table");
        assert.ok(table);
        if (table && "rows" in table) {
            const rows = table.rows;
            assert.equal(rows[1]?.[4]?.text, "18");
        }
    });
    it("drops MiniMax chart xAxis/yAxis/dataLabels and coerces $text legend", () => {
        const page = {
            id: "birth",
            pageType: "content",
            elements: [
                {
                    elementId: "birth-chart",
                    elementType: "chart",
                    bounds: [60, 252, 560, 230],
                    data: {
                        cols: ["年份", "累计产量"],
                        rows: [
                            [1925, 1],
                            [1935, 80],
                        ],
                    },
                    series: [
                        {
                            type: "bar",
                            encode: { x: "年份", y: "累计产量" },
                            fill: { $text: "#52DA92" },
                            dataLabels: { show: "true" },
                        },
                    ],
                    title: { $text: "徕卡 I 累计产量增长（千台）" },
                    legend: { $text: "false" },
                    dataLabels: { show: "true" },
                    xAxis: { type: "category" },
                    yAxis: { label: { fontSize: "10" } },
                },
            ],
        };
        const clean = structuredClone(page);
        normalizeWritePageDialect(clean);
        const normalized = normalizeWritePageArgs(clean);
        const chart = normalized.elements[0];
        assert.equal(chart.xAxis, undefined);
        assert.equal(chart.yAxis, undefined);
        assert.equal(chart.dataLabels, undefined);
        assert.equal(chart.legend, false);
        assert.equal(chart.title, "徕卡 I 累计产量增长（千台）");
        const decision = decideWritePage(normalized, undefined);
        assert.equal(decision.action, "write");
    });
    it("rejects unprefixed RRGGBB at write_page instead of persisting a color that becomes 000000", () => {
        const decision = decideWritePage({
            id: "19_final",
            pageType: "final",
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "0E0807" },
                },
                {
                    elementId: "recap",
                    elementType: "text",
                    bounds: [60, 120, 840, 80],
                    content: { text: "我把一条事故频发的发布线改造成可回滚。", fontSize: 18, color: "E8DED7" },
                },
            ],
        }, undefined);
        assert.equal(decision.action, "reject");
        if (decision.action === "reject" && decision.outcome.outcome === "rejected") {
            assert.match(decision.outcome.detail, /invalid_color/);
            assert.match(decision.outcome.detail, /0E0807|E8DED7/);
        }
    });
    it("rejects unresolved $nope at write_page and accepts existing $primary", () => {
        const rejected = decideWritePage({
            id: "19_final",
            pageType: "final",
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "#0E0807" },
                },
                {
                    elementId: "recap",
                    elementType: "text",
                    bounds: [60, 120, 840, 80],
                    content: { text: "我把一条事故频发的发布线改造成可回滚。", fontSize: 18, color: "$nope" },
                },
                {
                    elementId: "ask",
                    elementType: "text",
                    bounds: [60, 312, 840, 80],
                    content: { text: "下个月请评委给三件事反馈。", fontSize: 16, color: "#E8DED7" },
                },
            ],
        }, undefined);
        assert.equal(rejected.action, "reject");
        if (rejected.action === "reject" && rejected.outcome.outcome === "rejected") {
            assert.match(rejected.outcome.detail, /invalid_color/);
            assert.match(rejected.outcome.detail, /\$nope/);
        }
        const allowed = decideWritePage({
            id: "19_final",
            pageType: "final",
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "$primary" },
                },
                {
                    elementId: "recap",
                    elementType: "text",
                    bounds: [60, 120, 840, 80],
                    content: { text: "我把一条事故频发的发布线改造成可回滚。", fontSize: 18, color: "$text" },
                },
                {
                    elementId: "ask",
                    elementType: "text",
                    bounds: [60, 312, 840, 80],
                    content: { text: "下个月请评委给三件事反馈。", fontSize: 16, color: "$text" },
                },
            ],
        }, undefined, { pageCount: 0, theme: { colors: { primary: "#2563EB", text: "#111111" } } });
        assert.equal(allowed.action, "write");
    });
    it("rejects HTML style color:0E0807 at write_page and accepts official span colors", () => {
        const rejected = decideWritePage({
            id: "19_final",
            pageType: "final",
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "#0E0807" },
                },
                {
                    elementId: "recap",
                    elementType: "text",
                    bounds: [60, 120, 840, 80],
                    content: {
                        text: '<p><span style="color:0E0807">我把一条事故频发的发布线改造成可回滚。</span></p>',
                        fontSize: 18,
                        color: "#E8DED7",
                    },
                },
            ],
        }, undefined);
        assert.equal(rejected.action, "reject");
        if (rejected.action === "reject" && rejected.outcome.outcome === "rejected") {
            assert.match(rejected.outcome.detail, /invalid_color/);
            assert.match(rejected.outcome.detail, /0E0807/);
            assert.match(rejected.outcome.detail, /@style\.color/);
        }
        const allowed = decideWritePage({
            id: "19_final",
            pageType: "final",
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "#0E0807" },
                },
                {
                    elementId: "recap",
                    elementType: "text",
                    bounds: [60, 120, 840, 80],
                    content: {
                        text: '<p><span style="color:#E8DED7">我把一条事故频发的发布线改造成可回滚。</span></p>',
                        fontSize: 18,
                        color: "#E8DED7",
                    },
                },
                {
                    elementId: "ask",
                    elementType: "text",
                    bounds: [60, 312, 840, 80],
                    content: {
                        text: '<p><span style="color:$primary">下个月请评委给三件事反馈。</span></p>',
                        fontSize: 16,
                        color: "#E8DED7",
                    },
                },
            ],
        }, undefined, { pageCount: 0, theme: { colors: { primary: "#2563EB", text: "#111111" } } });
        assert.equal(allowed.action, "write");
    });
    it("rejects an empty closer instead of skipping it as identical", () => {
        const empty = {
            id: "closing",
            pageType: "final",
            elements: [
                {
                    elementId: "cl-bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "#06223F" },
                },
            ],
        };
        const decision = decideWritePage(empty, undefined);
        assert.equal(decision.action, "reject");
        if (decision.action === "reject" && decision.outcome.outcome === "rejected") {
            assert.match(decision.outcome.detail, /empty_closer/);
        }
        const skipAttempt = decideWritePage(empty, {
            pageId: "closing",
            revision: 5,
            pageSha256: "deadbeef",
            yamlExists: true,
        });
        assert.equal(skipAttempt.action, "reject");
    });
    it("rejects leftover last-disk *_content as an empty closer", () => {
        const empty = {
            id: "16_content",
            pageType: "content",
            elements: [
                {
                    elementId: "cl-bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "#06223F" },
                },
            ],
        };
        const decision = decideWritePage(empty, undefined, {
            pageCount: 16,
            lastBasename: "16_content",
        });
        assert.equal(decision.action, "reject");
        if (decision.action === "reject" && decision.outcome.outcome === "rejected") {
            assert.match(decision.outcome.detail, /empty_closer/);
        }
    });
    it("rejects a 缺货天数 body cell that is empty", () => {
        const page = {
            id: "12_stockout",
            pageType: "content",
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "#FFFFFF" },
                },
                {
                    elementId: "title",
                    elementType: "text",
                    bounds: [40, 36, 800, 40],
                    content: { text: "澄光生活 · 缺货 SKU", fontSize: 24 },
                },
                {
                    elementType: "table",
                    bounds: [44, 178, 872, 190],
                    rows: [
                        [{ text: "SKU 名称" }, { text: "缺货天数" }],
                        [{ text: "青瓷杯套装 6 件" }, { text: "" }],
                    ],
                },
            ],
        };
        const decision = decideWritePage(page, undefined);
        assert.equal(decision.action, "reject");
        if (decision.action === "reject" && decision.outcome.outcome === "rejected") {
            assert.match(decision.outcome.detail, /empty_cell/);
        }
    });
    it("rejects another pack's Color Palette hex on first write instead of snapping it", () => {
        const pine = packColorWriteContextFrom({
            designSystemId: "consulting/pine-green-strategy",
        });
        const foreign = {
            id: "cover",
            pageType: "cover",
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "#FDC356" },
                },
                {
                    elementId: "title",
                    elementType: "text",
                    bounds: [80, 160, 800, 80],
                    content: { text: "北麓制造 2026 上半年经营汇报", fontSize: 36, color: "#FFFFFF" },
                },
            ],
        };
        const refused = decideWritePage(foreign, undefined, { pageCount: 0, ...pine });
        assert.equal(refused.action, "reject");
        if (refused.action === "reject" && refused.outcome.outcome === "rejected") {
            assert.match(refused.outcome.detail, /pack_color/);
            assert.match(refused.outcome.detail, /Allowed pack colors:/);
        }
        const adopted = {
            ...foreign,
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "#03522C" },
                },
                foreign.elements[1],
            ],
        };
        const allowed = decideWritePage(adopted, undefined, { pageCount: 0, ...pine });
        if (allowed.action === "reject" && allowed.outcome.outcome === "rejected") {
            assert.doesNotMatch(allowed.outcome.detail, /#FDC356/);
        }
        const emptyAdopt = decideWritePage(foreign, undefined);
        assert.equal(emptyAdopt.action, "write");
        const navy = {
            ...foreign,
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "#06223F" },
                },
                foreign.elements[1],
            ],
        };
        const navyRefused = decideWritePage(navy, undefined, { pageCount: 0, ...pine });
        assert.equal(navyRefused.action, "reject");
        const hostBlue = {
            ...foreign,
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "#2563EB" },
                },
                foreign.elements[1],
            ],
        };
        const hostBlueRefused = decideWritePage(hostBlue, undefined, { pageCount: 0, ...pine });
        assert.equal(hostBlueRefused.action, "reject");
        const packPrimary = {
            id: "cover",
            pageType: "cover",
            elements: [
                {
                    elementId: "bg",
                    elementType: "shape",
                    bounds: [0, 0, 960, 540],
                    fill: { type: "solid", color: "$primary" },
                },
                foreign.elements[1],
            ],
        };
        const packPrimaryWrite = decideWritePage(packPrimary, undefined, {
            pageCount: 0,
            theme: { colors: { primary: "#03522C" } },
            ...pine,
        });
        assert.equal(packPrimaryWrite.action, "write");
        const emptyPrimaryReject = decideWritePage(packPrimary, undefined, {
            pageCount: 0,
            theme: { colors: { primary: "#2563EB" } },
            ...pine,
        });
        assert.equal(emptyPrimaryReject.action, "reject");
        if (emptyPrimaryReject.action === "reject" && emptyPrimaryReject.outcome.outcome === "rejected") {
            assert.match(emptyPrimaryReject.outcome.detail, /pack_color/);
            assert.match(emptyPrimaryReject.outcome.detail, /did not rebind Theme.colors/);
        }
        const emptyAdoptNavy = decideWritePage(navy, undefined);
        assert.equal(emptyAdoptNavy.action, "write");
    });
});
describe("provider quota inspect", () => {
    it("marks the slice paused when the model returns QUOTA", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-inspect-"));
        const store = new SliceSessionStore(workspace);
        const opened = store.openProject({
            dshSessionId: "sess-quota",
            title: "cover",
            design: { kind: "self-directed" },
            provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
        });
        const root = store.resolveRoot(opened.binding);
        writeSliceRuntime(root, {
            brief: "为《澄光生活》做一页月报封面",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        recordAgentError(root, classifyAgentError({ code: "QUOTA", message: "free tier 20/day" }));
        const snap = store.inspect("sess-quota");
        assert.equal(snap.phase.kind, "paused");
        if (snap.phase.kind === "paused") {
            assert.match(snap.phase.detail, /provider-quota/);
        }
    });
    it("marks the slice paused on MiniMax token-plan 2056 when OpenRouter failover does not run", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-token-plan-"));
        const store = new SliceSessionStore(workspace);
        const opened = store.openProject({
            dshSessionId: "sess-2056",
            title: "cover",
            design: { kind: "self-directed" },
            provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
        });
        const root = store.resolveRoot(opened.binding);
        writeSliceRuntime(root, {
            brief: "澄光生活 2026年7月经营月报",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        recordAgentError(root, classifyAgentError({ message: "2056 Token Plan 用量上限，请升级 Token Plan" }));
        const snap = store.inspect("sess-2056");
        assert.equal(snap.phase.kind, "paused");
        assert.notEqual(snap.phase.kind, "complete");
        if (snap.phase.kind === "paused") {
            assert.match(snap.phase.detail, /provider-token-plan/);
        }
    });
    it("keeps auth failures paused even after a page exists", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-auth-"));
        const store = new SliceSessionStore(workspace);
        const opened = store.openProject({
            dshSessionId: "sess-auth",
            title: "cover",
            design: { kind: "self-directed" },
            provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
        });
        const root = store.resolveRoot(opened.binding);
        writeSliceRuntime(root, {
            brief: "给小学生介绍勾股定理",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        initializeRunLedger(root);
        const ledgerPath = path.join(root, "_agent", "run-ledger.v1.json");
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
        ledger.facts.push({
            type: "page.revision-committed",
            pageId: "cover",
            revision: 1,
            pageSha256: "deadbeef",
        });
        fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
        recordAgentError(root, classifyAgentError({ code: "AUTH", message: "invalid api key" }));
        const snap = store.inspect("sess-auth");
        assert.equal(snap.phase.kind, "paused");
        assert.notEqual(snap.phase.kind, "complete");
        if (snap.phase.kind === "paused") {
            assert.match(snap.phase.detail, /provider-auth/);
        }
    });
    it("treats leftover PI_AI_ERROR Provider returned error as OpenRouter 429 pause", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-or-429-"));
        const store = new SliceSessionStore(workspace);
        const opened = store.openProject({
            dshSessionId: "sess-or-429",
            title: "cover",
            design: { kind: "self-directed" },
            provider: { providerId: "openrouter", modelId: OPENROUTER_MINIMAX_FREE_MODEL },
        });
        const root = store.resolveRoot(opened.binding);
        writeSliceRuntime(root, {
            brief: "澄光生活 2026年7月经营月报",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        recordAgentError(root, { code: "PI_AI_ERROR", detail: "Provider returned error" });
        const snap = store.inspect("sess-or-429");
        assert.equal(snap.phase.kind, "paused");
        assert.notEqual(snap.phase.kind, "complete");
        if (snap.phase.kind === "paused") {
            assert.match(snap.phase.detail, /provider-rate-limit/);
        }
    });
});
describe("minimax-cn generate route", () => {
    it("defaults to MiniMax-M3 and honors an explicit imported provider", () => {
        resetGenerateRouteState();
        assert.deepEqual(resolveSlidesLlmRoute({}), {
            provider: "minimax-cn",
            model: "MiniMax-M3",
        });
        assert.deepEqual(resolveSlidesLlmRoute({ SLIDESTUDIO_GEMINI_MODEL: "gemini-3.5-flash-lite" }), {
            provider: "minimax-cn",
            model: "MiniMax-M3",
        });
        assert.deepEqual(resolveSlidesLlmRoute({ SLIDESTUDIO_LLM_MODEL: "MiniMax-M2.7" }), {
            provider: "minimax-cn",
            model: "MiniMax-M2.7",
        });
        assert.deepEqual(resolveSlidesLlmRoute({
            SLIDESTUDIO_LLM_PROVIDER: "amd",
            SLIDESTUDIO_LLM_MODEL: "DeepSeek-V4-Flash",
            AMD_API_KEY: "sk-test-amd",
        }), { provider: "amd", model: "DeepSeek-V4-Flash" });
        assert.deepEqual(assertMinimaxCnGenerateReady({ MINIMAX_API_KEY: "test-not-a-live-key" }), {
            provider: "minimax-cn",
            model: "MiniMax-M3",
        });
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "route-roster-"));
        assert.equal(slidesProviderHasModel(home, "minimax-cn", "MiniMax-M3"), true);
        assert.equal(slidesProviderHasModel(home, "minimax-cn", "unknown-model"), false);
    });
    it("aliases MINIMAX_CN_API_KEY, MINIMAXCN_API_KEY, and MINIMAX_API_KEY in that order", () => {
        const fromCn = { MINIMAX_CN_API_KEY: "sk-test-cn-only" };
        bindMinimaxCnKey(fromCn);
        assert.equal(fromCn.MINIMAX_CN_API_KEY, "sk-test-cn-only");
        assert.equal(fromCn.MINIMAXCN_API_KEY, "sk-test-cn-only");
        assert.equal(fromCn.MINIMAX_API_KEY, "sk-test-cn-only");
        const fromCloud = { MINIMAXCN_API_KEY: "sk-test-cloud-only" };
        bindMinimaxCnKey(fromCloud);
        assert.equal(fromCloud.MINIMAX_CN_API_KEY, "sk-test-cloud-only");
        assert.equal(fromCloud.MINIMAXCN_API_KEY, "sk-test-cloud-only");
        assert.equal(fromCloud.MINIMAX_API_KEY, "sk-test-cloud-only");
        const fromAlias = { MINIMAX_API_KEY: "sk-test-alias-only" };
        bindMinimaxCnKey(fromAlias);
        assert.equal(fromAlias.MINIMAX_CN_API_KEY, "sk-test-alias-only");
        assert.equal(fromAlias.MINIMAXCN_API_KEY, "sk-test-alias-only");
        assert.equal(fromAlias.MINIMAX_API_KEY, "sk-test-alias-only");
        const preferCn = {
            MINIMAX_CN_API_KEY: "sk-test-cn-wins",
            MINIMAXCN_API_KEY: "sk-test-cloud-loses",
            MINIMAX_API_KEY: "sk-test-alias-loses",
        };
        bindMinimaxCnKey(preferCn);
        assert.equal(preferCn.MINIMAX_CN_API_KEY, "sk-test-cn-wins");
        assert.equal(preferCn.MINIMAX_API_KEY, "sk-test-cn-wins");
    });
    it("refuses Antigravity and missing MiniMax keys", () => {
        assert.throws(() => resolveSlidesLlmRoute({
            SLIDESTUDIO_LLM_PROVIDER: "agy-google-antigravity",
            SLIDESTUDIO_LLM_MODEL: "gemini-3.8-flash",
        }), /Antigravity generate is rejected/);
        assert.throws(() => assertMinimaxCnGenerateReady({ GEMINI_API_KEY: "no", GOOGLE_API_KEY: "no" }), /has no credential/);
        assert.throws(() => assertMinimaxCnGenerateReady({
            MINIMAX_CN_API_KEY: "k",
            SLIDESTUDIO_LLM_BASE_URL: "https://api.minimax.io/v1",
        }), /official CN/);
    });
    it("does not let an OpenRouter key steal an explicit AMD route", () => {
        resetGenerateRouteState();
        const env = {
            MINIMAX_CN_API_KEY: "sk-test-cn",
            OPENROUTER_ONLYUSE_FREEMODEL_API_KEY: "sk-or-test-not-a-live-key",
            AMD_API_KEY: "sk-test-amd",
            SLIDESTUDIO_LLM_PROVIDER: "amd",
            SLIDESTUDIO_LLM_MODEL: "DeepSeek-V4-Flash",
        };
        assert.deepEqual(assertMinimaxCnGenerateReady(env), {
            provider: "amd",
            model: "DeepSeek-V4-Flash",
        });
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "amd-prefer-"));
        const state = connectionState(home, env);
        assert.equal(state.ready, true);
        assert.equal(state.providerId, "amd");
        assert.equal(state.model, "DeepSeek-V4-Flash");
        assert.doesNotMatch(JSON.stringify(state), /sk-or-test/);
        assert.doesNotMatch(JSON.stringify(state), /sk-test-amd/);
    });
    it("uses MiniMax China when that is the explicit route", () => {
        resetGenerateRouteState();
        const env = {
            OPENROUTER_ONLYUSE_FREEMODEL_API_KEY: "sk-or-test-not-a-live-key",
            MINIMAX_CN_API_KEY: "sk-test-cn",
            SLIDESTUDIO_LLM_PROVIDER: "minimax-cn",
            SLIDESTUDIO_LLM_MODEL: "MiniMax-M3",
        };
        assert.deepEqual(assertMinimaxCnGenerateReady(env), {
            provider: "minimax-cn",
            model: "MiniMax-M3",
        });
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "cn-home-"));
        const state = connectionState(home, env);
        assert.equal(state.ready, true);
        assert.equal(state.providerId, "minimax-cn");
        assert.equal(state.model, "MiniMax-M3");
        assert.doesNotMatch(JSON.stringify(state), /sk-or-test/);
    });
    it("switches MiniMax CN 401/403 to OpenRouter; temporary 429 waits, 2056 does not", () => {
        resetGenerateRouteState();
        const env = {
            MINIMAX_CN_API_KEY: "sk-test-cn",
            OPENROUTER_ONLYUSE_FREEMODEL_API_KEY: "sk-or-test-not-a-live-key",
        };
        assert.equal(assertMinimaxCnGenerateReady(env).provider, "minimax-cn");
        const auth = classifyAgentError({ code: "403", message: "forbidden" });
        assert.equal(auth.code, "provider-auth");
        assert.equal(isOpenRouterFailoverFault(auth), true);
        assert.equal(isWaitAndResumeFault(auth), false);
        assert.equal(isHardProviderFault(auth), true);
        const exhausted = classifyAgentError({
            message: "2056 Token Plan 用量上限，请升级 Token Plan",
        });
        assert.equal(exhausted.code, "provider-token-plan");
        assert.equal(isMinimaxTokenPlanExhausted(exhausted.detail), true);
        assert.equal(isOpenRouterFailoverFault(exhausted), false);
        assert.equal(isWaitAndResumeFault(exhausted), false);
        const limited = classifyAgentError({
            code: "RATE_LIMIT",
            message: '429 {"type":"error","error":{"type":"rate_limit_error"}}',
        });
        assert.equal(limited.code, "provider-rate-limit");
        assert.equal(isOpenRouterFailoverFault(limited), false);
        assert.equal(isWaitAndResumeFault(limited), true);
        assert.equal(isMinimaxCnFailoverFault(limited), false);
        const fromBody = classifyAgentError({
            message: '{"type":"error","error":{"type":"rate_limit_error","message":"token plan"}}',
        });
        assert.equal(fromBody.code, "provider-rate-limit");
        const wrapped = classifyAgentError({
            code: "PI_AI_ERROR",
            message: "Provider returned error",
        });
        assert.equal(wrapped.code, "provider-rate-limit");
        assert.equal(isOpenRouterFailoverFault(wrapped), false);
        assert.equal(isMinimaxCnFailoverFault(wrapped), false);
        assert.equal(isWaitAndResumeFault(wrapped), true);
        markOpenRouterHardFailed();
        assert.equal(assertMinimaxCnGenerateReady(env).provider, "minimax-cn");
        resetGenerateRouteState();
        assert.equal(assertMinimaxCnGenerateReady(env).provider, "minimax-cn");
        resetGenerateRouteState();
    });
});
describe("multi-provider API keys", () => {
    const TEST_ENV = "SLIDESTUDIO_TEST_ONLY_VENDOR_KEY";
    function writeCatalog(home) {
        fs.writeFileSync(path.join(home, "slides-model-catalog.json"), JSON.stringify({
            sourceHome: home,
            destHome: home,
            excluded: [],
            oauthSkipped: [],
            defaultProvider: "test-vendor",
            defaultModel: "test-1",
            providers: [
                {
                    id: "test-vendor",
                    name: "Test Vendor",
                    apiKeyEnv: TEST_ENV,
                    models: ["test-1"],
                    ready: false,
                },
            ],
        }));
    }
    it("a catalog ready flag alone does not mark a keyless provider ready", () => {
        const prev = process.env[TEST_ENV];
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
        try {
            delete process.env[TEST_ENV];
            writeCatalog(home);
            // Flip the fixture's static flag on: with no env key and no stored key
            // the provider must still report not-ready — a green row that cannot
            // complete a call is how "Cannot read properties of undefined" bubbles
            // reached the chat surface.
            const catalog = JSON.parse(fs.readFileSync(path.join(home, "slides-model-catalog.json"), "utf8"));
            catalog.providers[0].ready = true;
            fs.writeFileSync(path.join(home, "slides-model-catalog.json"), JSON.stringify(catalog));
            const row = slidesProviders(home).find((item) => item.id === "test-vendor");
            assert.equal(row?.ready, false);
            saveHomeKey(home, "test-vendor", "sk-test-vendor");
            assert.equal(slidesProviders(home).find((item) => item.id === "test-vendor")?.ready, true);
        }
        finally {
            if (prev === undefined)
                delete process.env[TEST_ENV];
            else
                process.env[TEST_ENV] = prev;
        }
    });
    it("saves a key for any catalog provider and marks it ready", () => {
        const prev = process.env[TEST_ENV];
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
        try {
            writeCatalog(home);
            saveHomeKey(home, "test-vendor", "sk-test-vendor");
            assert.equal(process.env[TEST_ENV], "sk-test-vendor");
            assert.equal(slidesProviders(home).find((row) => row.id === "test-vendor")?.ready, true);
            assert.doesNotMatch(JSON.stringify(slidesProviders(home)), /sk-test-vendor/);
        }
        finally {
            if (prev === undefined)
                delete process.env[TEST_ENV];
            else
                process.env[TEST_ENV] = prev;
        }
    });
    it("rebinds stored catalog keys on boot and deletes them on logout", () => {
        const prev = process.env[TEST_ENV];
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
        try {
            writeCatalog(home);
            saveHomeKey(home, "test-vendor", "sk-test-vendor");
            delete process.env[TEST_ENV];
            bindHomeKeys(home);
            assert.equal(process.env[TEST_ENV], "sk-test-vendor");
            assert.equal(deleteHomeKey(home, "test-vendor"), true);
            assert.equal(process.env[TEST_ENV], undefined);
            assert.equal(slidesProviders(home).find((row) => row.id === "test-vendor")?.ready, false);
            assert.equal(deleteHomeKey(home, "test-vendor"), false);
        }
        finally {
            if (prev === undefined)
                delete process.env[TEST_ENV];
            else
                process.env[TEST_ENV] = prev;
        }
    });
    it("DELETE /slides/providers/:id/key removes the key and refreshes the roster", async () => {
        const prev = process.env[TEST_ENV];
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
        const runtime = { dshHome: home };
        try {
            writeCatalog(home);
            const saved = await invokeSlides(runtime, "POST", "/slides/providers/test-vendor/key", {
                apiKey: "sk-test-vendor",
            });
            assert.equal(saved.status, 200);
            assert.equal(saved.json.providers.find((row) => row.id === "test-vendor")?.ready, true);
            assert.equal(saved.json.providers.find((row) => row.id === "test-vendor")?.keyStored, true);
            const removed = await invokeSlides(runtime, "DELETE", "/slides/providers/test-vendor/key");
            assert.equal(removed.status, 200);
            assert.equal(removed.json.removed, true);
            assert.equal(removed.json.providers.find((row) => row.id === "test-vendor")?.ready, false);
            assert.equal(removed.json.providers.find((row) => row.id === "test-vendor")?.keyStored, false);
            assert.equal(fs.existsSync(path.join(home, "credentials", "test-vendor.key")), false);
        }
        finally {
            if (prev === undefined)
                delete process.env[TEST_ENV];
            else
                process.env[TEST_ENV] = prev;
        }
    });
});
describe("native-first search routes", () => {
    it("advertises provider-native search for xai, codex, and anthropic only", () => {
        assert.equal(routeHasNativeSearch("pi-xai"), true);
        assert.equal(routeHasNativeSearch("pi-openai-codex"), true);
        assert.equal(routeHasNativeSearch("pi-anthropic"), true);
        assert.equal(routeHasNativeSearch("pi-github-copilot"), false);
        assert.equal(routeHasNativeSearch("pi-openrouter"), false);
        assert.equal(routeHasNativeSearch("minimax-cn"), false);
        assert.equal(routeHasNativeSearch("amd"), false);
        assert.equal(routeHasNativeSearch(undefined), false);
        assert.equal(routeHasNativeSearch(""), false);
    });
    it("marks nativeSearch on oauth providers in the roster", () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
        const rows = slidesProviders(home);
        assert.equal(rows.find((row) => row.id === "pi-xai")?.nativeSearch, true);
        assert.equal(rows.find((row) => row.id === "pi-openai-codex")?.nativeSearch, true);
        assert.equal(rows.find((row) => row.id === "pi-anthropic")?.nativeSearch, true);
        assert.equal(rows.find((row) => row.id === "pi-github-copilot")?.nativeSearch, false);
    });
    it("marks a signed-in subscription route ready even when the catalog imported it without a key", () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
        fs.writeFileSync(path.join(home, "slides-model-catalog.json"), JSON.stringify({
            sourceHome: "/src",
            destHome: home,
            excluded: [],
            oauthSkipped: ["xai"],
            defaultProvider: "pi-xai",
            defaultModel: "grok-4.6",
            providers: [
                { id: "pi-xai", name: "Grok (xAI)", apiKeyEnv: "TEST_NO_XAI_KEY", models: ["grok-4.6"], ready: false },
                {
                    id: "minimax-cn",
                    name: "MiniMax 中国",
                    apiKeyEnv: "MINIMAX_CN_API_KEY",
                    models: ["MiniMax-M3"],
                    ready: false,
                },
            ],
        }));
        fs.writeFileSync(path.join(home, ".dsh-oauth-auth.json"), JSON.stringify({
            version: 1,
            credentials: {
                xai: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 60_000 },
            },
        }));
        const rows = slidesProviders(home);
        assert.equal(rows.filter((row) => row.id === "pi-xai").length, 1);
        const grok = rows.find((row) => row.id === "pi-xai");
        assert.equal(grok?.ready, true);
        assert.deepEqual(grok?.methods, ["oauth"]);
        assert.equal(rows.find((row) => row.id === "pi-openai-codex")?.ready, false);
        fs.unlinkSync(path.join(home, "slides-model-catalog.json"));
        assert.equal(slidesProviders(home).find((row) => row.id === "pi-xai")?.ready, true);
        const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-other-"));
        assert.equal(slidesProviders(otherHome).find((row) => row.id === "pi-xai")?.ready, false);
        fs.unlinkSync(path.join(home, ".dsh-oauth-auth.json"));
        assert.equal(slidesProviders(home).find((row) => row.id === "pi-xai")?.ready, false);
    });
});
describe("product home", () => {
    function capture(method, url) {
        const sent = {
            status: 0,
            headers: {},
            body: "",
            headersSent: false,
        };
        const req = { method, url };
        const res = {
            get headersSent() {
                return sent.headersSent;
            },
            writeHead(status, headers) {
                sent.status = status;
                sent.headers = headers ?? {};
                sent.headersSent = true;
            },
            end(body) {
                sent.body = body ?? "";
            },
        };
        return { req, res, sent };
    }
    it("sends / to the create hub", () => {
        const { req, res, sent } = capture("GET", "/");
        redirectRootToProductHome(req, res);
        assert.equal(sent.status, 302);
        assert.equal(sent.headers.location, PRODUCT_HOME);
    });
    it("lets DSH exchange a launch token before the redirect", () => {
        const { req, res, sent } = capture("GET", "/?token=launch");
        let saw = false;
        redirectRootToProductHome(req, res, (innerReq, innerRes) => {
            saw = true;
            assert.equal(innerReq.url, "/?token=launch");
            innerRes.writeHead(303, { location: "/" });
            innerRes.end();
            return false;
        });
        assert.equal(saw, true);
        assert.equal(sent.status, 303);
        assert.equal(sent.headers.location, "/");
    });
    it("rejects other methods", () => {
        const { req, res, sent } = capture("POST", "/");
        redirectRootToProductHome(req, res);
        assert.equal(sent.status, 405);
    });
});
describe("product proxy", () => {
    async function listen(server) {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Expected a loopback TCP listener");
        return `http://127.0.0.1:${address.port}`;
    }
    async function close(server) {
        if (!server.listening)
            return;
        await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
    function post(frontOrigin, headers) {
        return new Promise((resolve, reject) => {
            const outgoing = request(`${frontOrigin}/app/api/open`, { method: "POST", headers }, (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => {
                    body += chunk;
                });
                response.on("end", () => resolve({ statusCode: response.statusCode, body }));
            });
            outgoing.on("error", reject);
            outgoing.end();
        });
    }
    async function withProxyServers(verify) {
        const requests = [];
        const upstream = createServer((req, res) => {
            requests.push({
                method: req.method,
                path: req.url,
                host: req.headers.host,
                origin: req.headers.origin,
            });
            res.writeHead(202, { "content-type": "text/plain" });
            res.end("upstream response");
        });
        const upstreamOrigin = await listen(upstream);
        const front = createServer((req, res) => proxyToEditor(req, res, upstreamOrigin));
        try {
            const frontOrigin = await listen(front);
            await verify({ frontOrigin, upstreamOrigin, requests });
        }
        finally {
            await close(front);
            await close(upstream);
        }
    }
    it("does not proxy generate or Pi routes to the editor sidecar", () => {
        assert.equal(shouldProxyToEditor("/api/generate"), false);
        assert.equal(shouldProxyToEditor("/api/pi/auth"), false);
        assert.equal(shouldProxyToEditor("/app/hub.html"), true);
        assert.equal(shouldProxyToEditor("/app/api/export"), true);
        assert.equal(shouldProxyToEditor("/api/export"), true);
    });
    it("rewrites same-origin mutations to the editor origin and preserves the upstream response", async () => {
        await withProxyServers(async ({ frontOrigin, upstreamOrigin, requests }) => {
            const response = await post(frontOrigin, {
                host: new URL(frontOrigin).host,
                origin: frontOrigin,
                "sec-fetch-site": "same-origin",
            });
            assert.equal(response.statusCode, 202);
            assert.equal(response.body, "upstream response");
            assert.deepEqual(requests, [
                {
                    method: "POST",
                    path: "/api/open",
                    host: new URL(upstreamOrigin).host,
                    origin: upstreamOrigin,
                },
            ]);
        });
    });
    it("rejects mutations from a different Origin without contacting the editor", async () => {
        await withProxyServers(async ({ frontOrigin, requests }) => {
            const frontUrl = new URL(frontOrigin);
            const frontPort = Number(frontUrl.port);
            const otherPort = frontPort === 65535 ? frontPort - 1 : frontPort + 1;
            const response = await post(frontOrigin, {
                host: frontUrl.host,
                origin: `${frontUrl.protocol}//${frontUrl.hostname}:${otherPort}`,
                "sec-fetch-site": "same-origin",
            });
            assert.equal(response.statusCode, 403);
            assert.equal(response.body, JSON.stringify({ error: "cross-site mutation rejected" }));
            assert.equal(requests.length, 0);
        });
    });
    it("rejects cross-site fetch mutations without contacting the editor", async () => {
        await withProxyServers(async ({ frontOrigin, requests }) => {
            const response = await post(frontOrigin, {
                host: new URL(frontOrigin).host,
                origin: frontOrigin,
                "sec-fetch-site": "cross-site",
            });
            assert.equal(response.statusCode, 403);
            assert.equal(response.body, JSON.stringify({ error: "cross-site mutation rejected" }));
            assert.equal(requests.length, 0);
        });
    });
});
describe("editor Agent batch review scope", () => {
    const shaA = "a".repeat(64);
    const shaB = "b".repeat(64);
    const batchEdit = (overrides = {}) => ({
        authorizationId: "comment-batch:1",
        pages: [
            { pageId: "01_page", revision: 3, pageSha256: shaA },
            { pageId: "02_page", revision: 5, pageSha256: shaB },
        ],
        reviewScope: {
            items: [
                {
                    kind: "elements",
                    pageId: "01_page",
                    elementIds: ["title", "title"],
                    pageRevision: 3,
                    pageSha256: shaA,
                    commentId: "c1",
                    commentRevision: 1,
                },
                {
                    kind: "page",
                    pageId: "02_page",
                    elementIds: [],
                    pageRevision: 5,
                    pageSha256: shaB,
                    commentId: "c2",
                    commentRevision: 2,
                },
            ],
        },
        ...overrides,
    });
    it("verifies every item against its own authorized page and lists both pages in the turn", () => {
        const scopes = editorReviewScopesFromEdit(batchEdit());
        assert.equal(scopes?.length, 2);
        assert.deepEqual(scopes?.[0]?.elementIds, ["title"]);
        assert.equal(scopes?.[1]?.kind, "page");
        const turn = turnTextWithReviewScope("Apply the batch", scopes);
        assert.match(turn, /Server-verified batch scope for 2 comments across 2 page\(s\)/);
        assert.match(turn, /"01_page"/);
        assert.match(turn, /"02_page"/);
        assert.match(turn, /pass each page's own pageSha256 as its expectedPageSha256/);
    });
    it("accepts multiple independent comments on one page, regardless of item order", () => {
        const edit = batchEdit();
        edit.reviewScope.items.splice(1, 0, {
            kind: "elements",
            pageId: "01_page",
            elementIds: ["subtitle", "body"],
            pageRevision: 3,
            pageSha256: shaA,
            commentId: "c3",
            commentRevision: 4,
        });
        edit.reviewScope.items.reverse();
        const scopes = editorReviewScopesFromEdit(edit);
        assert.equal(scopes.length, 3);
        assert.deepEqual(scopes.find((scope) => scope.commentId === "c1")?.elementIds, ["title"]);
        assert.deepEqual(scopes.find((scope) => scope.commentId === "c3")?.elementIds, ["subtitle", "body"]);
        assert.match(turnTextWithReviewScope("Apply", scopes), /3 comments across 2 page/);
        assert.throws(() => editorReviewScopesFromEdit({
            ...edit,
            reviewScope: {
                items: [...edit.reviewScope.items, { ...edit.reviewScope.items[0], pageId: "outside", commentId: "c4" }],
            },
        }), /authorized editorEdit.pages/);
    });
    it("keeps the single-page contract byte-identical", () => {
        const single = editorReviewScopesFromEdit({
            authorizationId: "comment:review-1",
            pageId: "01_page",
            revision: 7,
            pageSha256: shaA,
            reviewScope: {
                kind: "elements",
                pageId: "01_page",
                elementIds: ["title"],
                pageRevision: 7,
                pageSha256: shaA,
                commentId: "review-1",
                commentRevision: 3,
            },
        });
        assert.equal(single?.length, 1);
        assert.match(turnTextWithReviewScope("Apply the review", single), /Server-verified scope for comment/);
    });
    it("refuses a batch item that borrows another page's revision or hash", () => {
        assert.throws(() => editorReviewScopesFromEdit(batchEdit({
            reviewScope: {
                items: [
                    {
                        kind: "elements",
                        pageId: "01_page",
                        elementIds: ["title"],
                        pageRevision: 5,
                        pageSha256: shaA,
                        commentId: "c1",
                        commentRevision: 1,
                    },
                    {
                        kind: "page",
                        pageId: "02_page",
                        elementIds: [],
                        pageRevision: 5,
                        pageSha256: shaB,
                        commentId: "c2",
                        commentRevision: 2,
                    },
                ],
            },
        })), /pageRevision must match/);
        assert.throws(() => editorReviewScopesFromEdit(batchEdit({
            reviewScope: {
                items: [
                    {
                        kind: "elements",
                        pageId: "01_page",
                        elementIds: ["title"],
                        pageRevision: 3,
                        pageSha256: shaB,
                        commentId: "c1",
                        commentRevision: 1,
                    },
                    {
                        kind: "page",
                        pageId: "02_page",
                        elementIds: [],
                        pageRevision: 5,
                        pageSha256: shaB,
                        commentId: "c2",
                        commentRevision: 2,
                    },
                ],
            },
        })), /pageSha256 must match/);
    });
    it("refuses missing page coverage, duplicate page authorizations, or duplicate comments", () => {
        assert.throws(() => editorReviewScopesFromEdit(batchEdit({
            reviewScope: {
                items: [
                    {
                        kind: "page",
                        pageId: "01_page",
                        elementIds: [],
                        pageRevision: 3,
                        pageSha256: shaA,
                        commentId: "c1",
                        commentRevision: 1,
                    },
                ],
            },
        })), /must cover every authorized page/);
        assert.throws(() => editorReviewScopesFromEdit(batchEdit({
            reviewScope: {
                items: [
                    {
                        kind: "page",
                        pageId: "01_page",
                        elementIds: [],
                        pageRevision: 3,
                        pageSha256: shaA,
                        commentId: "c1",
                        commentRevision: 1,
                    },
                    {
                        kind: "page",
                        pageId: "02_page",
                        elementIds: [],
                        pageRevision: 5,
                        pageSha256: shaB,
                        commentId: "c1",
                        commentRevision: 1,
                    },
                ],
            },
        })), /duplicate comment/);
        assert.throws(() => editorReviewScopesFromEdit({
            authorizationId: "comment-batch:dup-page",
            pages: [
                { pageId: "01_page", revision: 3, pageSha256: shaA },
                { pageId: "01_page", revision: 3, pageSha256: shaA },
            ],
            reviewScope: {
                items: [
                    {
                        kind: "page",
                        pageId: "01_page",
                        elementIds: [],
                        pageRevision: 3,
                        pageSha256: shaA,
                        commentId: "c1",
                        commentRevision: 1,
                    },
                    {
                        kind: "page",
                        pageId: "01_page",
                        elementIds: [],
                        pageRevision: 3,
                        pageSha256: shaA,
                        commentId: "c2",
                        commentRevision: 1,
                    },
                ],
            },
        }), /must not claim the same page twice/);
    });
});
describe("same-session turn and model mutex", () => {
    function runtime(overrides = {}) {
        return {
            workspaceRoot: REPO_ROOT,
            dshHome: fs.mkdtempSync(path.join(os.tmpdir(), "mutex-home-")),
            store: { bindingFor: () => undefined, inspect: () => undefined },
            presentation: {},
            agentBusy: () => false,
            markBusy: () => undefined,
            cancelRateLimitWait: () => undefined,
            operatorStop: async () => undefined,
            getAgent: () => ({ followup: () => undefined }),
            createAgent: async () => ({ sessionId: "unused" }),
            resumeAgent: async () => undefined,
            switchModel: async () => undefined,
            ...overrides,
        };
    }
    it("rejects a turn or model switch while the Agent is busy", async () => {
        const host = runtime({ agentBusy: () => true });
        const turn = await invokeSlides(host, "POST", "/slides/sessions/busy/turn", { text: "continue" });
        assert.equal(turn.status, 409);
        assert.equal(turn.json.code, "session_busy");
        const model = await invokeSlides(host, "POST", "/slides/sessions/busy/model", {
            provider: "pi-xai",
            model: "grok-4.6",
        });
        assert.equal(model.status, 409);
        assert.equal(model.json.code, "session_busy");
    });
    it("accepts a live steer followup while the Agent is busy", async () => {
        let followed = "";
        const host = runtime({
            agentBusy: () => true,
            getAgent: () => ({
                steer: (message) => {
                    followed = String(message?.content?.[0]?.text || "");
                },
            }),
        });
        const turn = await invokeSlides(host, "POST", "/slides/sessions/busy/turn", {
            text: "封面标题再克制一点",
            steer: true,
        });
        assert.equal(turn.status, 200);
        assert.equal(turn.json.ok, true);
        assert.equal(followed, "封面标题再克制一点");
    });
    it("rejects a steer while the conversation is in discuss mode and keeps the mode", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "steer-discuss-"));
        recordConversationMessage(root, "先聊聊提纲", "discuss");
        let steered = false;
        const host = runtime({
            agentBusy: () => true,
            store: {
                bindingFor: () => ({ projectRoot: root }),
                resolveRoot: () => root,
                inspect: () => undefined,
            },
            getAgent: () => ({
                steer: () => {
                    steered = true;
                },
            }),
        });
        const turn = await invokeSlides(host, "POST", "/slides/sessions/busy/turn", {
            text: "把标题改大",
            steer: true,
        });
        assert.equal(turn.status, 409);
        assert.equal(turn.json.code, "invalid_conversation_mode");
        assert.equal(steered, false);
        const persisted = readConversation(root);
        assert.equal(persisted.mode, "discuss");
        assert.equal(persisted.messages.length, 1);
    });
    it("records a steer with the conversation's current mode, not generate", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "steer-edit-"));
        recordConversationMessage(root, "把标题改大", "edit");
        let followed = "";
        const host = runtime({
            agentBusy: () => true,
            store: {
                bindingFor: () => ({ projectRoot: root }),
                resolveRoot: () => root,
                inspect: () => undefined,
            },
            getAgent: () => ({
                steer: (message) => {
                    followed = String(message?.content?.[0]?.text || "");
                },
            }),
        });
        const turn = await invokeSlides(host, "POST", "/slides/sessions/busy/turn", {
            text: "颜色再浅一点",
            steer: true,
        });
        assert.equal(turn.status, 200);
        assert.equal(followed, "颜色再浅一点");
        const persisted = readConversation(root);
        assert.equal(persisted.mode, "edit");
        assert.equal(persisted.messages.at(-1)?.mode, "edit");
        assert.equal(persisted.messages.at(-1)?.text, "颜色再浅一点");
    });
    it("validates modelSelection before switching or sending a followup", async () => {
        let switched = false;
        let followed = false;
        const host = runtime({
            switchModel: async () => {
                switched = true;
            },
            getAgent: () => ({
                followup: () => {
                    followed = true;
                },
            }),
        });
        const response = await invokeSlides(host, "POST", "/slides/sessions/idle/turn", {
            text: "continue",
            modelSelection: { provider: "pi-xai" },
        });
        assert.equal(response.status, 400);
        assert.equal(switched, false);
        assert.equal(followed, false);
    });
});
describe("cover raster preference", () => {
    it("picks the cover page and its raster, not the first png on disk", () => {
        assert.equal(pickRasterFile(["p3_conclusion.png", "p1_cover.png", "p2_toc.png"], "p1_cover"), "p1_cover.png");
        assert.equal(pickRequestedRasterFile(["p3_squares.png", "p1_cover.png", "p5_formula.png"], "p3_squares"), "p3_squares.png");
        assert.equal(pickRequestedRasterFile(["p3_squares.png", "p1_cover.png"], "p3_demonstration"), undefined);
        const cover = pickCoverRevision([
            { type: "page.revision-committed", pageId: "p1_cover", revision: 4, pageSha256: "a" },
            { type: "page.revision-committed", pageId: "p3_conclusion", revision: 2, pageSha256: "b" },
        ]);
        assert.equal(cover?.pageId, "p1_cover");
        assert.equal(cover?.revision, 4);
    });
});
describe("deck title from brief", () => {
    it("does not slug the 勾股定理 brief into academic/paper-white-courseware", () => {
        const kids = fs.readFileSync(path.join(REPO_ROOT, "fixtures/briefs/kids-pythagoras.md"), "utf8");
        const title = deckTitleFromBrief(kids);
        assert.equal(title, "给小学生介绍勾股定理");
        assert.doesNotMatch(title, /paper-white|courseware|academic/);
        const fromTitle = slugTitle(title);
        assert.match(fromTitle, /勾股定理/);
        assert.doesNotMatch(fromTitle, /paper-white|courseware|a-b-c/);
        const fromWholeBrief = slugTitle(kids);
        assert.match(fromWholeBrief, /勾股定理/);
        assert.doesNotMatch(fromWholeBrief, /paper-white|courseware|a-b-c/);
    });
    it("does not turn a²+b²=c² into an a-b-c academic folder slug", () => {
        const accidental = slugTitle("a²+b²=c²。不要做成课件模板，不要绑定 academic/paper-white-courseware");
        assert.doesNotMatch(accidental, /paper-white|courseware|a-b-c/);
        assert.equal(slugTitle("勾股定理"), "勾股定理");
    });
    it("keeps 2026年7月 in the 澄光生活 slug", () => {
        const slug = slugTitle("澄光生活 2026年7月经营月报");
        assert.match(slug, /澄光生活/);
        assert.match(slug, /2026/);
        assert.match(slug, /7月/);
        assert.doesNotMatch(slug, /^-年-月-/);
    });
});
describe("slice provider binding", () => {
    it("updates the on-disk provider after OpenRouter failover", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-provider-"));
        const store = new SliceSessionStore(workspace);
        const opened = store.openProject({
            dshSessionId: "sess-switch",
            title: "cover",
            design: { kind: "self-directed" },
            provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
        });
        store.updateProvider("sess-switch", {
            providerId: "openrouter",
            modelId: OPENROUTER_MINIMAX_FREE_MODEL,
        });
        const snap = store.inspect("sess-switch");
        assert.equal(snap.binding.provider.providerId, "openrouter");
        assert.equal(snap.binding.provider.modelId, OPENROUTER_MINIMAX_FREE_MODEL);
        assert.equal(opened.binding.provider.providerId, "minimax-cn");
    });
    it("openProject lists zero composed pages and does not plant 1_cover.page", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-empty-create-"));
        const store = new SliceSessionStore(workspace);
        const opened = store.openProject({
            dshSessionId: "sess-empty-create",
            title: "澄光生活 2026年7月经营月报",
            design: { kind: "self-directed" },
            provider: { providerId: "openrouter", modelId: OPENROUTER_MINIMAX_FREE_MODEL },
        });
        const root = store.resolveRoot(opened.binding);
        const project = loadProject(root);
        assert.equal(project.pages.length, 0);
        assert.deepEqual(project.presentation.pages, []);
        assert.equal(fs.existsSync(path.join(root, "pages", "1_cover.page")), false);
        const snap = store.inspect("sess-empty-create");
        assert.equal(snap.project.pageCount, 0);
    });
    it("bindingFor caches the index and survives a corrupt sibling binding", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-binding-cache-"));
        const store = new SliceSessionStore(workspace);
        store.openProject({
            dshSessionId: "sess-cache-a",
            title: "a",
            design: { kind: "self-directed" },
            provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
        });
        // First call warms the index; a later on-disk edit must not be re-read.
        assert.equal(store.bindingFor("sess-cache-a")?.provider.providerId, "minimax-cn");
        const bindingFile = path.join(store.resolveRoot(store.bindingFor("sess-cache-a")), "_agent", "slice-binding.json");
        fs.writeFileSync(bindingFile, JSON.stringify({
            version: 1,
            dshSessionId: "sess-cache-a",
            projectRoot: store.bindingFor("sess-cache-a").projectRoot,
            design: { kind: "self-directed" },
            provider: { providerId: "openrouter", modelId: "minimax/minimax-m3:free" },
            createdAt: "x",
        }));
        assert.equal(store.bindingFor("sess-cache-a")?.provider.providerId, "minimax-cn");
        // updateProvider keeps the cached index and the file in sync.
        store.updateProvider("sess-cache-a", { providerId: "openrouter", modelId: "m" });
        assert.equal(store.bindingFor("sess-cache-a")?.provider.providerId, "openrouter");
        // A corrupt sibling binding file must not take down unrelated lookups.
        const corruptDir = path.join(store.slicesRoot(), "deck-badseed0");
        fs.mkdirSync(path.join(corruptDir, "_agent"), { recursive: true });
        fs.writeFileSync(path.join(corruptDir, "_agent", "slice-binding.json"), "{not json");
        const fresh = new SliceSessionStore(workspace);
        assert.equal(fresh.bindingFor("sess-cache-a")?.provider.providerId, "openrouter");
        assert.equal(fresh.bindingFor("missing"), undefined);
    });
});
describe("self-directed kids brief", () => {
    it("does not bind academic/paper-white-courseware on disk", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kids-"));
        const store = new SliceSessionStore(workspace);
        const opened = store.openProject({
            dshSessionId: "sess-kids",
            title: deckTitleFromBrief(fs.readFileSync(path.join(REPO_ROOT, "fixtures/briefs/kids-pythagoras.md"), "utf8")),
            design: { kind: "self-directed" },
            provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
        });
        const root = store.resolveRoot(opened.binding);
        // Neutral folder: the deck's title lives in the PPTD metadata, never in a
        // path or the editor URL (the model used to hand that path to the user).
        assert.equal(path.basename(path.dirname(opened.binding.projectRoot)), "dsh-slices");
        assert.match(path.basename(opened.binding.projectRoot), /^deck-[A-Za-z0-9_-]+$/);
        assert.doesNotMatch(opened.binding.projectRoot, /勾股定理/);
        assert.doesNotMatch(opened.binding.projectRoot, /paper-white|courseware|a-b-c/);
        writeSliceRuntime(root, {
            brief: "给小学生介绍勾股定理",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        const runtime = JSON.stringify(readSliceRuntimeFile(root));
        const dshRuntime = fs.readFileSync(path.join(root, "_agent", "dsh-runtime.json"), "utf8");
        assert.doesNotMatch(runtime, /paper-white-courseware/);
        assert.doesNotMatch(runtime, /education-training/);
        assert.doesNotMatch(dshRuntime, /paper-white-courseware/);
        assert.equal(JSON.parse(dshRuntime).design.kind, "self-directed");
    });
    it("does not show a leaked 不要做成课件模板 brief as the inspect title", () => {
        const kids = fs.readFileSync(path.join(REPO_ROOT, "fixtures/briefs/kids-pythagoras.md"), "utf8");
        const leaked = "给小学生介绍勾股定理。用三角形和面积讲清楚 a²+b²=c²。不要做成课件模板，";
        assert.equal(displayDeckTitle(leaked, kids), "给小学生介绍勾股定理");
        assert.equal(displayDeckTitle("勾股定理：三角形里的秘密", kids), "勾股定理：三角形里的秘密");
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kids-title-"));
        const store = new SliceSessionStore(workspace);
        const opened = store.openProject({
            dshSessionId: "sess-title",
            title: leaked,
            design: { kind: "self-directed" },
            provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
        });
        writeSliceRuntime(store.resolveRoot(opened.binding), {
            brief: kids,
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        const snap = store.inspect("sess-title");
        assert.equal(snap.project.title, "给小学生介绍勾股定理");
        assert.doesNotMatch(snap.project.title, /课件模板|paper-white/);
    });
});
describe("rate-limit wait and same-session resume", () => {
    const openRouter429 = '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"minimax/minimax-m3:free is temporarily rate-limited upstream. Please retry shortly","provider_name":"GMICloud","retry_after_seconds":60,"retry_after_seconds_raw":60,"headers":{"Retry-After":"60"}}}';
    it("honors Retry-After then 15s/30s/60s/2m/5m/cap 15m", () => {
        assert.equal(parseRetryAfterMs(openRouter429), 60_000);
        assert.equal(parseRetryAfterMs({ headers: { "Retry-After": "12" } }), 12_000);
        assert.equal(rateLimitWaitMs(0, 60_000), 60_000);
        assert.deepEqual([...RATE_LIMIT_BACKOFF_MS], [15_000, 30_000, 60_000, 120_000, 300_000]);
        assert.equal(rateLimitWaitMs(0), 15_000);
        assert.equal(rateLimitWaitMs(1), 30_000);
        assert.equal(rateLimitWaitMs(2), 60_000);
        assert.equal(rateLimitWaitMs(3), 120_000);
        assert.equal(rateLimitWaitMs(4), 300_000);
        assert.equal(rateLimitWaitMs(5), RATE_LIMIT_BACKOFF_CAP_MS);
        assert.equal(rateLimitWaitMs(9), 15 * 60_000);
        assert.equal(rateLimitWaitMs(0, 20 * 60_000), RATE_LIMIT_BACKOFF_CAP_MS);
    });
    it("pauses then resumes the same session; operator stop cancels", async () => {
        const scheduled = [];
        const resumed = [];
        const pauses = [];
        const ctl = new RateLimitResumeController({
            now: () => 1_000,
            schedule: (ms, fn) => {
                const rec = { ms, fn, cancelled: false };
                scheduled.push(rec);
                return {
                    cancel: () => {
                        rec.cancelled = true;
                    },
                };
            },
            resume: (sessionId) => {
                resumed.push(sessionId);
            },
            notePaused: (sessionId, _fault, wait) => {
                pauses.push({ sessionId, waitMs: wait.waitMs, attempt: wait.attempt });
            },
        });
        const fault = classifyAgentError({ code: 429, message: openRouter429 });
        assert.equal(fault.code, "provider-rate-limit");
        const same = "sess-chengguang";
        assert.equal(ctl.pauseAndResume(same, fault, parseRetryAfterMs(openRouter429)), true);
        assert.equal(ctl.isWaiting(same), true);
        assert.equal(scheduled.length, 1);
        assert.equal(scheduled[0]?.ms, 60_000);
        assert.equal(pauses[0]?.sessionId, same);
        assert.deepEqual(resumed, []);
        scheduled[0]?.fn();
        await Promise.resolve();
        assert.deepEqual(resumed, [same]);
        ctl.pauseAndResume(same, { code: "provider-rate-limit", detail: "429" });
        assert.equal(scheduled.at(-1)?.ms, 30_000);
        ctl.operatorStop(same);
        assert.equal(scheduled.at(-1)?.cancelled, true);
        const afterStop = resumed.length;
        scheduled.at(-1)?.fn();
        await Promise.resolve();
        assert.equal(resumed.length, afterStop);
    });
    it("rejected resume re-records the pause and clears the resuming flag", async () => {
        const scheduled = [];
        const failures = [];
        let calls = 0;
        const ctl = new RateLimitResumeController({
            now: () => 1_000,
            schedule: (ms, fn) => {
                const rec = { ms, fn, cancelled: false };
                scheduled.push(rec);
                return {
                    cancel: () => {
                        rec.cancelled = true;
                    },
                };
            },
            resume: () => {
                calls += 1;
                if (calls === 1)
                    return Promise.reject(new Error("kernel gone"));
            },
            notePaused: () => undefined,
            resumeFailed: (sessionId, fault, error) => {
                failures.push({
                    sessionId,
                    code: fault.code,
                });
                assert.equal(error instanceof Error ? error.message : "", "kernel gone");
            },
        });
        const same = "sess-resume-fail";
        const fault = { code: "provider-rate-limit", detail: "429" };
        assert.equal(ctl.pauseAndResume(same, fault), true);
        scheduled[0]?.fn();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(failures.length, 1);
        assert.equal(failures[0]?.sessionId, same);
        // After the failed resume the session is no longer "in flight" — a fresh
        // 429 may arm a new wait instead of being swallowed by a stale flag.
        assert.equal(ctl.isWaiting(same), false);
        assert.equal(ctl.pauseAndResume(same, fault), true);
        assert.equal(scheduled.length, 2);
    });
    it("does not wait-and-resume 401/403", () => {
        const resumed = [];
        const ctl = new RateLimitResumeController({
            now: () => 0,
            schedule: () => ({ cancel: () => undefined }),
            resume: (sessionId) => {
                resumed.push(sessionId);
            },
            notePaused: () => undefined,
        });
        const auth = classifyAgentError({ code: "401", message: "invalid api key" });
        assert.equal(isHardProviderFault(auth), true);
        assert.equal(ctl.pauseAndResume("sess-auth", auth), false);
        assert.deepEqual(resumed, []);
    });
    it("keeps inspect paused with rateLimitWait and never complete", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-wait-"));
        const store = new SliceSessionStore(workspace);
        store.openProject({
            dshSessionId: "sess-wait",
            title: "cover",
            design: { kind: "self-directed" },
            provider: { providerId: "openrouter", modelId: "minimax/minimax-m3:free" },
        });
        const root = store.resolveRoot(store.bindingFor("sess-wait"));
        writeSliceRuntime(root, {
            brief: "澄光生活 2026年7月经营月报",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        recordAgentError(root, classifyAgentError({ code: 429, message: openRouter429 }));
        writeRateLimitWait(root, {
            attempt: 1,
            waitMs: 60_000,
            nextRetryAt: Date.now() + 60_000,
            code: "provider-rate-limit",
        });
        const snap = store.inspect("sess-wait");
        assert.equal(snap.phase.kind, "paused");
        assert.notEqual(snap.phase.kind, "complete");
        assert.equal(snap.rateLimitWait?.code, "provider-rate-limit");
        assert.equal(snap.rateLimitWait?.waitMs, 60_000);
        assert.equal(snap.binding.dshSessionId, "sess-wait");
    });
    it("does not treat idle complete as success while a 429 wait is pending", () => {
        const scheduled = [];
        const ctl = new RateLimitResumeController({
            now: () => 1_000,
            schedule: (ms, fn) => {
                scheduled.push({ ms, fn });
                return {
                    cancel: () => {
                        scheduled.at(-1).cancelled = true;
                    },
                };
            },
            resume: () => undefined,
            notePaused: () => undefined,
        });
        const fault = classifyAgentError({ code: 429, message: openRouter429 });
        assert.equal(ctl.pauseAndResume("sess-complete-429", fault, 60_000), true);
        assert.equal(ctl.isWaiting("sess-complete-429"), true);
        if (!ctl.isWaiting("sess-complete-429"))
            ctl.onTurnSuccess("sess-complete-429");
        assert.equal(ctl.isWaiting("sess-complete-429"), true);
        assert.equal(scheduled[0]?.cancelled, undefined);
    });
});
describe("empty closer inspect", () => {
    it("surfaces a 429 before the generic empty-closer page-ready state", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-empty-closer-"));
        const store = new SliceSessionStore(workspace);
        store.openProject({
            dshSessionId: "sess-empty-closer",
            title: "澄光生活",
            design: { kind: "self-directed" },
            provider: { providerId: "openrouter", modelId: OPENROUTER_MINIMAX_FREE_MODEL },
        });
        const root = store.resolveRoot(store.bindingFor("sess-empty-closer"));
        writeSliceRuntime(root, {
            brief: "澄光生活 2026年7月经营月报",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        initializeRunLedger(root);
        const project = loadProject(root);
        project.pages.push({
            path: "pages/p01_cover.page",
            page: {
                pageType: "cover",
                elements: [
                    {
                        elementId: "cl-bg",
                        elementType: "shape",
                        shapeName: "rect",
                        bounds: [0, 0, 960, 540],
                        fill: { type: "solid", color: "#06223F" },
                    },
                    {
                        elementId: "t",
                        elementType: "text",
                        bounds: [80, 160, 800, 80],
                        content: { text: "封面标题足够长了用于测试", fontSize: 36, color: "#FFFFFF" },
                    },
                ],
            },
        }, {
            path: "pages/02_final.page",
            page: {
                pageType: "final",
                elements: [
                    {
                        elementId: "cl-bg",
                        elementType: "shape",
                        shapeName: "rect",
                        bounds: [0, 0, 960, 540],
                        fill: { type: "solid", color: "#06223F" },
                    },
                ],
            },
        });
        project.presentation.pages = project.pages.map((page) => page.path);
        saveProject(project);
        const ledgerPath = path.join(root, "_agent", "run-ledger.v1.json");
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
        ledger.facts.push({ type: "page.revision-committed", pageId: "cover", revision: 1, pageSha256: "aa" }, { type: "page.revision-committed", pageId: "closing", revision: 1, pageSha256: "bb" }, { type: "deck.composed", deckSha256: "cc" });
        fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
        recordAgentError(root, classifyAgentError({
            code: 429,
            message: '429: {"message":"Provider returned error","code":429,"metadata":{"retry_after_seconds":60,"headers":{"Retry-After":"60"}}}',
        }));
        const snap = store.inspect("sess-empty-closer");
        assert.equal(snap.phase.kind, "paused");
        assert.notEqual(snap.phase.kind, "complete");
        if (snap.phase.kind === "paused")
            assert.match(snap.phase.detail, /provider-rate-limit/);
        assert.equal(snap.rateLimitWait, undefined);
    });
    it("does not treat an unbound historical compose fact as current completion", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-closer-ok-"));
        const store = new SliceSessionStore(workspace);
        store.openProject({
            dshSessionId: "sess-closer-ok",
            title: "澄光生活",
            design: { kind: "self-directed" },
            provider: { providerId: "openrouter", modelId: OPENROUTER_MINIMAX_FREE_MODEL },
        });
        const root = store.resolveRoot(store.bindingFor("sess-closer-ok"));
        writeSliceRuntime(root, {
            brief: "澄光生活 2026年7月经营月报",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        initializeRunLedger(root);
        const project = loadProject(root);
        project.pages.push({
            path: "pages/02_final.page",
            page: {
                pageType: "final",
                elements: [
                    {
                        elementId: "cl-bg",
                        elementType: "shape",
                        shapeName: "rect",
                        bounds: [0, 0, 960, 540],
                        fill: { type: "solid", color: "#06223F" },
                    },
                    {
                        elementId: "cl-title",
                        elementType: "text",
                        bounds: [80, 140, 760, 80],
                        content: { text: "澄光生活 · 结束页", fontSize: 36, color: "#FFFFFF" },
                    },
                    {
                        elementId: "cl-recap",
                        elementType: "text",
                        bounds: [80, 240, 760, 72],
                        content: { text: "7月营收 1,860 万，预算达成 93%。", fontSize: 18, color: "#FFFFFF" },
                    },
                ],
            },
        });
        project.presentation.pages = project.pages.map((page) => page.path);
        saveProject(project);
        const ledgerPath = path.join(root, "_agent", "run-ledger.v1.json");
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
        ledger.facts.push({ type: "page.revision-committed", pageId: "cover", revision: 1, pageSha256: "aa" }, { type: "page.revision-committed", pageId: "closing", revision: 1, pageSha256: "bb" }, { type: "deck.composed", deckSha256: "cc" });
        fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
        const snap = store.inspect("sess-closer-ok");
        assert.equal(snap.phase.kind, "page-ready");
        assert.notEqual(snap.phase.kind, "complete");
    });
    it("pauses a composed closer on 429 so Retry-After can resume the same session", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-closer-429-"));
        const store = new SliceSessionStore(workspace);
        store.openProject({
            dshSessionId: "sess-closer-429",
            title: "澄光生活",
            design: { kind: "self-directed" },
            provider: { providerId: "openrouter", modelId: OPENROUTER_MINIMAX_FREE_MODEL },
        });
        const root = store.resolveRoot(store.bindingFor("sess-closer-429"));
        writeSliceRuntime(root, {
            brief: "澄光生活 2026年7月经营月报",
            design: { kind: "self-directed" },
            editorBaseUrl: "http://127.0.0.1:55200",
            strictExecution: true,
        });
        initializeRunLedger(root);
        const project = loadProject(root);
        project.pages.push({
            path: "pages/02_final.page",
            page: {
                pageType: "final",
                elements: [
                    {
                        elementId: "cl-bg",
                        elementType: "shape",
                        shapeName: "rect",
                        bounds: [0, 0, 960, 540],
                        fill: { type: "solid", color: "#06223F" },
                    },
                    {
                        elementId: "cl-title",
                        elementType: "text",
                        bounds: [80, 140, 760, 80],
                        content: { text: "澄光生活 · 结束页", fontSize: 36, color: "#FFFFFF" },
                    },
                    {
                        elementId: "cl-recap",
                        elementType: "text",
                        bounds: [80, 240, 760, 72],
                        content: { text: "7月营收 1,860 万，预算达成 93%。", fontSize: 18, color: "#FFFFFF" },
                    },
                ],
            },
        });
        project.presentation.pages = project.pages.map((page) => page.path);
        saveProject(project);
        const ledgerPath = path.join(root, "_agent", "run-ledger.v1.json");
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
        ledger.facts.push({ type: "page.revision-committed", pageId: "cover", revision: 1, pageSha256: "aa" }, { type: "page.revision-committed", pageId: "closing", revision: 1, pageSha256: "bb" }, { type: "deck.composed", deckSha256: "cc" });
        fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
        recordAgentError(root, classifyAgentError({
            code: 429,
            message: '429: {"message":"Provider returned error","code":429,"metadata":{"retry_after_seconds":60,"headers":{"Retry-After":"60"}}}',
        }));
        writeRateLimitWait(root, {
            attempt: 1,
            waitMs: 60_000,
            nextRetryAt: Date.now() + 60_000,
            code: "provider-rate-limit",
        });
        const snap = store.inspect("sess-closer-429");
        assert.equal(snap.phase.kind, "paused");
        assert.notEqual(snap.phase.kind, "complete");
        assert.equal(snap.rateLimitWait?.code, "provider-rate-limit");
        assert.equal(snap.rateLimitWait?.waitMs, 60_000);
    });
});
describe("director brief pages hint", () => {
    it("does not treat 不要做成经营月报 as a KPI monthly report", () => {
        const harness = "闸门复现灯开关\n两页即可：封面 + 结束页。不要做成经营月报，不要做成课件。虚构车间灯开关验收。";
        const hint = pagesHintForBrief(harness);
        assert.doesNotMatch(hint, /full operating report/);
        assert.match(hint, /Plan every page the brief actually needs/);
        const directed = directorBrief(harness);
        assert.match(directed, /闸门复现灯开关/);
        assert.match(directed, /deterministic render layout gate/);
        assert.match(directed, /layoutStatus=pass/);
        assert.match(directed, /expectedPageSha256/);
        assert.match(directed, /only authority for vision, research, image, render, and export/);
        assert.match(directed, /missingReferenceChunks.*before commit_design or write_todo/);
        assert.match(directed, /After all page and structural gates pass, call compose_deck/);
        assert.doesNotMatch(directed, /grok-4\.6|Grok already|dsh-oauth native hosted|x_search/);
        assert.doesNotMatch(directed, /MUST call search_image or generate_image/);
        assert.match(directed, /data\.cols/);
        assert.match(directed, /generate_image with that width and height/);
        assert.match(directed, /empty slot is refused/);
        assert.match(directed, /write_page using the same bounds/);
        assert.match(directed, /matching capability is configured/);
        assert.doesNotMatch(directed, /move to the next todo page/);
        assert.match(directed, /layoutStatus=pass is overflow-only/);
        assert.match(directed, /current structural pass/);
        assert.match(directed, /rewrite seal/);
        assert.doesNotMatch(directed, /full operating report/);
        assert.doesNotMatch(directed, /Missing rasters are not overflow/);
    });
    it("still plans ~20 pages for a real 经营月报 brief", () => {
        const hint = pagesHintForBrief("澄光生活 2026年7月经营月报，约 20 页。");
        assert.match(hint, /full operating report/);
        assert.match(hint, /20 pages/);
        assert.match(hint, /deterministic render_page layout pass/);
    });
    it("respects an explicit smaller page count for a focused 经营月报", () => {
        const hint = pagesHintForBrief("客户运营中心 2026 年 7 月经营月报，请制作 7 页。");
        assert.match(hint, /full operating report/);
        assert.match(hint, /Plan about 7 pages/);
        assert.doesNotMatch(hint, /Plan about 20 pages/);
    });
    const beilu = "给公司董事会做一份「北麓制造 2026 上半年经营汇报」。办公场景，给董事会的半年经营审议，不是门店月报，不是产品立项。内容要有：H1 收入/毛利/现金一句话结论，三条业务线达成，产能与交期，客户与回款，资本开支，下半年要拍的板。 16 页左右。虚构演示数据。不要澄光生活，不要青岚费控，不要学习分享，不要个人答辩。\n视觉不要素白公文：深色封面、杂志感排版、数字很大、对比强、克制留白、琥珀或铜点缀。仍是董事会半年经营汇报，不是花哨营销页，不是月报换皮。";
    it("classifies 董事会半年经营汇报 as board H1, not product intro or retail monthly", () => {
        const hint = pagesHintForBrief(beilu);
        assert.match(hint, /board half-year/);
        assert.match(hint, /16/);
        assert.doesNotMatch(hint, /product introduction/);
        assert.doesNotMatch(hint, /full operating report/);
        assert.doesNotMatch(hint, /Plan about 20 pages/);
        const directed = directorBrief(beilu);
        assert.match(directed, /北麓制造/);
        assert.match(directed, /深色封面/);
        assert.match(directed, /Host will not paint leftover/);
        assert.match(directed, /Do not adopt work\/\*/);
        assert.match(directed, /from the catalog/);
        assert.match(directed, /empty adopt/);
        assert.doesNotMatch(directed, /product introduction \/ 立项/);
        assert.doesNotMatch(directed, /full operating report/);
    });
    it("keeps explicit colors and typography from a board H1 brief as overrides", () => {
        const realBrief = "做一份给经营层与董事看的 2026 半年度检讨简报。12 页。封面与末页深蓝，内页暖灰白，点缀砖红与松绿；标题衬线、正文无衬线。";
        const hint = pagesHintForBrief(realBrief);
        assert.match(hint, /board half-year/);
        assert.match(hint, /Plan about 12 pages/);
        const directed = directorBrief(realBrief);
        assert.match(directed, /explicit visual overrides/);
        assert.doesNotMatch(directed, /No explicit style/);
    });
    it("classifies 青岚费控 产品介绍 as 立项, not a 20-page 澄光月报", () => {
        const qinglan = "给管理层做一份「青岚费控」产品介绍，办公立项用。讲清楚：这是什么、给谁用（财务/部门经理/员工）、解决什么报销和对账痛点、核心流程、和现有 Excel/OA 的差别、上线节奏、这次要拍的板。16 页左右。虚构演示数据即可。不要做成经营月报，不要澄光生活，不要学习分享，不要个人答辩。";
        const hint = pagesHintForBrief(qinglan);
        assert.match(hint, /product introduction|立项/);
        assert.match(hint, /16/);
        assert.doesNotMatch(hint, /full operating report/);
        assert.doesNotMatch(hint, /Plan about 20 pages/);
        assert.doesNotMatch(hint, /board half-year/);
        const directed = directorBrief(qinglan);
        assert.match(directed, /青岚费控/);
        assert.doesNotMatch(directed, /full operating report/);
        assert.match(directed, /经营月报 layouts/);
        assert.match(directed, /Do not adopt work\/\*/);
        assert.match(directed, /empty adopt/);
    });
    it("classifies 开题答辩 as academic and requires an academic catalog pack", () => {
        const hint = pagesHintForBrief("开题报告：城市热岛。只有方法边界，没有实验数据。");
        assert.match(hint, /academic\/\*/);
        assert.match(hint, /empty adopt/);
        assert.doesNotMatch(hint, /full operating report/);
        assert.doesNotMatch(hint, /board half-year/);
    });
    it("classifies 学习分享 as knowledge-share and requires consulting or promotion", () => {
        const share = "给同事做一次内部「学习分享」。办公场景，约 30 分钟的知识分享会，听众是同组同事，不是经营月报，不是产品立项。16–20 页。不要澄光生活。";
        const hint = pagesHintForBrief(share);
        assert.match(hint, /学习分享/);
        assert.match(hint, /Consulting and promotion/);
        assert.match(hint, /empty adopt/);
        assert.doesNotMatch(hint, /full operating report/);
        assert.doesNotMatch(hint, /product introduction \/ 立项/);
        assert.doesNotMatch(hint, /board half-year/);
        const directed = directorBrief(share);
        assert.match(directed, /学习分享/);
        assert.match(directed, /Do not adopt work\/\*/);
        assert.match(directed, /agent-self-directed-plan is refused/);
        const chapters = "给AI产品同学做一场内部学习分享：Agent 怎么把需求拆成可执行计划。封面之后分三部分：问题、方法、例子。每部分先一张章节页再展开。收尾一页把步骤收成清单。";
        const chapterHint = pagesHintForBrief(chapters);
        assert.match(chapterHint, /学习分享/);
        assert.doesNotMatch(chapterHint, /single cover/);
    });
    it("gives office-specific direction to performance, work, teaching, training, and proposal briefs", () => {
        const cases = [
            [
                "做一份个人年中述职报告：目标达成、代表项目、能力复盘和下半年计划。8页。",
                /performance review|述职/,
                /goal.*evidence.*reflection.*next plan/i,
            ],
            [
                "做一份项目阶段工作汇报：进度、交付、风险、资源和下周计划。8页。",
                /work report|工作汇报/,
                /status.*evidence.*risk.*next action/i,
            ],
            [
                "做一份高中物理教学课件：概念导入、推导、例题、课堂练习与小结。8页。",
                /teaching courseware|教学/,
                /objective.*concept.*worked example.*practice.*recap/i,
            ],
            [
                "做一份新员工培训课件：流程、案例、练习和检查清单。8页。",
                /training deck|培训/,
                /objective.*procedure.*example.*practice.*checklist/i,
            ],
            [
                "做一份仓储自动化项目立项方案：现状、目标、方案、投入、里程碑、风险和决策事项。8页。",
                /project proposal|立项方案/,
                /problem.*option.*investment.*milestone.*risk.*decision/i,
            ],
        ];
        for (const [brief, kind, structure] of cases) {
            const hint = pagesHintForBrief(brief);
            assert.match(hint, kind);
            assert.match(hint, /8/);
            assert.match(hint, structure);
            assert.doesNotMatch(hint, /Plan every page the brief actually needs/);
            assert.doesNotMatch(hint, /full operating report/);
        }
    });
    it("does not invent an 8-page cap when a catalog style is selected and the brief omits a count", () => {
        const brief = "做一份高中物理教学课件：概念导入、推导、例题、课堂练习与小结。";
        const hint = pagesHintForBrief(brief);
        assert.match(hint, /teaching courseware|教学/);
        assert.doesNotMatch(hint, /Plan about 8 pages/);
        assert.doesNotMatch(hint, /at least six/);
        assert.match(hint, /selected catalog style never implies page count/);
        const directed = directorBrief(brief, "academic/blue-line-courseware");
        assert.match(directed, /academic\/blue-line-courseware/);
        assert.match(directed, /do not treat the pack as a page-count cap/);
        assert.doesNotMatch(directed, /Plan about 8 pages/);
    });
    it("does not invent 10/16/18/20 page defaults when the brief omits a count", () => {
        const training = pagesHintForBrief("做一份新员工培训课件：流程、案例、练习和检查清单。");
        assert.match(training, /training deck|培训/);
        assert.doesNotMatch(training, /Plan about 8 pages/);
        const share = pagesHintForBrief("给同事做一次内部「学习分享」。办公场景，知识分享会。不要澄光生活。");
        assert.match(share, /学习分享/);
        assert.doesNotMatch(share, /Plan about 18 pages/);
        const monthly = pagesHintForBrief("澄光生活 2026年7月经营月报。");
        assert.match(monthly, /full operating report/);
        assert.doesNotMatch(monthly, /Plan about 20 pages/);
    });
});
describe("Hub produce-gate load path", () => {
    const repoRoot = REPO_ROOT;
    it("rejects an empty leftover *_content write on the loaded host without painting YAML", () => {
        assert.equal(emptyWriteIsRejectedByLoadedHost(), true);
    });
    it("loaded createEmptyProject does not list a host seed as a composed slide", () => {
        assert.equal(emptyCreateHasNoSeedFromLoadedPptd(), true);
    });
    it("matches workspace dist hashes and is generate-ready", () => {
        const report = inspectHubProduceGates(repoRoot);
        assert.equal(report.ok, true, `failed=${report.failed.join(",")} missing=${report.missing.join(",")}`);
        assert.equal(report.hashMatch, true);
        assert.equal(report.emptyWriteRejected, true);
        assert.equal(report.emptyCreateHasNoSeed, true);
        assert.equal(report.generateReady, true);
        assertHubProduceGatesReady(repoRoot);
    });
    it("fails closed when the workspace dist hash does not match the loaded host", () => {
        const fake = fs.mkdtempSync(path.join(os.tmpdir(), "stale-gates-"));
        for (const rel of PRODUCE_GATE_REL_FILES) {
            fs.mkdirSync(path.dirname(path.join(fake, rel)), { recursive: true });
            fs.writeFileSync(path.join(fake, rel), "export function pageHasVisibleContent() { return true }\n");
        }
        const report = inspectHubProduceGates(fake);
        assert.equal(report.ok, false);
        assert.equal(report.hashMatch, false);
        assert.ok(report.failed.includes("stale-profile-hash"));
        assert.throws(() => assertHubProduceGatesReady(fake), StaleProduceGatesError);
    });
    it("POST /slides/sessions and /turn return 503 stale_produce_gates; GET /slides/state still serves", async () => {
        const fake = fs.mkdtempSync(path.join(os.tmpdir(), "stale-gates-http-"));
        for (const rel of PRODUCE_GATE_REL_FILES) {
            fs.mkdirSync(path.dirname(path.join(fake, rel)), { recursive: true });
            fs.writeFileSync(path.join(fake, rel), "export function pageHasVisibleContent() { return true }\n");
        }
        const parked = "84082545-3666-485f-94d4-84f3176549b7";
        const runtime = staleRuntime(fake, parked);
        const health = await invokeSlides(runtime, "GET", "/slides/health");
        assert.equal(health.status, 200);
        const healthBody = health.json;
        assert.equal(healthBody.produceGates?.ok, false);
        assert.equal(healthBody.produceGates?.hashMatch, false);
        assert.equal(healthBody.produceGates?.emptyWriteRejected, true);
        assert.equal(healthBody.produceGates?.emptyCreateHasNoSeed, true);
        const created = await invokeSlides(runtime, "POST", "/slides/sessions", { brief: "must not generate" });
        assert.equal(created.status, 503);
        const createdBody = created.json;
        assert.equal(createdBody.code, "stale_produce_gates");
        assert.equal(createdBody.generateReady, false);
        const turn = await invokeSlides(runtime, "POST", `/slides/sessions/${parked}/turn`, { text: "continue" });
        assert.equal(turn.status, 503);
        const turnBody = turn.json;
        assert.equal(turnBody.code, "stale_produce_gates");
        const state = await invokeSlides(runtime, "GET", `/slides/state/${parked}`);
        assert.equal(state.status, 200);
        const stateBody = state.json;
        assert.equal(stateBody.kernel, "dsh");
    });
    it("waits for operator stop quiescence before sending the stop response", async () => {
        const sessionId = "stop-after-idle";
        const runtime = staleRuntime(fs.mkdtempSync(path.join(os.tmpdir(), "stop-route-")), sessionId);
        let begin;
        let release;
        const began = new Promise((resolve) => {
            begin = resolve;
        });
        const quiescent = new Promise((resolve) => {
            release = resolve;
        });
        runtime.operatorStop = async (id) => {
            assert.equal(id, sessionId);
            begin();
            await quiescent;
        };
        const pending = invokeSlides(runtime, "POST", `/slides/sessions/${sessionId}/stop`);
        await began;
        let responded = false;
        void pending.then(() => {
            responded = true;
        });
        await Promise.resolve();
        assert.equal(responded, false);
        release();
        const stopped = await pending;
        assert.equal(stopped.status, 200);
        assert.deepEqual(stopped.json, {
            ok: true,
            sessionId,
            stopped: true,
            kernel: "dsh",
            hostDirected: false,
        });
    });
});
function staleRuntime(workspaceRoot, parkedSessionId) {
    return {
        workspaceRoot,
        dshHome: os.tmpdir(),
        store: {
            inspect: () => ({
                binding: {
                    version: 1,
                    dshSessionId: parkedSessionId,
                    projectRoot: "output/dsh-slices/parked",
                    design: { kind: "self-directed" },
                    provider: { providerId: "openrouter", modelId: "minimax/minimax-m3:free" },
                    createdAt: "2026-08-28T00:00:00.000Z",
                },
                project: { title: "parked", pageCount: 0, deckSha256: "" },
                phase: { kind: "paused", detail: "operator-stop" },
            }),
            bindingFor: () => undefined,
        },
        presentation: {
            hydrate: () => undefined,
            inspect: async () => undefined,
        },
        agentBusy: () => false,
        markBusy: () => undefined,
        cancelRateLimitWait: () => undefined,
        operatorStop: async () => undefined,
        getAgent: () => undefined,
        createAgent: async () => {
            throw new Error("createAgent must not run when produce gates are stale");
        },
        resumeAgent: async () => {
            throw new Error("resumeAgent must not run when produce gates are stale");
        },
        switchModel: async () => undefined,
    };
}
describe("hosted runtime model roster", () => {
    const catalog = new Map([
        [
            "minimax-local",
            new Map([
                [
                    "minimax-code-m3.1",
                    {
                        name: "MiniMax M3.1 Preview",
                        inputModalities: ["text"],
                        efforts: ["high"],
                    },
                ],
            ]),
        ],
        [
            "devin-local",
            new Map([
                [
                    "devin/swe-2",
                    {
                        name: "SWE-2",
                        inputModalities: ["text"],
                        efforts: ["max"],
                    },
                ],
            ]),
        ],
    ]);
    it("advertises native custom adapters without an exported catalog or copied credentials", () => {
        const providers = hostedProviders(catalog);
        assert.deepEqual(providers.map((p) => p.id), ["minimax-local", "devin-local"]);
        assert.equal(providers[0]?.ready, true);
        assert.deepEqual(providers[0]?.models, ["minimax-code-m3.1"]);
        assert.deepEqual(providers[0]?.modelEfforts?.["minimax-code-m3.1"], ["high"]);
        for (const [provider, models] of catalog) {
            for (const model of models.keys()) {
                const route = assertSlidesGenerateReady({}, { provider, model, managedCatalog: catalog });
                assert.equal(route.provider, provider);
                assert.equal(route.model, model);
            }
        }
    });
    it("serves the live picker and health selection from the same hosted roster", async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-roster-"));
        try {
            const runtime = {
                ...staleRuntime(home, "unused-session"),
                workspaceRoot: REPO_ROOT,
                dshHome: home,
                managedModels: true,
                listModelCatalog: async () => catalog,
                providerHealth: () => ({ kind: "broken", reason: "temporary adapter error" }),
            };
            const models = await invokeSlides(runtime, "GET", "/slides/models");
            assert.equal(models.status, 200);
            const groups = models.json;
            assert.deepEqual(groups.map((group) => group.providerId), ["minimax-local", "devin-local"]);
            assert.equal(groups[0]?.models[0]?.name, "MiniMax M3.1 Preview");
            const health = await invokeSlides(runtime, "GET", "/slides/health");
            const body = health.json;
            assert.deepEqual(body.selection, { providerId: "minimax-local", model: "minimax-code-m3.1", ready: true });
            assert.equal(body.generateReady, true);
        }
        finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
    it("shows every registered hosted provider while retaining existing generation restrictions", () => {
        const all = new Map([
            ...catalog,
            [
                "antigravity",
                new Map([
                    [
                        "custom-model",
                        {
                            name: "Custom",
                            inputModalities: ["text"],
                        },
                    ],
                ]),
            ],
        ]);
        assert.equal(hostedProviders(all).length, 3);
        assert.throws(() => assertSlidesGenerateReady({}, { provider: "antigravity", model: "custom-model", managedCatalog: all }), /Antigravity generate is rejected/);
    });
    it("rejects missing hosted models and preserves isolated-home credential checks", () => {
        assert.throws(() => assertSlidesGenerateReady({}, {
            provider: "minimax-local",
            model: "missing",
            managedCatalog: catalog,
        }), /current provider roster/);
        assert.throws(() => assertSlidesGenerateReady({}, {
            provider: "minimax-local",
            model: "minimax-code-m3.1",
            managedCatalog: new Map(),
        }), /current provider roster/);
        assert.throws(() => assertSlidesGenerateReady({}, {
            provider: "minimax-local",
            model: "minimax-code-m3.1",
        }), /no credential/);
    });
});
it("does not mistake a provider trace id for an authentication status", () => {
    assert.equal(friendlyProviderCause("devin upstream error (invalid_argument): an internal error occurred (trace ID: ae34269d84d62b2d7403fcd39296220a)"), "（模型服务拒绝了本次请求）");
    assert.equal(friendlyProviderCause("upstream HTTP 403 Forbidden"), "（模型服务认证失效或未配置）");
});
//# sourceMappingURL=host.test.js.map