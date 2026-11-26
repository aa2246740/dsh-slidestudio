/**
 * Append-only runtime session log at `<projectRoot>/_agent/runtime-session.v1.jsonl`.
 * Records are buffered until a project root is attached. Loading tolerates a
 * crash-truncated final line, closes a turn left open by a crash as
 * `interrupted`, and repairs the transcript (dangling tool calls get an
 * interrupted tool result, empty failed assistant replies are dropped) so the
 * run can resume.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { redactText, redactValue, scrubRegisteredSecrets } from "./redact.js";

export type SessionWriteGate = (projectRoot: string, write: () => void) => boolean;

export const RUNTIME_SESSION_REL = path.join("_agent", "runtime-session.v1.jsonl");
export const INTERRUPTED_TOOL_RESULT =
  "Tool call interrupted by a host restart before it returned; re-check durable state.";
const IMAGE_PLACEHOLDER = "[image omitted from the runtime session log]";

export type TurnEndReason =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted"; readonly reason?: { readonly kind: string; readonly reason?: string } }
  | { readonly kind: "error"; readonly error: { readonly code: string; readonly message: string } }
  | { readonly kind: "max-tokens" }
  | { readonly kind: "interrupted" };

type RecordBody =
  | { readonly type: "session/start"; readonly sessionId: string }
  | { readonly type: "turn/start"; readonly turn: number }
  | { readonly type: "message"; readonly turn: number; readonly message: AgentMessage }
  | { readonly type: "turn/end"; readonly turn: number; readonly reason: TurnEndReason }
  | { readonly type: "fault"; readonly turn: number; readonly code: string; readonly detail: string };

export type SessionRecord = RecordBody & { readonly v: 1; readonly seq: number; readonly at: string };

export type RecoveredSession = {
  readonly records: readonly SessionRecord[];
  readonly messages: AgentMessage[];
  readonly lastTurn: number;
  /** Turn that had `turn/start` but no `turn/end` (closed as interrupted during recovery). */
  readonly interruptedTurn?: number;
  readonly corruptLines: number;
  readonly truncatedTail: boolean;
};

function stripImages(message: AgentMessage): AgentMessage {
  const content = (message as unknown as { content?: unknown }).content;
  if (!Array.isArray(content) || !content.some((block) => (block as { type?: unknown }).type === "image")) {
    return message;
  }
  return {
    ...message,
    content: content.map((block) =>
      (block as { type?: unknown }).type === "image" ? { type: "text", text: IMAGE_PLACEHOLDER } : block,
    ),
  } as AgentMessage;
}

function parseLines(text: string): { records: SessionRecord[]; corrupt: number; truncatedTail: boolean } {
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  const records: SessionRecord[] = [];
  let corrupt = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as SessionRecord);
    } catch {
      corrupt += 1;
    }
  }
  let truncatedTail = false;
  if (tail.trim()) {
    try {
      records.push(JSON.parse(tail) as SessionRecord);
    } catch {
      truncatedTail = true;
    }
  }
  return { records, corrupt, truncatedTail };
}

type Block = { type?: unknown; id?: unknown; name?: unknown };

function isEmptyFailure(message: AgentMessage): boolean {
  const record = message as unknown as { role?: unknown; stopReason?: unknown; content?: unknown };
  if (record.role !== "assistant") return false;
  const failed = record.stopReason === "error" || record.stopReason === "aborted";
  return failed && (!Array.isArray(record.content) || record.content.length === 0);
}

/** Repair a transcript so pi-agent-core can continue it after a crash. */
export function repairTranscript(messages: readonly AgentMessage[], now = Date.now()): AgentMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    const record = message as unknown as { role?: unknown; toolCallId?: unknown };
    if (record.role === "toolResult") answered.add(String(record.toolCallId));
  }
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (isEmptyFailure(message)) continue;
    out.push(message);
    const record = message as unknown as { role?: unknown; content?: unknown };
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    for (const block of record.content as Block[]) {
      if (block.type !== "toolCall" || answered.has(String(block.id))) continue;
      answered.add(String(block.id));
      out.push({
        role: "toolResult",
        toolCallId: String(block.id),
        toolName: String(block.name),
        content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
        isError: true,
        timestamp: now,
      } as AgentMessage);
    }
  }
  return out;
}

