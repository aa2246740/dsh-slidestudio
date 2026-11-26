/**
 * OpenKimi produce tools that Pi actually calls.
 * `--skill` only advertises markdown. These tools are the stack.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeGenerateTool,
  executeGenerateToolAsync,
  persistWrittenPages,
  type AgentTodo,
  type AgentToolState,
  type ToolExecution,
} from "./agent-tools.js";
import { createPageRasterPort } from "./page-raster.js";
import { loadPlaybook } from "./playbook.js";
import { imageConfigured, imageConfigFromEnv, createImagePort } from "./image-port.js";
import { imageSearchConfigured, imageSearchConfigFromEnv, createImageSearchPort } from "./image-search-port.js";
import type { SkillDeckInput, SkillPageInput } from "./skill-pages.js";
import {
  listOpenKimiSourceRequirements,
  readOpenKimiSourceChunk,
  resolveOpenKimiPresetDesignSourceId,
  verifyOpenKimiPack,
  type DesignDirection,
  type SourceRequirement,
  type VerifiedOpenKimiPack,
} from "./openkimi-source-pack.js";
import {
  readOpenKimiVisualBytes,
  resolveOpenKimiDesignPreview,
  verifyOpenKimiVisualPack,
} from "./openkimi-visual-pack.js";
import {
  assertPageMatchesDesignContract,
  assertTodoMatchesDesignContract,
  commitDesignContract,
  readDesignContract,
  requirePlannedLayoutFamily,
} from "./design-contract.js";
import { renderDeckOverview } from "./deck-overview.js";
import {
  bytesSha256,
  contextFromToolArgs,
  currentPageRevision,
  currentDeckSnapshot,
  ensureRunLedger,
  inspectRunLedger,
  pageRewriteGate,
  readRunLedger,
  recordCompose,
  recordDeckOverviewPrepared,
  recordDeckTasteReview,
  recordDesignContractCommitted,
  recordDesignContractReturned,
  recordDesignReferencePrepared,
  recordPreparedImageEmitted,
  recordImagePrepared,
  recordPageRevision,
  recordRaster,
  recordReferenceChunk,
  recordStructuralReview,
  recordTodo,
  recordVisualReview,
  requireComposeReady,
  requireDesignContractCurrent,
  requireDesignReferenceEmitted,
  requireReferencesComplete,
  requireTodo,
  stableSha256,
  TASTE_EXECUTION_GATE_VERSION,
  type DeckTasteAxisReview,
  type PageLayoutIssue,
  type ReferenceRequirement,
  type RunToolContext,
} from "./run-ledger.js";

export const PI_SKILL_TOOL_NAMES = [
  "think",
  "list_references",
  "read_reference",
  "view_design_reference",
  "commit_design",
  "read_design",
  "write_todo",
  "write_page",
  "render_page",
  "review_page",
  "review_pages",
  "render_deck",
  "review_deck",
  "compose_deck",
] as const;

export type PiSkillToolName = (typeof PI_SKILL_TOOL_NAMES)[number];

const PI_OPTIONAL_IMAGE_TOOLS = ["search_image", "generate_image"] as const;
const PI_INTERNAL_TOOLS = ["_mark_image_emitted"] as const;

export function piRpcToolAllowlist(env: NodeJS.ProcessEnv = process.env): string {
  const names: string[] = ["read", ...PI_SKILL_TOOL_NAMES];
  if (imageSearchConfigured(imageSearchConfigFromEnv(env))) names.push("search_image");
  if (imageConfigured(imageConfigFromEnv(env))) names.push("generate_image");
  return names.join(",");
}

export const PI_RPC_TOOL_ALLOWLIST = piRpcToolAllowlist();

const HANDS_STATE_REL = path.join("_agent", "hands-state.json");
const RUNTIME_REL = path.join("_agent", "runtime.json");
const OUTLINE_REL = path.join("_agent", "outline.json");

export type PiHandsRuntime = {
  brief: string;
  categoryId?: string;
  designSystemId?: string;
  editorBaseUrl?: string;
  designDirection?: "self-directed" | "user-design" | "preset";
  strictExecution?: boolean;
  /** Product strict runs enable this. Omit only for frozen pre-taste fixtures. */
  tasteExecution?: boolean;
};

type HandsStateFile = {
  todos: AgentTodo[];
  writtenPages: SkillPageInput[];
  skillDeck?: SkillDeckInput;
};

export function resolvePiHandsExtension(): string {
  const fromSrc = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "extensions",
    "open-slidestudio",
    "pi-hands.ts",
  );
  if (fs.existsSync(fromSrc)) return fromSrc;
  throw new Error(`Pi hands extension not found at ${fromSrc}`);
}

export function resolvePiHandsCli(): string {
  const fromDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "pi-hands-cli.js");
  if (fs.existsSync(fromDist)) return fromDist;
  const fromSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "pi-hands-cli.ts");
  if (fs.existsSync(fromSrc)) return fromSrc;
  throw new Error("pi-hands-cli.js not built");
}

