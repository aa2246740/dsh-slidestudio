/**
 * Pi RPC brain: `pi --mode rpc` is the agent runtime.
 * It loads open-slidestudio + open-kimi-ppt via `--skill` and writes PPTD.
 * Host Think/Plan templates are not this path.
 */
import fs from "node:fs";
import path from "node:path";
import { loadProject, saveProject, type PptdProject } from "@open-slidestudio/pptd-v2";
import {
  deterministicDeck,
  inferDeckIntent,
  parseComposeDeck,
  resolveGenerateDesign,
  resolvePlaybookCategory,
  type ComposeDeck,
} from "./compose-ir.js";
import { materializeDeck } from "./materialize.js";
import { applySkillDeck, parseSkillDeck, skillToCompose, type SkillDeckInput } from "./skill-pages.js";
import { missingOperatingFactsReason } from "./report-facts.js";
import {
  DEFAULT_CATEGORY,
  DEFAULT_DESIGN_SYSTEM,
  loadPlaybook,
  type Palette,
  type PlaybookBundle,
} from "./playbook.js";
import { detectCapabilities, formatCapabilityCard, type CapabilityCard } from "./capability-card.js";
import type { AgentRunHooks } from "./agent-brain.js";
import type { ToolStep } from "./harness-types.js";
import { piAvailable } from "./pi-available.js";
import { piProviderLoginReady } from "./pi-auth.js";
import {
  mergeSkillStackEvidence,
  hasExplicitUserDesign,
  skillStackEvidence,
  skillsExecutionMode,
  writePiRuntime,
} from "./pi-hands.js";
import { inspectRunLedger, type RunLedgerInspection } from "./run-ledger.js";
import { paintExhibit } from "./exhibit-paint.js";
import { parsePagedScript } from "./host-produce.js";
import { reviewSkillPages } from "./layout-qa.js";
import { formatSkillPathsMarkdown, resolvePiSkillDirs } from "./pi-skill.js";
import {
  classifyPiEvents,
  classifyPiFailure,
  piModelCandidates,
  shouldSwitchPiModel,
  summarizePiError,
  type PiFailure,
} from "./pi-failure.js";
import { formatPauseMessage, type AgentPause, type AgentPauseKind } from "./generate-checkpoint.js";
import {
  PiRpcSession,
  assistantTextsFromEvents,
  piConfigFromEnv,
  publicPiRuntimeEvent,
  summarizeTimedEvents,
  type PiPublicRuntimeEvent,
  type PiRpcLine,
  type TimedPiEvent,
} from "./pi-rpc.js";

export type PiSessionFactoryOpts = {
  cwd: string;
  model?: string;
  provider?: string;
};

export type PiSessionLike = {
  start(): Promise<void>;
  getState(): Promise<PiRpcLine>;
  promptAndWait(message: string, timeoutMs: number): Promise<PiRpcLine[]>;
  stop(): Promise<void>;
  getStderr(): string;
  onEvent?(listener: (event: PiRpcLine) => void): () => void;
};

export type PiBrainOptions = {
  skillRoot?: string;
  designSystemId?: string;
  categoryId?: string;
  bin?: string;
  model?: string;
  provider?: string;
  timeoutMs?: number;
  /** Dev/fixture escape hatch only. Production and the default fail closed. */
  fallback?: boolean;
  editorBaseUrl?: string;
  /** Parsed Hub attachments. Written to `_agent/attachments.md` for Pi to read. */
  referenceText?: string;
  createSession?: (opts: PiSessionFactoryOpts) => PiSessionLike;
  /** Test seam for exercising the production ledger while injecting a fake Pi session. */
  strictExecution?: boolean;
  /** Default true. Tests with createSession skip. Env needs SLIDESTUDIO_PI_ALLOW_ENV=1. */
  requireProductLogin?: boolean;
  /** Tests inject a fake clock. Live path waits Google retryDelay. */
  sleep?: (ms: number) => Promise<void>;
  /** Sanitized live Pi events for the product timeline. */
  onRuntimeEvent?: (event: PiPublicRuntimeEvent) => void;
};

export type PiBrain = {
  kind: "pi-rpc";
  usedPi: boolean;
  fallbackReason?: string;
  model?: string;
  sessionId?: string;
  skills: string[];
  eventTrace: string[];
  timedEvents: TimedPiEvent[];
  pause?: AgentPause;
  compose: (brief: string, project: PptdProject) => Promise<void>;
  run: (hooks: AgentRunHooks) => Promise<void>;
};

const COMPOSE_REL = path.join("_agent", "compose-deck.json");
const SKILL_REL = path.join("_agent", "skill-deck.json");

