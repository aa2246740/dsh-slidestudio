/** Visual QA and delivery: render/review pages, compose and export the deck. */
import fs from "node:fs";
import path from "node:path";
import { inspectProjectCapabilities, readPageRaster } from "@open-slidestudio/presentation-run";
import type { SlideContentBlock, SlideToolContext, SlideToolDefinition, SlideToolResult } from "./contract.js";
import { shouldAttachPageRaster } from "./page-raster-content.js";
import {
  isLeaseRefusalData,
  present,
  receiptResult,
  result,
  sessionKeyOf,
  slideTool,
  type SlideToolRuntimeDeps,
} from "./tool-kit.js";
import { reviewPageGate, type ExclusiveSessionGate } from "./write-page-serial.js";
import { SlideToolArgsError } from "./contract.js";

const RASTER_SINK_MISSING =
  "vision.mode is main-model but the DSH attachments service is not mounted; cannot send the raster to the selected model";

function runExclusivePageStep<T>(
  gate: ExclusiveSessionGate,
  sessionId: string,
  toolName: string,
  task: () => Promise<T>,
): Promise<T> {
  const slot = gate.tryAcquire(sessionId, toolName);
  if (!slot.ok) {
    throw new SlideToolArgsError([
      `Host runs ${toolName} one page at a time. ${slot.busyWith} is still running; wait for that result before another ${toolName}.`,
    ]);
  }
  return task().finally(() => slot.release());
}

function rasterBytesFromPayload(projectRoot: string, src: unknown): Buffer | undefined {
  if (typeof src !== "string" || !src.trim()) return undefined;
  const root = path.resolve(projectRoot);
  const abs = path.resolve(root, src.trim());
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return undefined;
  if (!fs.existsSync(abs)) return undefined;
  const bytes = fs.readFileSync(abs);
  return bytes.length >= 64 ? bytes : undefined;
}

/**
 * The page raster as a neutral image block when the selected model reviews
 * pixels (`vision.mode` main-model). `deliveryToken` is marked emitted only
 * after the host delivered the image.
 */
export function pageRasterContent(opts: {
  readonly deps: SlideToolRuntimeDeps;
  readonly ctx: SlideToolContext;
  readonly pageId: string;
  readonly pngBytes?: Buffer;
  readonly deliveryToken?: string;
}): Pick<SlideToolResult, "content" | "onContentDelivered"> {
  const { deps, ctx, pageId } = opts;
  const visionMode = inspectProjectCapabilities(ctx.projectRoot).vision.mode;
  const pngBytes = opts.pngBytes ?? readPageRaster(ctx.projectRoot, pageId);
  if (!shouldAttachPageRaster({ visionMode, pngBytes }) || !pngBytes) return {};
  if (ctx.acceptsImageContent === false) throw new Error(RASTER_SINK_MISSING);
  const block: SlideContentBlock = {
    type: "image",
    data: new Uint8Array(pngBytes),
    mediaType: "image/png",
    name: `${pageId || "page"}.png`,
  };
  const token = opts.deliveryToken;
  return {
    content: [block],
    ...(token
      ? {
          onContentDelivered: async () => {
            await present(deps, ctx, "_mark_image_emitted", { deliveryToken: token });
          },
        }
      : {}),
  };
}

export function renderPageTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "render_page",
    description:
      "Raster the current page through the native editor #slide screenshot. Host accepts only one render_page at a time: wait for this result before the next page. Wait for this tool result before review_page. When inspect_capabilities.vision.mode is main-model, the PNG is attached as an image part for the selected vision-capable model. Copy the complete DELIVERY_TOKEN from this successful result into review_page for the same pageId and revision.",
    parameters: { pageId: { type: "string", required: true } },
    readOnly: false,
    render: "vision",
    async execute(args, ctx) {
      return runExclusivePageStep(reviewPageGate, sessionKeyOf(ctx), "render_page", async () => {
        const receipt = await present(deps, ctx, "render_page", args);
        if (!receipt.ok && isLeaseRefusalData(receipt.payload)) return receiptResult(receipt);
        const pageId = String(args.pageId ?? "").trim();
        const pngBytes =
          rasterBytesFromPayload(ctx.projectRoot, receipt.payload.src) ?? readPageRaster(ctx.projectRoot, pageId);
        const token = receipt.payload.deliveryToken;
        const raster = pageRasterContent({
          deps,
          ctx,
          pageId,
          pngBytes,
          deliveryToken: typeof token === "string" ? token : undefined,
        });
        const data = { ok: receipt.ok, summary: receipt.summary, detail: receipt.detail, payload: receipt.payload };
        return { ...result(data), ...raster };
      });
    },
  });
}

export function reviewPageTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "review_page",
    description:
      "Aesthetics-only visual review after a successful render_page for this exact pageId and revision. Host accepts only one review_page at a time: wait for this result before the next page. Copy its complete DELIVERY_TOKEN exactly; do not shorten or reuse it. verdict=pass requires issues=[] because praise is not an unresolved issue. verdict=revise requires one or more concrete visible defects in issues. When vision.mode is none this tool is unavailable; use review_pages for deterministic checks and authorized editor edits for human-requested revisions.",
    parameters: {
      pageId: { type: "string", required: true },
      revision: { type: "integer", required: true },
      deliveryToken: { type: "string", required: true },
      verdict: { type: "string", enum: ["pass", "revise"], required: true },
      issues: { type: "array", items: { type: "string" }, required: true },
    },
    closed: true,
    readOnly: false,
    render: "vision",
    async execute(args, ctx) {
      return runExclusivePageStep(reviewPageGate, sessionKeyOf(ctx), "review_page", async () => {
        const pageId = String(args.pageId ?? "").trim();
        const receipt = await present(deps, ctx, "review_page", args);
        if (!receipt.ok && isLeaseRefusalData(receipt.payload)) return receiptResult(receipt);
        const raster = pageRasterContent({ deps, ctx, pageId });
        const data = { ok: receipt.ok, summary: receipt.summary, detail: receipt.detail, payload: receipt.payload };
        return { ...result(data), ...raster };
      });
    },
  });
}

export function reviewPagesTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "review_pages",
    description:
      "Run deterministic structural and latest-plan coverage review from disk. Missing and extra pages are issues with ok=false and a Chinese recovery hint. Repair missing pages; restore orphan ids to the plan or delete_pages, then review again.",
    parameters: {},
    closed: true,
    readOnly: false,
    async execute(args, ctx) {
      return receiptResult(await present(deps, ctx, "review_pages", args));
    },
  });
}

export function composeDeckTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "compose_deck",
    description:
      "Seal current PPTD pages after every required gate passes. Pass only the title. Success returns page IDs, titles, deck hash and a short per-page provenance summary; use read_page for content. On rejection, follow payload.next and the exact missingReferenceChunks/page-id arrays; do not repeat compose_deck without satisfying that step.",
    parameters: { title: { type: "string", required: true } },
    closed: true,
    readOnly: false,
    async execute(args, ctx) {
      return receiptResult(await present(deps, ctx, "compose_deck", args));
    },
  });
}

export function exportDeckTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "export_deck",
    description: "Export the current PPTD project to a hybrid editable PPTX. Full-page raster is a failure.",
    parameters: {},
    readOnly: false,
    async execute(args, ctx) {
      return receiptResult(await present(deps, ctx, "export_deck", args));
    },
  });
}
