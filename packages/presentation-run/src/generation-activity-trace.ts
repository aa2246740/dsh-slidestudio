import fs from "node:fs";
import path from "node:path";
import type { GenerationActivityEvent } from "./generation-activity.js";
import { boundTraceDetail } from "./generation-activity-detail.js";

/**
 * Project the raw produce journals (v2 agent-trace, v1 hands-log) into
 * presentation-safe activity events. Split from generation-activity.ts so the
 * ledger projection and the journal projection stay independently readable.
 */
const HANDS_LOG_REL = path.join("_agent", "hands-log.jsonl");
const AGENT_TRACE_REL = path.join("_agent", "agent-trace.jsonl");

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readJsonl(file: string): unknown[] {
  if (!fs.existsSync(file)) return [];
  const rows: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as unknown);
    } catch {
      /* skip a broken line */
    }
  }
  return rows;
}

function pageIdFromHands(row: Record<string, unknown>): string | undefined {
  const summary = typeof row.summary === "string" ? row.summary : "";
  if (row.name === "write_page" || row.name === "render_page" || row.name === "review_page") {
    const token = summary.split("·")[0]?.trim();
    if (token && !/execution gate/i.test(token)) return token;
  }
  try {
    const args = typeof row.args === "string" ? asRecord(JSON.parse(row.args)) : undefined;
    const id = args?.id ?? args?.pageId;
    if (typeof id === "string" && id.trim()) return id.trim();
  } catch {
    /* truncated args */
  }
  return undefined;
}

type TraceKind = NonNullable<GenerationActivityEvent["kind"]>;
type TraceStatus = GenerationActivityEvent["status"];
type TraceProjection = {
  event: GenerationActivityEvent;
  detailMode: "append" | "replace";
};

function traceKind(value: unknown): TraceKind | undefined {
  if (
    value === "message" ||
    value === "reasoning" ||
    value === "tool" ||
    value === "result" ||
    value === "turn" ||
    value === "think"
  )
    return value;
  return undefined;
}

function traceStatus(row: Record<string, unknown>, kind: TraceKind): TraceStatus {
  const value = row.status;
  if (
    value === "running" ||
    value === "complete" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "needs-attention"
  )
    return value;
  if (kind === "result") return row.ok === false ? "failed" : "complete";
  if (kind === "tool") return "running";
  return "complete";
}

function traceLabel(kind: TraceKind, status: TraceStatus, name?: string): string {
  if (kind === "message") return status === "running" ? "正在输出" : "回复";
  if (kind === "reasoning" || kind === "think") return status === "running" ? "正在思考" : "思考";
  if (kind === "tool") return name ? `调用 ${name}` : "调用工具";
  if (kind === "result") {
    if (status === "failed") return name ? `${name} 失败` : "工具失败";
    if (status === "cancelled") return name ? `${name} 已停止` : "工具已停止";
    return name ? `${name} 完成` : "工具完成";
  }
  if (name === "step") return status === "running" ? "步骤开始" : "步骤结束";
  if (status === "failed") return "本轮失败";
  if (status === "cancelled") return "本轮已停止";
  if (status === "needs-attention") return "本轮需要处理";
  return status === "running" ? "本轮开始" : "本轮完成";
}

function optionalTraceFields(
  row: Record<string, unknown>,
  name: string | undefined,
  callId: string | undefined,
  pageId: string | undefined,
): Partial<GenerationActivityEvent> {
  return {
    ...(typeof row.ok === "boolean" ? { ok: row.ok } : {}),
    ...(row.truncated === true ? { truncated: true } : {}),
    ...(name ? { name } : {}),
    ...(callId ? { callId } : {}),
    ...(pageId ? { pageId } : {}),
    ...(typeof row.turn === "number" ? { turn: row.turn } : {}),
    ...(typeof row.step === "number" ? { step: row.step } : {}),
  };
}

function eventFromTraceRow(row: Record<string, unknown>, index: number): TraceProjection | undefined {
  const rawKind = traceKind(row.kind);
  if (!rawKind) return undefined;
  // The v1 writer labeled ordinary assistant message text as "think". Keep
  // those rows visible without continuing the old claim that it was reasoning.
  const kind: TraceKind = rawKind === "think" ? "message" : rawKind;
  const at = typeof row.at === "string" ? row.at : new Date(0).toISOString();
  const name = typeof row.name === "string" ? row.name : undefined;
  const rawDetail = typeof row.detail === "string" ? row.detail : typeof row.text === "string" ? row.text : "";
  const bounded = boundTraceDetail(rawDetail);
  const pageId = typeof row.pageId === "string" ? row.pageId : undefined;
  const callId = typeof row.callId === "string" ? row.callId : undefined;
  const status = traceStatus(row, rawKind);
  const legacyId = `trace-${rawKind}-${index}-${name ?? callId ?? at}`;
  const id = typeof row.id === "string" && row.id ? row.id : legacyId;
  const event: GenerationActivityEvent = {
    id,
    type: `agent.${kind}`,
    at,
    label: traceLabel(kind, status, name),
    status,
    ...bounded,
    kind,
    ...optionalTraceFields(row, name, callId, pageId),
  };

  return {
    event,
    detailMode: row.detailMode === "append" ? "append" : "replace",
  };
}

