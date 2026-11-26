/**
 * Agent brain: intranet LLM runs the generate skill via a tool loop.
 * Missing key / non-transient loop fail → playbook.
 * 429 / busy / timeout after retries → pause + checkpoint, not a fake recipe.
 */
import type { PptdProject } from "@open-slidestudio/pptd-v2";
import { runAgentLoop, type AgentToolTrace } from "./agent-runtime.js";
import { deterministicDeck } from "./compose-ir.js";
import { formatPauseMessage, type AgentCheckpoint, type AgentPause } from "./generate-checkpoint.js";
import type { CapabilityCard } from "./capability-card.js";
import type { ImagePort } from "./image-port.js";
import type { ImageSearchPort } from "./image-search-port.js";
import type { LlmPort } from "./llm-port.js";
import type { PageRasterPort } from "./page-raster.js";
import type { ResearchPort } from "./research-port.js";
import { materializeDeck } from "./materialize.js";
import { applySkillDeck, type SkillDeckInput } from "./skill-pages.js";
import { DEFAULT_CATEGORY, DEFAULT_DESIGN_SYSTEM, loadPlaybook, type PlaybookBundle } from "./playbook.js";
import type { ToolStep } from "./harness-types.js";
import { planFromDeck, thinkAboutBrief, type ReasonBlock } from "./reason.js";

export type AgentBrainOptions = {
  skillRoot?: string;
  designSystemId?: string;
  categoryId?: string;
  llm: LlmPort;
  referenceText?: string;
  research?: ResearchPort;
  image?: ImagePort;
  imageSearch?: ImageSearchPort;
  raster?: PageRasterPort;
  capability?: CapabilityCard;
  resume?: AgentCheckpoint;
};

export type AgentRunHooks = {
  brief: string;
  project: PptdProject;
  emit: (step: ToolStep) => void;
  emitUpdate: (step: ToolStep) => void;
  streamDetail?: (text: string, write: (partial: string) => void) => Promise<void>;
};

export type AgentBrain = {
  kind: "agent";
  playbook: PlaybookBundle;
  readonly usedLlm: boolean;
  fallbackReason?: string;
  traces: AgentToolTrace[];
  pause?: AgentPause;
  think: (brief: string) => ReasonBlock;
  plan: (brief: string) => Promise<ReasonBlock>;
  compose: (brief: string, project: PptdProject) => Promise<void>;
  run: (hooks: AgentRunHooks) => Promise<void>;
};

export function createAgentBrain(opts: AgentBrainOptions): AgentBrain {
  const playbook = loadPlaybook({
    skillRoot: opts.skillRoot,
    designSystemId: opts.designSystemId ?? DEFAULT_DESIGN_SYSTEM,
    categoryId: opts.categoryId ?? DEFAULT_CATEGORY,
  });

  let usedLlm = false;
  let fallbackReason: string | undefined;
  let traces: AgentToolTrace[] = [];
  let pause: AgentPause | undefined;
  let cachedDeck = deterministicDeck("pending", playbook.designSystemId, opts.referenceText, playbook.categoryId);
  let cachedSkill: SkillDeckInput | undefined;

  const apply = (project: PptdProject) => {
    if (cachedSkill) {
      applySkillDeck(project, cachedSkill, playbook.palette);
      return;
    }
    materializeDeck(project, cachedDeck, playbook.palette);
  };

  const loop = async (brief: string, onTrace?: (t: AgentToolTrace) => void | Promise<void>, projectRoot?: string) => {
    const result = await runAgentLoop({
      brief,
      playbook,
      llm: opts.llm,
      referenceText: opts.referenceText,
      research: opts.research,
      image: opts.image,
      imageSearch: opts.imageSearch,
      raster: opts.raster,
      capability: opts.capability,
      projectRoot,
      resume: opts.resume,
      onTrace,
    });
    traces = result.traces;
    fallbackReason = result.fallbackReason;
    if (result.source === "paused") {
      pause = result.pause;
      usedLlm = result.traces.length > 0;
      return result;
    }
    pause = undefined;
    cachedDeck = result.deck;
    cachedSkill = result.skillDeck;
    usedLlm = result.source === "agent";
    return result;
  };

  const brain: AgentBrain = {
    kind: "agent",
    playbook,
    get usedLlm() {
      return usedLlm;
    },
    get fallbackReason() {
      return fallbackReason;
    },
    get traces() {
      return traces;
    },
    get pause() {
      return pause;
    },
    think(brief) {
      return thinkAboutBrief(brief, opts.referenceText);
    },
    async plan(brief) {
      const result = await loop(brief);
      if (result.source === "paused") {
        return {
          summary: "已暂停",
          detail: formatPauseMessage(result.pause.kind),
        };
      }
      return planFromDeck(result.deck);
    },
    async compose(brief, project) {
      if (!usedLlm && !traces.length && !pause) {
        await loop(brief, undefined, project.rootDir);
      }
      if (pause) return;
      apply(project);
    },
    async run(hooks) {
      if (opts.resume?.traces?.length) {
        for (const trace of opts.resume.traces) {
          hooks.emit({
            tool: asToolName(trace.tool),
            label: trace.label,
            status: trace.ok ? "completed" : "failed",
            summary: trace.summary,
            detail: trace.detail,
          });
        }
      }
      const result = await loop(
        hooks.brief,
        async (trace) => {
          const step: ToolStep = {
            tool: asToolName(trace.tool),
            label: trace.label,
            status: "running",
            summary: trace.summary,
          };
          hooks.emit(step);
          if (hooks.streamDetail && trace.detail) {
            await hooks.streamDetail(trace.detail, (partial) => {
              step.status = "running";
              step.detail = partial;
              hooks.emitUpdate(step);
            });
          } else {
            step.detail = trace.detail;
            hooks.emitUpdate(step);
          }
          step.status = trace.ok ? "completed" : "failed";
          step.summary = trace.summary;
          step.detail = trace.detail;
          hooks.emitUpdate(step);
        },
        hooks.project.rootDir,
      );
      if (result.source === "paused") {
        hooks.emit({
          tool: "wait",
          label: "Waiting",
          status: "failed",
          summary: formatPauseMessage(result.pause.kind),
          detail: result.pause.reason,
        });
        return;
      }
      if (!result.traces.some((t) => t.tool === "compose_deck")) {
        const lines = result.deck.pages
          .map((p, i) => `${String(i + 1).padStart(2, "0")}  ${p.role}  ${p.title}`)
          .join("\n");
        const step: ToolStep = {
          tool: "compose_deck",
          label: "Compose Deck",
          status: "completed",
          summary: `${result.deck.pages.length} pages · ${result.source}`,
          detail: lines,
        };
        hooks.emit(step);
      }
      apply(hooks.project);
    },
  };
  return brain;
}

function asToolName(raw: string): ToolStep["tool"] {
  const known: ToolStep["tool"][] = [
    "think",
    "plan",
    "read_file",
    "research",
    "write_todo",
    "compose_deck",
    "generate_image",
    "search_image",
    "write_page",
    "render_page",
    "review_pages",
    "wait",
    "validate",
    "version_snapshot",
    "export_pptx",
  ];
  return known.includes(raw as ToolStep["tool"]) ? (raw as ToolStep["tool"]) : "think";
}
