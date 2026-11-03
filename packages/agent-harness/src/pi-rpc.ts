/**
 * Pi `--mode rpc` transport (stdio JSONL).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { inferPiProvider, piAuthEnv } from "./pi-auth.js";
import { piRpcToolAllowlist, resolvePiHandsExtension } from "./pi-hands.js";
import { resolvePiSkillDirs } from "./pi-skill.js";

export { inferPiProvider, piAuthEnv } from "./pi-auth.js";
export { resolveHostSkillDir, resolvePiSkillDirs } from "./pi-skill.js";

export type PiRpcOptions = {
  bin?: string;
  cwd: string;
  model?: string;
  provider?: string;
  thinking?: string;
  extraArgs?: string[];
  /** Inserted after the binary and before default `--mode rpc` flags (tests). */
  prefixArgs?: string[];
  /** Skill dirs passed as `--skill`. Empty = host + vendored open-kimi-ppt. */
  skills?: string[];
  /** Pi extension that registers OpenKimi produce tools. */
  extension?: string;
  /** Strict tool allowlist. Default is read + produce tools (no generic write). */
  tools?: string;
  env?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  now?: () => Date;
};

export type PiRpcLine = Record<string, unknown>;

/** One Pi RPC event name with the clock taken when the line arrived. */
export type TimedPiEvent = { at: string; event: string };

/** Sanitized live event for the product timeline. Never exposes chain-of-thought or credentials. */
export type PiPublicRuntimeEvent = {
  id: string;
  at: string;
  kind: "agent" | "tool";
  status: "running" | "completed" | "failed";
  tool?: string;
  label: string;
  summary?: string;
  progress?: { current?: number; total?: number; pageId?: string };
};

export type PiRpcConfig = {
  bin: string;
  model?: string;
  provider?: string;
  timeoutMs: number;
};

function bundledPiBin(): string | undefined {
  const candidate = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  return fs.existsSync(candidate) ? candidate : undefined;
}

const FIRE_AND_FORGET = new Set([
  "setStatus",
  "setWidget",
  "notify",
  "setTitle",
  "set_editor_text",
]);

export function resolveXaiAuthExtension(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || path.join(home, ".pi", "agent");
  const rel = path.join(
    "git",
    "github.com",
    "BlockedPath",
    "pi-xai-oauth",
    "extensions",
    "xai-oauth.ts",
  );
  const candidate = path.join(agentDir, rel);
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function piConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PiRpcConfig {
  const timeoutRaw = Number(env.SLIDESTUDIO_PI_TIMEOUT_MS);
  const provider = inferPiProvider(env);
  const explicitModel = env.SLIDESTUDIO_PI_MODEL?.trim();
  const grok = provider === "xai-auth" || provider === "xai";
  return {
    bin: env.SLIDESTUDIO_PI_BIN?.trim() || bundledPiBin() || "pi",
    model: explicitModel || (grok ? "grok-4.5" : undefined),
    provider,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 360_000,
  };
}

/**
 * Pi argv: isolate discovery, load host+vendor skills, and the produce-tool extension.
 * `--skill` is markdown discovery. Produce tools come from `-e` (write_todo / write_page / …).
 */
export function buildPiRpcArgs(options: PiRpcOptions): string[] {
  let skills = options.skills;
  if (!skills) {
    try {
      skills = Object.values(resolvePiSkillDirs());
    } catch {
      skills = [];
    }
  }
  let extension = options.extension;
  if (!extension) {
    try {
      extension = resolvePiHandsExtension();
    } catch {
      extension = "";
    }
  }
  const args = [
    ...(options.prefixArgs ?? []),
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--thinking",
    options.thinking ?? "off",
    "--tools",
    options.tools ?? piRpcToolAllowlist(options.env ?? process.env),
  ];
  if (extension.trim()) args.push("-e", extension);
  const wantsGrok = options.provider === "xai-auth" || options.provider === "xai";
  if (wantsGrok) {
    const xai = resolveXaiAuthExtension(options.env ?? process.env);
    if (xai) args.push("-e", xai);
  }
  for (const skill of skills) {
    if (skill.trim()) args.push("--skill", skill);
  }
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.extraArgs) args.push(...options.extraArgs);
  return args;
}