function writeCapabilityFiles(root: string, card: CapabilityCard): void {
  const dir = path.join(root, "_agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "capability.json"), `${JSON.stringify(card, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "capability.md"), `${formatCapabilityCard(card)}\n`, "utf8");
}

function writeAgentKit(
  root: string,
  playbook: PlaybookBundle,
  brief: string,
  card: CapabilityCard,
  referenceText?: string,
): void {
  const dir = path.join(root, "_agent");
  fs.mkdirSync(dir, { recursive: true });
  writeCapabilityFiles(root, card);
  fs.writeFileSync(
    path.join(dir, "schema.json"),
    `${JSON.stringify(
      {
        title: "string",
        pages: [
          {
            id: "page-01",
            pageType: "cover|route|concept|method|demo|transfer",
            elements: [
              {
                elementId: "title",
                elementType: "text",
                bounds: [40, 40, 880, 48],
                content: { text: "page title", bold: true, fontSize: 22 },
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "playbook.md"),
    [
      `# Runtime routing ${playbook.designSystemId} / ${playbook.categoryId}`,
      "",
      ...tasteLockLines(brief, playbook),
      "This file contains routing facts only. It is not an OpenKimi source and cannot satisfy the source gate.",
      "Call list_references, read every required chunk, inspect the selected preview, then commit the design contract before planning pages.",
      `Category: ${playbook.categoryId}`,
      `Selected reference basis: ${playbook.designSystemId}`,
      hasExplicitUserDesign(brief)
        ? "The user's exact visual hints override conflicting contract rules. They do not remove the selected reference basis."
        : "Use the selected reference as the basis, then make a task-specific necessary design judgment.",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "brief.txt"), brief, "utf8");
  if (referenceText?.trim()) {
    fs.writeFileSync(path.join(dir, "attachments.md"), `${referenceText.trim()}\n`, "utf8");
  }
  const dirs = resolvePiSkillDirs({ skillRoot: playbook.skillRoot, cwd: root });
  fs.writeFileSync(path.join(dir, "skill-paths.md"), formatSkillPathsMarkdown(dirs), "utf8");
}

function buildPrompt(
  playbook: PlaybookBundle,
  brief: string,
  card: CapabilityCard,
  recovery?: RunLedgerInspection,
): string {
  const passedPages =
    recovery?.pages
      .filter((page) => page.visualReview === "pass" && page.layout === "pass")
      .map((page) => page.pageId) ?? [];
  const recoveryLines = recovery?.initialized
    ? [
        "RECOVERY RUN: continue the durable project on disk; do not start a replacement deck.",
        "This is a new Pi context, so re-read every exact source chunk and emit the selected preview again.",
        recovery.designContract === "current"
          ? "A committed design contract already exists. Call read_design after the source and preview steps; do not re-author or amend it."
          : "No committed design contract is available yet. Commit it after the exact source and preview steps.",
        recovery.todoCount > 0
          ? "A committed todo already exists. Read _agent/outline.json and _agent/hands-state.json; keep its order and do not replace it. After source, preview, and read_design, call review_pages before rewriting anything. Treat each returned page id and exact field-level repair as authoritative; keep clean pages unchanged."
          : "No todo is committed yet. Continue with contract-bound write_todo.",
        passedPages.length
          ? `These durable page revisions already passed page image and layout review: ${passedPages.join(", ")}. Keep them unless a later full-deck revise decision names them.`
          : "No page revision has a durable page-review pass yet.",
        `Durable blockers at recovery start: ${recovery.composeBlockers.join("; ")}`,
      ]
    : [];
  return [
    "You are Pi producing an Open SlideStudio deck.",
    "Follow the host skill open-slidestudio (SKILL.md already loaded). That is the produce process.",
    "Read _agent/capability.md and _agent/brief.txt.",
    "Call list_references, then read every required original OpenKimi chunk with read_reference. Next call view_design_reference and inspect the actual preview image.",
    "Commit one task-specific design contract with commit_design before write_todo. The contract must plan page ids, narrative jobs, focal points, and varied layout families. User style hints are overrides, not a reason to skip the selected design source.",
    "In write_todo, copy the committed pageId, title, and layoutFamily exactly, then declare every requested editable exhibit. The host rejects prose substitutes and plan drift.",
    "Call write_page once per todo item with the COMPLETE elements[] array. It replaces the whole page and never appends elements; keep every bounds/style/fill/line/alignment field inside its owning element. After each write_page, call render_page, inspect the attached PNG, and call review_page with the exact token. When deterministic layoutStatus=pass, move to the next todo page unless review_pages names it as failing or review_page/review_deck explicitly says revise. Then run structural review_pages, call render_deck, inspect the attached full-deck overview, and call review_deck across all nine axes. compose_deck is locked until the current deck taste pass is grounded and has no remaining AI defaults.",
    formatCapabilityCard({ ...card, runtime: { ...card.runtime, kind: "pi" } }),
    `Selected OpenKimi reference basis: ${playbook.designSystemId}`,
    hasExplicitUserDesign(brief)
      ? "The user's exact colors, typography, and layout instructions override conflicting reference rules but do not erase the reference basis."
      : "Interpret the selected reference for this task; do not copy its literal text or data.",
    `Category: ${playbook.categoryId}`,
    ...recoveryLines,
    "",
    "User brief:",
    brief,
  ].join("\n");
}

