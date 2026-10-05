import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { filterCatalog, loadReferenceCatalog, resolveRepoRoot } from "./catalog.js";
import { inspectProjectCapabilities } from "./capabilities.js";
import { assertChartEvidence } from "./chart-gate.js";
import { exportEditablePptx, readVerifiedDelivery } from "./export-deck.js";
import {
  listSourceReceipts,
  recordSourceReceipt,
  requireConsultAdoptBeforeWrite,
} from "./receipts.js";
import type {
  CommandContext,
  CommandReceipt,
  OpenRunInput,
  PresentationCommand,
  PresentationRun,
  RunHandle,
  RunId,
  RunInspection,
} from "./types.js";
import { runDomainHand } from "./domain/domain-hands.js";
import { writeJsonAtomic } from "./domain/atomic-file.js";
import { parseCanonicalPagePlan, type CanonicalPlanPage } from "./domain/page-plan.js";
import {
  currentVisualReviewsMissing,
  ensureRunLedgerExecutionPolicy,
  inspectRunLedger,
  readRunLedger,
} from "./domain/run-ledger.js";
import { inspectGenerationActivity } from "./generation-activity.js";
import { inspectProjectExecution } from "./execution-observation.js";
import { kindThemePackIssue, sourceIdList } from "./domain/theme-pack.js";
import {
  resolveOpenKimiPresetDesignSourceId,
  verifyOpenKimiPack,
} from "./domain/openkimi-source-pack.js";

const BINDING_REL = path.join("_agent", "presentation-run.v1.json");

type BindingFile = OpenRunInput & { readonly runId: RunId; contextEpochId?: string };

function bindingPath(projectRoot: string): string {
  return path.join(projectRoot, BINDING_REL);
}

function writeBinding(input: BindingFile): void {
  writeJsonAtomic(bindingPath(input.projectRoot), input);
}

function readBinding(projectRoot: string): BindingFile | undefined {
  const file = bindingPath(projectRoot);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as BindingFile;
}

function fail(name: string, detail: string): CommandReceipt {
  return {
    ok: false,
    name,
    summary: "rejected",
    detail,
    payload: { error: detail },
  };
}

function ok(name: string, summary: string, payload: Record<string, unknown>, detail = summary): CommandReceipt {
  return { ok: true, name, summary, detail, payload };
}

type MissingReferenceChunk = Readonly<{ sourceId: string; chunkIndex: number }>;

function uniqueMissingChunks(chunks: readonly MissingReferenceChunk[]): MissingReferenceChunk[] {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    const key = `${chunk.sourceId}#${chunk.chunkIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateAdoptedMissingChunks(
  repoRoot: string,
  projectRoot: string,
  adoptedSourceIds: readonly string[],
): MissingReferenceChunk[] {
  if (!adoptedSourceIds.length) return [];
  const ledger = readRunLedger(projectRoot);
  if (!ledger) return [];
  const pack = verifyOpenKimiPack(repoRoot);
  const resolved = new Set<string>();
  for (const raw of adoptedSourceIds) {
    const sourceId = raw.trim();
    if (!sourceId || sourceId === "agent-self-directed-plan") continue;
    if (pack.entriesById.has(sourceId)) {
      resolved.add(sourceId);
      continue;
    }
    try {
      resolved.add(resolveOpenKimiPresetDesignSourceId(pack, sourceId));
    } catch {
      // A non-pack consulted source is not promoted to a new immutable requirement.
    }
  }
  const missing: MissingReferenceChunk[] = [];
  for (const sourceId of resolved) {
    const entry = pack.entriesById.get(sourceId);
    if (!entry) continue;
    for (const chunk of entry.chunks) {
      const read = ledger.facts.some(
        (fact) =>
          fact.type === "reference.chunk-returned" &&
          fact.sourceId === sourceId &&
          fact.fileSha256 === entry.sha256 &&
          fact.chunkIndex === chunk.index &&
          fact.chunkSha256 === chunk.sha256,
      );
      if (!read) missing.push({ sourceId, chunkIndex: chunk.index });
    }
  }
  return missing;
}

function planningReferencePreflight(
  repoRoot: string,
  projectRoot: string,
  name: "commit_design" | "write_todo",
  adoptedSourceIds: readonly string[],
): CommandReceipt | undefined {
  const status = inspectRunLedger(projectRoot);
  if (!status.initialized) return undefined;
  const missingReferenceChunks = uniqueMissingChunks([
    ...status.missingReferenceChunks,
    ...candidateAdoptedMissingChunks(repoRoot, projectRoot, adoptedSourceIds),
  ]);
  if (!missingReferenceChunks.length) return undefined;
  const exact = missingReferenceChunks.map((chunk) => `${chunk.sourceId}#${chunk.chunkIndex}`);
  return {
    ok: false,
    name,
    summary: "required references unread",
    detail: `Read every required source chunk before planning. Call read_reference for: ${exact.join(", ")}`,
    payload: {
      error: "required_source_chunks_unread",
      next: "read_reference",
      referencesComplete: false,
      missingReferenceChunks,
    },
  };
}

