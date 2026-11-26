/**
 * In-process generate runtime: execute vendored open-kimi SKILL.md step 3.
 * The model writes PPTD pages via compose_deck. role+bullets is a stamped fallback.
 * Production still does not run official iframe / export scripts.
 */
import {
  composeBodyRules,
  deterministicDeck,
  extractReferenceLines,
  finalizeComposeDeck,
  inferDeckIntent,
  intentComposeGuidance,
  isNamedClassroomFact,
  type ComposeDeck,
  type ComposeTodo,
} from "./compose-ir.js";
import {
  type AgentCheckpoint,
  type AgentPause,
  type AgentPauseKind,
  type AgentToolTrace,
} from "./generate-checkpoint.js";
import { classifyLlmFailure, type LlmChatMessage, type LlmPort, type LlmToolCall } from "./llm-port.js";
import type { PlaybookBundle } from "./playbook.js";
import {
  GENERATE_TOOLS,
  executeGenerateToolAsync,
  parseToolArgs,
  researchExecution,
  toolStepMeta,
  type AgentToolState,
  type ToolExecution,
} from "./agent-tools.js";
import { detectCapabilities, formatCapabilityCard, type CapabilityCard } from "./capability-card.js";
import type { ImagePort } from "./image-port.js";
import type { ImageSearchPort } from "./image-search-port.js";
import type { PageRasterPort } from "./page-raster.js";
import { createLocalResearchPort, type ResearchPort } from "./research-port.js";
import { assertSkillDeck, parseSkillDeck, skillToCompose, type SkillDeckInput } from "./skill-pages.js";

export type { AgentCheckpoint, AgentPause, AgentPauseKind, AgentToolTrace };

export type AgentLoopResult =
  | {
      deck: ComposeDeck;
      skillDeck?: SkillDeckInput;
      source: "agent" | "playbook";
      fallbackReason?: string;
      traces: AgentToolTrace[];
    }
  | {
      source: "paused";
      fallbackReason: string;
      traces: AgentToolTrace[];
      pause: AgentPause;
    };

export type AgentLoopOptions = {
  brief: string;
  playbook: PlaybookBundle;
  llm: LlmPort;
  referenceText?: string;
  research?: ResearchPort;
  image?: ImagePort;
  imageSearch?: ImageSearchPort;
  raster?: PageRasterPort;
  capability?: CapabilityCard;
  projectRoot?: string;
  maxTurns?: number;
  resume?: Pick<AgentCheckpoint, "messages" | "traces" | "turnsUsed" | "maxTurns">;
  onTrace?: (trace: AgentToolTrace) => void | Promise<void>;
};

const ALLOWED = new Set(GENERATE_TOOLS.map((t) => t.function.name));