export function writePiRuntime(root: string, runtime: PiHandsRuntime): void {
  const dir = path.join(root, "_agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, RUNTIME_REL), `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
  if (runtime.strictExecution) initializePiRunLedger(root);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function loadRuntime(root: string): PiHandsRuntime {
  const file = path.join(root, RUNTIME_REL);
  if (fs.existsSync(file)) {
    const rec = readJson(file) as Partial<PiHandsRuntime>;
    const designDirection =
      rec.designDirection === "self-directed" ||
      rec.designDirection === "user-design" ||
      rec.designDirection === "preset"
        ? rec.designDirection
        : undefined;
    const categoryId = typeof rec.categoryId === "string" ? rec.categoryId.trim() : "";
    const designSystemId = typeof rec.designSystemId === "string" ? rec.designSystemId.trim() : "";
    return {
      brief: String(rec.brief ?? "").trim(),
      categoryId: categoryId || undefined,
      designSystemId: designSystemId || undefined,
      editorBaseUrl: rec.editorBaseUrl,
      designDirection,
      strictExecution: rec.strictExecution === true,
      tasteExecution: rec.tasteExecution === true,
    };
  }
  const briefFile = path.join(root, "_agent", "brief.txt");
  return {
    brief: fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8").trim() : "",
  };
}

function repositoryRoot(): string {
  const marker = path.join("packages", "agent-harness", "reference", "openkimi-source-manifest.v1.json");
  const candidates: string[] = [];
  const envRoot = process.env.OPEN_SLIDESTUDIO_ROOT?.trim();
  if (envRoot) candidates.push(envRoot);
  candidates.push(process.cwd());
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    candidates.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (fs.existsSync(path.join(root, marker))) return root;
  }
  throw new Error(`Open SlideStudio repo root not found (looked for ${marker})`);
}

export function hasExplicitUserDesign(brief: string): boolean {
  return /(?:配色|色系|主色|辅色|颜色|视觉风格|字体|字号|版式|页面比例|16\s*[:：]\s*9|#[0-9a-f]{3,8}|深蓝|海军蓝|藏蓝|琥珀金|金色|白底|黑底)/i.test(
    brief,
  );
}

function resolveDesignDirection(runtime: PiHandsRuntime, pack: VerifiedOpenKimiPack): DesignDirection {
  if (runtime.designDirection === "self-directed" && !runtime.tasteExecution) {
    return { kind: "self-directed" };
  }
  // A color, font, ratio, or layout hint is an override. It is not a complete
  // design system and must never remove the selected OpenKimi design source.
  return {
    kind: "preset",
    sourceId: resolveOpenKimiPresetDesignSourceId(pack, runtime.designSystemId ?? ""),
  };
}

function toLedgerRequirement(pack: VerifiedOpenKimiPack, requirement: SourceRequirement): ReferenceRequirement {
  const entry = pack.entriesById.get(requirement.sourceId);
  if (!entry) throw new Error(`OpenKimi requirement is missing: ${requirement.sourceId}`);
  return {
    sourceId: requirement.sourceId,
    fileSha256: entry.sha256,
    chunkIndexes: requirement.requiredChunkIndexes,
    reason: requirement.kind === "categories" ? "category-guide" : requirement.kind,
  };
}

export function initializePiRunLedger(root: string): void {
  const runtime = loadRuntime(root);
  const repoRoot = repositoryRoot();
  const pack = verifyOpenKimiPack(repoRoot);
  const designDirection = resolveDesignDirection(runtime, pack);
  const selfDirected = designDirection.kind === "self-directed" && !runtime.tasteExecution;
  const requirements = listOpenKimiSourceRequirements(pack, {
    ...(runtime.categoryId ? { categoryId: runtime.categoryId } : {}),
    designDirection,
  }).map((requirement) => toLedgerRequirement(pack, requirement));
  if (selfDirected) {
    ensureRunLedger(root, {
      manifestSha256: bytesSha256(fs.readFileSync(pack.manifestPath)),
      requirementsId: stableSha256({ requirements }),
      requirements,
    });
    return;
  }
  const selectedDesignSourceId = resolveOpenKimiPresetDesignSourceId(pack, runtime.designSystemId ?? "");
  const selectedDesign = pack.entriesById.get(selectedDesignSourceId);
  if (!selectedDesign) throw new Error("selected OpenKimi design source is missing");
  const tasteGate = runtime.tasteExecution
    ? (() => {
        const visualPack = verifyOpenKimiVisualPack(repoRoot);
        const preview = resolveOpenKimiDesignPreview(visualPack, runtime.designSystemId ?? "");
        return {
          version: TASTE_EXECUTION_GATE_VERSION,
          visualManifestSha256: bytesSha256(fs.readFileSync(visualPack.manifestPath)),
          designSystemId: runtime.designSystemId ?? "",
          selectedDesignSourceId,
          selectedDesignSha256: selectedDesign.sha256,
          selectedPreviewSourceId: preview.sourceId,
          selectedPreviewSha256: preview.sha256,
        } as const;
      })()
    : undefined;
  ensureRunLedger(root, {
    manifestSha256: bytesSha256(fs.readFileSync(pack.manifestPath)),
    requirementsId: stableSha256({ requirements, tasteGate }),
    requirements,
    ...(tasteGate ? { tasteGate } : {}),
  });
}

function loadHandsState(root: string): HandsStateFile {
  const file = path.join(root, HANDS_STATE_REL);
  if (!fs.existsSync(file)) {
    return { todos: [], writtenPages: [] };
  }
  const rec = readJson(file) as Partial<HandsStateFile>;
  return {
    todos: Array.isArray(rec.todos) ? rec.todos : [],
    writtenPages: Array.isArray(rec.writtenPages) ? rec.writtenPages : [],
    skillDeck: rec.skillDeck,
  };
}

function saveHandsState(root: string, state: HandsStateFile): void {
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(path.join(root, HANDS_STATE_REL), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function buildToolState(root: string): AgentToolState {
  const runtime = loadRuntime(root);
  const saved = loadHandsState(root);
  const attach = path.join(root, "_agent", "attachments.md");
  return {
    brief: runtime.brief,
    playbook: loadPlaybook({
      categoryId: runtime.categoryId,
      designSystemId: runtime.designSystemId,
      hostDefaults: false,
    }),
    referenceText: fs.existsSync(attach) ? fs.readFileSync(attach, "utf8") : undefined,
    todos: saved.todos,
    researchNotes: [],
    writtenPages: saved.writtenPages,
    skillDeck: saved.skillDeck,
    projectRoot: root,
    raster: createPageRasterPort({ editorBaseUrl: runtime.editorBaseUrl }),
    image: imageConfigured() ? createImagePort() : undefined,
    imageSearch: imageSearchConfigured() ? createImageSearchPort() : undefined,
  };
}

function explicitComposeMutations(state: AgentToolState, result: ToolExecution): SkillPageInput[] {
  const payload = result.payload as Partial<SkillDeckInput> | undefined;
  if (!payload || !Array.isArray(payload.pages)) return [];
  const historical = state.writtenPages ?? [];
  return payload.pages.filter((page): page is SkillPageInput => {
    if (!page || typeof page.id !== "string") return false;
    const prior = historical.find((item) => item.id === page.id);
    return !prior;
  });
}

function persistFromState(root: string, state: AgentToolState, pageMutations?: readonly SkillPageInput[]): void {
  saveHandsState(root, {
    todos: state.todos,
    writtenPages: state.writtenPages ?? [],
    skillDeck: state.skillDeck,
  });
  if (state.todos.length) {
    fs.writeFileSync(path.join(root, OUTLINE_REL), `${JSON.stringify({ items: state.todos }, null, 2)}\n`, "utf8");
  }
  if (pageMutations) persistWrittenPages(state, pageMutations);
}

function failedTool(name: string, error: unknown): ToolExecution {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    name,
    ok: false,
    summary: "execution gate rejected",
    detail,
    payload: { error: detail },
  };
}

function loggedToolExecution(
  root: string,
  name: string,
  args: Record<string, unknown>,
  result: ToolExecution,
): ToolExecution {
  appendHandsLog(root, {
    at: new Date().toISOString(),
    name,
    ok: result.ok,
    summary: result.summary,
    detail: result.ok ? undefined : result.detail,
    keys: Object.keys(args),
    args: JSON.stringify(args).slice(0, 1500),
  });
  return result;
}

function safeProjectFile(root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, relativePath);
  if (candidate === absoluteRoot || !candidate.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`project file escapes the run root: ${relativePath}`);
  }
  return candidate;
}

function issueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return String(item);
    const rec = item as Record<string, unknown>;
    const pageId = typeof rec.pageId === "string" ? `${rec.pageId}: ` : "";
    const message = typeof rec.message === "string" ? rec.message : JSON.stringify(rec);
    return `${pageId}${message}`;
  });
}

const MISPLACED_PAGE_STYLE_KEYS = new Set([
  "align",
  "bold",
  "color",
  "fill",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "item",
  "layoutRole",
  "letterSpacing",
  "line",
  "lineHeight",
  "position",
  "rect",
  "text",
  "value",
]);

function requireWholePageWriteArgs(args: Record<string, unknown>): void {
  const misplaced = Object.keys(args)
    .filter((key) => MISPLACED_PAGE_STYLE_KEYS.has(key))
    .sort();
  if (!misplaced.length) return;
  throw new Error(
    `write_page received element fields at page level: ${misplaced.join(", ")}. ` +
      "write_page replaces the entire page; send one complete elements[] array for the page. " +
      "Put text, style, bounds, fill, line, alignment, and layoutRole inside their owning element.",
  );
}

function layoutEvidence(value: unknown): {
  status: "pass" | "fail" | "unavailable";
  issues: PageLayoutIssue[];
} {
  if (!value || typeof value !== "object") return { status: "unavailable", issues: [] };
  const rec = value as Record<string, unknown>;
  const issues: PageLayoutIssue[] = [];
  if (Array.isArray(rec.hardIssues)) {
    for (const raw of rec.hardIssues) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const id = typeof item.elementId === "string" ? [item.elementId] : [];
      issues.push({
        code: String(item.kind ?? "rendered-layout-error"),
        severity: "error",
        elementIds: id,
        detail: String(item.detail ?? "rendered layout failed"),
      });
    }
  }
  if (Array.isArray(rec.warnings)) {
    for (const raw of rec.warnings) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const ids = Array.isArray(item.elementIds)
        ? item.elementIds.filter((id): id is string => typeof id === "string")
        : [];
      issues.push({
        code: String(item.kind ?? "rendered-layout-warning"),
        severity: "warning",
        elementIds: ids,
        detail: String(item.detail ?? "rendered layout warning"),
      });
    }
  }
  return {
    status: rec.checked === true ? (rec.ok === true ? "pass" : "fail") : "unavailable",
    issues,
  };
}