/** Fold append-only v2 deltas/snapshots, while still accepting v1 trace rows. */
export function generationActivityEventsFromTraceRows(rows: readonly unknown[]): GenerationActivityEvent[] {
  const events: GenerationActivityEvent[] = [];
  const positions = new Map<string, number>();

  const settleRunning = (matches: (event: GenerationActivityEvent) => boolean, status: TraceStatus): void => {
    events.forEach((event, index) => {
      if (event.status !== "running" || !matches(event)) return;
      const kind = event.kind;
      if (!kind || kind === "ledger") return;
      events[index] = {
        ...event,
        status,
        label: traceLabel(kind, status, event.name),
      };
    });
  };

  rows.forEach((value, index) => {
    const projected = eventFromTraceRow(asRecord(value) ?? {}, index);
    if (!projected) return;
    let priorIndex = positions.get(projected.event.id);

    // Some providers use different content indexes for streamed chunks and
    // the terminal assistant/message snapshot. Reconcile only when the
    // turn/step/kind identifies one unambiguous running block.
    if (
      priorIndex === undefined &&
      projected.detailMode === "replace" &&
      (projected.event.kind === "message" || projected.event.kind === "reasoning") &&
      projected.event.status !== "running"
    ) {
      const candidates: number[] = [];
      events.forEach((event, eventIndex) => {
        if (
          event.status === "running" &&
          event.kind === projected.event.kind &&
          event.turn === projected.event.turn &&
          event.step === projected.event.step
        ) {
          candidates.push(eventIndex);
        }
      });
      if (candidates.length === 1) priorIndex = candidates[0];
    }
    const __split6929 = () => {
      if (priorIndex === undefined) {
        positions.set(projected.event.id, events.length);
        events.push(projected.event);
      } else {
        const prior = events[priorIndex]!;
        const combined =
          projected.detailMode === "append"
            ? boundTraceDetail(`${prior.detail ?? ""}${projected.event.detail ?? ""}`)
            : { detail: projected.event.detail, truncated: projected.event.truncated };
        events[priorIndex] = {
          ...prior,
          ...projected.event,
          ...(projected.event.ok === undefined ? { ok: undefined } : {}),
          id: prior.id,
          at: prior.at,
          ...(combined.detail === undefined ? { detail: undefined } : { detail: combined.detail }),
          ...(prior.truncated || combined.truncated || projected.event.truncated
            ? { truncated: true }
            : { truncated: undefined }),
        };
        // A reconciled snapshot keeps the first stable id canonical while also
        // accepting any later row that uses the terminal snapshot id.
        positions.set(projected.event.id, priorIndex);
      }
    };
    __split6929();

    const lifecycle = projected.event;
    if (lifecycle.kind !== "turn" || lifecycle.status === "running") return;
    if (lifecycle.name === "step" && lifecycle.turn !== undefined && lifecycle.step !== undefined) {
      settleRunning(
        (event) => event.kind !== "turn" && event.turn === lifecycle.turn && event.step === lifecycle.step,
        lifecycle.status,
      );
      return;
    }
    if (lifecycle.name === "turn" && lifecycle.turn !== undefined) {
      settleRunning((event) => event.kind !== "turn" && event.turn === lifecycle.turn, lifecycle.status);
    }
  });
  return events;
}

function eventFromHandsRow(row: Record<string, unknown>, index: number): GenerationActivityEvent | undefined {
  const name = typeof row.name === "string" ? row.name : "";
  if (!name) return undefined;
  if (name === "render_page") return undefined;
  const at = typeof row.at === "string" ? row.at : new Date(0).toISOString();
  const ok = row.ok !== false;
  const summary = typeof row.summary === "string" ? row.summary : "";
  const detail = typeof row.detail === "string" ? row.detail : summary;
  const bounded = boundTraceDetail(detail || summary);
  return {
    id: `hands-${index}-${name}-${at}`,
    type: `tool.${name}`,
    at,
    label: ok ? `调用 ${name}` : `${name} 失败`,
    status: ok ? "complete" : "needs-attention",
    ...bounded,
    ...(typeof row.ok === "boolean" ? { ok: row.ok } : {}),
    kind: "tool",
    name,
    pageId: pageIdFromHands(row),
  };
}

/** Hands-log + session trace, so 生成历程 shows thinking and tool calls, not only ledger labels. */
export function readProduceTraceEvents(root: string): GenerationActivityEvent[] {
  const trace = generationActivityEventsFromTraceRows(readJsonl(path.join(root, AGENT_TRACE_REL)));
  if (trace.length) return trace;
  return readJsonl(path.join(root, HANDS_LOG_REL))
    .map((row, index) => eventFromHandsRow(asRecord(row) ?? {}, index))
    .filter((row): row is GenerationActivityEvent => Boolean(row));
}
