/**
 * Agent harness: Pi tools timeline + PPTD project output.
 * The product path uses the repository-pinned Pi kernel and fails closed.
 * Playbook and direct LLM brains remain explicit developer/test fixtures only.
 * A capability card is advertised before design. Media is optional.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createEmptyProject,
  loadProject,
  saveProject,
  type PptdProject,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import { snapshotVersion } from "@open-slidestudio/project-store";
import type { AgentRunHooks } from "./agent-brain.js";
import { resolvePlaybookCategory } from "./compose-ir.js";
import type { ToolName, ToolStep } from "./harness-types.js";
import { clearGenerateCheckpoint, writeGenerateCheckpoint } from "./generate-checkpoint.js";
import { reviewSkillPages } from "./layout-qa.js";
import { createPlaybookBrain } from "./playbook-brain.js";
import { DEFAULT_DESIGN_SYSTEM } from "./playbook.js";
import { localPlan, thinkAboutBrief, type ReasonBlock } from "./reason.js";
import { streamText } from "./stream-text.js";

export {
  loadPlaybook,
  listDesignSystems,
  resolveSkillRoot,
  extractPalette,
  DEFAULT_DESIGN_SYSTEM,
  DEFAULT_CATEGORY,
} from "./playbook.js";
export type { PlaybookBundle, Palette, DesignSystemRef } from "./playbook.js";
export { createPlaybookBrain } from "./playbook-brain.js";
export type { PlaybookBrain, PlaybookBrainOptions } from "./playbook-brain.js";
export { createAgentBrain } from "./agent-brain.js";
export type { AgentBrain, AgentBrainOptions, AgentRunHooks } from "./agent-brain.js";
export { createHostBrain, outlineFromBrief, extractPlaces, parsePagedScript } from "./host-produce.js";
export type { HostBrain, HostBrainOptions, HostPageCopy } from "./host-produce.js";
export { classifyExhibit, paintExhibit } from "./exhibit-paint.js";
export type { ExhibitKind } from "./exhibit-paint.js";
export { qaPaintedPage, repairPaintedPage, qaScriptFidelity } from "./produce-qa.js";
export { maybePlaceImage, evidencePagesFromReference } from "./host-media.js";
export { runAgentLoop } from "./agent-runtime.js";
export type { AgentLoopResult, AgentToolTrace } from "./agent-runtime.js";
export {
  writeGenerateCheckpoint,
  readGenerateCheckpoint,
  recoverGenerateCheckpoint,
  clearGenerateCheckpoint,
  parseGenerateCheckpoint,
  formatPauseMessage,
  GENERATE_CHECKPOINT_FILE,
} from "./generate-checkpoint.js";
export type { AgentCheckpoint, AgentPause, AgentPauseKind } from "./generate-checkpoint.js";
export {
  GENERATE_TOOLS,
  runResearch,
  researchExecution,
  executeGenerateTool,
  executeGenerateToolAsync,
} from "./agent-tools.js";
export type { ResearchResult } from "./agent-tools.js";
export {
  createLocalResearchPort,
  createHttpResearchPort,
  researchConfigFromEnv,
  parseResearchHit,
} from "./research-port.js";
export type { ResearchPort, ResearchPortConfig, ResearchQuery } from "./research-port.js";
export {
  parseComposeDeck,
  assertComposeHasBody,
  fillComposeFromTodos,
  finalizeComposeDeck,
  composeBodyRules,
  collectPageLines,
  deterministicDeck,
  briefToOutline,
  extractReferenceLines,
  inferDeckIntent,
  resolvePlaybookCategory,
  resolveGenerateDesign,
  intentComposeGuidance,
  isNamedClassroomFact,
  HUB_DEFAULT_DESIGN,
  DEFAULT_TEACH_DESIGN,
  DEFAULT_ACADEMIC_DESIGN,
  DEFAULT_PROMO_DESIGN,
  DEFAULT_REPORT_DESIGN,
  DEFAULT_TRAVEL_DESIGN,
} from "./compose-ir.js";
export type { ComposeDeck, ComposePage, DeckIntent } from "./compose-ir.js";
export { hasOperatingFacts, missingOperatingFactsReason, extractMarkedGaps, NEED_DATA_REASON } from "./report-facts.js";
export {
  parseSkillDeck,
  parseSkillPage,
  parseElement,
  parseBounds,
  hasSkillElements,
  assertSkillDeck,
  skillToCompose,
  applySkillDeck,
} from "./skill-pages.js";
export type { SkillDeckInput, SkillPageInput } from "./skill-pages.js";
export { thinkAboutBrief, planFromDeck, localPlan } from "./reason.js";
export type { ReasonBlock } from "./reason.js";
export { chunkText, streamText } from "./stream-text.js";
export type { StreamTextOptions } from "./stream-text.js";
export {
  llmConfigFromEnv,
  createLlmPort,
  chatCompletionsUrl,
  parseLlmConfig,
  classifyLlmFailure,
  formatLlmWaitMessage,
  LlmHttpError,
} from "./llm-port.js";
export type {
  LlmPort,
  LlmPortConfig,
  LlmImage,
  LlmChatMessage,
  LlmToolCall,
  LlmToolSpec,
  LlmTurnResult,
  LlmRetryInfo,
  LlmFailureKind,
} from "./llm-port.js";
export { normalizeToolCalls } from "./llm-port.js";
export { rebuildNodesFromImage, imageToDataUrl } from "./image-rebuild-llm.js";
export { createImagePort, imageConfigFromEnv, imageConfigured } from "./image-port.js";
export type { ImagePort, ImagePortConfig, GeneratedImage } from "./image-port.js";
export { createImageSearchPort, imageSearchConfigFromEnv, imageSearchConfigured } from "./image-search-port.js";
export type { ImageSearchPort, ImageSearchPortConfig, ImageSearchHit } from "./image-search-port.js";
export { detectCapabilities, formatCapabilityCard } from "./capability-card.js";
export type { CapabilityCard } from "./capability-card.js";
export { createPageRasterPort, editorUrlFromEnv, savePageRaster, rasterToDataUrl } from "./page-raster.js";
export type { PageRasterPort, PageRasterResult } from "./page-raster.js";
export { findPiSdkRoot, piAvailable } from "./pi-available.js";
export type { PiAvailability } from "./pi-available.js";
export {
  formatPiAuthChip,
  inferPiProvider,
  listPiStoredAuth,
  piAuthEnv,
  piAuthPath,
  piProviderLoginReady,
  piProductLoginReady,
  productPiAuth,
  resolvePiAuth,
  resolvePiAuthForProvider,
} from "./pi-auth.js";
export type { PiAuthKind, PiAuthSource, PiAuthStatus, PiStoredAuth } from "./pi-auth.js";
export {
  listPiLoginProviders,
  logoutPiProvider,
  piLoginSnapshot,
  savePiApiKey,
  PI_LOGIN_PROVIDERS,
} from "./pi-login.js";
export type { PiLoginMethod, PiLoginProvider } from "./pi-login.js";
export { answerPiOAuth, cancelPiOAuth, getPiOAuthSession, startPiOAuth } from "./pi-oauth.js";
export type { PiOAuthEvent, PiOAuthPrompt, PiOAuthSessionView } from "./pi-oauth.js";
export { persistWrittenPages } from "./agent-tools.js";
export { saveMediaFile, mediaExists, listMedia } from "./media-store.js";
export {
  reviewSkillPages,
  detectExhibit,
  pageCoverage,
  coursewarePageIssues,
  hasCoursewareColor,
  hasDrawnExhibit,
  isCoursewareExhibitPage,
  isNeutralHex,
  inferBriefPageExhibits,
  inferTodoExhibits,
  isTodoExhibitKind,
  requestedExhibitIssues,
  resolveTodoExhibits,
  TODO_EXHIBIT_KINDS,
} from "./layout-qa.js";
export type { LayoutReview, LayoutIssue, TodoExhibitContract, TodoExhibitKind } from "./layout-qa.js";
export { missingLockedPageFacts, reportFactIssues } from "./report-facts.js";
export type { ReportFactIssue } from "./report-facts.js";
export { paintKidsCoursewarePage, ensureKidsCoursewarePage, isHostNoteCopy, KIDS_INK } from "./kids-courseware.js";
export {
  paintOfficialRecipePage,
  ensureOfficialRecipePage,
  keepWrittenClassroomPage,
  officialRecipesMarkdown,
  hasOfficialRecipe,
  hasOfficialRecipeKind,
  hasHomemadeFourCircles,
  hasKidsDoodle,
  officialCopyPairs,
  kindCopyMatches,
  PAPER_WHITE,
} from "./playbook-recipes.js";
export type { RebuildNode } from "./image-rebuild-llm.js";
export { materializeDeck, chartHasNumericY, stripIndexPrefix, titleFontSize } from "./materialize.js";
export { clocksFromTimed, createPiBrain } from "./pi-brain.js";
export {
  PI_RPC_TOOL_ALLOWLIST,
  PI_SKILL_TOOL_NAMES,
  piRpcToolAllowlist,
  resolvePiHandsExtension,
  runPiHand,
  initializePiRunLedger,
  hasExplicitUserDesign,
  skillStackEvidence,
  skillsExecutionMode,
  writePiRuntime,
} from "./pi-hands.js";
export type { PiHandsRuntime, SkillStackEvidence } from "./pi-hands.js";
export {
  verifyOpenKimiPack,
  listOpenKimiSourceRequirements,
  readOpenKimiSourceChunk,
  readOpenKimiSource,
} from "./openkimi-source-pack.js";
export {
  verifyOpenKimiVisualPack,
  resolveOpenKimiDesignPreview,
  readOpenKimiVisualBytes,
} from "./openkimi-visual-pack.js";
export { commitDesignContract, readDesignContract, LAYOUT_FAMILIES, DESIGN_CONTRACT_REL } from "./design-contract.js";
export type { CommittedDesignContract, DesignContractDraft, LayoutFamily } from "./design-contract.js";
export { renderDeckOverview, DECK_OVERVIEW_RENDERER_VERSION } from "./deck-overview.js";
export {
  inspectRunLedger,
  readRunLedger,
  RUN_LEDGER_REL,
  currentPageRevision,
  stableSha256,
  contextFromToolArgs,
  recordTodo,
  requireTodo,
  requireReferencesComplete,
  recordPreparedImageEmitted,
} from "./run-ledger.js";
export { buildPiImageContent, buildPiRenderedPageContent } from "./pi-image-content.js";
export { authenticGenerationStatus } from "./generation-provenance.js";
export type { AuthenticGenerationStatus } from "./generation-provenance.js";
export type { PiBrain, PiBrainOptions, PiSessionFactoryOpts, PiSessionLike } from "./pi-brain.js";
export {
  classifyPiEvents,
  classifyPiFailure,
  piModelCandidates,
  shouldSwitchPiModel,
  summarizePiError,
  GOOGLE_PRODUCE_MODELS,
  XAI_PRODUCE_MODELS,
} from "./pi-failure.js";
export type { PiFailure, PiFailureKind } from "./pi-failure.js";
export {
  PiRpcSession,
  buildPiRpcArgs,
  piConfigFromEnv,
  assistantTextsFromEvents,
  summarizeEvents,
  summarizeTimedEvents,
  resolveXaiAuthExtension,
} from "./pi-rpc.js";
export type { PiRpcConfig, PiRpcOptions, TimedPiEvent } from "./pi-rpc.js";
export { HOST_SKILL_NAME, formatSkillPathsMarkdown, resolveHostSkillDir, resolvePiSkillDirs } from "./pi-skill.js";

export type { ToolName, ToolStep } from "./harness-types.js";

export type AgentRunResult = {
  status: "ready" | "failed" | "paused";
  steps: ToolStep[];
  projectRoot: string;
  versionLabel?: string;
  pptxPath?: string;
  exportBytes?: number;
  composeSource?: string;
  fallbackReason?: string;
  pauseKind?: string;
  canResume?: boolean;
};

export type GenerateReason = {
  brief: string;
  think: ReasonBlock | null;
  plan: ReasonBlock | null;
  tools?: { tool: string; label: string; summary: string; detail: string }[];
};

const REASON_TOOLS = new Set<ToolName>(["think", "plan", "read_file", "research", "write_todo"]);

/** Disk copy of Think / Plan / agent tools so the editor workspace can reopen them. */
export function persistGenerateReason(root: string, brief: string, steps: ToolStep[]): GenerateReason | null {
  const thinkStep = steps.find((s) => s.tool === "think" && s.status === "completed");
  const planStep = steps.find((s) => (s.tool === "plan" || s.tool === "write_todo") && s.status === "completed");
  const tools = steps
    .filter((s) => REASON_TOOLS.has(s.tool) && s.status === "completed")
    .map((s) => ({
      tool: s.tool,
      label: s.label,
      summary: s.summary ?? "",
      detail: s.detail ?? "",
    }));
  if (!thinkStep && !planStep && !tools.length) return null;
  const payload: GenerateReason = {
    brief,
    think: thinkStep ? { summary: thinkStep.summary ?? "", detail: thinkStep.detail ?? "" } : null,
    plan: planStep ? { summary: planStep.summary ?? "", detail: planStep.detail ?? "" } : null,
    tools: tools.length ? tools : undefined,
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "generate-reason.json"), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export type Brain = {
  compose(brief: string, project: PptdProject): void | Promise<void>;
  think?(brief: string): ReasonBlock | Promise<ReasonBlock>;
  plan?(brief: string): ReasonBlock | Promise<ReasonBlock>;
  /** Full tool-loop generate. When present, harness skips canned Think→Plan→Compose. */
  run?: (hooks: AgentRunHooks) => Promise<void>;
};

/** Mock brain: multi-page outline from brief keywords — offline, no LLM. */
export const mockBrain: Brain = {
  compose(brief, project) {
    const title = brief.trim().slice(0, 40) || "未命名演示";
    project.presentation.title = title;
    if (project.pages.length === 0) {
      project.pages.push({
        path: "pages/cover.page",
        page: {
          pageType: "cover",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [
            {
              elementId: "title",
              elementType: "text",
              bounds: [80, 200, 800, 80],
              content: {
                text: title,
                style: "$title",
                align: ["center", "middle"],
              },
            },
          ],
        },
      });
      project.presentation.pages = project.pages.map((page) => page.path);
    }
    const cover = project.pages[0]!.page;
    const titleEl = cover.elements.find((e) => e.elementType === "text") as TextElement | undefined;
    if (titleEl) {
      titleEl.content.text = title;
    }
    // second page: bullets from brief
    const bodyPath = "pages/2_body.page";
    if (!project.presentation.pages.includes(bodyPath)) {
      project.presentation.pages.push(bodyPath);
      project.pages.push({
        path: bodyPath,
        page: {
          pageType: "content",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [
            {
              elementId: "h1",
              elementType: "text",
              bounds: [60, 40, 840, 48],
              content: {
                text: "要点",
                bold: true,
                fontSize: 28,
                color: "#111111",
              },
            },
            {
              elementId: "body",
              elementType: "text",
              bounds: [60, 120, 840, 320],
              content: {
                text: brief.slice(0, 500),
                fontSize: 16,
                color: "#333333",
              },
            },
            {
              elementId: "card",
              elementType: "shape",
              bounds: [60, 460, 200, 40],
              shapeName: "roundRect",
              fill: { type: "solid", color: "#2563EB" },
            },
            {
              elementId: "mini-chart",
              elementType: "chart",
              bounds: [300, 400, 540, 120],
              data: {
                cols: ["项", "值"],
                rows: [
                  ["A", 3],
                  ["B", 5],
                  ["C", 2],
                ],
              },
              series: [{ type: "bar", name: "值", encode: { x: "项", y: "值" } }],
              title: "示意",
            },
          ],
        },
      });
    }
  },
};

function describeBrain(brain: Brain): {
  composeSource?: string;
  fallbackReason?: string;
} {
  const rec = brain as Brain & {
    kind?: string;
    usedPi?: boolean;
    usedLlm?: boolean;
    fallbackReason?: string;
    pause?: { kind?: string; reason?: string };
  };
  if (rec.kind === "pi-rpc") {
    if (rec.pause) {
      return {
        composeSource: "paused",
        fallbackReason: rec.fallbackReason,
      };
    }
    return {
      composeSource: rec.usedPi ? "pi-rpc" : "fallback",
      fallbackReason: rec.fallbackReason,
    };
  }
  if (rec.kind === "playbook") {
    return { composeSource: rec.usedLlm ? "llm" : "playbook" };
  }
  if (rec.kind === "host") {
    return { composeSource: "host-produce" };
  }
  if (rec.kind === "agent") {
    if (rec.pause) {
      return {
        composeSource: "paused",
        fallbackReason: rec.fallbackReason,
      };
    }
    return {
      composeSource: rec.usedLlm ? "agent" : "playbook",
      fallbackReason: rec.fallbackReason,
    };
  }
  return { composeSource: "mock" };
}

function step(tool: ToolName, label: string, fn: () => void | Promise<void>, done?: string | (() => string)): ToolStep {
  const s: ToolStep = { tool, label, status: "running" };
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") {
      // async handled by caller
    }
    s.status = "completed";
    s.summary = typeof done === "function" ? done() : (done ?? "ok");
  } catch (e) {
    s.status = "failed";
    s.summary = e instanceof Error ? e.message : String(e);
    throw e;
  }
  return s;
}