function buildSystemPrompt(
  playbook: PlaybookBundle,
  brief: string,
  referenceText: string | undefined,
  card: CapabilityCard,
): string {
  const refs = extractReferenceLines(referenceText);
  const intent = inferDeckIntent(brief, playbook.categoryId);
  const researchLine = refs.names.length
    ? `Attachments you may quote: ${refs.names.join(", ")}`
    : isNamedClassroomFact(brief)
      ? "No attachments. research() may return classroom_common for 勾股 3-4-5 only. Never fake a source."
      : "No attachments. research() must report a gap — never classroom_common, never a fake source.";
  return [
    "You are the Open SlideStudio HOST executing vendored SKILL.md rules. You are not Kimi Slides and not Codex.",
    formatCapabilityCard(card),
    "",
    "Tools you MAY use (only if the card says the hand exists):",
    "- search_image → only when imageSearch=YES. Writes media/{id} from the search port.",
    "- generate_image → only when imageGenerate=YES, or you accept a labeled 占位. Prefer search first.",
    "- write_page → per-page PPTD produce. compose_deck can still take the full deck.",
    "- render_page → native #slide screenshot. Host also auto-renders after write_page when raster is available. If kind=unavailable, you did not see the page.",
    "- review_pages → structural QA. Not official export_images.py.",
    "Media is not required. A valid deck may be text, shape, table, and chart only.",
    "If you do write elementType:image or background.src, that src must already exist. Empty src is dropped.",
    "If generate_image returns kind=placeholder, it is not a photo — mark 占位 on the page.",
    "You MUST use tools. Write think, todo, and page copy in the same language as the user brief.",
    "Do not mention Kimi trademarks. Do not call export_pptx.py, export_images.py, or any iframe.",
    "Never invent statistics, URLs, customer cases, or institutional citations. After a research gap, numbers need 占位.",
    "",
    `Loaded category: ${playbook.categoryId}`,
    `Loaded design_system: ${playbook.designSystemId}`,
    `Inferred intent: ${intent}`,
    researchLine,
    "",
    "Required order:",
    "1. think — audience, path, what you will not invent. Use the capability card.",
    "2. read_playbook: skill, then pptd, then category",
    "3. read_file when attachments exist",
    "4. research (gap is allowed; do not invent)",
    "5. write_todo. Page count follows the brief and attachments — do not pad a 月报/复盘 to 6, and do not force a classroom 6-page path onto a report. Declare every requested chart, table, and diagram in each item's exhibits list. The host merges page-specific brief requirements and rejects prose substitutes. Headings/tables you skip must be listed in think() — silent clipping is a lie.",
    "6. search_image / generate_image only if the card says YES and you chose a bitmap",
    "7. write_page (host auto-renders #slide if raster is available). Look at the PNG if vision=main-model, then edit. You may also call render_page yourself.",
    "8. compose_deck, then review_pages",
    "",
    ...intentComposeGuidance(intent, brief),
  ].join("\n");
}

function acceptComposePayload(
  raw: unknown,
  todos: ComposeTodo[],
  opts: { minPages?: number; minBullets?: number },
): { deck: ComposeDeck; skillDeck?: SkillDeckInput } {
  const skill = parseSkillDeck(raw);
  if (skill) {
    assertSkillDeck(skill, { minPages: opts.minPages ?? 2 });
    return { deck: skillToCompose(skill), skillDeck: skill };
  }
  return { deck: finalizeComposeDeck(raw, todos, opts) };
}

function parseDeckFromText(
  text: string,
  todos: ComposeTodo[],
  opts: { minPages?: number; minBullets?: number },
): { deck: ComposeDeck; skillDeck?: SkillDeckInput } | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1]!.trim() : trimmed;
  try {
    return acceptComposePayload(JSON.parse(raw) as unknown, todos, opts);
  } catch {
    return undefined;
  }
}

function fallbackDeck(opts: AgentLoopOptions): ComposeDeck {
  return deterministicDeck(opts.brief, opts.playbook.designSystemId, opts.referenceText, opts.playbook.categoryId);
}

