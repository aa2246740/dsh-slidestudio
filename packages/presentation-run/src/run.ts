import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { loadReferenceCatalog, resolveRepoRoot } from "./catalog.js";
import { listReferences } from "./list-references.js";
import { inspectProjectCapabilities } from "./capabilities.js";
import { assertChartEvidence } from "./chart-gate.js";
import { exportEditablePptx, readVerifiedDelivery } from "./export-deck.js";
import { authorityRefusalReceipt, runContextAuthorized } from "./write-authority.js";
import { listSourceReceipts, recordSourceReceipt, requireConsultAdoptBeforeWrite } from "./receipts.js";
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
import {
  carriedAdoptedSourceIds,
  commitAdoptedDesignSources,
  currentAdoptedSourceSelection,
} from "./domain/design-adoption.js";
import { planningReferencePreflight } from "./domain/design-source-preflight.js";
import {
  designAuthorityDecision,
  designAuthoritySourceIssue,
  effectiveCatalogPackId,
  readDesignAuthority,
  readHubDesignSystemId,
  resolvePlanningStyleAuthority,
} from "./domain/design-authority.js";
import {
  persistPlanningAuthority,
  readClarificationRecords,
  requirementAuthorityIssue,
} from "./domain/report-authority.js";
import { designAuthorityRefusal, resolvePlanDeclarations } from "./domain/plan-declarations.js";
import { restrictedDesignAdoptionRefusal } from "./domain/restricted-design-adoption.js";
import { paletteSourceIds } from "./domain/design-aspects.js";
import { writeJsonAtomic } from "./domain/atomic-file.js";
import { parseCanonicalPagePlan, type CanonicalPlanPage } from "./domain/page-plan.js";
import { forwardPlanFeedback } from "./domain/material-use.js";
import {
  currentVisualReviewsMissing,
  ensureRunLedgerExecutionPolicy,
  inspectRunLedger,
  readRunLedger,
} from "./domain/run-ledger.js";
import { inspectGenerationActivity } from "./generation-activity.js";
import { inspectProjectExecution } from "./execution-observation.js";
import { composeGateFailure } from "./domain/compose-gate-failure.js";
import {
  canonicalizeAdoptedSourceIds,
  catalogPackPaletteHexes,
  detailWithSubmittedAlias,
  kindThemePackIssue,
  resolvePlanningAdoption,
  sourceIdList,
  type KindThemePackIssue,
} from "./domain/theme-pack.js";

const BINDING_REL = path.join("_agent", "presentation-run.v1.json");

type BindingFile = OpenRunInput & { readonly runId: RunId; contextEpochId?: string };

function bindingPath(projectRoot: string): string {
  return path.join(projectRoot, BINDING_REL);
}

function writeBinding(input: BindingFile): void {
  const file = bindingPath(input.projectRoot);
  // Skip the rewrite when the persisted content already matches: hydrate()
  // re-persists the unchanged binding on every /slides/state poll, which turns
  // the editor's heartbeat into a constant disk write for every open project.
  const content = `${JSON.stringify(input, null, 2)}\n`;
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
  } catch {
    // Unreadable binding file — fall through and overwrite it.
  }
  writeJsonAtomic(file, input);
}

function readBinding(projectRoot: string): BindingFile | undefined {
  const file = bindingPath(projectRoot);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BindingFile;
  } catch {
    // A crash or power loss can leave the atomic write as a zero-filled stub.
    // Quarantine it so one damaged deck cannot stop run hydration for all projects.
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // best effort — an unreadable dir still must not throw here
    }
    return undefined;
  }
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