/**
 * Pages + elements, then compose-mode layout QA.
 * Does not require media. Dangling image src fails. Empty pages fail.
 */
function validateGeneratedProject(root: string): number {
  const p = loadProject(root);
  if (p.pages.length < 1) throw new Error("no pages");
  for (const pg of p.pages) {
    if (!Array.isArray(pg.page.elements)) throw new Error("bad page");
  }
  const review = reviewSkillPages(
    p.pages.map((pg, i) => ({
      id: path.basename(pg.path, ".page") || `page-${i + 1}`,
      pageType: pg.page.pageType,
      notes: pg.page.notes,
      background: pg.page.background,
      elements: pg.page.elements,
    })),
    { projectRoot: root, mode: "compose" },
  );
  if (!review.ok) {
    throw new Error(`layout_qa: ${review.issues.map((issue) => `${issue.pageId}:${issue.code}`).join("; ")}`);
  }
  return p.pages.length;
}

/**
 * Run generate: create project dir, playbook compose, validate, version.
 * Optionally export PPTX via dynamic import of exporter-native (avoids hard cycle).
 */
export async function runGenerateAsync(opts: {
  projectRoot: string;
  brief: string;
  brain?: Brain;
  exportPptx?: boolean;
  /** Parsed reference attachments. Passed through to the default playbook brain. */
  referenceText?: string;
  /** AC-03: official-shaped tool rows as they happen. */
  onStep?: (step: ToolStep, index: number) => void;
  /**
   * Pause between Think / Plan / Compose body chunks so the UI can paint.
   * 0 (default) still emits growing `detail` while status is running.
   */
  streamPaceMs?: number;
  streamChunkSize?: number;
}): Promise<AgentRunResult> {
  const brain: Brain =
    opts.brain ??
    createPlaybookBrain({
      referenceText: opts.referenceText,
      categoryId: resolvePlaybookCategory(opts.brief),
    });
  const steps: ToolStep[] = [];
  const root = path.resolve(opts.projectRoot);
  const emitNew = (s: ToolStep) => {
    steps.push(s);
    opts.onStep?.(s, steps.length - 1);
  };
  const emitUpdate = (s: ToolStep) => {
    opts.onStep?.(s, steps.indexOf(s));
  };
  const emit = emitNew;

  const pace = Math.max(0, opts.streamPaceMs ?? 0);
  const chunkSize = opts.streamChunkSize ?? 4;
  const runReasoned = async (
    tool: ToolName,
    label: string,
    work: () => ReasonBlock | Promise<ReasonBlock>,
  ): Promise<void> => {
    const s: ToolStep = { tool, label, status: "running" };
    emitNew(s);
    try {
      const block = await Promise.resolve(work());
      s.summary = block.summary;
      emitUpdate(s);
      await streamText(
        block.detail,
        (partial) => {
          s.status = "running";
          s.detail = partial;
          emitUpdate(s);
        },
        { paceMs: pace, chunkSize },
      );
      s.status = "completed";
      s.summary = block.summary;
      s.detail = block.detail;
      emitUpdate(s);
    } catch (e) {
      s.status = "failed";
      s.summary = e instanceof Error ? e.message : String(e);
      emitUpdate(s);
      throw e;
    }
  };

  try {
    if (!opts.brief.trim()) throw new Error("brief required");
    let project = fs.existsSync(path.join(root, "deck.pptd"))
      ? loadProject(root)
      : createEmptyProject(root, { title: "生成中" });

    if (brain.run) {
      await brain.run({
        brief: opts.brief,
        project,
        emit: emitNew,
        emitUpdate,
        streamDetail: (text: string, write: (partial: string) => void) =>
          streamText(text, write, { paceMs: pace, chunkSize }),
      });
      const rec = brain as Brain & {
        pause?: { kind: string; checkpoint: import("./generate-checkpoint.js").AgentCheckpoint };
      };
      if (rec.pause) {
        let diskReady = false;
        try {
          const t = JSON.parse(fs.readFileSync(path.join(root, "_agent", "pi-trace.json"), "utf8")) as {
            usedPi?: boolean;
            skillStack?: { ok?: boolean };
          };
          const pagesDir = path.join(root, "pages");
          const pageCount = fs.existsSync(pagesDir)
            ? fs.readdirSync(pagesDir).filter((n) => n.endsWith(".page")).length
            : 0;
          diskReady = Boolean(t.usedPi && t.skillStack?.ok);
        } catch {
          diskReady = false;
        }
        if (!diskReady) {
          writeGenerateCheckpoint(root, rec.pause.checkpoint);
          persistGenerateReason(root, opts.brief, steps);
          return {
            status: "paused",
            steps,
            projectRoot: root,
            composeSource: "paused",
            fallbackReason: describeBrain(brain).fallbackReason,
            pauseKind: rec.pause.kind,
            canResume: true,
          };
        }
      }
      clearGenerateCheckpoint(root);
      saveProject(project);
      project = loadProject(root);
    } else {
      await runReasoned("think", "Think", () => {
        return brain.think?.(opts.brief) ?? thinkAboutBrief(opts.brief, opts.referenceText);
      });
      await runReasoned("plan", "Plan", () => {
        if (brain.plan) return brain.plan(opts.brief);
        return localPlan(opts.brief, DEFAULT_DESIGN_SYSTEM, opts.referenceText, resolvePlaybookCategory(opts.brief))
          .reason;
      });

      const composeStep: ToolStep = {
        tool: "compose_deck",
        label: "Compose Deck",
        status: "running",
      };
      emit(composeStep);
      try {
        await Promise.resolve(brain.compose(opts.brief, project));
        saveProject(project);
        project = loadProject(root);
        const source = describeBrain(brain).composeSource;
        const lines = project.pages.map((pg, i) => {
          const titleEl = pg.page.elements.find(
            (e): e is TextElement => e.elementId === "title" && e.elementType === "text",
          );
          const title = titleEl?.content.text ?? pg.page.pageType;
          return `${String(i + 1).padStart(2, "0")}  ${pg.page.pageType}  ${title}`;
        });
        composeStep.summary = `${project.pages.length} pages`;
        emitUpdate(composeStep);
        await streamText(
          lines.join("\n"),
          (partial) => {
            composeStep.status = "running";
            composeStep.detail = partial;
            emitUpdate(composeStep);
          },
          { paceMs: pace, chunkSize },
        );
        composeStep.status = "completed";
        composeStep.summary = `${project.pages.length} pages · ${source}`;
        composeStep.detail = lines.join("\n");
        emitUpdate(composeStep);
      } catch (e) {
        composeStep.status = "failed";
        composeStep.summary = e instanceof Error ? e.message : String(e);
        opts.onStep?.(composeStep, steps.length - 1);
        throw e;
      }
    }
    let pageCount = 0;
    emit(
      step(
        "validate",
        "Validate",
        () => {
          pageCount = validateGeneratedProject(root);
        },
        () => `${pageCount} pages`,
      ),
    );
    let versionLabel: string | undefined;
    emit(
      step(
        "version_snapshot",
        "Version",
        () => {
          const v = snapshotVersion(root, {
            label: "V1",
            note: opts.brief.slice(0, 80),
          });
          versionLabel = v.label;
        },
        () => versionLabel || "V1",
      ),
    );

    let pptxPath: string | undefined;
    let exportBytes: number | undefined;
    if (opts.exportPptx) {
      const expStep: ToolStep = {
        tool: "export_pptx",
        label: "Export PPTX",
        status: "running",
      };
      emit(expStep);
      try {
        const { exportProjectToFile } = await import("@open-slidestudio/exporter-native");
        pptxPath = path.join(root, "deck.pptx");
        const exp = await exportProjectToFile(root, pptxPath);
        exportBytes = exp.report.bytes;
        expStep.status = "completed";
        expStep.summary = `${exp.report.bytes} bytes`;
        opts.onStep?.(expStep, steps.length - 1);
      } catch (e) {
        expStep.status = "failed";
        expStep.summary = e instanceof Error ? e.message : String(e);
        opts.onStep?.(expStep, steps.length - 1);
        throw e;
      }
    }

    persistGenerateReason(root, opts.brief, steps);
    return {
      status: "ready",
      steps,
      projectRoot: root,
      versionLabel,
      pptxPath,
      exportBytes,
      ...describeBrain(brain),
    };
  } catch (e) {
    persistGenerateReason(root, opts.brief, steps);
    const described = describeBrain(brain);
    return {
      status: "failed",
      steps,
      projectRoot: root,
      composeSource: described.composeSource,
      fallbackReason: described.fallbackReason || (e instanceof Error ? e.message : String(e)),
    };
  }
}

