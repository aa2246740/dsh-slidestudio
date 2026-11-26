/**
 * Persist a generate tool-loop pause so the user can retry or continue later.
 * Never store API keys or Authorization headers.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LlmChatMessage } from "./llm-port.js";

export type AgentToolTrace = {
  tool: string;
  label: string;
  summary: string;
  detail: string;
  ok: boolean;
};

export const GENERATE_CHECKPOINT_FILE = "generate-checkpoint.json";

export type AgentPauseKind = "rate_limit" | "busy" | "timeout" | "auth" | "model_unavailable" | "transient";

export type AgentCheckpoint = {
  v: 1;
  brief: string;
  messages: LlmChatMessage[];
  traces: AgentToolTrace[];
  categoryId: string;
  designSystemId: string;
  turnsUsed: number;
  maxTurns: number;
  pausedAt: string;
  reason: string;
  kind: AgentPauseKind;
};

export type AgentPause = {
  kind: AgentPauseKind;
  reason: string;
  retryAfterMs?: number;
  checkpoint: AgentCheckpoint;
};

export function formatPauseMessage(kind: AgentPauseKind | string): string {
  switch (kind) {
    case "rate_limit":
      return "模型额度或限流仍未恢复。进度已保存，可以重试，也可以切换供应商或模型后继续。";
    case "busy":
      return "模型现在太忙。进度已保存，可以重试，也可以切换供应商或模型后继续。";
    case "timeout":
      return "模型这次没有及时返回。进度已保存，可以重试，也可以换一个模型继续。";
    case "auth":
      return "供应商登录已经失效。进度已保存，请重新登录或切换供应商后继续。";
    case "model_unavailable":
      return "当前模型不可用或无法继续处理这份演示文稿。进度已保存，请换一个支持图片的模型继续。";
    default:
      return "模型这次出错了。进度已保存，可以重试，也可以切换供应商或模型后继续。";
  }
}

function isChatMessage(raw: unknown): raw is LlmChatMessage {
  if (!raw || typeof raw !== "object") return false;
  const role = (raw as { role?: unknown }).role;
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

export function parseGenerateCheckpoint(raw: unknown): AgentCheckpoint | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return undefined;
  const brief = typeof o.brief === "string" ? o.brief : "";
  if (!brief.trim()) return undefined;
  if (!Array.isArray(o.messages) || !o.messages.every(isChatMessage)) return undefined;
  const kind = o.kind;
  if (
    kind !== "rate_limit" &&
    kind !== "busy" &&
    kind !== "timeout" &&
    kind !== "auth" &&
    kind !== "model_unavailable" &&
    kind !== "transient"
  ) {
    return undefined;
  }
  return {
    v: 1,
    brief,
    messages: o.messages as LlmChatMessage[],
    traces: Array.isArray(o.traces) ? (o.traces as AgentToolTrace[]) : [],
    categoryId: typeof o.categoryId === "string" ? o.categoryId : "",
    designSystemId: typeof o.designSystemId === "string" ? o.designSystemId : "",
    turnsUsed: Number(o.turnsUsed) || 0,
    maxTurns: Number(o.maxTurns) || 10,
    pausedAt: typeof o.pausedAt === "string" ? o.pausedAt : new Date().toISOString(),
    reason: typeof o.reason === "string" ? o.reason : "",
    kind,
  };
}

function redactSecrets(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/("(?:api[_-]?key|authorization)"\s*:\s*")[^"]*"/gi, '$1[redacted]"');
}

export function writeGenerateCheckpoint(root: string, checkpoint: AgentCheckpoint): string {
  const dest = path.join(root, GENERATE_CHECKPOINT_FILE);
  const payload = redactSecrets(JSON.stringify(checkpoint, null, 2));
  fs.mkdirSync(root, { recursive: true });
  const temp = `${dest}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${payload}\n`, "utf8");
  fs.renameSync(temp, dest);
  return dest;
}

export function readGenerateCheckpoint(root: string): AgentCheckpoint | undefined {
  const dest = path.join(root, GENERATE_CHECKPOINT_FILE);
  if (!fs.existsSync(dest)) return undefined;
  try {
    return parseGenerateCheckpoint(JSON.parse(fs.readFileSync(dest, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Rebuild the small resume pointer after a process crash that happened before
 * generate-checkpoint.json was atomically committed. Durable design/page/review
 * state stays in the RunLedger and PPTD files; no chat transcript is invented.
 */
export function recoverGenerateCheckpoint(root: string): AgentCheckpoint | undefined {
  const runtimeFile = path.join(root, "_agent", "runtime.json");
  const ledgerFile = path.join(root, "_agent", "run-ledger.v1.json");
  if (!fs.existsSync(runtimeFile) || !fs.existsSync(ledgerFile)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(runtimeFile, "utf8")) as Record<string, unknown>;
    const brief = typeof raw.brief === "string" ? raw.brief.trim() : "";
    const categoryId = typeof raw.categoryId === "string" ? raw.categoryId.trim() : "";
    const designSystemId = typeof raw.designSystemId === "string" ? raw.designSystemId.trim() : "";
    if (!brief || !categoryId || !designSystemId || raw.strictExecution !== true) {
      return undefined;
    }
    return {
      v: 1,
      brief,
      messages: [],
      traces: [],
      categoryId,
      designSystemId,
      turnsUsed: 0,
      maxTurns: 10,
      pausedAt: new Date().toISOString(),
      reason: "Recovered from the durable Open SlideStudio run ledger after an interrupted provider session.",
      kind: "transient",
    };
  } catch {
    return undefined;
  }
}

export function clearGenerateCheckpoint(root: string): void {
  const dest = path.join(root, GENERATE_CHECKPOINT_FILE);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
}
