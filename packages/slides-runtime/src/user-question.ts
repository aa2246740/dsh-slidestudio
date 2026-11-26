/**
 * Optional built-in `ask_user_question` suspension tool. The question is
 * persisted to `<projectRoot>/_agent/assistant-questions.v1.json` (the same
 * row shape the DSH host writes), the tool call then waits for an external
 * `answer` / `cancel` or the run's AbortSignal, and the pi-agent-core loop
 * resumes in place with the answer as the tool result. Interactive hosts
 * enable it; headless and MCP hosts leave it off.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export const ASK_USER_QUESTION_TOOL = "ask_user_question";
export const ASSISTANT_QUESTIONS_REL = path.join("_agent", "assistant-questions.v1.json");
const MAX_CUSTOM_ANSWER = 8000;

export type QuestionOption = { readonly label: string; readonly description?: string };
export type QuestionItem = {
  readonly id: string;
  readonly question: string;
  readonly detail?: string;
  readonly header?: string;
  readonly options?: readonly QuestionOption[];
  readonly multiSelect?: boolean;
};
export type QuestionAnswerItem = { readonly id: string; readonly selected: string[]; readonly custom?: string };
export type QuestionAnswer = { readonly answers: QuestionAnswerItem[] };

export type AssistantQuestionRow = {
  readonly id: string;
  readonly at: string;
  readonly questions: QuestionItem[];
  readonly status: "pending" | "answered" | "cancelled" | "interrupted";
  readonly answer?: QuestionAnswer;
  readonly answeredAt?: string;
  readonly callId?: string;
};

export type UserQuestionErrorCode = "ASK_ABORTED" | "ASK_CANCELLED" | "ASK_INVALID";

export class UserQuestionError extends Error {
  constructor(
    message: string,
    readonly code: UserQuestionErrorCode,
  ) {
    super(message);
    this.name = "UserQuestionError";
  }
}

function invalid(message: string): never {
  throw new UserQuestionError(message, "ASK_INVALID");
}

function answerItemFor(question: QuestionItem, received: readonly unknown[], seen: Set<string>): QuestionAnswerItem {
  const item = received.find(
    (value) => value && typeof value === "object" && (value as { id?: unknown }).id === question.id,
  ) as Record<string, unknown> | undefined;
  const selectedRaw = item?.selected;
  if (
    !item ||
    seen.has(question.id) ||
    !Array.isArray(selectedRaw) ||
    selectedRaw.some((label) => typeof label !== "string")
  ) {
    invalid("回答与当前问题不匹配。");
  }
  seen.add(question.id);
  const selected = selectedRaw as string[];
  const offered = (label: string) => question.options?.some((option) => option.label === label) ?? false;
  if (new Set(selected).size !== selected.length || selected.some((label) => !offered(label))) {
    invalid("请选择当前问题提供的选项。");
  }
  const custom = typeof item.custom === "string" ? item.custom.trim() : "";
  const singleViolation = !question.multiSelect && (selected.length > 1 || (selected.length > 0 && custom !== ""));
  if (custom.length > MAX_CUSTOM_ANSWER || (!selected.length && !custom) || singleViolation) {
    invalid("请提供一个有效回答。");
  }
  return { id: question.id, selected, ...(custom ? { custom } : {}) };
}

/** Validate an answer against its questions (same rules as the DSH host). */
export function validateQuestionAnswer(questions: readonly QuestionItem[], value: unknown): QuestionAnswer {
  const received = value && typeof value === "object" ? (value as { answers?: unknown }).answers : undefined;
  if (!Array.isArray(received) || received.length !== questions.length) invalid("请回答所有问题后再继续。");
  const seen = new Set<string>();
  return { answers: questions.map((question) => answerItemFor(question, received, seen)) };
}

type Waiter = { finish(answer?: QuestionAnswer, error?: Error, force?: boolean): void };

export type QuestionWriteGate = (projectRoot: string, write: () => void) => boolean;

/** Durable question rows plus the live waiters of one runtime session. */
export class QuestionBroker {
  private readonly waiters = new Map<string, Waiter>();
  private memory: AssistantQuestionRow[] = [];

  constructor(
    private readonly rootFor: () => string | undefined,
    private readonly writeGate?: QuestionWriteGate,
  ) {}

  private file(): string | undefined {
    const root = this.rootFor();
    return root ? path.join(root, ASSISTANT_QUESTIONS_REL) : undefined;
  }