function serializeLine(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

export function isIdleEvent(event: PiRpcLine): boolean {
  // Pi emits agent_end before its internal processing flag is cleared.
  // A follow-up prompt is safe only after agent_settled.
  return event.type === "agent_settled";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const bits: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      bits.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const rec = part as Record<string, unknown>;
    if (typeof rec.text === "string") bits.push(rec.text);
  }
  return bits.join("");
}

/** Pull assistant chat text out of Pi RPC events (message_end / turn_end). */
export function assistantTextsFromEvents(events: PiRpcLine[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type !== "message_end" && ev.type !== "turn_end") continue;
    const msg =
      ev.message && typeof ev.message === "object"
        ? (ev.message as Record<string, unknown>)
        : undefined;
    if (!msg) continue;
    if (typeof msg.role === "string" && msg.role !== "assistant") continue;
    const text = textFromContent(msg.content).trim();
    if (text) out.push(text);
  }
  return out;
}

function receivedAtOf(ev: PiRpcLine): string {
  if (typeof ev._receivedAt === "string" && ev._receivedAt) return ev._receivedAt;
  if (typeof ev.timestamp === "string" && ev.timestamp) return ev.timestamp;
  return new Date().toISOString();
}

const PUBLIC_TOOL_LABELS: Record<string, string> = {
  think: "理解任务",
  read: "读取资料",
  list_references: "核对原始资料",
  read_reference: "读取原始资料",
  view_design_reference: "查看设计参考",
  commit_design: "确定设计方向",
  read_design: "读取设计契约",
  write_todo: "规划页面",
  research: "检索资料",
  search_image: "搜索图片",
  generate_image: "生成图片",
  write_page: "设计页面",
  render_page: "渲染页面",
  review_page: "检查页面",
  review_pages: "检查整稿",
  render_deck: "生成整稿总览",
  review_deck: "审查整稿审美",
  compose_deck: "完成演示文稿",
};

function argRecord(ev: PiRpcLine): Record<string, unknown> {
  return ev.args && typeof ev.args === "object" && !Array.isArray(ev.args)
    ? (ev.args as Record<string, unknown>)
    : {};
}

function publicToolSummary(tool: string, args: Record<string, unknown>): {
  summary?: string;
  progress?: PiPublicRuntimeEvent["progress"];
} {
  if (tool === "write_todo") {
    const total = Array.isArray(args.items) ? args.items.length : undefined;
    return {
      summary: total ? `${total} 页计划` : undefined,
      progress: total ? { total } : undefined,
    };
  }
  if (tool === "write_page" || tool === "render_page") {
    const pageId = String(args.id ?? args.pageId ?? "").trim();
    return { summary: pageId || undefined, progress: pageId ? { pageId } : undefined };
  }
  if (tool === "read_reference") {
    const source = String(args.sourceId ?? "").trim();
    const chunk = Number(args.chunkIndex);
    return {
      summary: source ? `${source} #${Number.isFinite(chunk) ? chunk : "?"}` : undefined,
    };
  }
  if (tool === "research" || tool === "search_image") {
    const query = String(args.query ?? "").trim();
    return { summary: query ? query.slice(0, 80) : undefined };
  }
  if (tool === "compose_deck") {
    const title = String(args.title ?? "").trim();
    return { summary: title ? title.slice(0, 80) : undefined };
  }
  return {};
}

