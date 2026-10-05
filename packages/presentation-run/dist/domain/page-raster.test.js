import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assessRenderedLayout, pinnedPlaywrightRuntimePath, projectHasPptd, rasterRuntimeReady, readPageRaster, readRenderedLayout, normalizeRasterPageToNativeSlideSize, savePageRaster, } from "./page-raster.js";
describe("page raster project manifest", () => {
    it("accepts any root PPTD manifest name, not only deck.pptd", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-raster-manifest-"));
        try {
            fs.writeFileSync(path.join(root, "quarterly-review.pptd"), "{}\n");
            assert.equal(projectHasPptd(root), true);
        }
        finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it("treats a missing pinned Playwright runtime as not ready", () => {
        const missing = path.join(os.tmpdir(), "missing-pinned-runtime.mjs");
        assert.equal(rasterRuntimeReady({ SLIDESTUDIO_PLAYWRIGHT_RUNTIME: missing }), false);
    });
    it("points a missing runtime at the managed state dir, not a Codex box homedir", () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pw-repo-"));
        const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "pw-home-"));
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-state-"));
        const env = { OPEN_SLIDESTUDIO_ROOT: repo };
        const resolved = pinnedPlaywrightRuntimePath(env, { repoRoot: repo, homeDir: emptyHome, stateDir });
        assert.equal(resolved, path.join(stateDir, "playwright-runtime", "runtime.mjs"));
        assert.equal(rasterRuntimeReady(env, resolved), false);
        assert.equal(resolved.includes(".codex/playwright-runtime"), false);
    });
    it("uses a repo-pinned runtime when Codex homedir is empty", () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pw-repo-ready-"));
        const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "pw-home-empty-"));
        const file = path.join(repo, ".runtime", "playwright", "runtime.mjs");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `export function verifyPinnedRuntime() { return true; }
export async function launchPinnedChromium() { throw new Error("stub"); }
`);
        const env = { OPEN_SLIDESTUDIO_ROOT: repo };
        const resolved = pinnedPlaywrightRuntimePath(env, { repoRoot: repo, homeDir: emptyHome });
        assert.equal(resolved, file);
        assert.equal(rasterRuntimeReady(env, resolved), true);
    });
    it("refuses to claim render ready when the runtime file exists but has no launch API", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-empty-"));
        const file = path.join(dir, "runtime.mjs");
        fs.writeFileSync(file, "export const nope = true;\n");
        assert.equal(rasterRuntimeReady({ SLIDESTUDIO_PLAYWRIGHT_RUNTIME: file }), false);
    });
    it("round-trips a page raster that vision can attach", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-raster-bytes-"));
        const png = Buffer.alloc(80, 7);
        try {
            savePageRaster(root, "1_cover", png);
            const loaded = readPageRaster(root, "1_cover");
            assert.ok(loaded);
            assert.equal(loaded.equals(png), true);
            assert.equal(readPageRaster(root, "missing_page"), undefined);
        }
        finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
function snapshot(contrastRatio, requiredContrast) {
    return {
        slideWidth: 960,
        slideHeight: 540,
        fontsReady: true,
        nodes: [{
                id: "cover-title",
                type: "text",
                layoutRole: "content",
                left: 80,
                top: 80,
                right: 880,
                bottom: 140,
                scrollWidth: 800,
                clientWidth: 800,
                scrollHeight: 60,
                clientHeight: 60,
                textColor: "rgb(0, 0, 0)",
                backgroundColor: "rgb(14, 42, 71)",
                backgroundSource: "path:fill",
                contrastRatio,
                requiredContrast,
            }],
    };
}
describe("rendered text contrast", () => {
    it("fails black text on the captured navy cover", () => {
        const report = assessRenderedLayout(snapshot(1.44, 4.5));
        assert.equal(report.ok, false);
        assert.equal(report.hardIssues[0]?.kind, "text-contrast");
        assert.match(report.hardIssues[0]?.detail ?? "", /1\.44.*4\.50/);
    });
    it("accepts a compliant foreground and the large-text 3:1 threshold", () => {
        assert.equal(assessRenderedLayout(snapshot(12.42, 4.5)).ok, true);
        assert.equal(assessRenderedLayout(snapshot(3.2, 3)).ok, true);
        assert.equal(assessRenderedLayout(snapshot(3.2, 4.5)).ok, false);
    });
    it("fails closed when the rendered background cannot be resolved", () => {
        const unresolved = snapshot(12.42, 4.5);
        unresolved.nodes[0].contrastUnresolvedSource = "div:background-image";
        const report = assessRenderedLayout(unresolved);
        assert.equal(report.ok, false);
        assert.equal(report.hardIssues[0]?.kind, "text-contrast-unresolved");
    });
});
describe("rendered text contrast DOM sampler", () => {
    let browser;
    before(async () => {
        const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
        const repo = path.resolve(pkg, "../..");
        const runtimePath = pinnedPlaywrightRuntimePath({ OPEN_SLIDESTUDIO_ROOT: repo }, { repoRoot: repo });
        // Any resolved source is fine (repo, managed, codex or machine install);
        // it only has to be a real pinned runtime the DOM sampler can launch.
        assert.equal(rasterRuntimeReady({ OPEN_SLIDESTUDIO_ROOT: repo }, runtimePath), true);
        const runtime = (await import(pathToFileURL(runtimePath).href));
        const pin = runtime.verifyPinnedRuntime();
        assert.ok(pin.playwrightVersion);
        assert.ok(pin.chromiumRevision);
        browser = await runtime.launchPinnedChromium();
    });
    after(async () => {
        await browser?.close();
    });
    async function sample(body, slideBackground = "#0E2A47") {
        assert.ok(browser, "pinned Chromium was not launched");
        const page = await browser.newPage();
        try {
            await page.setContent(`<!doctype html>
        <style>
          #slide { position:relative; width:960px; height:540px; background:${slideBackground}; font-family:sans-serif; }
          .el { position:absolute; box-sizing:border-box; }
          .text { left:80px; top:80px; width:800px; height:80px; font-size:18px; line-height:1.3; }
        </style>
        <div id="slide">${body}</div>`);
            return await readRenderedLayout(page);
        }
        finally {
            await page.close();
        }
    }
    it("ignores transparent HTML default fill and finds the real light slide", async () => {
        const report = await sample(`
      <div class="el" style="inset:0;z-index:1"></div>
      <div class="el text" data-id="light-on-light" style="z-index:2;color:#fff">Unreadable white copy</div>
    `, "#F7F2EA");
        assert.ok(report.hardIssues.some((issue) => issue.kind === "text-contrast" && issue.elementId === "light-on-light"), JSON.stringify(report.hardIssues));
    });
    it("measures real rich-text runs instead of a ghost parent color", async () => {
        const report = await sample(`
      <div class="el text" data-id="rich" style="color:#000"><span style="color:#fff">Readable white span</span></div>
    `);
        assert.equal(report.hardIssues.some((issue) => issue.kind === "text-contrast"), false, JSON.stringify(report.hardIssues));
    });
    it("keeps a text box's own solid background in the contrast stack", async () => {
        const report = await sample(`
      <div class="el text" data-id="self-bg" style="color:#fff;background:#0E2A47">Readable own-background copy</div>
    `, "#F7F2EA");
        assert.equal(report.hardIssues.some((issue) => issue.kind === "text-contrast"), false, JSON.stringify(report.hardIssues));
    });
    it("reports footer geometry in native 960x540 coordinates after editor fit scaling", async () => {
        assert.ok(browser, "pinned Chromium was not launched");
        const page = await browser.newPage();
        try {
            await page.setContent(`<!doctype html>
        <style>
          body { margin: 0; }
          .slide-card { width: 1102px; height: 620px; }
          #slide {
            position: relative;
            width: 960px;
            height: 540px;
            transform: scale(${620 / 540});
            transform-origin: top left;
            background: #fff;
          }
          .el { position: absolute; box-sizing: border-box; }
        </style>
        <div class="slide-card">
          <div id="slide">
            <div class="el text" data-id="footer" data-layout-role="footer"
              style="left:60px;top:495px;width:460px;height:24px;color:#111">Footer</div>
          </div>
        </div>`);
            await normalizeRasterPageToNativeSlideSize(page);
            const dimensions = await page.evaluate(() => {
                const slide = document.getElementById("slide");
                const rect = slide.getBoundingClientRect();
                const parent = slide.parentElement.getBoundingClientRect();
                return { width: rect.width, height: rect.height, parentWidth: parent.width, parentHeight: parent.height };
            });
            assert.deepEqual(dimensions, {
                width: 960,
                height: 540,
                parentWidth: 960,
                parentHeight: 540,
            });
            const report = await readRenderedLayout(page);
            assert.equal(report.footerZoneTop, 500);
            const issue = report.hardIssues.find((row) => row.kind === "footer-outside-footer-zone");
            assert.match(issue?.detail ?? "", /footer begins at 495\.0.*starting at 500\.0/);
        }
        finally {
            await page.close();
        }
    });
    it("composites foreground alpha and ancestor opacity before contrast", async () => {
        const rgba = await sample(`
      <div class="el text" data-id="rgba" style="color:rgba(255,255,255,.25)">Faded copy</div>
    `);
        assert.ok(rgba.hardIssues.some((issue) => issue.kind === "text-contrast"));
        const opacity = await sample(`
      <div class="el text" data-id="opacity" style="color:#fff;opacity:.25">Faded group copy</div>
    `);
        assert.ok(opacity.hardIssues.some((issue) => issue.kind === "text-contrast"));
    });
    it("applies shared group opacity after composing text over its own background", async () => {
        const report = await sample(`
      <div class="el text" data-id="opacity-group" style="font-size:24px;color:#fff;background:#000;opacity:.5">Readable grouped copy</div>
    `, "#FFFFFF");
        assert.equal(report.hardIssues.some((issue) => issue.kind === "text-contrast"), false, JSON.stringify(report.hardIssues));
    });
    it("checks SVG chart labels against the slide or the bar beneath them", async () => {
        const lowContrast = await sample(`
      <div class="el chart" data-id="chart-low" style="left:80px;top:80px;width:400px;height:160px">
        <svg width="400" height="160"><text x="20" y="40" fill="#777777" font-size="12">Low contrast axis</text></svg>
      </div>
    `, "#F7F2EA");
        assert.ok(lowContrast.hardIssues.some((issue) => issue.kind === "text-contrast" && issue.elementId === "chart-low"), JSON.stringify(lowContrast.hardIssues));
        const onBar = await sample(`
      <div class="el chart" data-id="chart-bar" style="left:80px;top:80px;width:400px;height:160px">
        <svg width="400" height="160">
          <rect x="10" y="10" width="240" height="80" fill="#0E2A47"></rect>
          <text x="30" y="55" fill="#FFFFFF" font-size="18">Readable on bar</text>
        </svg>
      </div>
    `, "#F7F2EA");
        assert.equal(onBar.hardIssues.some((issue) => issue.kind === "text-contrast"), false, JSON.stringify(onBar.hardIssues));
    });
    it("fails closed for text over gradient and SVG url paints", async () => {
        const gradient = await sample(`
      <div class="el text" data-id="gradient" style="color:#fff;background-image:linear-gradient(#fff,#fff)">Unresolved gradient</div>
    `, "#0E2A47");
        assert.ok(gradient.hardIssues.some((issue) => issue.kind === "text-contrast-unresolved" && issue.elementId === "gradient"), JSON.stringify(gradient.hardIssues));
        const svgPaint = await sample(`
      <div class="el chart" data-id="svg-paint" style="left:80px;top:80px;width:400px;height:160px">
        <svg width="400" height="160">
          <defs><linearGradient id="white"><stop stop-color="#fff"></stop></linearGradient></defs>
          <rect x="10" y="10" width="240" height="80" fill="url(#white)"></rect>
          <text x="30" y="55" fill="#FFFFFF" font-size="18">Unresolved SVG paint</text>
        </svg>
      </div>
    `, "#0E2A47");
        assert.ok(svgPaint.hardIssues.some((issue) => issue.kind === "text-contrast-unresolved" && issue.elementId === "svg-paint"), JSON.stringify(svgPaint.hardIssues));
    });
    it("blocks a horizontal rule whose rendered clearance above text is unsafe", async () => {
        const report = await sample(`
      <div class="el shape" data-id="section-rule" style="left:72px;top:310px;width:816px;height:1px;background:#D9D2C5"></div>
      <div class="el text" data-id="section-label" style="left:72px;top:322px;width:816px;height:16px;color:#706960;font-size:10px">H1 累計（合併口徑）</div>
    `, "#F7F2EA");
        assert.ok(report.hardIssues.some((issue) => String(issue.kind) === "line-text-clearance" &&
            issue.elementId === "section-rule,section-label"), JSON.stringify(report.hardIssues));
        const crossing = await sample(`
      <div class="el shape" data-id="crossing-rule" style="left:72px;top:328px;width:816px;height:1px;background:#D9D2C5"></div>
      <div class="el text" data-id="crossed-label" style="left:72px;top:322px;width:816px;height:16px;color:#706960;font-size:10px">判斷</div>
    `, "#F7F2EA");
        assert.ok(crossing.hardIssues.some((issue) => String(issue.kind) === "line-text-intersection" &&
            issue.elementId === "crossing-rule,crossed-label"), JSON.stringify(crossing.hardIssues));
    });
});
//# sourceMappingURL=page-raster.test.js.map