  private readRows(): AssistantQuestionRow[] {
    const file = this.file();
    if (!file) return this.memory;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as AssistantQuestionRow[]) : [];
    } catch {
      return [];
    }
  }

  private writeRows(rows: AssistantQuestionRow[]): void {
    const root = this.rootFor();
    const file = root ? path.join(root, ASSISTANT_QUESTIONS_REL) : undefined;
    if (!file || !root) {
      this.memory = rows;
      return;
    }
    const commit = () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(rows, null, 2));
      fs.renameSync(temp, file);
    };
    if (!this.writeGate) {
      commit();
      return;
    }
    if (!this.writeGate(root, commit)) {
      throw new UserQuestionError("writer lease is not held; cannot persist question state", "ASK_ABORTED");
    }
  }

  /** Rows as presented; a persisted pending row without a live waiter reads as interrupted. */
  list(): AssistantQuestionRow[] {
    return this.readRows().map((row) =>
      row.status === "pending" && !this.waiters.has(row.id) ? { ...row, status: "interrupted" } : row,
    );
  }

  get pendingCount(): number {
    return this.waiters.size;
  }

  /** Read-only check of stale pending rows left on disk without a live waiter. */
  stalePendingIds(): string[] {
    return this.readRows()
      .filter((row) => row.status === "pending" && !this.waiters.has(row.id))
      .map((row) => row.id);
  }

  /** Persist stale pending rows (left by a crash or restart) as interrupted. Returns their ids. */
  markInterrupted(): string[] {
    const rows = this.readRows();
    const stale = rows.filter((row) => row.status === "pending" && !this.waiters.has(row.id)).map((row) => row.id);
    if (stale.length) {
      this.writeRows(rows.map((row) => (stale.includes(row.id) ? { ...row, status: "interrupted" } : row)));
    }
    return stale;
  }

  ask(
    questions: readonly QuestionItem[],
    options: { signal?: AbortSignal; callId?: string } = {},
  ): Promise<QuestionAnswer> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(new UserQuestionError("Question aborted", "ASK_ABORTED"));
    const row: AssistantQuestionRow = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      questions: structuredClone([...questions]),
      status: "pending",
      ...(options.callId ? { callId: options.callId } : {}),
    };
    return new Promise((resolve, reject) => {
      const onAbort = () => finish(undefined, new UserQuestionError("Question aborted", "ASK_ABORTED"), true);
      const finish = (answer?: QuestionAnswer, error?: Error, force = false) => {
        if (!this.waiters.has(row.id)) return;
        try {
          this.settleRow(row.id, answer);
        } catch (failure) {
          // Never acknowledge an answer that was not durably saved; keep waiting.
          if (!force) throw failure;
          error = failure instanceof Error ? failure : new Error(String(failure));
        }
        this.waiters.delete(row.id);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else if (answer) resolve(answer);
      };
      this.waiters.set(row.id, { finish });
      try {
        this.writeRows([...this.readRows(), row]);
      } catch (error) {
        this.waiters.delete(row.id);
        reject(error);
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private settleRow(id: string, answer: QuestionAnswer | undefined): void {
    const at = new Date().toISOString();
    this.writeRows(
      this.readRows().map((item) =>
        item.id === id
          ? { ...item, status: answer ? "answered" : "cancelled", ...(answer ? { answer, answeredAt: at } : {}) }
          : item,
      ),
    );
  }

  private live(id: string): { row: AssistantQuestionRow; waiter?: Waiter } {
    const row = this.list().find((item) => item.id === id);
    if (!row) throw new UserQuestionError("这个问题已不存在，请刷新对话。", "ASK_INVALID");
    return { row, waiter: this.waiters.get(id) };
  }

  /** Answer a pending question. Retrying an identical settled answer is a no-op. */
  answer(id: string, value: unknown): void {
    const { row, waiter } = this.live(id);
    const answer = validateQuestionAnswer(row.questions, value);
    if (row.status === "answered" && JSON.stringify(row.answer) === JSON.stringify(answer)) return;
    if (row.status !== "pending" || !waiter)
      throw new UserQuestionError("这个问题已结束，请查看最新对话。", "ASK_INVALID");
    waiter.finish(answer);
  }

  cancel(id: string): void {
    const { row, waiter } = this.live(id);
    if (row.status === "cancelled") return;
    if (row.status !== "pending" || !waiter)
      throw new UserQuestionError("这个问题已结束，请查看最新对话。", "ASK_INVALID");
    waiter.finish(
      undefined,
      new UserQuestionError(
        "The user cancelled this question; do not infer a choice or proceed with dependent changes.",
        "ASK_CANCELLED",
      ),
    );
  }

  dispose(): void {
    for (const waiter of [...this.waiters.values()]) {
      waiter.finish(undefined, new UserQuestionError("Question connection closed", "ASK_ABORTED"), true);
    }
  }
}

const OPTION_SCHEMA = {
  type: "object",
  properties: { label: { type: "string" }, description: { type: "string" } },
  required: ["label"],
};

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          detail: { type: "string" },
          header: { type: "string" },
          options: { type: "array", items: OPTION_SCHEMA },
          multiSelect: { type: "boolean" },
        },
        required: ["id", "question"],
      },
    },
  },
  required: ["questions"],
};

/** The suspension tool bound to one broker. */
export function askUserQuestionTool(broker: QuestionBroker): AgentTool {
  return {
    name: ASK_USER_QUESTION_TOOL,
    label: "Ask the user",
    description:
      "Ask the user one to four structured questions and wait for the answer. Use only when a decision cannot be inferred from the brief or materials.",
    parameters: QUESTION_SCHEMA,
    executionMode: "sequential",
    async execute(toolCallId, params, signal): Promise<AgentToolResult> {
      const questions = (params as { questions: QuestionItem[] }).questions;
      try {
        const answer = await broker.ask(questions, { signal, callId: toolCallId });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...answer }) }], details: undefined };
      } catch (error) {
        if (error instanceof UserQuestionError && error.code === "ASK_CANCELLED") {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: error.code, detail: error.message }) }],
            details: undefined,
            isError: true,
          };
        }
        throw error;
      }
    },
  };
}
