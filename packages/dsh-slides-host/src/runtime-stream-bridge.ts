/**
 * Live SSE projection of `SlidesAgentRuntime` events. Real model deltas
 * (pi-agent-core `message_update` text/thinking deltas) become idempotent,
 * short-interval text snapshots keyed by the same row ids the runtime's
 * durable trace writes (`assistant:<turn>:<step>:<block>:<kind>`), so the
 * committed snapshot replaces the streaming row in the editor live panel.
 * Tool, result and turn rows are published as the runtime commits them.
 */
import {
  AGENT_TRACE_DETAIL_MAX,
  assistantRows,
  resultRow,
  toolRow,
  turnEndReason,
  turnRow,
  type RuntimeEvent,
  type RuntimeTurnResult,
} from "@open-slidestudio/slides-runtime";
import { applyTraceTruthGuard } from "@open-slidestudio/slides-tools";
import { publicAssistantDetail, type AgentTraceRow } from "./agent-trace.js";

type AgentEvent = Extract<RuntimeEvent, { type: "agent" }>["event"];

type LiveTurn = {
  readonly turn: number;
  step: number;
  attemptId: string;
  revision: number;
  readonly rows: Map<string, AgentTraceRow>;
  readonly texts: Map<string, string>;
  readonly dirty: Set<string>;
};

type AssistantDelta = {
  readonly type: string;
  readonly contentIndex?: number;
  readonly delta?: string;
  readonly content?: string;
};

const DELTA_TYPES = new Set(["text_delta", "thinking_delta", "text_end", "thinking_end"]);

export type LivePublisher = (sessionId: string, rows: readonly AgentTraceRow[]) => void;

export class RuntimeStreamBridge {
  private readonly turns = new Map<string, LiveTurn>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly publish: LivePublisher,
    private readonly rootFor: (sessionId: string) => string | undefined = () => undefined,
    private readonly flushMs = 40,
  ) {}

  observe(sessionId: string, event: RuntimeEvent): void {
    if (event.type === "turn/start") this.onTurnStart(sessionId, event.turn);
    else if (event.type === "turn/end") this.onTurnEnd(sessionId, event.result);
    else if (event.type === "agent") this.onAgent(sessionId, event.event);
  }

  private onTurnStart(sessionId: string, turn: number): void {
    this.closeStreaming(sessionId, "cancelled");
    this.turns.set(sessionId, {
      turn,
      step: 0,
      attemptId: "",
      revision: 0,
      rows: new Map(),
      texts: new Map(),
      dirty: new Set(),
    });
    this.publish(sessionId, [turnRow({ turn })]);
  }

  private onTurnEnd(sessionId: string, result: RuntimeTurnResult): void {
    this.closeStreaming(sessionId, "cancelled");
    this.turns.delete(sessionId);
    this.publish(sessionId, [turnRow({ turn: result.turn }, turnEndReason(result))]);
  }

  private onAgent(sessionId: string, event: AgentEvent): void {
    const live = this.turns.get(sessionId);
    if (!live) return;
    const stamp = { turn: live.turn, step: live.step };
    switch (event.type) {
      case "turn_start":
        this.closeStreaming(sessionId, "cancelled", false);
        live.step += 1;
        live.attemptId = `${sessionId}:${live.turn}:${live.step}`;
        live.revision = 0;
        return;
      case "message_update":
        this.onDelta(live, event.assistantMessageEvent as AssistantDelta);
        return;
      case "message_end":
        if ((event.message as { role?: unknown }).role === "assistant") {
          this.settle(sessionId, assistantRows(stamp, event.message));
        }
        return;
      case "tool_execution_start":
        this.settle(sessionId, [toolRow(stamp, event.toolCallId, event.toolName, event.args)]);
        return;
      case "tool_execution_end":
        this.settle(sessionId, [
          resultRow(
            stamp,
            event.toolCallId,
            (event.result as { content?: unknown } | undefined)?.content,
            event.isError,
          ),
        ]);
        return;
      default:
        return;
    }
  }

  private onDelta(live: LiveTurn, event: AssistantDelta): void {
    if (!DELTA_TYPES.has(event.type)) return;
    const streaming = event.type.endsWith("_delta");
    const kind = event.type.startsWith("thinking") ? "reasoning" : "message";
    const index = event.contentIndex ?? 0;
    const id = `assistant:${live.turn}:${live.step}:${index}:${kind}`;
    const text = streaming ? `${live.texts.get(id) ?? ""}${event.delta ?? ""}` : (event.content ?? "");
    live.texts.set(id, text);
    live.revision += 1;
    const prior = live.rows.get(id);
    live.rows.set(id, {
      id,
      at: prior?.at ?? new Date().toISOString(),
      turn: live.turn,
      step: live.step,
      kind,
      status: streaming ? "running" : "complete",
      detailMode: "replace",
      ...publicAssistantDetail(text),
      stream: { attemptId: live.attemptId, revision: live.revision, index },
    });
    live.dirty.add(id);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** Committed rows win over live text and cannot be followed by delayed deltas. */
  settle(sessionId: string, rows: readonly AgentTraceRow[]): void {
    if (!rows.length) return;
    this.flush(sessionId);
    const root = this.rootFor(sessionId);
    const guarded = root ? (applyTraceTruthGuard(root, rows, AGENT_TRACE_DETAIL_MAX) as AgentTraceRow[]) : rows;
    const live = this.turns.get(sessionId);
    const settled = guarded.map((row) => {
      const prior = live?.rows.get(row.id);
      if (!live || !prior) return row;
      const merged = {
        ...prior,
        ...row,
        id: prior.id,
        at: prior.at,
        ...(prior.stream ? { stream: prior.stream } : {}),
      };
      live.rows.set(row.id, merged);
      live.dirty.delete(row.id);
      return merged;
    });
    this.publish(sessionId, settled);
  }

  flush(sessionId?: string): void {
    for (const [id, live] of this.turns) {
      if (sessionId && sessionId !== id) continue;
      const rows = [...live.dirty].map((key) => live.rows.get(key)).filter((row): row is AgentTraceRow => !!row);
      live.dirty.clear();
      if (rows.length) this.publish(id, rows);
    }
  }

  disposeSession(sessionId: string): void {
    this.closeStreaming(sessionId, "cancelled");
    this.turns.delete(sessionId);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const id of [...this.turns.keys()]) this.disposeSession(id);
  }

  private closeStreaming(sessionId: string, status: "complete" | "cancelled", publish = true): void {
    const live = this.turns.get(sessionId);
    if (!live) return;
    for (const [id, row] of live.rows) {
      if (row.status !== "running") continue;
      live.rows.set(id, { ...row, status, detailMode: "replace" });
      live.dirty.add(id);
    }
    if (publish || live.dirty.size) this.flush(sessionId);
  }
}