function tasteLockLines(brief: string, playbook: PlaybookBundle): string[] {
  const intent = inferDeckIntent(brief, playbook.categoryId);
  if (intent !== "teach") return [];
  return [
    "Taste lock: K-12 classroom courseware — academic/paper-white-courseware + education-training.",
    "Official page types: cover, route, concept, method, demo, transfer.",
    "Official layouts: cover = header + giant circle + title band; route/method = header + list items[]; concept = header + two columns; demo/transfer = header + result bar. Do not invent stem/leaf/soil doodles.",
    "FORBIDDEN: homemade 4-step numbered circles, soil/sun/seed doodles, cream+black text walls, YAML notes as titles.",
    "Tokens: paper #FDFAF5, title #44712E, body #56687A, coral #F5987E, leaf #D7EBCE, blush #F9DED8.",
    "Read capability.md before layout. If imageSearch/imageGenerate are NO, use official no-image layouts. Do not write src.",
    "Do not use consulting pine-green (#0E382B) or write 咨询松绿色调.",
    "Clock: exact sources → selected preview → commit_design → write_todo → write/render/review each page → review_pages → render_deck → review_deck → compose_deck.",
    "",
  ];
}

function playbookForBrief(brief: string, opts: PiBrainOptions): PlaybookBundle {
  const categoryId = resolvePlaybookCategory(brief, opts.categoryId ?? DEFAULT_CATEGORY);
  const designSystemId = resolveGenerateDesign(brief, opts.designSystemId ?? DEFAULT_DESIGN_SYSTEM, categoryId);
  return loadPlaybook({
    skillRoot: opts.skillRoot,
    designSystemId,
    categoryId,
  });
}