function listReferencesResult(root: string, context: RunToolContext): ToolExecution {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const pack = verifyOpenKimiPack(repositoryRoot());
  const status = inspectRunLedger(root, context.contextEpochId);
  const missing = new Set(status.missingReferenceChunks.map((item) => `${item.sourceId}#${item.chunkIndex}`));
  const sources = ledger.sourcePack.requirements.map((requirement) => {
    const entry = pack.entriesById.get(requirement.sourceId);
    if (!entry) throw new Error(`required source is absent: ${requirement.sourceId}`);
    return {
      sourceId: requirement.sourceId,
      relativePath: entry.relativePath,
      reason: requirement.reason,
      byteLength: entry.byteLength,
      fileSha256: entry.sha256,
      chunks: requirement.chunkIndexes.map((chunkIndex) => ({
        chunkIndex,
        readInThisContext: !missing.has(`${requirement.sourceId}#${chunkIndex}`),
      })),
    };
  });
  const detail = sources
    .map(
      (source) =>
        `${source.sourceId} | ${source.reason} | ${source.byteLength} bytes | chunks ${source.chunks
          .map((chunk) => `${chunk.chunkIndex}${chunk.readInThisContext ? "✓" : ""}`)
          .join(",")}`,
    )
    .join("\n");
  return {
    name: "list_references",
    ok: true,
    summary: `${sources.length} required original files`,
    detail,
    payload: { referencesComplete: status.referencesComplete, sources },
  };
}

function readReferenceResult(root: string, context: RunToolContext, args: Record<string, unknown>): ToolExecution {
  const sourceId = String(args.sourceId ?? "").trim();
  const chunkIndex = Number(args.chunkIndex);
  if (!sourceId || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("read_reference requires sourceId and a non-negative integer chunkIndex");
  }
  const pack = verifyOpenKimiPack(repositoryRoot());
  const chunk = readOpenKimiSourceChunk(pack, sourceId, chunkIndex);
  recordReferenceChunk(root, context, {
    sourceId: chunk.sourceId,
    fileSha256: chunk.fileSha256,
    chunkIndex: chunk.index,
    chunkSha256: chunk.sha256,
  });
  return {
    name: "read_reference",
    ok: true,
    summary: `${chunk.relativePath} #${chunk.index}`,
    detail: [
      `ORIGINAL SOURCE ${chunk.sourceId}`,
      `chunk ${chunk.index} bytes ${chunk.byteStart}-${chunk.byteEndExclusive} sha256 ${chunk.sha256}`,
      "",
      chunk.text,
    ].join("\n"),
    payload: {
      sourceId: chunk.sourceId,
      relativePath: chunk.relativePath,
      chunkIndex: chunk.index,
      byteStart: chunk.byteStart,
      byteEndExclusive: chunk.byteEndExclusive,
      chunkSha256: chunk.sha256,
      fileSha256: chunk.fileSha256,
      text: chunk.text,
    },
  };
}

function writeCheckedProjectBytes(root: string, relativePath: string, bytes: Buffer): string {
  const file = safeProjectFile(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (bytesSha256(fs.readFileSync(file)) !== bytesSha256(bytes)) {
      throw new Error(`checked artifact changed at ${relativePath}`);
    }
    return relativePath;
  }
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
  return relativePath;
}

function viewDesignReferenceResult(root: string, context: RunToolContext): ToolExecution {
  const ledger = readRunLedger(root);
  const gate = ledger?.sourcePack.tasteGate;
  if (!gate) throw new Error("taste execution gate is not enabled for this run");
  const visualPack = verifyOpenKimiVisualPack(repositoryRoot());
  const preview = resolveOpenKimiDesignPreview(visualPack, gate.designSystemId);
  const bytes = readOpenKimiVisualBytes(visualPack, preview.sourceId);
  const src = writeCheckedProjectBytes(root, "_agent/references/selected-design.jpg", bytes);
  const deliveryToken = stableSha256({
    kind: "selected-design-preview",
    contextEpochId: context.contextEpochId,
    sourceId: preview.sourceId,
    sha256: preview.sha256,
  });
  const fact = recordDesignReferencePrepared(root, context, {
    sourceId: preview.sourceId,
    imageSha256: preview.sha256,
    src,
    deliveryToken,
  });
  return {
    name: "view_design_reference",
    ok: true,
    summary: `${gate.designSystemId} exact preview`,
    detail: [
      `Selected OpenKimi preview: ${gate.designSystemId}`,
      `sourceId: ${fact.sourceId}`,
      `sha256: ${fact.imageSha256}`,
      `DELIVERY_TOKEN: ${fact.deliveryToken}`,
    ].join("\n"),
    payload: {
      imageKind: "design-reference",
      src: fact.src,
      sha256: fact.imageSha256,
      deliveryToken: fact.deliveryToken,
      subjectId: gate.designSystemId,
      mimeType: fact.mediaType,
      sourceId: fact.sourceId,
    },
  };
}