function composeGateFailure(name: string, projectRoot: string): CommandReceipt | undefined {
  const status = inspectRunLedger(projectRoot);
  if (!status.initialized || status.composeReady) return undefined;
  const blockers = [...status.composeBlockers];
  const hasBlocker = (needle: string) => blockers.some((blocker) => blocker.includes(needle));
  const failedLayoutPageIds = status.pages
    .filter((page) => page.layout === "fail" && hasBlocker(`${page.pageId}: rendered layout`))
    .map((page) => page.pageId);
  const missingRasterPageIds = status.pages
    .filter(
      (page) =>
        page.layout !== "fail" && hasBlocker(`${page.pageId}: rendered layout`),
    )
    .map((page) => page.pageId);
  const missingImagePageIds = status.pages
    .filter((page) => hasBlocker(`${page.pageId}: image content not emitted`))
    .map((page) => page.pageId);
  const missingVisualReviewPageIds = status.pages
    .filter(
      (page) =>
        page.visualReview === "missing" && hasBlocker(`${page.pageId}: visual review`),
    )
    .map((page) => page.pageId);
  const failedVisualReviewPageIds = status.pages
    .filter(
      (page) =>
        page.visualReview === "revise" && hasBlocker(`${page.pageId}: visual review`),
    )
    .map((page) => page.pageId);
  const ledger = readRunLedger(projectRoot);
  const currentPageHashes = Object.fromEntries(
    status.pages.map((page) => [page.pageId, page.pageSha256]),
  );
  const structuralFailure = ledger
    ? [...ledger.facts].reverse().find(
        (fact) =>
          fact.type === "deck.structural-review-recorded" &&
          fact.ok === false &&
          Object.keys(currentPageHashes).length === Object.keys(fact.pageRevisions).length &&
          Object.entries(currentPageHashes).every(
            ([pageId, sha]) => fact.pageRevisions[pageId] === sha,
          ),
      )
    : undefined;
  const structuralIssues = structuralFailure?.type === "deck.structural-review-recorded"
    ? [...structuralFailure.issues]
    : [];
  const structuralFailedPageIds = status.pages
    .filter((page) => structuralIssues.some((issue) => issue.includes(page.pageId)))
    .map((page) => page.pageId);
  const next = status.missingReferenceChunks.length
    ? "read_reference"
    : status.todoCount === 0
      ? "write_todo"
      : failedLayoutPageIds.length || failedVisualReviewPageIds.length || status.structuralReview === "fail"
        ? "write_page"
      : missingRasterPageIds.length || missingImagePageIds.length
        ? "render_page"
        : missingVisualReviewPageIds.length
          ? "review_page"
          : status.structuralReview !== "pass"
            ? "review_pages"
            : "resolve_reported_blockers";
  return {
    ok: false,
    name,
    summary: "compose gate rejected",
    detail: `compose_deck is not ready. Next: ${next}. Blockers: ${blockers.join("; ")}`,
    payload: {
      error: "compose_not_ready",
      next,
      missingReferenceChunks: status.missingReferenceChunks,
      failedLayoutPageIds,
      missingRasterPageIds,
      missingImagePageIds,
      missingVisualReviewPageIds,
      failedVisualReviewPageIds,
      structuralReview: status.structuralReview,
      structuralFailedPageIds,
      structuralIssues,
      blockers,
    },
  };
}

export type PresentationRunDeps = {
  readonly repoRoot?: string;
};