function writePiVisualReview(root: string, timed: TimedPiEvent[]): void {
  const ledger = inspectRunLedger(root);
  if (ledger.initialized) {
    const pageSeen =
      ledger.pages.length > 0 &&
      ledger.pages.every(
        (page) => page.raster && page.imageEmitted && page.visualReview === "pass" && page.layout === "pass",
      );
    const seen = pageSeen && (!ledger.tasteGateEnabled || ledger.deckTasteReview === "pass");
    fs.writeFileSync(
      path.join(root, "_agent", "visual-review.json"),
      `${JSON.stringify(
        {
          seen,
          kind: seen ? "pi-page-and-deck-image-content-receipts" : "incomplete",
          note: seen
            ? "Every current page and the full-deck overview were emitted through Pi image content, current delivery tokens were returned in grounded reviews, and layout, structural, and taste gates passed. This does not inspect the provider's internal computation."
            : "Visual evidence is incomplete. Raster files and tool events alone do not count as review.",
          contextEpochId: ledger.contextEpochId ?? null,
          pages: ledger.pages,
          structuralReview: ledger.structuralReview,
          designReference: ledger.designReference,
          designContract: ledger.designContract,
          deckOverview: ledger.deckOverview,
          deckTasteReview: ledger.deckTasteReview,
          deckSnapshotSha256: ledger.deckSnapshotSha256 ?? null,
          composed: ledger.composed,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return;
  }
  const evidence = skillStackEvidence(timed);
  const rasterDir = path.join(root, "_agent", "rasters");
  const rasters = fs.existsSync(rasterDir) ? fs.readdirSync(rasterDir).filter((f) => f.endsWith(".png")) : [];
  fs.writeFileSync(
    path.join(root, "_agent", "visual-review.json"),
    `${JSON.stringify(
      {
        seen: evidence.visualOrReview,
        kind: evidence.visualOrReview ? "pi-tools" : "none",
        note: evidence.visualOrReview
          ? "Pi render_page/review_pages. Host did not raster after agent_end."
          : "No Pi visual tool. Host did not raster after agent_end.",
        rasters,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function parsePiJson(raw: unknown): { deck: ComposeDeck; skillDeck?: SkillDeckInput } | undefined {
  const skill = parseSkillDeck(raw);
  if (skill && skill.pages.length >= 2) {
    return { deck: skillToCompose(skill), skillDeck: skill };
  }
  try {
    return { deck: parseComposeDeck(raw) };
  } catch {
    return undefined;
  }
}

function reloadProjectFromDisk(project: PptdProject): boolean {
  const manifest = path.join(project.rootDir, "deck.pptd");
  if (!fs.existsSync(manifest)) return false;
  try {
    const fresh = loadProject(project.rootDir);
    if (fresh.pages.length < 2) return false;
    project.presentation = fresh.presentation;
    project.pages = fresh.pages;
    return true;
  } catch {
    return false;
  }
}

function readPiOutput(root: string): { deck: ComposeDeck; skillDeck?: SkillDeckInput } | undefined {
  const skillFile = path.join(root, SKILL_REL);
  const composeFile = path.join(root, COMPOSE_REL);
  const file = fs.existsSync(skillFile) ? skillFile : fs.existsSync(composeFile) ? composeFile : "";
  if (!file) return undefined;
  try {
    return parsePiJson(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Leftover helper. Product generate must not call this.
 * Host-painting remaining pages after agent_end is a failed produce.
 */
export function finishScriptedPages(
  skill: SkillDeckInput,
  brief: string,
  pal: Palette,
): { deck: SkillDeckInput; added: number } {
  const scripted = parsePagedScript(brief);
  if (scripted.length < 3 || skill.pages.length >= scripted.length) {
    return { deck: skill, added: 0 };
  }
  const extra = scripted
    .slice(skill.pages.length)
    .map((page, i) => paintExhibit(page, pal, skill.pages.length + i, scripted));
  return {
    deck: {
      title: skill.title || scripted[0]?.title || brief.slice(0, 24),
      pages: [...skill.pages, ...extra],
    },
    added: extra.length,
  };
}

function previewAssistant(events: PiRpcLine[]): string[] {
  return assistantTextsFromEvents(events)
    .slice(-4)
    .map((text) => text.slice(0, 800));
}

function writeAssistantPreview(root: string, events: PiRpcLine[]): void {
  const texts = assistantTextsFromEvents(events);
  if (!texts.length) return;
  fs.writeFileSync(
    path.join(root, "_agent", "pi-assistant.txt"),
    texts.map((text, i) => `--- message ${i + 1} ---\n${text.slice(0, 12_000)}\n`).join("\n"),
    "utf8",
  );
}

function stampNow(event: string): TimedPiEvent {
  return { at: new Date().toISOString(), event };
}

function pauseKindForPiFailure(reason: string, failure?: PiFailure): AgentPauseKind {
  if (failure?.kind === "rate_limit") return "rate_limit";
  if (failure?.kind === "auth") return "auth";
  if (failure?.kind === "client") return "model_unavailable";
  if (/timed?\s*out|timeout/i.test(reason)) return "timeout";
  if (/busy|overload|503|unavailable/i.test(reason)) return "busy";
  return "transient";
}

function appendTrace(brain: PiBrain, items: Array<string | TimedPiEvent>): void {
  for (const item of items) {
    const row = typeof item === "string" ? stampNow(item) : item;
    brain.timedEvents.push(row);
    brain.eventTrace.push(row.event);
  }
}

function fileMtime(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

export function clocksFromTimed(timed: TimedPiEvent[]): {
  agentStart: string | null;
  agentEnd: string | null;
  wallMs: number | null;
  toolWrites: TimedPiEvent[];
} {
  let startIdx = -1;
  for (let i = 0; i < timed.length; i++) {
    if (timed[i]?.event === "agent_start") startIdx = i;
  }
  const slice = startIdx >= 0 ? timed.slice(startIdx) : timed;
  const agentStart = startIdx >= 0 ? timed[startIdx] : null;
  const agentEnd = [...slice].reverse().find((e) => e.event === "agent_end") ?? slice.at(-1) ?? null;
  const toolWrites = timed.filter((e) => e.event.startsWith("tool:write"));
  const wallMs = agentStart && agentEnd ? Date.parse(agentEnd.at) - Date.parse(agentStart.at) : null;
  return {
    agentStart: agentStart?.at ?? null,
    agentEnd: agentEnd?.at ?? null,
    wallMs: Number.isFinite(wallMs) ? wallMs : null,
    toolWrites,
  };
}

function writeTrace(root: string, payload: Record<string, unknown>, timed: TimedPiEvent[]): void {
  const dir = path.join(root, "_agent");
  fs.mkdirSync(dir, { recursive: true });
  const clocks = clocksFromTimed(timed);
  fs.writeFileSync(
    path.join(dir, "pi-trace.json"),
    `${JSON.stringify(
      {
        ...payload,
        events: timed.map((e) => e.event),
        timedEvents: timed,
        agentStart: clocks.agentStart,
        agentEnd: clocks.agentEnd,
        wallMs: clocks.wallMs,
        toolWrites: clocks.toolWrites,
        fileMtimes: {
          brief: fileMtime(path.join(root, "_agent", "brief.txt")),
          skillDeck: fileMtime(path.join(root, "_agent", "skill-deck.json")),
          composeDeck: fileMtime(path.join(root, "_agent", "compose-deck.json")),
          deck: fileMtime(path.join(root, "deck.pptd")),
        },
        writtenAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function createPiBrain(opts: PiBrainOptions = {}): PiBrain {
  const envCfg = piConfigFromEnv();
  const playbook = loadPlaybook({
    skillRoot: opts.skillRoot,
    designSystemId: opts.designSystemId ?? DEFAULT_DESIGN_SYSTEM,
    categoryId: opts.categoryId ?? DEFAULT_CATEGORY,
  });
  const provider = opts.provider ?? envCfg.provider;
  const fallback = opts.fallback === true;
  const model = opts.model ?? (opts.provider && opts.provider !== envCfg.provider ? undefined : envCfg.model);
  const timeoutMs = opts.timeoutMs ?? envCfg.timeoutMs;
  const bin = opts.bin ?? envCfg.bin;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const skills = resolvePiSkillDirs({
    skillRoot: playbook.skillRoot,
    cwd: process.cwd(),
  });
  const skillPaths = [skills.host, skills.vendor];
  const requireLogin = opts.requireProductLogin !== false && !opts.createSession;

  const brain: PiBrain = {
    kind: "pi-rpc",
    usedPi: false,
    model,
    skills: skillPaths,
    eventTrace: [],
    timedEvents: [],
    async compose(brief, project) {
      const playbook = playbookForBrief(brief, opts);
      const strictExecution = opts.strictExecution ?? !opts.createSession;
      let activeSessionId = brain.sessionId;
      let activeProvider = provider;
      let activeModel = brain.model;
      const traceIdentity = () => ({
        sessionId: activeSessionId ?? null,
        model: activeModel ?? null,
        provider: activeProvider ?? null,
      });
      const apply = (deck: ComposeDeck, skillDeck?: SkillDeckInput) => {
        if (skillDeck) {
          applySkillDeck(project, skillDeck, playbook.palette);
          return;
        }
        materializeDeck(project, deck, playbook.palette);
      };
      if (requireLogin && !piProviderLoginReady(provider)) {
        throw new Error(
          provider
            ? `请先在创建页登录供应商 ${provider}（API key 或 OAuth）。`
            : "请先在创建页登录供应商（API key 或 OAuth）。环境变量不是产品登录。",
        );
      }
      let card = detectCapabilities({
        rasterAvailable: Boolean(opts.editorBaseUrl),
        pi: piAvailable(),
        runtimeKind: "pi",
      });
      const recoveryAtStart = inspectRunLedger(project.rootDir);
      writeAgentKit(project.rootDir, playbook, brief, card, opts.referenceText);
      const factsGap = missingOperatingFactsReason(brief, opts.referenceText);
      if (factsGap) {
        brain.usedPi = false;
        brain.fallbackReason = factsGap;
        writeTrace(
          project.rootDir,
          {
            usedPi: false,
            live: false,
            produce: "",
            error: factsGap,
            skills: skillPaths,
            ...traceIdentity(),
          },
          brain.timedEvents,
        );
        throw new Error(factsGap);
      }
      writePiRuntime(project.rootDir, {
        brief,
        categoryId: playbook.categoryId,
        designSystemId: playbook.designSystemId,
        editorBaseUrl: opts.editorBaseUrl,
        designDirection: "preset",
        strictExecution: !opts.createSession,
        tasteExecution: !opts.createSession,
      });
      const createSession =
        opts.createSession ??
        ((sessionOpts: PiSessionFactoryOpts) =>
          new PiRpcSession({
            bin,
            cwd: sessionOpts.cwd,
            model: sessionOpts.model ?? model,
            provider: sessionOpts.provider ?? provider,
            thinking: "off",
            skills: skillPaths,
          }));

      const candidates = piModelCandidates(model, provider);
      const models = candidates.length ? candidates : [model];
      let lastFailure: PiFailure | undefined;
      let lastReason = `Pi did not write ${SKILL_REL} or ${COMPOSE_REL}`;
      let collected: PiRpcLine[] = [];
      let lastStderr = "";

      const failClosed = (reason: string, failure?: PiFailure) => {
        brain.usedPi = false;
        brain.fallbackReason = reason;
        const closedStack = mergeSkillStackEvidence(brain.timedEvents, project.rootDir);
        const ledger = inspectRunLedger(project.rootDir);
        const durableInterrupted = strictExecution && ledger.initialized && !ledger.composed;
        const fixtureRateLimit = failure?.kind === "rate_limit" && !closedStack.compose && closedStack.pageWrites < 2;
        if (durableInterrupted || fixtureRateLimit) {
          const kind = pauseKindForPiFailure(reason, failure);
          brain.pause = {
            kind,
            reason,
            retryAfterMs: failure?.retryAfterMs,
            checkpoint: {
              v: 1,
              brief,
              messages: [],
              traces: [],
              categoryId: playbook.categoryId,
              designSystemId: playbook.designSystemId,
              turnsUsed: 0,
              maxTurns: 10,
              pausedAt: new Date().toISOString(),
              reason,
              kind,
            },
          };
        }
        writeTrace(
          project.rootDir,
          {
            usedPi: false,
            fallback,
            paused: Boolean(brain.pause),
            skills: skillPaths,
            skillsAs: skillsExecutionMode(brain.timedEvents),
            skillStack: closedStack,
            ...traceIdentity(),
            error: reason.slice(0, 800),
            stderr: lastStderr.slice(-800),
            assistantPreview: previewAssistant(collected),
          },
          brain.timedEvents,
        );
        if (collected.length) writeAssistantPreview(project.rootDir, collected);
        if (brain.pause) return;
        if (!fallback) throw new Error(reason);
        apply(deterministicDeck(brief, playbook.designSystemId, undefined, playbook.categoryId));
      };

      for (let i = 0; i < models.length; i++) {
        const candidate = models[i];
        let session: PiSessionLike | undefined;
        let unsubscribe: (() => void) | undefined;
        try {
          activeModel = candidate ?? model;
          session = createSession({
            cwd: project.rootDir,
            model: candidate,
            provider,
          });
          unsubscribe = session.onEvent?.((event) => {
            const publicEvent = publicPiRuntimeEvent(event);
            if (!publicEvent || !opts.onRuntimeEvent) return;
            try {
              opts.onRuntimeEvent(publicEvent);
            } catch {
              /* A disconnected browser must not terminate the agent. */
            }
          });
          await session.start();
          const sessionState = await session.getState();
          const stateModel =
            sessionState.model && typeof sessionState.model === "object"
              ? (sessionState.model as Record<string, unknown>)
              : undefined;
          activeSessionId =
            typeof sessionState.sessionId === "string" && sessionState.sessionId.trim()
              ? sessionState.sessionId.trim()
              : activeSessionId;
          activeProvider =
            typeof stateModel?.provider === "string" && stateModel.provider.trim()
              ? stateModel.provider.trim()
              : provider;
          activeModel =
            typeof stateModel?.id === "string" && stateModel.id.trim() ? stateModel.id.trim() : (candidate ?? model);
          const modelInputs = Array.isArray(stateModel?.input)
            ? stateModel.input.filter((input): input is string => typeof input === "string")
            : [];
          card = detectCapabilities({
            rasterAvailable: Boolean(opts.editorBaseUrl),
            pi: piAvailable(),
            runtimeKind: "pi",
            piModelInput: modelInputs,
          });
          writeCapabilityFiles(project.rootDir, card);
          if (!opts.createSession && card.vision.mode !== "main-model") {
            throw new Error(
              `Selected Pi model ${activeProvider ?? "unknown"}/${activeModel ?? "unknown"} does not declare image input; visual review cannot run honestly`,
            );
          }
          brain.sessionId = activeSessionId;
          brain.model = activeModel;
          // A previous candidate may have committed pages before its provider
          // failed. Re-read the durable ledger for every fresh model context so
          // failover resumes those exact revisions instead of using the stale
          // snapshot captured when compose() started.
          const recovery = i === 0 ? recoveryAtStart : inspectRunLedger(project.rootDir);
          // A failover context is always a recovery run: the previous
          // candidate may have died before the ledger was initialized, but the
          // durable project kit is already on disk and must not be treated as
          // a fresh start.
          const failoverRecovery: RunLedgerInspection =
            i > 0 && !recovery.initialized
              ? {
                  ...recovery,
                  initialized: true,
                  composeBlockers: [
                    ...recovery.composeBlockers,
                    "the previous model context failed before recording durable work",
                  ],
                }
              : recovery;
          const prompt = buildPrompt(
            playbook,
            brief,
            card,
            failoverRecovery.initialized ? failoverRecovery : undefined,
          );
          let events = await session.promptAndWait(prompt, timeoutMs);
          collected = events;
          if (i > 0) appendTrace(brain, [`model:${candidate}`]);
          appendTrace(brain, summarizeTimedEvents(events));
          writeTrace(
            project.rootDir,
            {
              usedPi: false,
              live: true,
              skills: skillPaths,
              ...traceIdentity(),
              assistantPreview: previewAssistant(collected),
            },
            brain.timedEvents,
          );

          let failure = classifyPiEvents(events);
          if (shouldSwitchPiModel(failure)) {
            lastFailure = failure;
            lastReason = failure!.message;
            lastStderr = session.getStderr();
            appendTrace(brain, [`${failure?.retiredModel ? "retired" : "quota"}:${candidate}`]);
            continue;
          }
          if (failure?.kind === "rate_limit" && failure.retryAfterMs) {
            const waitMs = Math.min(45_000, Math.max(1_000, failure.retryAfterMs));
            appendTrace(brain, [`retry-429:${waitMs}ms`]);
            await sleep(waitMs);
            const progress = skillStackEvidence(brain.timedEvents);
            const resume = strictExecution
              ? `Continue the gated run from disk. Satisfy the current blockers in order: exact sources, selected preview, committed/read design contract, contract-bound todo, every page render and review, structural review, full-deck overview and grounded nine-axis review, then compose. Current blockers: ${inspectRunLedger(project.rootDir).composeBlockers.join("; ")}`
              : progress.outline || progress.pageWrites > 0
                ? "Continue the OpenKimi stack from disk. Call render_page or review_pages, then compose_deck. Do not start over. Do not dump skill-deck.json."
                : prompt;
            const again = await session.promptAndWait(resume, timeoutMs);
            collected = [...events, ...again];
            appendTrace(brain, summarizeTimedEvents(again));
            events = again;
            failure = classifyPiEvents(again);
            if (shouldSwitchPiModel(failure)) {
              lastFailure = failure;
              lastReason = failure!.message;
              lastStderr = session.getStderr();
              appendTrace(brain, [`${failure?.retiredModel ? "retired" : "quota"}:${candidate}`]);
              continue;
            }
          }

          let evidence = mergeSkillStackEvidence(brain.timedEvents, project.rootDir);
          const teach = inferDeckIntent(brief) === "teach";
          const stackReady = () => {
            evidence = mergeSkillStackEvidence(brain.timedEvents, project.rootDir);
            if (strictExecution) return inspectRunLedger(project.rootDir).composed;
            // The local-web product always supplies editorBaseUrl and therefore
            // requires one successful raster per page. CLI/tests may deliberately
            // run without a browser; their authenticity is decided by the caller.
            return Boolean(evidence.ok && (!opts.editorBaseUrl || evidence.renderCoverage));
          };
          writeTrace(
            project.rootDir,
            {
              usedPi: false,
              live: true,
              skills: skillPaths,
              skillsAs: skillsExecutionMode(brain.timedEvents),
              skillStack: evidence,
              ...traceIdentity(),
              assistantPreview: previewAssistant(collected),
            },
            brain.timedEvents,
          );
          if (!stackReady() && !classifyPiEvents(events)) {
            const again = await session.promptAndWait(
              teach
                ? "Classroom run incomplete. Finish the exact sources, selected preview, design contract, and official page recipes. Review every page image, then structural QA, full-deck overview, and grounded deck taste before compose."
                : `The gated run is incomplete. Do not dump a deck in one shot. Follow the blockers through selected preview, design contract, page work, full-deck overview, and grounded taste review before compose. Blockers: ${inspectRunLedger(project.rootDir).composeBlockers.join("; ")}`,
              timeoutMs,
            );
            collected = [...collected, ...again];
            appendTrace(brain, ["retry-stack", ...summarizeTimedEvents(again)]);
            evidence = skillStackEvidence(brain.timedEvents);
            failure = classifyPiEvents(again) ?? failure;
          }
          if (!stackReady() && failure?.kind === "rate_limit" && failure.retryable) {
            const waitMs = Math.min(45_000, Math.max(1_000, failure.retryAfterMs ?? 8_000));
            appendTrace(brain, [`retry-429-stack:${waitMs}ms`]);
            await sleep(waitMs);
            const again = await session.promptAndWait(
              teach
                ? "Continue from disk. Complete page image reviews, structural QA, the full-deck overview, and grounded taste review before compose."
                : `Continue the gated run from disk. Satisfy these blockers without starting over: ${inspectRunLedger(project.rootDir).composeBlockers.join("; ")}`,
              timeoutMs,
            );
            collected = [...collected, ...again];
            appendTrace(brain, ["retry-stack", ...summarizeTimedEvents(again)]);
            evidence = skillStackEvidence(brain.timedEvents);
            failure = classifyPiEvents(again) ?? failure;
          }
          if (!stackReady() && evidence.pageWrites >= 1) {
            const again = await session.promptAndWait(
              `Continue from disk. The host will not salvage-compose. Follow the blockers in order through exact sources, selected preview, design contract, every page, structural QA, full-deck overview, and grounded taste review. Named gaps must appear as the metric name plus 缺失，待补. Keep all requested table columns. Blockers: ${inspectRunLedger(project.rootDir).composeBlockers.join("; ")}`,
              timeoutMs,
            );
            collected = [...collected, ...again];
            appendTrace(brain, ["retry-stack", ...summarizeTimedEvents(again)]);
            evidence = skillStackEvidence(brain.timedEvents);
            failure = classifyPiEvents(again) ?? failure;
          }
          if (!stackReady()) {
            writeAssistantPreview(project.rootDir, collected);
            lastStderr = session.getStderr();
            if (shouldSwitchPiModel(failure) && i < models.length - 1) {
              lastFailure = failure;
              lastReason = failure!.message;
              continue;
            }
            if (failure) {
              failClosed(failure.message, failure);
              return;
            }
            failClosed(
              strictExecution
                ? `gated OpenKimi run incomplete: ${inspectRunLedger(project.rootDir).composeBlockers.join("; ")}`
                : evidence.ok && !evidence.renderCoverage
                  ? `render_page covered ${evidence.renderPages}/${evidence.pageWrites} pages — need every page the user sees`
                  : evidence.reason,
            );
            return;
          }
          const out = readPiOutput(project.rootDir);
          let produce = out ? "pi-tools" : "";
          if (!out && evidence.ok && reloadProjectFromDisk(project)) {
            produce = "pi-tools";
          }
          writeAssistantPreview(project.rootDir, collected);
          lastStderr = session.getStderr();
          if (!out && !reloadProjectFromDisk(project)) {
            if (shouldSwitchPiModel(failure)) {
              lastFailure = failure;
              lastReason = failure!.message;
              appendTrace(brain, [`${failure?.retiredModel ? "retired" : "quota"}:${candidate}`]);
              continue;
            }
            if (failure) {
              lastFailure = failure;
              lastReason = failure.message;
              if (failure.kind === "rate_limit" && i < models.length - 1) {
                appendTrace(brain, [`rate-limit:${candidate}`]);
                continue;
              }
              failClosed(failure.message, failure);
              return;
            }
            throw new Error("Pi ran tools but did not persist PPTD pages");
          }
          if (out) apply(out.deck, out.skillDeck);
          saveProject(project);
          writePiVisualReview(project.rootDir, brain.timedEvents);
          brain.usedPi = true;
          brain.fallbackReason = undefined;
          brain.pause = undefined;
          writeTrace(
            project.rootDir,
            {
              usedPi: true,
              live: false,
              produce,
              produceKind: "skill-tools",
              skills: skillPaths,
              skillsAs: skillsExecutionMode(brain.timedEvents),
              skillStack: mergeSkillStackEvidence(brain.timedEvents, project.rootDir),
              ...traceIdentity(),
              assistantPreview: previewAssistant(collected),
            },
            brain.timedEvents,
          );
          return;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const classified = classifyPiFailure(reason);
          lastReason = classified.message === summarizePiError(reason) ? classified.message : reason;
          lastFailure = classified.kind === "unknown" ? lastFailure : classified;
          lastStderr = session?.getStderr() ?? lastStderr;
          appendTrace(brain, [`error:${candidate ?? "pi"}`]);
          if (shouldSwitchPiModel(classified) && i < models.length - 1) {
            lastReason = classified.message;
            continue;
          }
          brain.usedPi = false;
          brain.fallbackReason = lastReason;
          writeTrace(
            project.rootDir,
            {
              usedPi: false,
              fallback,
              skills: skillPaths,
              skillsAs: skillsExecutionMode(brain.timedEvents),
              skillStack: skillStackEvidence(brain.timedEvents),
              ...traceIdentity(),
              error: lastReason.slice(0, 800),
              stderr: lastStderr.slice(-800),
              assistantPreview: previewAssistant(collected),
            },
            brain.timedEvents,
          );
          if (collected.length) writeAssistantPreview(project.rootDir, collected);
          const interrupted = inspectRunLedger(project.rootDir);
          if (strictExecution && interrupted.initialized && !interrupted.composed) {
            failClosed(lastReason, classified);
            return;
          }
          if (classified.kind === "rate_limit") {
            failClosed(classified.message, classified);
            return;
          }
          if (!fallback) throw err;
          apply(deterministicDeck(brief, playbook.designSystemId, undefined, playbook.categoryId));
          return;
        } finally {
          unsubscribe?.();
          if (session) await session.stop().catch(() => undefined);
        }
      }

      failClosed(lastFailure?.message ?? lastReason, lastFailure);
    },
    async run(hooks) {
      const step: ToolStep = {
        tool: "compose_deck",
        label: "Pi · Skill",
        status: "running",
        summary: "open-slidestudio + open-kimi-ppt",
      };
      hooks.emit(step);
      try {
        await brain.compose(hooks.brief, hooks.project);
        if (brain.pause) {
          step.status = "failed";
          step.summary = formatPauseMessage(brain.pause.kind);
          step.detail = brain.pause.reason;
          hooks.emitUpdate(step);
          return;
        }
        step.status = "completed";
        step.summary = brain.usedPi ? `pi-rpc · skill` : `fallback · ${brain.fallbackReason ?? ""}`;
        step.detail = opts.onRuntimeEvent ? "" : brain.eventTrace.join("\n");
        if (hooks.streamDetail && step.detail) {
          await hooks.streamDetail(step.detail, (partial) => {
            step.status = "running";
            step.detail = partial;
            hooks.emitUpdate(step);
          });
          step.status = "completed";
          step.detail = brain.eventTrace.join("\n");
        }
        hooks.emitUpdate(step);
      } catch (err) {
        step.status = "failed";
        step.summary = err instanceof Error ? err.message : String(err);
        hooks.emitUpdate(step);
        throw err;
      }
    },
  };
  return brain;
}
