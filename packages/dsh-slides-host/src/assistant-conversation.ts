import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { publicAssistantDetail } from "./agent-trace.js";

export type AssistantMode = "discuss" | "edit" | "generate";
export type ConversationMessage = {
  id: string;
  at: string;
  text: string;
  mode: AssistantMode;
  reviewSubmissionId?: string;
  clientRequestId?: string;
};
export type Conversation = { version: 1; mode: AssistantMode; messages: ConversationMessage[] };
const FILE = "assistant-conversation.v1.json";
export const DISCUSSION_TOOLS: ReadonlySet<string> = new Set([
  "inspect_capabilities",
  "list_references",
  "read_reference",
  "read_page",
  "ask_user_question",
  "list_materials",
  "read_material",
  "query_material",
]);

export function readConversation(root: string): Conversation {
  const file = path.join(root, "_agent", FILE);
  if (!fs.existsSync(file)) return { version: 1, mode: "generate", messages: [] };
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Conversation;
  if (value.version !== 1 || !["discuss", "edit", "generate"].includes(value.mode) || !Array.isArray(value.messages)) {
    throw new Error("Invalid assistant conversation record");
  }
  return value;
}

/** The disk policy survives a Host restart; a read failure must never enable writes. */
export function discussionOnly(root: string): boolean {
  return readConversation(root).mode === "discuss";
}

export function recordConversationMessage(
  root: string,
  text: string,
  mode: AssistantMode,
  reviewSubmissionId?: string,
  clientRequestId?: string,
): ConversationMessage {
  const current = readConversation(root);
  const message = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    text: publicAssistantDetail(text).detail || "",
    mode,
    ...(reviewSubmissionId ? { reviewSubmissionId } : {}),
    ...(clientRequestId && /^[a-f0-9-]{36}$/.test(clientRequestId) ? { clientRequestId } : {}),
  };
  const file = path.join(root, "_agent", FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, mode, messages: [...current.messages, message] }, null, 2));
  fs.renameSync(temp, file);
  return message;
}

export function discussionInstruction(text: string, context = ""): string {
  return `当前是与用户讨论演示文稿的一轮对话。请沿用本会话的需求、讨论和已生成文稿，直接回应用户；可以给出提纲、解释和修改建议，必要时读取现有页面。此轮只讨论，不执行生成、编辑、合稿或导出，不要声称已经修改。不要为了满足先前的生成指令继续写页。只有缺少影响结果的关键信息时，必须使用 ask_user_question 提出简短问题并等待用户选择或填写，不要只在正文列选项让用户回复 A/B；回答会作为工具结果返回，接着完成本轮讨论。明确要求无需再次确认。不要要求用户切换模式或重复已经明确提出的要求。回答保持简洁；普通回答优先用短段落，只有真正并列的信息才用列表。${context ? `\n当前文稿上下文：${context}` : ""}\n<user_request>${text}</user_request>`;
}

/** A later user answer can complete the earlier creation request. */
export function generationInstruction(text: string): string {
  return `本轮继续执行用户在这段对话中提出的演示文稿制作请求。请结合前文理解最新回复（例如用户给出的页数、选择的方案）。上一轮的“只讨论”约束只适用于那一轮，本轮可以使用制作工具。所需信息已具备时直接制作，不重复问是否开始，不只返回提纲或承诺。仍须遵守用户给出的内容和范围；缺少必要信息时再问一个关键问题。\n<user_request>${text}</user_request>`;
}