/** The refusal for a brief whose theme pack the adopted sources do not supply. */
function kindThemePackReceipt(name: string, issue: KindThemePackIssue): CommandReceipt {
  return {
    ok: false,
    name,
    summary: "kind/theme pack",
    detail: issue.detail,
    payload: { error: issue.code, packId: issue.packId, kind: issue.kind, painted: false },
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
        context.runAuthorizedWrite ? { runAuthorizedWrite: context.runAuthorizedWrite } : undefined,
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
        return listReferences(repoRoot, context.projectRoot, epochFor(context.sessionId), args);
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
        const rawRequested = sourceIdList(args.adoptedSourceIds, args.adopt);
        const carried = carriedAdoptedSourceIds(args);
        // Omitting the field reuses the persisted selection. An explicit array, including [], replaces it.
        const planning = resolvePlanningAdoption({
          requested: carried ? rawRequested : [],
          persisted: carried ? [] : currentAdoptedSourceSelection(context.projectRoot),
        });
        if (planning.refusal) return fail(name, planning.refusal);
        const adopted = planning.ids;
        const bindingPackId = binding?.design.kind === "explicit-style" ? binding.design.designSystemId : undefined;
        // The Hub pack can live only in runtime.json when the binding omits the directive.
        const hubPackId = bindingPackId ?? readHubDesignSystemId(context.projectRoot);
        const epoch = epochFor(context.sessionId);
        const clarificationRecords = readClarificationRecords(context.projectRoot);
        const plannedAuthority = resolvePlanningStyleAuthority({
          projectRoot: context.projectRoot,
          args,
          hubPackId,
          records: clarificationRecords,
          contextEpochId: epoch,
        });
        if (plannedAuthority.issue) return designAuthorityRefusal(name, plannedAuthority.issue);
        // "" is explicit: the current authority replaced the catalog pack.
        const stylePackId = plannedAuthority.stylePackId ?? "";
        const declarations = resolvePlanDeclarations({
          projectRoot: context.projectRoot,
          args,
          adoptedSourceIds: adopted,
          stylePackId,
        });
        if (!declarations.ok) return fail(name, declarations.detail);
        const { designAspects, userColors, reportRequirements } = declarations;
        const outOfScope = restrictedDesignAdoptionRefusal(name, context.projectRoot, {
          adopted,
          designAspects,
          planned: plannedAuthority,
        });
        if (outOfScope) return outOfScope;
        if (plannedAuthority.authority) {
          const sourceIssue = designAuthoritySourceIssue({
            projectRoot: context.projectRoot,
            authority: plannedAuthority.authority,
            hubPackId,
            adoptedSourceIds: adopted,
            designAspects,
            knownCatalogPack: (id) => catalogPackPaletteHexes().has(id),
          });
          if (sourceIssue) return designAuthorityRefusal(name, sourceIssue);
        }
        const authorityIssue = requirementAuthorityIssue(reportRequirements, clarificationRecords, epoch);
        if (authorityIssue) {
          return {
            ok: false,
            name,
            summary: "requirement authority rejected",
            detail: authorityIssue.detail,
            payload: {
              error: authorityIssue.code,
              questionId: authorityIssue.questionId,
              next: "ask_user_question",
              painted: false,
            },
          };
        }
        const preflight = planningReferencePreflight(
          repoRoot,
          context.projectRoot,
          name,
          adopted,
          epochFor(context.sessionId),
          designAspects,
          {
            modelAcceptsImages: inspectProjectCapabilities(context.projectRoot).vision.modelAcceptsImages === true,
          },
          reportRequirements,
        );
        if (preflight) {
          return {
            ...preflight,
            detail: detailWithSubmittedAlias(preflight.detail, rawRequested, String(preflight.payload.sourceId ?? "")),
          };
        }
        let items: readonly CanonicalPlanPage[];
        try {
          items = parseCanonicalPagePlan(args.items ?? args.slidePlan);
        } catch (error) {
          return fail(name, error instanceof Error ? error.message : String(error));
        }
        const packIssue = kindThemePackIssue({
          brief: binding?.brief ?? "",
          adoptedSourceIds: paletteSourceIds(adopted, designAspects),
          designAspects,
          designSystemId: stylePackId || undefined,
          userExplicitPack: Boolean(stylePackId),
        });
        if (packIssue) return kindThemePackReceipt(name, packIssue);
        let planFeedback: Record<string, unknown> = {};
        if (readRunLedger(context.projectRoot)) {
          // Declarations the plan call may carry; the domain validates each before it records any.
          const declarations = Object.fromEntries(
            (["materialUse", "periodMap", "missingItems"] as const).flatMap((key) =>
              args[key] === undefined ? [] : [[key, args[key]]],
            ),
          );
          const committed = await invokeDomain("write_todo", { items, ...declarations }, context);
          if (!committed.ok) return { ...committed, name };
          planFeedback = forwardPlanFeedback(committed.payload);
        }
        const planSave = runContextAuthorized(context, () => {
          const saved = commitAdoptedDesignSources(
            context.projectRoot,
            adopted,
            context.toolCallId,
            designAspects,
            userColors,
          );
          if (saved.error) return { ok: false as const, error: saved.error };
          // One atomic write: requirements and the effective style authority change together.
          const decided = plannedAuthority.authority
            ? designAuthorityDecision(plannedAuthority.authority, plannedAuthority.existing)
            : undefined;
          persistPlanningAuthority(context.projectRoot, reportRequirements, {
            mode: plannedAuthority.declared ? "set" : "keep",
            ...(decided ? { decision: decided } : {}),
          });
          return { ok: true as const, saved, decided };
        });
        if (!planSave.ok) return authorityRefusalReceipt(name, planSave);
        if (!planSave.value.ok) return fail(name, planSave.value.error);
        const { saved, decided } = planSave.value;
        return ok(
          name,
          "design plan adopted",
          {
            outcome: "committed",
            items,
            plannedPageIds: items.map((page) => page.pageId),
            adoptedSourceIds: saved.adoptedSourceIds,
            designAspects,
            reportRequirements,
            ...(decided ? { designAuthority: decided } : {}),
            ...(userColors.length ? { userColors } : {}),
            ...planFeedback,
            ...(saved.hint ? { hint: saved.hint } : {}),
          },
          saved.hint ?? "design plan adopted",
        );
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
        const writePage = async () => {
          const chart = assertChartEvidence(args);
          if (!chart.ok) return fail(name, chart.detail);
          const binding = readBinding(context.projectRoot);
          const rawPageSources = sourceIdList(args.adoptedSourceIds, args.adopt);
          const pagePlan = resolvePlanningAdoption({ requested: rawPageSources });
          if (pagePlan.refusal) return fail(name, pagePlan.refusal);
          const adopted = canonicalizeAdoptedSourceIds(currentAdoptedSourceSelection(context.projectRoot));
          const pageSources = new Set(pagePlan.ids);
          // The current authority decides whether a catalog pack may still restrict this page.
          const writePackId = effectiveCatalogPackId(
            context.projectRoot,
            binding?.design.kind === "explicit-style" ? binding.design.designSystemId : undefined,
          );
          const packIssue = kindThemePackIssue({
            brief: binding?.brief ?? "",
            adoptedSourceIds: [...adopted, ...pageSources],
            projectRoot: context.projectRoot,
            designSystemId: writePackId,
            userExplicitPack: Boolean(writePackId),
          });
          if (packIssue) return kindThemePackReceipt(name, packIssue);
          const blocked = requireConsultAdoptBeforeWrite(context.projectRoot);
          if (blocked) return fail(name, blocked);
          const receipt = await invokeDomain(name, args, context);
          if (receipt.ok && pageSources.size > 0) {
            const pageId = String(receipt.payload.pageId ?? args.id ?? "");
            // "executed" must name a source this page actually used — a blanket
            // mark of every adopted row would credit sources the page never drew.
            runContextAuthorized(context, () => {
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
            });
          }
          return receipt;
        };
        return writePage();
      }
      if (name === "write_layout") {
        const writeLayout = () => {
          // The brief, pack and consult rules that gate write_page also gate a layout, before its checks.
          const binding = readBinding(context.projectRoot);
          const adopted = canonicalizeAdoptedSourceIds(currentAdoptedSourceSelection(context.projectRoot));
          const layoutPackId = effectiveCatalogPackId(
            context.projectRoot,
            binding?.design.kind === "explicit-style" ? binding.design.designSystemId : undefined,
          );
          const packIssue = kindThemePackIssue({
            brief: binding?.brief ?? "",
            adoptedSourceIds: adopted,
            projectRoot: context.projectRoot,
            designSystemId: layoutPackId,
            userExplicitPack: Boolean(layoutPackId),
          });
          if (packIssue) return kindThemePackReceipt(name, packIssue);
          const blocked = requireConsultAdoptBeforeWrite(context.projectRoot, name);
          if (blocked) return fail(name, blocked);
          return invokeDomain(name, args, context);
        };
        return writeLayout();
      }
      if (name === "export_deck") {
        const exported = await exportEditablePptx(context.projectRoot, {
          toolCallId: context.toolCallId,
          contextEpochId: epochFor(context.sessionId),
          sessionId: context.sessionId,
          runAuthorizedWrite: context.runAuthorizedWrite,
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
      return {
        runId: binding.runId,
        sessionId: binding.sessionId,
        projectRoot: binding.projectRoot,
      };
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
      const authorityReading = readDesignAuthority(binding.projectRoot);
      const designAuthority = authorityReading.kind === "valid" ? authorityReading.authority : undefined;
      const designSystemId = effectiveCatalogPackId(
        binding.projectRoot,
        binding.design.kind === "explicit-style" ? binding.design.designSystemId : undefined,
      );
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
        ...(designAuthority ? { designAuthority } : {}),
        receipts: listSourceReceipts(binding.projectRoot),
        catalog: { sourceFiles: catalog.sourceFiles, visualFiles: catalog.visualFiles },
        capabilities: inspectProjectCapabilities(binding.projectRoot),
        composed,
        exported,
        visualReviewMissing: currentVisualReviewsMissing(binding.projectRoot, pageCount),
        ledger,
        // inspection.pages tracks pages that exist now: a structurally deleted
        // page keeps its historical revision facts but must not look alive.
        pages: pageOrder.length ? ledger.pages.filter((page) => pageOrder.includes(page.pageId)) : ledger.pages,
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
            design:
              binding.design.kind === "explicit-style"
                ? { kind: "explicit-style", designSystemId: binding.design.designSystemId }
                : { kind: "self-directed" },
            brief: binding.brief,
          },
        }),
      };
    },
  };
}