async function composeOnceFromJson(
  opts: AgentLoopOptions,
): Promise<{ deck: ComposeDeck; skillDeck?: SkillDeckInput } | { error: string } | undefined> {
  if (!opts.llm.completeJson) return undefined;
  try {
    const raw = await opts.llm.completeJson(
      buildSystemPrompt(opts.playbook, opts.brief, opts.referenceText, opts.capability ?? detectCapabilities()),
      `User brief:\n${opts.brief}\n\nEmit compose_deck JSON now. Prefer pages[].elements PPTD. role+bullets is fallback only.`,
    );
    return acceptComposePayload(raw, [], composeBodyRules(opts.brief, opts.playbook.categoryId));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function composeTrace(deck: ComposeDeck, skillDeck?: SkillDeckInput): ToolExecution {
  return {
    name: "compose_deck",
    ok: true,
    summary: skillDeck ? `${skillDeck.pages.length} 页 PPTD` : `${deck.pages.length} 页 · IR fallback`,
    detail: skillDeck
      ? skillDeck.pages
          .map(
            (p, i) => `${String(i + 1).padStart(2, "0")}  ${p.pageType ?? "page"}  ${p.id}  · ${p.elements.length} el`,
          )
          .join("\n")
      : `role+bullets only — skill did not write PPTD elements.\n${deck.pages
          .map((p, i) => `${String(i + 1).padStart(2, "0")}  ${p.role}  ${p.title}`)
          .join("\n")}`,
    payload: skillDeck ?? deck,
  };
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const traces: AgentToolTrace[] = opts.resume?.traces?.slice() ?? [];
  const push = async (exec: ToolExecution) => {
    const meta = toolStepMeta(exec.name);
    const trace: AgentToolTrace = {
      tool: meta.tool,
      label: meta.label,
      summary: exec.summary,
      detail: exec.detail,
      ok: exec.ok,
    };
    traces.push(trace);
    await opts.onTrace?.(trace);
  };

  const research = opts.research ?? createLocalResearchPort();
  const completeTurn = opts.llm.completeTurn;
  if (!completeTurn) {
    const fromJson = await composeOnceFromJson(opts);
    if (fromJson && "deck" in fromJson) {
      return {
        deck: fromJson.deck,
        skillDeck: fromJson.skillDeck,
        source: "agent",
        traces,
      };
    }
    return {
      deck: fallbackDeck(opts),
      source: "playbook",
      fallbackReason: fromJson && "error" in fromJson ? fromJson.error : "LLM port has no completeTurn",
      traces,
    };
  }

  const capability = opts.capability ?? detectCapabilities();
  const state: AgentToolState = {
    brief: opts.brief,
    playbook: opts.playbook,
    referenceText: opts.referenceText,
    todos: [],
    researchNotes: [],
    writtenPages: [],
    projectRoot: opts.projectRoot,
    image: opts.image,
    imageSearch: opts.imageSearch,
    raster: opts.raster,
  };

  const finishWithoutDeck = async (reason: string): Promise<AgentLoopResult> => {
    const fromJson = await composeOnceFromJson(opts);
    if (fromJson && "deck" in fromJson) {
      await push(composeTrace(fromJson.deck, fromJson.skillDeck));
      return {
        deck: fromJson.deck,
        skillDeck: fromJson.skillDeck,
        source: "agent",
        fallbackReason: reason,
        traces,
      };
    }
    return {
      deck: fallbackDeck(opts),
      source: "playbook",
      fallbackReason: reason,
      traces,
    };
  };

  const messages: LlmChatMessage[] = opts.resume?.messages?.length
    ? opts.resume.messages.slice()
    : [
        {
          role: "system",
          content: buildSystemPrompt(opts.playbook, opts.brief, opts.referenceText, capability),
        },
        {
          role: "user",
          content: `Generate an editable deck for this brief:\n${opts.brief}`,
        },
      ];

  const maxTurns = Math.max(4, Math.min(24, opts.resume?.maxTurns ?? opts.maxTurns ?? 18));
  const startTurn = Math.max(0, opts.resume?.turnsUsed ?? 0);
  let lastError = "";

  const pauseLoop = (err: unknown, turnsUsed: number): AgentLoopResult => {
    const info = classifyLlmFailure(err);
    const kind: AgentPauseKind = info.kind === "client" ? "transient" : info.kind;
    const reason = info.message;
    return {
      source: "paused",
      fallbackReason: reason,
      traces,
      pause: {
        kind,
        reason,
        retryAfterMs: info.retryAfterMs,
        checkpoint: {
          v: 1,
          brief: opts.brief,
          messages,
          traces,
          categoryId: opts.playbook.categoryId,
          designSystemId: opts.playbook.designSystemId,
          turnsUsed,
          maxTurns,
          pausedAt: new Date().toISOString(),
          reason,
          kind,
        },
      },
    };
  };

  try {
    for (let turn = startTurn; turn < maxTurns; turn++) {
      let result;
      try {
        result = await completeTurn(messages, GENERATE_TOOLS);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (classifyLlmFailure(e).retryable) {
          return pauseLoop(e, turn);
        }
        return finishWithoutDeck(lastError);
      }

      if (result.toolCalls.length) {
        messages.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls,
        });
        for (const call of result.toolCalls.slice(0, 6)) {
          const exec = await dispatchCall(call, state, research);
          await push(exec);
          const payload = asToolPayload(exec.payload);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify(payload.forModel),
          });
          if (exec.name === "render_page" && payload.dataUrl && capability.vision.mode === "main-model") {
            messages.push({
              role: "user",
              content: [
                {
                  type: "text",
                  text: "This is the native #slide raster (not official iframe). Edit with write_page if needed. If you cannot see the image, say so and keep structural edits only.",
                },
                { type: "image_url", image_url: { url: payload.dataUrl } },
              ],
            });
          }
          const alreadyRendering = result.toolCalls.some((c) => c.function.name.trim() === "render_page");
          if (exec.name === "write_page" && exec.ok && !alreadyRendering && state.raster?.available) {
            const writtenId =
              exec.payload &&
              typeof exec.payload === "object" &&
              "page" in exec.payload &&
              exec.payload.page &&
              typeof exec.payload.page === "object" &&
              "id" in exec.payload.page &&
              typeof exec.payload.page.id === "string"
                ? exec.payload.page.id
                : undefined;
            const renderExec = await executeGenerateToolAsync(
              "render_page",
              writtenId ? { pageId: writtenId } : {},
              state,
            );
            await push(renderExec);
            const renderPayload = asToolPayload(renderExec.payload);
            if (renderPayload.dataUrl && capability.vision.mode === "main-model") {
              messages.push({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Host auto-rendered the page you just wrote (native #slide, not official iframe). Edit with write_page if needed. If you cannot see the image, say so.",
                  },
                  { type: "image_url", image_url: { url: renderPayload.dataUrl } },
                ],
              });
            } else {
              messages.push({
                role: "user",
                content: `Host auto-rendered: ${renderExec.summary}. ${renderExec.detail}`,
              });
            }
          }
        }
        if (state.deck) {
          return {
            deck: state.deck,
            skillDeck: state.skillDeck,
            source: "agent",
            traces,
          };
        }
        continue;
      }

      const fromText = parseDeckFromText(
        result.content,
        state.todos,
        composeBodyRules(opts.brief, opts.playbook.categoryId),
      );
      if (fromText) {
        state.deck = fromText.deck;
        state.skillDeck = fromText.skillDeck;
        await push(composeTrace(fromText.deck, fromText.skillDeck));
        return {
          deck: fromText.deck,
          skillDeck: fromText.skillDeck,
          source: "agent",
          traces,
        };
      }

      messages.push({
        role: "assistant",
        content: result.content || "",
      });
      messages.push({
        role: "user",
        content:
          "That was not a tool call. Call think, read_playbook, write_todo, then compose_deck. generate_image only if you chose bitmaps.",
      });
      lastError = "model returned text without tools";
    }

    return finishWithoutDeck(lastError || "agent did not call compose_deck");
  } finally {
    await opts.raster?.close?.();
  }
}

function asToolPayload(raw: unknown): {
  forModel: unknown;
  dataUrl?: string;
} {
  if (!raw || typeof raw !== "object") return { forModel: raw };
  const rec = raw as Record<string, unknown>;
  if (typeof rec.dataUrl !== "string") return { forModel: raw };
  const { dataUrl, ...rest } = rec;
  return { forModel: rest, dataUrl };
}

async function dispatchCall(call: LlmToolCall, state: AgentToolState, research: ResearchPort): Promise<ToolExecution> {
  const name = call.function.name.trim();
  if (!ALLOWED.has(name)) {
    return {
      name,
      ok: false,
      summary: "blocked",
      detail: `Tool not allowed: ${name}`,
      payload: { error: `not allowed: ${name}` },
    };
  }
  const args = parseToolArgs(call.function.arguments);
  if (name === "research") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return {
        name,
        ok: false,
        summary: "query required",
        detail: "research.query required",
        payload: { error: "query required" },
      };
    }
    const result = await research.search({
      query,
      brief: state.brief,
      referenceText: state.referenceText,
    });
    state.researchNotes.push(result);
    return researchExecution(result);
  }
  return executeGenerateToolAsync(name, args, state);
}