function commitDesignResult(root: string, context: RunToolContext, args: Record<string, unknown>): ToolExecution {
  requireReferencesComplete(root, context.contextEpochId);
  requireDesignReferenceEmitted(root, context.contextEpochId);
  const runtime = loadRuntime(root);
  const ledger = readRunLedger(root);
  const gate = ledger?.sourcePack.tasteGate;
  if (!gate) throw new Error("taste execution gate is not enabled for this run");
  const categoryId = runtime.categoryId;
  if (!categoryId) throw new Error("taste execution gate requires categoryId");
  const contract = commitDesignContract(root, {
    brief: runtime.brief,
    categoryId,
    designSystemId: gate.designSystemId,
    references: [
      {
        sourceId: gate.selectedDesignSourceId,
        sha256: gate.selectedDesignSha256,
        role: "selected-design",
      },
      {
        sourceId: gate.selectedPreviewSourceId,
        sha256: gate.selectedPreviewSha256,
        role: "selected-preview",
      },
    ],
    draft: args,
  });
  recordDesignContractCommitted(root, context, contract.contractSha256);
  return {
    name: "commit_design",
    ok: true,
    summary: `${contract.draft.slidePlan.length} page design contract committed`,
    detail: [
      `DESIGN CONTRACT ${contract.contractSha256}`,
      `designSystemId: ${contract.designSystemId}`,
      `layout families: ${[...new Set(contract.draft.slidePlan.map((slide) => slide.layoutFamily))].join(", ")}`,
      "This is intent and acceptance law only. No PPTD geometry was host-generated.",
      "",
      JSON.stringify(contract, null, 2),
    ].join("\n"),
    payload: { contractSha256: contract.contractSha256, contract },
  };
}

function readDesignResult(root: string, context: RunToolContext): ToolExecution {
  const contract = readDesignContract(root);
  if (!contract) throw new Error("design contract is not committed");
  recordDesignContractReturned(root, context);
  return {
    name: "read_design",
    ok: true,
    summary: `design contract ${contract.contractSha256.slice(0, 12)}`,
    detail: [`EXACT COMMITTED DESIGN CONTRACT ${contract.contractSha256}`, "", JSON.stringify(contract, null, 2)].join(
      "\n",
    ),
    payload: { contractSha256: contract.contractSha256, contract },
  };
}

async function renderDeckResult(root: string, context: RunToolContext): Promise<ToolExecution> {
  const snapshot = currentDeckSnapshot(root, context.contextEpochId);
  const overview = await renderDeckOverview({
    projectRoot: root,
    deckSnapshotSha256: snapshot.deckSnapshotSha256,
    pages: snapshot.pageSnapshot,
  });
  const fact = recordDeckOverviewPrepared(root, context, snapshot, {
    bytes: overview.bytes,
    src: overview.src,
    width: overview.width,
    height: overview.height,
    rendererVersion: overview.rendererVersion,
  });
  return {
    name: "render_deck",
    ok: true,
    summary: `${snapshot.pageSnapshot.length} page overview`,
    detail: [
      `Current deck overview: ${snapshot.pageSnapshot.length} pages in committed todo order`,
      `deckSnapshotSha256: ${snapshot.deckSnapshotSha256}`,
      `overviewSha256: ${fact.overviewSha256}`,
      `DELIVERY_TOKEN: ${fact.deliveryToken}`,
    ].join("\n"),
    payload: {
      imageKind: "deck-overview",
      src: fact.src,
      sha256: fact.overviewSha256,
      deliveryToken: fact.deliveryToken,
      subjectId: fact.deckSnapshotSha256,
      mimeType: "image/png",
      deckSnapshotSha256: fact.deckSnapshotSha256,
      pageIds: fact.pageSnapshot.map((page) => page.pageId),
      width: fact.width,
      height: fact.height,
    },
  };
}

function reviewDeckResult(root: string, context: RunToolContext, args: Record<string, unknown>): ToolExecution {
  if (args.verdict !== "pass" && args.verdict !== "revise") {
    throw new Error("review_deck verdict must be pass or revise");
  }
  const axes = Array.isArray(args.axes) ? (args.axes as DeckTasteAxisReview[]) : [];
  const remainingAiDefaults = Array.isArray(args.remainingAiDefaults)
    ? args.remainingAiDefaults.filter((item): item is string => typeof item === "string")
    : [];
  const revisionActions = Array.isArray(args.revisionActions)
    ? args.revisionActions
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({ pageId: String(item.pageId ?? ""), action: String(item.action ?? "") }))
    : [];
  const fact = recordDeckTasteReview(root, context, {
    deliveryToken: String(args.deliveryToken ?? "").trim(),
    verdict: args.verdict,
    axes,
    strongestPageId: String(args.strongestPageId ?? ""),
    weakestPageId: String(args.weakestPageId ?? ""),
    visualMemoryObserved: String(args.visualMemoryObserved ?? ""),
    summary: String(args.summary ?? ""),
    remainingAiDefaults,
    revisionActions,
  });
  return {
    name: "review_deck",
    ok: true,
    summary: `deck taste ${fact.verdict}`,
    detail:
      fact.verdict === "pass"
        ? `Deck taste passed for ${fact.deckSnapshotSha256}; every required axis is grounded.`
        : `Deck must be revised: ${fact.revisionActions.map((item) => `${item.pageId} ${item.action}`).join("; ")}`,
    payload: fact,
  };
}

