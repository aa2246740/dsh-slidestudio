import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pinnedPlaywrightRuntimePath } from "./page-raster.js";

export const DECK_OVERVIEW_RENDERER_VERSION = "deck-overview-v1";

export type DeckOverviewPage = Readonly<{
  pageId: string;
  revision: number;
  pageSha256: string;
  rasterSha256: string;
  rasterSrc: string;
}>;

export type DeckOverviewResult = Readonly<{
  src: string;
  bytes: Buffer;
  sha256: string;
  width: number;
  height: number;
  rendererVersion: typeof DECK_OVERVIEW_RENDERER_VERSION;
}>;

export type DeckOverviewRenderer = (
  input: Readonly<{
    html: string;
    selector: "#deck-overview";
  }>,
) => Promise<Readonly<{ bytes: Buffer; width: number; height: number }>>;

export type RenderDeckOverviewInput = Readonly<{
  projectRoot: string;
  deckSnapshotSha256: string;
  pages: readonly DeckOverviewPage[];
  renderer?: DeckOverviewRenderer;
  pinnedRuntimePath?: string;
}>;

export async function renderDeckOverview(input: RenderDeckOverviewInput): Promise<DeckOverviewResult> {
  if (!/^[a-f0-9]{64}$/.test(input.deckSnapshotSha256)) {
    throw new Error("deck overview requires a valid snapshot hash");
  }
  if (input.pages.length < 2) throw new Error("deck overview requires at least 2 pages");
  const pages = input.pages.map((page, index) => readPage(input.projectRoot, page, index));
  const dir = path.join(path.resolve(input.projectRoot), "_agent", "overviews");
  const name = `${input.deckSnapshotSha256}.png`;
  const file = path.join(dir, name);
  const metaFile = path.join(dir, `${input.deckSnapshotSha256}.json`);
  if (fs.existsSync(file) && fs.existsSync(metaFile)) {
    const bytes = fs.readFileSync(file);
    assertPng(bytes, "deck overview replay");
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as Record<string, unknown>;
    const existingSha = sha256(bytes);
    if (
      meta.deckSnapshotSha256 !== input.deckSnapshotSha256 ||
      meta.sha256 !== existingSha ||
      meta.rendererVersion !== DECK_OVERVIEW_RENDERER_VERSION ||
      !Number.isFinite(meta.width) ||
      !Number.isFinite(meta.height)
    ) {
      throw new Error("deck overview replay metadata is invalid");
    }
    return {
      src: `_agent/overviews/${name}`,
      bytes,
      sha256: existingSha,
      width: Math.round(Number(meta.width)),
      height: Math.round(Number(meta.height)),
      rendererVersion: DECK_OVERVIEW_RENDERER_VERSION,
    };
  }
  const html = overviewHtml(pages);
  const renderer = input.renderer ?? createPinnedRenderer(input.pinnedRuntimePath ?? pinnedPlaywrightRuntimePath());
  const shot = await renderer({ html, selector: "#deck-overview" });
  assertPng(shot.bytes, "deck overview");
  if (!Number.isFinite(shot.width) || !Number.isFinite(shot.height) || shot.width < 640 || shot.height < 240) {
    throw new Error("deck overview renderer returned invalid dimensions");
  }
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file);
    if (sha256(existing) !== sha256(shot.bytes)) {
      throw new Error("deck overview replay produced different bytes for the same snapshot");
    }
  } else {
    atomicWrite(file, shot.bytes);
  }
  atomicWrite(
    metaFile,
    Buffer.from(
      `${JSON.stringify(
        {
          deckSnapshotSha256: input.deckSnapshotSha256,
          sha256: sha256(shot.bytes),
          width: Math.round(shot.width),
          height: Math.round(shot.height),
          rendererVersion: DECK_OVERVIEW_RENDERER_VERSION,
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  );
  return {
    src: `_agent/overviews/${name}`,
    bytes: shot.bytes,
    sha256: sha256(shot.bytes),
    width: Math.round(shot.width),
    height: Math.round(shot.height),
    rendererVersion: DECK_OVERVIEW_RENDERER_VERSION,
  };
}

function readPage(projectRoot: string, page: DeckOverviewPage, index: number) {
  if (!/^[a-z][a-z0-9-]*$/.test(page.pageId)) {
    throw new Error(`invalid overview page id at index ${index}`);
  }
  const root = path.resolve(projectRoot);
  const file = path.resolve(root, page.rasterSrc);
  if (file === root || !file.startsWith(`${root}${path.sep}`)) {
    throw new Error(`overview raster escapes project: ${page.rasterSrc}`);
  }
  const bytes = fs.readFileSync(file);
  assertPng(bytes, page.pageId);
  if (sha256(bytes) !== page.rasterSha256) {
    throw new Error(`overview raster hash mismatch: ${page.pageId}`);
  }
  return { ...page, bytes };
}

function overviewHtml(pages: readonly (DeckOverviewPage & Readonly<{ bytes: Buffer }>)[]): string {
  const cards = pages
    .map(
      (page, index) => `
        <figure class="page" data-page-id="${escapeHtml(page.pageId)}">
          <img alt="P${index + 1} ${escapeHtml(page.pageId)}" src="data:image/png;base64,${page.bytes.toString("base64")}">
          <figcaption>P${index + 1}</figcaption>
        </figure>`,
    )
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;background:#e9ebef;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#deck-overview{width:1480px;padding:32px;display:grid;grid-template-columns:repeat(3,1fr);gap:28px 24px;background:#e9ebef}
.page{margin:0;min-width:0}.page img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#fff;box-shadow:0 1px 5px rgba(13,25,44,.16)}
.page figcaption{height:28px;padding-top:8px;color:#4e5868;font-size:15px;font-weight:650;letter-spacing:.04em}
</style></head><body><main id="deck-overview">${cards}</main></body></html>`;
}

function createPinnedRenderer(runtimeFile: string): DeckOverviewRenderer {
  return async ({ html, selector }) => {
    if (!fs.existsSync(runtimeFile)) {
      throw new Error(`Pinned Playwright runtime is missing: ${runtimeFile}`);
    }
    const runtime = (await import(pathToFileURL(runtimeFile).href)) as {
      verifyPinnedRuntime?: () => unknown;
      launchPinnedChromium?: (opts?: { headless?: boolean }) => Promise<unknown>;
    };
    if (typeof runtime.verifyPinnedRuntime !== "function" || typeof runtime.launchPinnedChromium !== "function") {
      throw new Error(`Pinned Playwright runtime API mismatch: ${runtimeFile}`);
    }
    runtime.verifyPinnedRuntime();
    const browser = (await runtime.launchPinnedChromium({ headless: true })) as OverviewBrowser;
    try {
      const page = await browser.newPage({ viewport: { width: 1544, height: 900 } });
      try {
        await page.setContent(html, { waitUntil: "load" });
        await page.evaluate(async () => {
          const images = Array.from(document.images);
          await Promise.all(
            images.map((image) =>
              image.complete
                ? Promise.resolve()
                : new Promise<void>((resolve, reject) => {
                    image.addEventListener("load", () => resolve(), { once: true });
                    image.addEventListener("error", () => reject(new Error("overview image failed")), {
                      once: true,
                    });
                  }),
            ),
          );
        });
        const locator = page.locator(selector);
        const bounds = await locator.boundingBox();
        if (!bounds) throw new Error("deck overview selector is missing");
        const bytes = Buffer.from(await locator.screenshot({ type: "png" }));
        return { bytes, width: bounds.width, height: bounds.height };
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  };
}

type OverviewBrowser = {
  newPage(options: { viewport: { width: number; height: number } }): Promise<OverviewPage>;
  close(): Promise<void>;
};

type OverviewPage = {
  setContent(html: string, options: { waitUntil: "load" }): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  locator(selector: string): {
    boundingBox(): Promise<{ width: number; height: number } | null>;
    screenshot(options: { type: "png" }): Promise<Buffer>;
  };
  close(): Promise<void>;
};

function assertPng(bytes: Buffer, label: string): void {
  if (bytes.length < 64 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error(`${label} is not a complete PNG`);
  }
}

function atomicWrite(file: string, bytes: Buffer): void {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escaped[char] ?? char;
  });
}