function scrubPlainNode(
  value: unknown,
  ancestors: Set<object>,
  cache: WeakMap<object, unknown>,
): { value: unknown; cyclic: boolean } {
  if (typeof value === "string") return { value: scrubRegisteredSecrets(value), cyclic: false };
  if (value === null || typeof value !== "object") return { value, cyclic: false };
  if (ancestors.has(value)) return { value: "[circular]", cyclic: true };
  if (cache.has(value)) return { value: cache.get(value), cyclic: false };
  ancestors.add(value);
  let cyclic = false;
  try {
    if (Array.isArray(value)) {
      const out = value.map((item) => {
        const child = scrubPlainNode(item, ancestors, cache);
        if (child.cyclic) cyclic = true;
        return child.value;
      });
      if (!cyclic) cache.set(value, out);
      return { value: out, cyclic };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = scrubPlainNode(v, ancestors, cache);
      if (child.cyclic) cyclic = true;
      out[k] = child.value;
    }
    if (!cyclic) cache.set(value, out);
    return { value: out, cyclic };
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeDiagnostic(row: unknown, ancestors: Set<object>, cache: WeakMap<object, unknown>): unknown {
  if (!row || typeof row !== "object") return redactValue(row, undefined, ancestors);
  const type = (row as { type?: unknown }).type;
  if (type === "slides-runtime/dsh-replay-state") return scrubPlainNode(row, ancestors, cache).value;
  return redactValue(row, undefined, ancestors);
}

function sanitizeMessage(message: AgentMessage): AgentMessage {
  const ancestors = new Set<object>([message as unknown as object]);
  const cache = new WeakMap<object, unknown>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(message as unknown as Record<string, unknown>)) {
    if (k === "errorMessage" && typeof v === "string") out[k] = redactText(v);
    else if (k === "diagnostics" && Array.isArray(v)) {
      ancestors.add(v);
      try {
        out[k] = v.map((row) => sanitizeDiagnostic(row, ancestors, cache));
      } finally {
        ancestors.delete(v);
      }
    } else {
      out[k] = scrubPlainNode(v, ancestors, cache).value;
    }
  }
  return out as unknown as AgentMessage;
}

function sanitizeRecordBody(body: RecordBody, persistImages: boolean): RecordBody {
  if (body.type === "fault") {
    return { ...body, detail: redactText(body.detail) };
  }
  if (body.type === "turn/end" && body.reason.kind === "error") {
    return {
      ...body,
      reason: { kind: "error", error: { ...body.reason.error, message: redactText(body.reason.error.message) } },
    };
  }
  if (body.type !== "message") return body;
  const cleaned = persistImages ? body.message : stripImages(body.message);
  return { ...body, message: sanitizeMessage(cleaned) };
}

export class RuntimeSessionStore {
  private root?: string;
  private file?: string;
  private seq = 0;
  private readonly pending: SessionRecord[] = [];

  constructor(
    private readonly options: { readonly persistImages?: boolean; readonly writeGate?: SessionWriteGate } = {},
  ) {}

  get attachedFile(): string | undefined {
    return this.file;
  }

  private writeGated(projectRoot: string, write: () => void): boolean {
    if (!this.options.writeGate) {
      write();
      return true;
    }
    return this.options.writeGate(projectRoot, write);
  }

  get currentSeq(): number {
    return this.seq;
  }

  /** Bind (or re-sync after lease handoff) the log to `projectRoot` and flush buffered records. */
  attach(projectRoot: string): boolean {
    const file = path.join(projectRoot, RUNTIME_SESSION_REL);
    return this.writeGated(projectRoot, () => {
      this.root = projectRoot;
      this.file = file;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size > 0) {
        const last = Buffer.alloc(1);
        const fd = fs.openSync(file, "r");
        try {
          fs.readSync(fd, last, 0, 1, size - 1);
        } finally {
          fs.closeSync(fd);
        }
        // Start after a crash-truncated tail on a fresh line.
        if (last.toString("utf8") !== "\n") fs.appendFileSync(file, "\n");
        const diskSeq = RuntimeSessionStore.read(projectRoot).records.reduce(
          (max, record) => (typeof record.seq === "number" && record.seq > max ? record.seq : max),
          0,
        );
        this.seq = Math.max(this.seq, diskSeq);
      }
      const buffered = this.pending.splice(0).map((record) => ({ ...record, seq: ++this.seq }));
      if (buffered.length) fs.appendFileSync(file, buffered.map((record) => `${JSON.stringify(record)}\n`).join(""));
    });
  }

  append(body: RecordBody): boolean {
    const prepared = sanitizeRecordBody(body, this.options.persistImages === true);
    if (!this.file || !this.root) {
      const record = { v: 1, seq: 0, at: new Date().toISOString(), ...prepared } as SessionRecord;
      this.pending.push(record);
      return true;
    }
    const file = this.file;
    return this.writeGated(this.root, () => {
      const record = { v: 1, seq: ++this.seq, at: new Date().toISOString(), ...prepared } as SessionRecord;
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    });
  }

  /** Parse a session log without modifying it. */
  static read(projectRoot: string): { records: SessionRecord[]; corrupt: number; truncatedTail: boolean } {
    const file = path.join(projectRoot, RUNTIME_SESSION_REL);
    if (!fs.existsSync(file)) return { records: [], corrupt: 0, truncatedTail: false };
    return parseLines(fs.readFileSync(file, "utf8"));
  }

  /** Read-only inspection for crash recovery: repairs the in-memory transcript without writing to disk. */
  inspect(projectRoot: string): RecoveredSession {
    const { records, corrupt, truncatedTail } = RuntimeSessionStore.read(projectRoot);
    let open: number | undefined;
    let lastTurn = 0;
    const messages: AgentMessage[] = [];
    for (const record of records) {
      if (record.type === "turn/start") {
        open = record.turn;
        lastTurn = Math.max(lastTurn, record.turn);
      } else if (record.type === "turn/end" && record.turn === open) {
        open = undefined;
      } else if (record.type === "message") {
        messages.push(record.message);
      }
    }
    return {
      records,
      messages: repairTranscript(messages),
      lastTurn,
      ...(open !== undefined ? { interruptedTurn: open } : {}),
      corruptLines: corrupt,
      truncatedTail,
    };
  }

  /**
   * Load and recover a session: an unclosed turn is closed as interrupted
   * (appended to the log), and the transcript is repaired for continuation.
   */
  recover(projectRoot: string): RecoveredSession {
    const inspected = this.inspect(projectRoot);
    if (this.attach(projectRoot) && inspected.interruptedTurn !== undefined) {
      this.append({ type: "turn/end", turn: inspected.interruptedTurn, reason: { kind: "interrupted" } });
    }
    return inspected;
  }
}