export async function runPiHand(name: string, args: Record<string, unknown>, root: string): Promise<ToolExecution> {
  if (
    !PI_SKILL_TOOL_NAMES.includes(name as PiSkillToolName) &&
    !PI_OPTIONAL_IMAGE_TOOLS.includes(name as (typeof PI_OPTIONAL_IMAGE_TOOLS)[number]) &&
    !PI_INTERNAL_TOOLS.includes(name as (typeof PI_INTERNAL_TOOLS)[number])
  ) {
    return {
      name,
      ok: false,
      summary: "unknown tool",
      detail: `not a Pi skill tool: ${name}`,
      payload: { error: `unknown tool: ${name}` },
    };
  }
  const strict = Boolean(readRunLedger(root));
  let context: RunToolContext | undefined;
  let cleanArgs = args;
  if (strict) {
    try {
      const extracted = contextFromToolArgs(args);
      context = extracted.context;
      cleanArgs = extracted.args;
      if (name === "list_references") {
        return loggedToolExecution(root, name, cleanArgs, listReferencesResult(root, context));
      }
      if (name === "read_reference") {
        return loggedToolExecution(root, name, cleanArgs, readReferenceResult(root, context, cleanArgs));
      }
      if (name === "view_design_reference") {
        return loggedToolExecution(root, name, cleanArgs, viewDesignReferenceResult(root, context));
      }
      if (name === "commit_design") {
        return loggedToolExecution(root, name, cleanArgs, commitDesignResult(root, context, cleanArgs));
      }
      if (name === "read_design") {
        return loggedToolExecution(root, name, cleanArgs, readDesignResult(root, context));
      }
      if (name === "render_deck") {
        return loggedToolExecution(root, name, cleanArgs, await renderDeckResult(root, context));
      }
      if (name === "review_deck") {
        return loggedToolExecution(root, name, cleanArgs, reviewDeckResult(root, context, cleanArgs));
      }
      if (name === "_mark_image_emitted") {
        const deliveryToken = String(cleanArgs.deliveryToken ?? "").trim();
        if (!deliveryToken) throw new Error("deliveryToken is required");
        const fact = recordPreparedImageEmitted(root, context, deliveryToken);
        const subject =
          fact.type === "page.image-content-emitted"
            ? `${fact.pageId} revision ${fact.revision}`
            : fact.type === "design.reference-image-emitted"
              ? fact.sourceId
              : fact.deckSnapshotSha256;
        return loggedToolExecution(root, name, cleanArgs, {
          name,
          ok: true,
          summary: `${subject} image emitted`,
          detail: `${subject} image content emitted to Pi`,
          payload: fact,
        });
      }
      if (name === "review_page") {
        const pageId = String(cleanArgs.pageId ?? "").trim();
        const revision = Number(cleanArgs.revision);
        const deliveryToken = String(cleanArgs.deliveryToken ?? "").trim();
        const verdict = cleanArgs.verdict;
        const issues = Array.isArray(cleanArgs.issues)
          ? cleanArgs.issues.filter((issue): issue is string => typeof issue === "string")
          : [];
        if (!pageId || !Number.isSafeInteger(revision) || revision < 1 || !deliveryToken) {
          throw new Error("review_page requires pageId, revision, and deliveryToken");
        }
        if (verdict !== "pass" && verdict !== "revise") {
          throw new Error("review_page verdict must be pass or revise");
        }
        const fact = recordVisualReview(root, context, {
          pageId,
          revision,
          deliveryToken,
          verdict,
          issues,
        });
        return loggedToolExecution(root, name, cleanArgs, {
          name,
          ok: true,
          summary: `${pageId} ${verdict}`,
          detail:
            verdict === "pass"
              ? `${pageId} revision ${revision} visual review passed`
              : `${pageId} revision ${revision} must be rewritten: ${issues.join("; ")}`,
          payload: fact,
        });
      }
      if (name === "write_todo") {
        requireReferencesComplete(root, context.contextEpochId);
        if (readRunLedger(root)?.sourcePack.tasteGate) {
          requireDesignReferenceEmitted(root, context.contextEpochId);
          requireDesignContractCurrent(root, context.contextEpochId);
          const contract = readDesignContract(root);
          if (!contract) throw new Error("design contract is not committed");
          const items = Array.isArray(cleanArgs.items) ? cleanArgs.items : [];
          assertTodoMatchesDesignContract(contract, items);
        }
      }
      if (name === "write_page") {
        requireTodo(root);
        requireWholePageWriteArgs(cleanArgs);
        const pageId = String(cleanArgs.id ?? "").trim();
        const rewrite = pageRewriteGate(root, pageId);
        if (!rewrite.allowed) throw new Error(rewrite.reason);
        if (readRunLedger(root)?.sourcePack.tasteGate) {
          const contract = readDesignContract(root);
          if (!contract) throw new Error("design contract is not committed");
          if (typeof cleanArgs.pageType !== "string" || !cleanArgs.pageType.trim()) {
            cleanArgs.pageType = requirePlannedLayoutFamily(contract, pageId);
          }
          assertPageMatchesDesignContract(
            contract,
            pageId,
            typeof cleanArgs.pageType === "string" ? cleanArgs.pageType : undefined,
          );
        }
      }
      if (name === "compose_deck") requireComposeReady(root, context.contextEpochId);
    } catch (error) {
      return loggedToolExecution(root, name, cleanArgs, failedTool(name, error));
    }
  } else if (
    name === "list_references" ||
    name === "read_reference" ||
    name === "view_design_reference" ||
    name === "commit_design" ||
    name === "read_design" ||
    name === "review_page" ||
    name === "render_deck" ||
    name === "review_deck" ||
    name === "_mark_image_emitted"
  ) {
    return loggedToolExecution(root, name, cleanArgs, failedTool(name, "run ledger is not initialized"));
  }

  const state = buildToolState(root);
  let result: ToolExecution;
  try {
    const executionArgs =
      strict && name === "compose_deck" ? { title: String(cleanArgs.title ?? "").trim() } : cleanArgs;
    result =
      name === "render_page" || name === "search_image" || name === "generate_image"
        ? await executeGenerateToolAsync(name, executionArgs, state)
        : executeGenerateTool(name, executionArgs, state);
    const pageMutations = name === "compose_deck" && result.ok ? explicitComposeMutations(state, result) : [];
    persistFromState(root, state, name === "compose_deck" && result.ok ? pageMutations : undefined);
    if (strict && context && result.ok) {
      if (name === "write_todo") {
        const items = (result.payload as { items?: unknown[] } | undefined)?.items ?? [];
        recordTodo(root, context, items);
      } else if (name === "write_page") {
        const page = (result.payload as { page?: SkillPageInput } | undefined)?.page;
        if (!page?.id) throw new Error("write_page succeeded without a page payload");
        recordPageRevision(root, context, page.id, page);
      } else if (name === "render_page") {
        const payload = (result.payload ?? {}) as Record<string, unknown>;
        const { dataUrl: _legacyDataUrl, ...transportPayload } = payload;
        const pageId = String(payload.pageId ?? "").trim();
        const src = String(payload.src ?? "").trim();
        const page = currentPageRevision(root, pageId);
        if (!page || !src) throw new Error("render_page did not return a current page raster");
        const abs = safeProjectFile(root, src);
        const bytes = fs.readFileSync(abs);
        const layout = layoutEvidence(payload.layout);
        const recorded = recordRaster(root, page, {
          bytes,
          src,
          width: Number(payload.width ?? 0),
          height: Number(payload.height ?? 0),
          layoutStatus: layout.status,
          layoutIssues: layout.issues,
        });
        recordImagePrepared(root, context, recorded.fact, recorded.deliveryToken);
        const layoutDetail = recorded.fact.layoutIssues.length
          ? recorded.fact.layoutIssues.map((issue) => `- ${issue.code}: ${issue.detail}`).join("\n")
          : "- none";
        result = {
          ...result,
          detail: [
            result.detail,
            `revision: ${page.revision}`,
            `rasterSha256: ${recorded.fact.rasterSha256}`,
            `layoutStatus: ${recorded.fact.layoutStatus}`,
            "layoutIssues:",
            layoutDetail,
            `DELIVERY_TOKEN: ${recorded.deliveryToken}`,
          ].join("\n"),
          payload: {
            ...transportPayload,
            pageRevision: page.revision,
            pageSha256: page.pageSha256,
            rasterSha256: recorded.fact.rasterSha256,
            deliveryToken: recorded.deliveryToken,
            layoutStatus: recorded.fact.layoutStatus,
            layoutIssues: recorded.fact.layoutIssues,
          },
        };
      } else if (name === "review_pages") {
        const payload = (result.payload ?? {}) as Record<string, unknown>;
        recordStructuralReview(root, true, issueStrings(payload.issues));
      } else if (name === "compose_deck") {
        recordCompose(root, context, String(cleanArgs.title ?? "").trim());
      }
    } else if (strict && name === "review_pages") {
      const payload = (result.payload ?? {}) as Record<string, unknown>;
      recordStructuralReview(root, false, issueStrings(payload.issues));
    }
  } catch (error) {
    result = failedTool(name, error);
  }
  appendHandsLog(root, {
    at: new Date().toISOString(),
    name,
    ok: result.ok,
    summary: result.summary,
    detail: result.ok ? undefined : result.detail,
    keys: Object.keys(cleanArgs),
    args: JSON.stringify(cleanArgs).slice(0, 1500),
    payload:
      name === "write_page"
        ? {
            painted: Boolean((result.payload as { painted?: boolean } | undefined)?.painted),
            restamped: Boolean((result.payload as { restamped?: boolean } | undefined)?.restamped),
          }
        : name === "review_pages"
          ? {
              ok: result.ok,
              issues: (result.payload as { issues?: unknown } | undefined)?.issues ?? [],
            }
          : undefined,
  });
  return result;
}