export function createPresentationRun(deps: PresentationRunDeps = {}): PresentationRun {
  const repoRoot = deps.repoRoot ?? resolveRepoRoot();
  const epochs = new Map<string, string>();
  const byRun = new Map<RunId, BindingFile>();

  const remember = (binding: BindingFile) => {
    byRun.set(binding.runId, binding);
    byRun.set(binding.sessionId, binding);
    writeBinding(binding);
  };

  const epochFor = (sessionId: string): string => {
    // The binding file is the source of truth — persistPresentationRunProvider
    // mints a fresh contextEpochId on a provider/model change, so re-read it
    // instead of serving the in-memory snapshot from open time.
    const binding = byRun.get(sessionId);
    let fresh: BindingFile | undefined;
    if (binding) {
      try {
        fresh = readBinding(binding.projectRoot);
      } catch {
        fresh = undefined;
      }
    }
    const stored = fresh?.contextEpochId?.trim() || binding?.contextEpochId?.trim() || "";
    if (stored) {
      epochs.set(sessionId, stored);
      return stored;
    }
    const minted = `dsh-${crypto.randomUUID()}`;
    epochs.set(sessionId, minted);
    const base = fresh ?? binding;
    if (base) remember({ ...base, contextEpochId: minted });
    return minted;
  };

  // Domain tools are read-modify-write sequences across several _agent files;
  // the per-file locks guard individual writes, but a whole invocation must not
  // interleave with another turn on the same project. Serialize per project.
  const domainQueues = new Map<string, Promise<unknown>>();
  const enqueueDomain = <T>(projectRoot: string, fn: () => Promise<T>): Promise<T> => {
    const prev = domainQueues.get(projectRoot) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    domainQueues.set(
      projectRoot,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };

  const invokeDomain = async (
    name: string,
    args: Record<string, unknown>,
    context: CommandContext,
  ): Promise<CommandReceipt> => {
    const result = await enqueueDomain(context.projectRoot, () =>
      runDomainHand(
        name,
        {
          ...args,
          __openSlideStudio: {
            commandId: context.toolCallId,
            contextEpochId: epochFor(context.sessionId),
          },
        },
        context.projectRoot,
      ),
    );
    return {
      ok: result.ok,
      name: result.name ?? name,
      summary: result.summary,
      detail: result.detail,
      payload: (result.payload ?? {}) as Record<string, unknown>,
    };
  };

  const lookup = (runId: RunId): BindingFile => {
    const cached = byRun.get(runId);
    if (cached) return cached;
    throw new Error(`unknown presentation run: ${runId}`);
  };

  return {
    epochFor,
    async open(input: OpenRunInput): Promise<RunHandle> {
      if (input.design.kind === "self-directed" && "categoryId" in (input as object)) {
        throw new Error("self-directed open must not carry categoryId");
      }
      const runId = input.sessionId;
      const binding: BindingFile = { ...input, runId };
      remember(binding);
      epochFor(input.sessionId);
      return { runId, sessionId: input.sessionId, projectRoot: input.projectRoot };
    },

    async execute(command: PresentationCommand, context: CommandContext): Promise<CommandReceipt> {
      const name = command.name;
      const args = command.args;
      if (context.abortSignal.aborted) {
        return fail(name, "cancelled");
      }
      if (name === "inspect_capabilities") {
        const capabilities = inspectProjectCapabilities(context.projectRoot);
        return ok(name, capabilities.note, { ...capabilities });
      }
      if (name === "list_references") {
        const catalog = loadReferenceCatalog(repoRoot);
        const filtered = filterCatalog(catalog, {
          family: typeof args.family === "string" ? args.family : undefined,
          kind: args.kind === "visual" || args.kind === "source" ? args.kind : undefined,
          tag: typeof args.tag === "string" ? args.tag : undefined,
        });
        const ledger = inspectRunLedger(context.projectRoot, epochFor(context.sessionId));
        const requiredReferenceChunks = readRunLedger(context.projectRoot)?.sourcePack.requirements
          .flatMap((requirement) => requirement.chunkIndexes.map((chunkIndex) => ({
            sourceId: requirement.sourceId,
            chunkIndex,
            reason: requirement.reason,
          }))) ?? [];
        const prefix = ledger.initialized
          ? ledger.referencesComplete
            ? "All required source chunks are read."
            : `Read these required chunks before commit_design or write_todo: ${ledger.missingReferenceChunks
                .map((chunk) => `${chunk.sourceId}#${chunk.chunkIndex}`)
                .join(", ")}.`
          : "No strict source ledger is initialized.";
        return ok(name, `${filtered.sourceFiles} sources · ${filtered.visualFiles} visuals`, {
          referencesComplete: ledger.initialized && ledger.referencesComplete,
          requiredReferenceChunks,
          missingReferenceChunks: ledger.missingReferenceChunks,
          next: ledger.initialized && !ledger.referencesComplete ? "read_reference" : undefined,
          sourceFiles: catalog.sourceFiles,
          visualFiles: catalog.visualFiles,
          listedSourceFiles: filtered.sourceFiles,
          listedVisualFiles: filtered.visualFiles,
          sources: [...filtered.sources, ...filtered.visuals],
          uncropped: true,
        }, `${prefix}\n${filtered.sourceFiles} sources · ${filtered.visualFiles} visuals`);
      }
      if (name === "read_reference") {
        const receipt = await invokeDomain(name, args, context);
        const sourceId = String(args.sourceId ?? receipt.payload.sourceId ?? "").trim();
        if (receipt.ok && sourceId) {
          recordSourceReceipt(context.projectRoot, {
            sourceId,
            state: "consulted",
            toolCallId: context.toolCallId,
          });
        }
        return receipt;
      }
      if (name === "commit_design" || name === "write_todo") {
        const binding = readBinding(context.projectRoot);
        const requestedSources = sourceIdList(args.adoptedSourceIds, args.adopt);
        const adopted = requestedSources.length ? requestedSources : sourceIdList(
          listSourceReceipts(context.projectRoot)
            .filter((row) => row.state === "adopted" || row.state === "executed")
            .map((row) => row.sourceId));
        const preflight = planningReferencePreflight(repoRoot, context.projectRoot, name, adopted);
        if (preflight) return preflight;
        let items: readonly CanonicalPlanPage[];
        try { items = parseCanonicalPagePlan(args.items ?? args.slidePlan); }
        catch (error) { return fail(name, error instanceof Error ? error.message : String(error)); }
        const packIssue = kindThemePackIssue({
          brief: binding?.brief ?? "",
          adoptedSourceIds: adopted,
          designSystemId:
            binding?.design.kind === "explicit-style" ? binding.design.designSystemId : undefined,
          userExplicitPack: binding?.design.kind === "explicit-style",
        });
        if (packIssue) {
          return {
            ok: false,
            name,
            summary: "kind/theme pack",
            detail: packIssue.detail,
            payload: {
              error: packIssue.code,
              packId: packIssue.packId,
              kind: packIssue.kind,
              painted: false,
            },
          };
        }
        if (readRunLedger(context.projectRoot)) {
          // Validate the same chosen sources at both layers. Persist their
          // adoption only after the domain plan commit succeeds.
          const committed = await invokeDomain("write_todo", { items, adoptedSourceIds: adopted }, context);
          if (!committed.ok) return { ...committed, name };
        }
        if (adopted.length === 0) {
          recordSourceReceipt(context.projectRoot, {
            sourceId: "agent-self-directed-plan",
            state: "adopted",
            toolCallId: context.toolCallId,
          });
        } else {
          for (const sourceId of adopted) {
            recordSourceReceipt(context.projectRoot, {
              sourceId,
              state: "adopted",
              toolCallId: context.toolCallId,
            });
          }
        }
        return ok(name, "design plan adopted", {
          outcome: "committed",
          items, plannedPageIds: items.map((page) => page.pageId),
          adoptedSourceIds: adopted.length ? adopted : ["agent-self-directed-plan"],
        });
      }
      if (name === "web_search" || name === "search_image" || name === "generate_image") {
        const caps = inspectProjectCapabilities(context.projectRoot);
        const on =
          name === "web_search"
            ? caps.research.configured
            : name === "search_image"
              ? caps.imageSearch.configured
              : caps.imageGenerate.configured;
        if (!on) return fail(name, `${name} is not configured; do not invent media`);
      }
      if (name === "write_page") {
        const chart = assertChartEvidence(args);
        if (!chart.ok) return fail(name, chart.detail);
        const binding = readBinding(context.projectRoot);
        const adopted = listSourceReceipts(context.projectRoot)
          .filter((row) => row.state === "adopted" || row.state === "executed")
          .map((row) => row.sourceId);
        const packIssue = kindThemePackIssue({
          brief: binding?.brief ?? "",
          adoptedSourceIds: sourceIdList(args.adoptedSourceIds, args.adopt, adopted),
          designSystemId:
            binding?.design.kind === "explicit-style" ? binding.design.designSystemId : undefined,
          userExplicitPack: binding?.design.kind === "explicit-style",
        });
        if (packIssue) {
          return {
            ok: false,
            name,
            summary: "kind/theme pack",
            detail: packIssue.detail,
            payload: {
              error: packIssue.code,
              packId: packIssue.packId,
              kind: packIssue.kind,
              painted: false,
            },
          };
        }
        const blocked = requireConsultAdoptBeforeWrite(context.projectRoot);
        if (blocked) return fail(name, blocked);
        const receipt = await invokeDomain(name, args, context);
        if (receipt.ok) {
          const pageId = String(receipt.payload.pageId ?? args.id ?? "");
          // "executed" must name a source this page actually used — a blanket
          // mark of every adopted row would credit sources the page never drew.
          const pageSources = new Set(
            sourceIdList(args.adoptedSourceIds, args.adopt).map((id) => id.trim()),
          );
          for (const row of listSourceReceipts(context.projectRoot).filter(
            (item) => item.state === "adopted" && pageSources.has(item.sourceId),
          )) {
            recordSourceReceipt(context.projectRoot, {
              sourceId: row.sourceId,
              state: "executed",
              toolCallId: context.toolCallId,
              pageId,
            });
          }
        }
        return receipt;
      }
      if (name === "export_deck") {
        const exported = await exportEditablePptx(context.projectRoot, {
          toolCallId: context.toolCallId,
          contextEpochId: epochFor(context.sessionId),
          sessionId: context.sessionId,
        });
        return {
          ok: exported.ok,
          name,
          summary: exported.summary,
          detail: exported.detail,
          payload: exported.payload,
        };
      }
      if (name === "compose_deck") {
        const blocked = composeGateFailure(name, context.projectRoot);
        if (blocked) return blocked;
      }
      return invokeDomain(name, args, context);
    },

    hydrate(projectRoot: string): RunHandle | undefined {
      const binding = readBinding(projectRoot);
      if (!binding) return undefined;
      ensureRunLedgerExecutionPolicy(projectRoot, {
        currentRenderedLayoutRequired: Boolean(binding.editorBaseUrl?.trim()),
        structuralReviewRequired: true,
      });
      remember(binding);
      if (binding.contextEpochId?.trim()) {
        epochs.set(binding.sessionId, binding.contextEpochId.trim());
      }
      return { runId: binding.runId, sessionId: binding.sessionId, projectRoot: binding.projectRoot };
    },

    async inspect(runId: RunId): Promise<RunInspection> {
      const binding = lookup(runId);
      const catalog = loadReferenceCatalog(repoRoot);
      let pageCount = 0;
      let title = "";
      let pageOrder: string[] = [];
      try {
        if (fs.existsSync(path.join(binding.projectRoot, "deck.pptd"))) {
          const project = loadProject(binding.projectRoot);
          pageCount = project.pages.length;
          title = project.presentation.title ?? "";
          pageOrder = project.pages.map((loaded) => path.basename(loaded.path).replace(/\.page$/i, ""));
        }
      } catch {
        pageCount = 0;
      }
      const ledger = inspectRunLedger(binding.projectRoot);
      const composed = ledger.composed;
      const exported = Boolean(readVerifiedDelivery(binding.projectRoot));
      const designSystemId =
        binding.design.kind === "explicit-style" ? binding.design.designSystemId : undefined;
      return {
        runId: binding.runId,
        sessionId: binding.sessionId,
        projectRoot: binding.projectRoot,
        brief: binding.brief,
        design: binding.design,
        provider: binding.provider,
        pageCount,
        title,
        hostDirected: false,
        categoryId: undefined,
        designSystemId,
        receipts: listSourceReceipts(binding.projectRoot),
        catalog: { sourceFiles: catalog.sourceFiles, visualFiles: catalog.visualFiles },
        capabilities: inspectProjectCapabilities(binding.projectRoot),
        composed,
        exported,
        visualReviewMissing: currentVisualReviewsMissing(binding.projectRoot, pageCount),
        ledger,
        // inspection.pages tracks pages that exist now: a structurally deleted
        // page keeps its historical revision facts but must not look alive.
        pages: pageOrder.length
          ? ledger.pages.filter((page) => pageOrder.includes(page.pageId))
          : ledger.pages,
        pageOrder,
        structuralReview: ledger.structuralReview,
        composeReady: ledger.composeReady,
        composeBlockers: ledger.composeBlockers,
        activity: inspectGenerationActivity(binding.projectRoot),
        execution: inspectProjectExecution({
          root: binding.projectRoot,
          capability: inspectProjectCapabilities(binding.projectRoot),
          verifiedDelivery: readVerifiedDelivery(binding.projectRoot),
          binding: {
            provider: binding.provider,
            design: binding.design.kind === "explicit-style"
              ? { kind: "explicit-style", designSystemId: binding.design.designSystemId }
              : { kind: "self-directed" },
            brief: binding.brief,
          },
        }),
      };
    },
  };
}