/** Sync wrapper without export (tests / simple callers). Playbook default is sync. */
export function runGenerate(opts: {
  projectRoot: string;
  brief: string;
  brain?: Brain;
  referenceText?: string;
}): AgentRunResult {
  const brain =
    opts.brain ??
    createPlaybookBrain({
      referenceText: opts.referenceText,
      categoryId: resolvePlaybookCategory(opts.brief),
    });
  const steps: ToolStep[] = [];
  const root = path.resolve(opts.projectRoot);

  try {
    const thought = thinkAboutBrief(opts.brief, opts.referenceText);
    steps.push({
      tool: "think",
      label: "Think",
      status: "completed",
      summary: thought.summary,
      detail: thought.detail,
    });
    const planned = brain.plan
      ? brain.plan(opts.brief)
      : localPlan(opts.brief, DEFAULT_DESIGN_SYSTEM, opts.referenceText, resolvePlaybookCategory(opts.brief)).reason;
    if (planned && typeof (planned as Promise<ReasonBlock>).then === "function") {
      throw new Error("async brain requires runGenerateAsync");
    }
    const planBlock = planned as ReasonBlock;
    steps.push({
      tool: "plan",
      label: "Plan",
      status: "completed",
      summary: planBlock.summary,
      detail: planBlock.detail,
    });

    let project = createEmptyProject(root, { title: "生成中" });
    let composeSummary = "";
    steps.push(
      step(
        "compose_deck",
        "Compose Deck",
        () => {
          const maybe = brain.compose(opts.brief, project);
          if (maybe && typeof (maybe as Promise<void>).then === "function") {
            throw new Error("async brain requires runGenerateAsync");
          }
          saveProject(project);
          project = loadProject(root);
          composeSummary = `${project.pages.length} pages · ${describeBrain(brain).composeSource}`;
        },
        () => composeSummary,
      ),
    );
    let pageCount = 0;
    steps.push(
      step(
        "validate",
        "Validate",
        () => {
          pageCount = validateGeneratedProject(root);
        },
        () => `${pageCount} pages`,
      ),
    );
    let versionLabel: string | undefined;
    steps.push(
      step(
        "version_snapshot",
        "Version",
        () => {
          const v = snapshotVersion(root, {
            label: "V1",
            note: opts.brief.slice(0, 80),
          });
          versionLabel = v.label;
        },
        () => versionLabel || "V1",
      ),
    );

    persistGenerateReason(root, opts.brief, steps);
    return {
      status: "ready",
      steps,
      projectRoot: root,
      versionLabel,
    };
  } catch {
    persistGenerateReason(root, opts.brief, steps);
    return { status: "failed", steps, projectRoot: root };
  }
}