export type SkillStackEvidence = {
  ok: boolean;
  outline: boolean;
  pageWrites: number;
  renderPages: number;
  renderCoverage: boolean;
  visualOrReview: boolean;
  review: boolean;
  compose: boolean;
  oneShotDump: boolean;
  reason: string;
};

export const HANDS_LOG_REL = path.join("_agent", "hands-log.jsonl");

export function skillStackFromHandsLog(root: string): SkillStackEvidence {
  const file = path.join(root, HANDS_LOG_REL);
  if (!fs.existsSync(file)) return skillStackEvidence([]);
  const timed: Array<{ event: string }> = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { name?: string; ok?: boolean };
      if (!row.name) continue;
      if (row.ok === false) continue;
      timed.push({ event: `tool:${row.name}` });
    } catch {
      /* skip a broken line */
    }
  }
  return skillStackEvidence(timed);
}

function diskPageCount(root: string): number {
  const pages = path.join(root, "pages");
  if (!fs.existsSync(pages)) return 0;
  return fs.readdirSync(pages).filter((name) => name.endsWith(".page")).length;
}

function diskRasterCount(root: string): number {
  const dir = path.join(root, "_agent", "rasters");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.endsWith(".png")).length;
}

export function mergeSkillStackEvidence(
  timed: Array<{ event: string }>,
  root?: string,
  extra?: { compose?: boolean },
): SkillStackEvidence {
  const fromEvents = skillStackEvidence(timed);
  const fromHands = root ? skillStackFromHandsLog(root) : skillStackEvidence([]);
  const pageWrites = Math.max(fromEvents.pageWrites, fromHands.pageWrites, root ? diskPageCount(root) : 0);
  const renderPages = Math.max(fromEvents.renderPages, fromHands.renderPages, root ? diskRasterCount(root) : 0);
  const outline =
    fromEvents.outline ||
    fromHands.outline ||
    Boolean(root && fs.existsSync(path.join(root, "_agent", "outline.json")));
  const visualOrReview =
    fromEvents.visualOrReview || fromHands.visualOrReview || Boolean(root && diskRasterCount(root) > 0);
  const review = fromEvents.review || fromHands.review;
  const compose = fromEvents.compose || fromHands.compose || Boolean(extra?.compose);
  const oneShotDump = fromEvents.oneShotDump && fromHands.pageWrites === 0;
  const uniquePages = root ? diskPageCount(root) : 0;
  const uniqueRasters = root ? diskRasterCount(root) : 0;
  const renderCoverage = uniquePages >= 2 ? uniqueRasters >= uniquePages : pageWrites >= 2 && renderPages >= pageWrites;
  const ok = outline && pageWrites >= 2 && visualOrReview && review && compose && !oneShotDump;
  return {
    ok,
    outline,
    pageWrites,
    renderPages,
    renderCoverage,
    visualOrReview,
    review,
    compose,
    oneShotDump,
    reason: ok
      ? extra?.compose && !fromEvents.compose
        ? "OpenKimi stack ran as Pi tools; host composed after agent_end"
        : "OpenKimi stack ran as Pi tools"
      : skillStackEvidence(timed).reason,
  };
}

