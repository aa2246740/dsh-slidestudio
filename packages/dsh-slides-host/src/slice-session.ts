import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { readRunLedger, inspectRunLedger, stableSha256, pageHasReadableCopy } from "@open-slidestudio/presentation-run";
import { acquireProjectLease } from "./lease.js";
import {
  classifyAgentError,
  isPauseFault,
  isWaitAndResumeFault,
  readAgentError,
  readCurrentAgentError,
  readRateLimitWait,
} from "./agent-fault.js";
import { readSliceRuntimeFile } from "./runtime.js";
import type {
  DesignDirective,
  PageEvidence,
  SlicePhase,
  SliceSessionBinding,
  SliceSessionSnapshot,
} from "./protocol.js";

const BINDING_REL = path.join("_agent", "slice-session.v1.json");
const SLICES_DIR = path.join("output", "dsh-slices");

export function bindingPath(projectRoot: string): string {
  return path.join(projectRoot, BINDING_REL);
}

/**
 * Folder slug from a deck title.
 * Keep CJK so 勾股定理 stays 勾股定理. Never turn a²+b²=c² into a-b-c, and never
 * keep academic/paper-white-courseware from a brief that names a template it forbids.
 */
export function slugTitle(title: string): string {
  const stripped = title
    .replace(/academic\/paper-white-courseware/gi, " ")
    .replace(/paper-white-courseware/gi, " ")
    .replace(/不要绑定[^\s。,]*/g, " ")
    .replace(/不要做成课件模板/g, " ");
  const cjk = stripped
    .replace(/[^\u4e00-\u9fff0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (cjk) return cjk;
  const ascii = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!ascii || /^(?:[a-c]-)+[a-c]$/.test(ascii)) return "slice";
  return ascii;
}

/** Folder/display title. Do not slug the whole brief (it may name a template it forbids). */
export function deckTitleFromBrief(brief: string): string {
  const line = (brief.split(/\n/).find((row) => row.trim()) ?? "").trim();
  const sentence = line.split(/[。！？.!?]/)[0] ?? line;
  const cleaned = sentence
    .replace(/^#+\s*/, "")
    .replace(/[《》]/g, "")
    .replace(/不要绑定\S+/g, "")
    .trim();
  return cleaned.slice(0, 40) || "deck";
}

/** Inspect/chrome title. Do not surface a leaked “不要做成课件模板” brief as the deck name. */
export function displayDeckTitle(yamlTitle: string, brief: string): string {
  if (/不要绑定|不要做成课件模板|paper-white-courseware/i.test(yamlTitle) && brief.trim()) {
    return deckTitleFromBrief(brief);
  }
  return yamlTitle;
}

export class SliceSessionStore {
  /** In-memory session→binding index; populated lazily and kept in sync on writes. */
  private bindings?: Map<string, SliceSessionBinding>;

  constructor(private readonly workspaceRoot: string) {}

  slicesRoot(): string {
    return path.join(this.workspaceRoot, SLICES_DIR);
  }

  rebuild(): Map<string, SliceSessionBinding> {
    const index = new Map<string, SliceSessionBinding>();
    const root = this.slicesRoot();
    if (!fs.existsSync(root)) return index;
    for (const name of fs.readdirSync(root)) {
      const projectRoot = path.join(root, name);
      const file = bindingPath(projectRoot);
      if (!fs.existsSync(file)) continue;
      try {
        const binding = JSON.parse(fs.readFileSync(file, "utf8")) as SliceSessionBinding;
        if (typeof binding.dshSessionId === "string" && binding.dshSessionId) {
          index.set(binding.dshSessionId, binding);
        }
      } catch (error) {
        console.warn(
          `[dsh-slides-host] skipping corrupt session binding ${file}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return index;
  }

  private index(): Map<string, SliceSessionBinding> {
    if (!this.bindings) this.bindings = this.rebuild();
    return this.bindings;
  }

  bindingFor(dshSessionId: string): SliceSessionBinding | undefined {
    return this.index().get(dshSessionId);
  }

  resolveRoot(binding: SliceSessionBinding): string {
    return path.resolve(this.workspaceRoot, binding.projectRoot);
  }

  openProject(input: {
    dshSessionId: string;
    title: string;
    design: DesignDirective;
    provider: { providerId: string; modelId: string };
    size?: readonly [number, number];
  }): { binding: SliceSessionBinding; created: boolean } {
    const existing = this.bindingFor(input.dshSessionId);
    if (existing) {
      acquireProjectLease(this.resolveRoot(existing), "dsh", input.dshSessionId);
      return { binding: existing, created: false };
    }
    // Neutral folder name: the user's own words (and the deck title, which starts
    // as the brief) must not end up in a filesystem path or in the editor URL.
    const slug = `deck-${input.dshSessionId.slice(0, 8)}`;
    const abs = path.join(this.slicesRoot(), slug);
    fs.mkdirSync(this.slicesRoot(), { recursive: true });
    fs.mkdirSync(abs);
    try {
      createEmptyProject(abs, {
        title: input.title,
        size: input.size ? [input.size[0], input.size[1]] : undefined,
      });
      const binding: SliceSessionBinding = {
        version: 1,
        dshSessionId: input.dshSessionId,
        projectRoot: path.relative(this.workspaceRoot, abs),
        design: input.design,
        provider: input.provider,
        createdAt: new Date().toISOString(),
      };
      fs.mkdirSync(path.join(abs, "_agent"), { recursive: true });
      fs.writeFileSync(bindingPath(abs), `${JSON.stringify(binding, null, 2)}\n`);
      acquireProjectLease(abs, "dsh", input.dshSessionId);
      this.index().set(input.dshSessionId, binding);
      return { binding, created: true };
    } catch (error) {
      this.evictCreatedProject(input.dshSessionId, abs);
      throw error;
    }
  }

  /** Roll back a freshly created slice directory if post-open setup (e.g. lease/runtime write) fails. */
  evictCreatedProject(dshSessionId: string, projectRoot: string): void {
    const resolved = path.resolve(projectRoot);
    const root = path.resolve(this.slicesRoot());
    if (resolved.startsWith(`${root}${path.sep}`)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    this.bindings?.delete(dshSessionId);
  }

  updateProvider(dshSessionId: string, provider: { providerId: string; modelId: string }): void {
    const binding = this.bindingFor(dshSessionId);
    if (!binding) return;
    const next: SliceSessionBinding = { ...binding, provider };
    const root = this.resolveRoot(binding);
    fs.writeFileSync(bindingPath(root), `${JSON.stringify(next, null, 2)}\n`);
    this.index().set(dshSessionId, next);
  }

  inspect(dshSessionId: string): SliceSessionSnapshot {
    const binding = this.bindingFor(dshSessionId);
    if (!binding) {
      return {
        binding: {
          version: 1,
          dshSessionId,
          projectRoot: "",
          design: { kind: "self-directed" },
          provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
          createdAt: "",
        },
        project: { title: "", pageCount: 0, deckSha256: "" },
        phase: { kind: "awaiting-project" },
      };
    }
    const root = this.resolveRoot(binding);
    let title = "";
    let pageCount = 0;
    let deckSha256 = "";
    if (fs.existsSync(path.join(root, "deck.pptd"))) {
      const project = loadProject(root);
      title = project.presentation.title ?? "";
      try {
        const runtime = readSliceRuntimeFile(root);
        const brief = typeof runtime.brief === "string" ? runtime.brief : "";
        title = displayDeckTitle(title, brief);
      } catch {
        title = displayDeckTitle(title, "");
      }
      pageCount = project.pages.length;
      deckSha256 = stableSha256({
        title,
        pages: project.pages.map((page) => page.path),
      });
    }
    const phase = this.derivePhase(binding, root, pageCount);
    const error = readCurrentAgentError(root);
    const wait = readRateLimitWait(root);
    const classified = error ? classifyAgentError({ code: error.code, message: error.detail }) : undefined;
    const rateLimitWait =
      phase.kind === "paused" && classified && isWaitAndResumeFault(classified) && wait ? wait : undefined;
    return {
      binding,
      project: { title, pageCount, deckSha256 },
      phase,
      rateLimitWait,
    };
  }

  private derivePhase(binding: SliceSessionBinding, root: string, pageCount: number): SlicePhase {
    const ledger = readRunLedger(root);
    const lastTool = lastHandsTool(root) ?? "open_project";
    const error = readCurrentAgentError(root);
    if (!ledger) {
      if (error) return phaseFromError(error);
      return { kind: "awaiting-project" };
    }
    const last = pickCoverRevision(ledger.facts);
    if (!last || pageCount < 1) {
      if (error) return phaseFromError(error);
      return { kind: "generating", lastTool };
    }
    const rasterDir = path.join(root, "_agent", "rasters");
    const rasterFiles = fs.existsSync(rasterDir)
      ? fs.readdirSync(rasterDir).filter((name) => name.endsWith(".png"))
      : [];
    const rasterFile = pickRasterFile(rasterFiles, last.pageId);
    const rasterBytes = rasterFile ? fs.readFileSync(path.join(rasterDir, rasterFile)) : Buffer.alloc(0);
    const rasterSha256 = rasterBytes.length ? crypto.createHash("sha256").update(rasterBytes).digest("hex") : "";
    const review = [...ledger.facts]
      .reverse()
      .find((fact) => fact.type === "page.visual-review-recorded" && fact.pageId === last.pageId);
    const cover: PageEvidence = {
      pageId: last.pageId,
      revision: last.revision,
      pageSha256: last.pageSha256,
      rasterSha256,
      rasterUrl: `/slides/raster/${binding.dshSessionId}/${last.pageId}`,
      reviewVerdict: review?.type === "page.visual-review-recorded" ? review.verdict : "missing",
      layoutStatus: "unavailable",
    };
    const composed = inspectRunLedger(root).composed;
    const lastLoaded = fs.existsSync(path.join(root, "deck.pptd")) ? loadProject(root).pages.at(-1) : undefined;
    const closerOk = !lastLoaded || pageCount < 2 || pageHasReadableCopy({ elements: lastLoaded.page.elements });
    // Provider faults outrank the generic empty-closer page-ready state.
    // Temporary 429 stays paused so Retry-After can resume; token-plan / quota
    // stay paused for the operator.
    if (error && (!composed || !closerOk)) return phaseFromError(error);
    if (error && composed && closerOk) {
      const classified = classifyAgentError({ code: error.code, message: error.detail });
      if (isWaitAndResumeFault(classified)) return phaseFromError(error);
    }
    if (!closerOk) return { kind: "page-ready", cover };
    if (composed && closerOk) return { kind: "complete", cover, pageCount };
    return { kind: "page-ready", cover };
  }
}

function phaseFromError(error: NonNullable<ReturnType<typeof readAgentError>>): SlicePhase {
  const classified = classifyAgentError({ code: error.code, message: error.detail });
  if (isPauseFault(classified)) {
    return { kind: "paused", detail: `${classified.code}: ${classified.detail}` };
  }
  return { kind: "failed", error: classified };
}

type RevisionFact = {
  type: "page.revision-committed";
  pageId: string;
  revision: number;
  pageSha256: string;
};

export function pickRasterFile(files: string[], pageId: string): string | undefined {
  const pngs = files.filter((name) => name.toLowerCase().endsWith(".png"));
  const want = pageId.toLowerCase();
  return (
    pngs.find((name) => name.toLowerCase().includes(want)) ||
    pngs.find((name) => name.toLowerCase().includes("cover")) ||
    pngs[0]
  );
}

/** Exact page raster for GET /slides/raster/:sessionId/:pageId. Do not fall back to cover. */
export function pickRequestedRasterFile(files: string[], pageId: string): string | undefined {
  const pngs = files.filter((name) => name.toLowerCase().endsWith(".png"));
  const want = pageId.toLowerCase();
  const exact = pngs.find((name) => name.toLowerCase() === `${want}.png`);
  if (exact) return exact;
  return pngs.find((name) => name.toLowerCase().startsWith(`${want}.`) || name.toLowerCase().startsWith(`${want}_`));
}

export function pickCoverRevision(
  facts: ReadonlyArray<{ type: string; pageId?: string; revision?: number; pageSha256?: string }>,
): RevisionFact | undefined {
  const committed: RevisionFact[] = [];
  for (const fact of facts) {
    if (
      fact.type === "page.revision-committed" &&
      typeof fact.pageId === "string" &&
      typeof fact.revision === "number" &&
      typeof fact.pageSha256 === "string"
    ) {
      committed.push({
        type: "page.revision-committed",
        pageId: fact.pageId,
        revision: fact.revision,
        pageSha256: fact.pageSha256,
      });
    }
  }
  if (committed.length === 0) return undefined;
  const byPage = new Map<string, RevisionFact>();
  for (const fact of committed) byPage.set(fact.pageId, fact);
  const coverId = [...byPage.keys()].find((id) => /cover/i.test(id));
  return (coverId ? byPage.get(coverId) : undefined) ?? committed[committed.length - 1];
}

function lastHandsTool(projectRoot: string): string | undefined {
  const file = path.join(projectRoot, "_agent", "hands-log.jsonl");
  if (!fs.existsSync(file)) return undefined;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const last = lines.at(-1);
  if (!last) return undefined;
  try {
    const rec = JSON.parse(last) as { name?: unknown };
    return typeof rec.name === "string" ? rec.name : undefined;
  } catch {
    return undefined;
  }
}

export { yamlExistsForPage } from "@open-slidestudio/slides-tools";