export function publicPiRuntimeEvent(ev: PiRpcLine): PiPublicRuntimeEvent | undefined {
  const at = receivedAtOf(ev);
  if (ev.type === "agent_start") {
    return { id: "agent", at, kind: "agent", status: "running", label: "AI Agent" };
  }
  if (ev.type === "agent_end" || ev.type === "agent_settled") {
    return { id: "agent", at, kind: "agent", status: "completed", label: "AI Agent" };
  }
  if (ev.type !== "tool_execution_start" && ev.type !== "tool_execution_end") return undefined;
  const tool = typeof ev.toolName === "string" ? ev.toolName : "tool";
  const id = typeof ev.toolCallId === "string" && ev.toolCallId ? ev.toolCallId : `${tool}:${at}`;
  const meta = publicToolSummary(tool, argRecord(ev));
  return {
    id,
    at,
    kind: "tool",
    status:
      ev.type === "tool_execution_start"
        ? "running"
        : ev.isError === true
          ? "failed"
          : "completed",
    tool,
    label: PUBLIC_TOOL_LABELS[tool] ?? tool,
    ...meta,
  };
}

function nameFromRpcEvent(ev: PiRpcLine): string | undefined {
  if (typeof ev.type !== "string") return undefined;
  if (ev.type === "tool_execution_start") {
    const name =
      typeof ev.toolName === "string"
        ? ev.toolName
        : typeof ev.name === "string"
          ? ev.name
          : "tool";
    const args = ev.args && typeof ev.args === "object" ? (ev.args as Record<string, unknown>) : {};
    const target =
      typeof args.path === "string"
        ? args.path
        : typeof args.file === "string"
          ? args.file
          : "";
    return target ? `tool:${name}:${path.basename(target)}` : `tool:${name}`;
  }
  if (ev.type === "message_update") return undefined;
  const msg =
    ev.message && typeof ev.message === "object"
      ? (ev.message as Record<string, unknown>)
      : undefined;
  const stop = msg?.stopReason ?? ev.stopReason;
  const err = msg?.errorMessage ?? ev.errorMessage ?? ev.error;
  if (stop === "error" || (typeof err === "string" && err.trim())) {
    const blob = typeof err === "string" ? err : "";
    const tag = /429|RESOURCE_EXHAUSTED/i.test(blob)
      ? "429"
      : /401|API key/i.test(blob)
        ? "auth"
        : "error";
    return `stop:${tag}`;
  }
  return ev.type;
}

/** Event names plus the ISO clock from when each RPC line arrived. */
export function summarizeTimedEvents(events: PiRpcLine[]): TimedPiEvent[] {
  const out: TimedPiEvent[] = [];
  for (const ev of events) {
    const event = nameFromRpcEvent(ev);
    if (!event) continue;
    out.push({ at: receivedAtOf(ev), event });
    if (out.length >= 400) break;
  }
  return out;
}

export function summarizeEvents(events: PiRpcLine[]): string[] {
  return summarizeTimedEvents(events).map((row) => row.event);
}