function appendHandsLog(root: string, row: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.appendFileSync(path.join(root, HANDS_LOG_REL), `${JSON.stringify(row)}\n`, "utf8");
}

/** `--skill` flags vs produce tools that actually executed. */
export function skillsExecutionMode(timed: Array<{ event: string }>): "pi-tools" | "flags-only" {
  const ran = timed.some((e) =>
    /^(tool:think|tool:list_references|tool:read_reference|tool:write_todo|tool:write_page|tool:render_page|tool:review_page|tool:review_pages|tool:compose_deck)/.test(
      e.event,
    ),
  );
  return ran ? "pi-tools" : "flags-only";
}

export function skillStackEvidence(timed: Array<{ event: string }>): SkillStackEvidence {
  const names = timed.map((e) => e.event);
  const outline = names.some((e) => e === "tool:write_todo" || e.startsWith("tool:write_todo:"));
  const pageWrites = names.filter((e) => e === "tool:write_page" || e.startsWith("tool:write_page:")).length;
  const renderPages = names.filter((e) => e === "tool:render_page" || e.startsWith("tool:render_page:")).length;
  const renderCoverage = pageWrites >= 2 && renderPages >= pageWrites;
  const visualOrReview = names.some(
    (e) =>
      e === "tool:render_page" ||
      e.startsWith("tool:render_page:") ||
      e === "tool:review_pages" ||
      e.startsWith("tool:review_pages:"),
  );
  const review = names.some((e) => e === "tool:review_pages" || e.startsWith("tool:review_pages:"));
  const compose = names.some((e) => e === "tool:compose_deck" || e.startsWith("tool:compose_deck:"));
  const oneShotDump = names.some((e) => e === "tool:write:skill-deck.json") && pageWrites === 0 && !outline;
  const ok = outline && pageWrites >= 2 && visualOrReview && review && compose && !oneShotDump;
  const missing: string[] = [];
  if (!outline) missing.push("write_todo");
  if (pageWrites < 2) missing.push(`write_page×${pageWrites} (need ≥2)`);
  if (!visualOrReview) missing.push("render_page|review_pages");
  if (!review) missing.push("review_pages");
  if (!compose) missing.push("compose_deck");
  if (oneShotDump) missing.push("one-shot skill-deck.json dump");
  return {
    ok,
    outline,
    pageWrites,
    renderPages,
    renderCoverage,
    visualOrReview,
    review,
    compose,
    oneShotDump,
    reason: ok ? "OpenKimi stack ran as Pi tools" : `skills did not run as Pi tools: ${missing.join(", ")}`,
  };
}
