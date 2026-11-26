import fs from "node:fs";
import path from "node:path";
import {
  ASSISTANT_QUESTIONS_REL,
  validateQuestionAnswer,
  type AssistantQuestionRow,
  type QuestionAnswer,
  type QuestionItem,
} from "@open-slidestudio/slides-runtime";

export type AssistantQuestion = AssistantQuestionRow;

/** The live slice of a session runtime's `QuestionBroker` the HTTP bridge needs. */
export type LiveQuestionBroker = {
  list(): AssistantQuestionRow[];
  answer(id: string, value: unknown): void;
  cancel(id: string): void;
};

/**
 * HTTP bridge for the product's single conversation surface. A running session
 * routes through its `SlidesAgentRuntime` question broker (which persists to
 * `_agent/assistant-questions.v1.json`); an idle or reloaded session reads the
 * persisted rows, where a pending row without a live waiter is interrupted.
 */
export class AssistantQuestions {
  constructor(
    private readonly rootFor: (sessionId: string) => string | undefined,
    private readonly brokerFor: (sessionId: string) => LiveQuestionBroker | undefined = () => undefined,
  ) {}

  private file(sessionId: string): string {
    const root = this.rootFor(sessionId);
    if (!root) throw new Error("Unknown slide session");
    return path.join(root, ASSISTANT_QUESTIONS_REL);
  }

  private persisted(sessionId: string): AssistantQuestion[] {
    const file = this.file(sessionId);
    if (!fs.existsSync(file)) return [];
    const rows = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(rows)) return [];
    return (rows as AssistantQuestion[]).map((row) =>
      row.status === "pending" ? { ...row, status: "interrupted" } : row,
    );
  }

  list(sessionId: string): AssistantQuestion[] {
    const broker = this.brokerFor(sessionId);
    if (broker) {
      this.file(sessionId);
      return broker.list();
    }
    return this.persisted(sessionId);
  }

  /** Answer or cancel a question; throws (HTTP 409) when it is gone, settled differently or invalid. */
  settle(sessionId: string, id: string, body: { action?: unknown; answer?: unknown }): void {
    const row = this.list(sessionId).find((item) => item.id === id);
    if (!row) throw new Error("这个问题已不存在，请刷新对话。");
    const answer = body.action === "answer" ? validateAnswer(row.questions, body.answer) : undefined;
    if (!answer && body.action !== "cancel") throw new Error("无效的回答操作");
    // A lost HTTP acknowledgement may be retried, but never changed after settlement.
    if (row.status === "answered" && JSON.stringify(row.answer) === JSON.stringify(answer)) return;
    if (row.status === "cancelled" && body.action === "cancel") return;
    const broker = this.brokerFor(sessionId);
    if (row.status !== "pending" || !broker) throw new Error("这个问题已结束，请查看最新对话。");
    if (answer) broker.answer(id, answer);
    else broker.cancel(id);
  }
}

export function validateAnswer(questions: readonly QuestionItem[], value: unknown): QuestionAnswer {
  return validateQuestionAnswer(questions, value);
}