export class PiRpcSession {
  private child: ChildProcess | null = null;
  private stderr = "";
  private exitError: Error | null = null;
  private requestId = 0;
  private readonly pending = new Map<
    string,
    { resolve: (v: PiRpcLine) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Set<(event: PiRpcLine) => void>();
  private stopReading: (() => void) | null = null;

  constructor(private readonly options: PiRpcOptions) {}

  getStderr(): string {
    return this.stderr;
  }

  onEvent(listener: (event: PiRpcLine) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Pi RPC session already started");
    const bin = this.options.bin ?? "pi";
    const args = buildPiRpcArgs(this.options);

    const child = spawn(bin, args, {
      cwd: this.options.cwd,
      env: piAuthEnv({ ...process.env, ...this.options.env }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr?.on("data", (buf: Buffer) => {
      this.stderr += buf.toString("utf8");
      if (this.stderr.length > 16_000) this.stderr = this.stderr.slice(-12_000);
    });

    child.once("error", (err) => {
      const wrapped = new Error(
        err.message.includes("ENOENT")
          ? `pi binary not found (${bin}). Install Pi or use --brain playbook.`
          : `Pi process error: ${err.message}`,
      );
      this.failAll(wrapped);
    });

    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      const err = new Error(
        `Pi exited (code=${code} signal=${signal}). Stderr: ${this.stderr.slice(-800)}`,
      );
      this.failAll(err);
    });

    if (!child.stdout) throw new Error("Pi stdout missing");
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const onLine = (line: string) => this.handleLine(line);
    rl.on("line", onLine);
    this.stopReading = () => {
      rl.off("line", onLine);
      rl.close();
    };

    await new Promise((r) => setTimeout(r, 80));
    if (child.exitCode !== null) {
      throw this.exitError ?? new Error(`Pi failed to start. ${this.stderr.slice(-400)}`);
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.stopReading?.();
    this.stopReading = null;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.pending.clear();
  }

  async send(command: Record<string, unknown>): Promise<PiRpcLine> {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin) throw new Error("Pi RPC session not started");
    if (this.exitError) throw this.exitError;
    const id = `req_${++this.requestId}`;
    const timeoutMs = this.options.commandTimeoutMs ?? 30_000;
    return new Promise<PiRpcLine>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timeout waiting for Pi ${String(command.type)}. Stderr: ${this.stderr.slice(-400)}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      stdin.write(serializeLine({ ...command, id }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async getState(): Promise<PiRpcLine> {
    const res = await this.send({ type: "get_state" });
    if (res.success === false) {
      throw new Error(typeof res.error === "string" ? res.error : "get_state failed");
    }
    return (res.data as PiRpcLine) ?? {};
  }

  async prompt(message: string): Promise<void> {
    const res = await this.send({ type: "prompt", message });
    if (res.success === false) {
      throw new Error(typeof res.error === "string" ? res.error : "prompt rejected");
    }
  }

  waitForIdle(timeoutMs: number, opts: { afterTurn?: boolean } = {}): Promise<PiRpcLine[]> {
    return new Promise((resolve, reject) => {
      const events: PiRpcLine[] = [];
      let started = !opts.afterTurn;
      let timer: NodeJS.Timeout;
      const armInactivityTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          unsub();
          reject(
            new Error(
              `Timeout waiting for Pi idle (${timeoutMs}ms without activity). Stderr: ${this.stderr.slice(-600)}`,
            ),
          );
        }, timeoutMs);
      };
      const unsub = this.onEvent((event) => {
        events.push(event);
        if (event.type === "agent_start" || event.type === "turn_start") started = true;
        if (started) armInactivityTimer();
        if (!started || !isIdleEvent(event)) return;
        clearTimeout(timer);
        unsub();
        resolve(events);
      });
      armInactivityTimer();
    });
  }

  async promptAndWait(message: string, timeoutMs: number): Promise<PiRpcLine[]> {
    const idle = this.waitForIdle(timeoutMs, { afterTurn: true });
    await this.prompt(message);
    return idle;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let data: PiRpcLine;
    try {
      data = JSON.parse(trimmed) as PiRpcLine;
    } catch {
      return;
    }
    if (typeof data._receivedAt !== "string" || !data._receivedAt) {
      data._receivedAt = (this.options.now?.() ?? new Date()).toISOString();
    }
    if (data.type === "response" && typeof data.id === "string") {
      const pending = this.pending.get(data.id);
      if (pending) {
        this.pending.delete(data.id);
        pending.resolve(data);
        return;
      }
    }
    if (data.type === "extension_ui_request") {
      this.replyExtensionUi(data);
      return;
    }
    for (const listener of this.listeners) listener(data);
  }

  private replyExtensionUi(raw: PiRpcLine): void {
    const method = typeof raw.method === "string" ? raw.method : "";
    if (FIRE_AND_FORGET.has(method) || raw.id == null) return;
    const stdin = this.child?.stdin;
    if (!stdin) return;
    let body: Record<string, unknown> = {
      type: "extension_ui_response",
      id: raw.id,
    };
    if (method === "confirm") {
      body = { ...body, confirmed: true };
    } else if (method === "select") {
      const opts = Array.isArray(raw.options) ? raw.options : [];
      const first = opts[0];
      body =
        typeof first === "string"
          ? { ...body, value: first }
          : { ...body, cancelled: true };
    } else {
      body = { ...body, value: "" };
    }
    stdin.write(serializeLine(body));
  }

  private failAll(err: Error): void {
    this.exitError = err;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}
