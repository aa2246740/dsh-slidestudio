/** The transport-independent MCP server: shared runtime plus a session registry. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPresentationRun, resolveRepoRoot, type PresentationRun } from "@open-slidestudio/presentation-run";
import type { SlideToolDefinition, SlideToolRuntimeDeps } from "@open-slidestudio/slides-tools";
import type { McpSessionState } from "./project-port.js";
import { McpSession } from "./session.js";

export const DEFAULT_EDITOR_URL = "http://127.0.0.1:55200";

export type SlidesMcpConfig = {
  /** Directory owning `output/dsh-slices/` (the SlideStudio data root). */
  readonly dataRoot: string;
  /** Native editor origin used by `open_in_editor`. */
  readonly editorBaseUrl?: string;
  /** Checkout or package root holding the reference catalog; discovered when omitted. */
  readonly repoRoot?: string;
  /** Directories `import_material` may read from. Empty (the default) refuses every import. */
  readonly allowedImportRoots?: readonly string[];
  /** False drops image content and declares a text-only provider route. */
  readonly acceptsImages?: boolean;
  readonly clientLabel?: string;
  readonly writerLeaseTtlMs?: number;
  readonly presentation?: PresentationRun;
  readonly extraTools?: (deps: SlideToolRuntimeDeps, state: McpSessionState) => SlideToolDefinition[];
  /** Diagnostics sink; defaults to stderr (stdout belongs to the stdio transport). */
  readonly log?: (line: string) => void;
};

export type SlidesMcpServer = {
  readonly config: Readonly<{ dataRoot: string; editorBaseUrl: string; acceptsImages: boolean }>;
  createSession(): McpSession;
  session(id: string): McpSession | undefined;
  /** Close one session and release its leases. Returns false for an unknown id. */
  closeSession(id: string): boolean;
  /** Close every session (process shutdown). */
  closeAll(): void;
  readonly sessionCount: number;
};

function stderrLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function createSlidesMcpServer(config: SlidesMcpConfig): SlidesMcpServer {
  if (!config.dataRoot || !path.isAbsolute(config.dataRoot)) {
    throw new Error("slides-mcp needs an absolute --data-root");
  }
  const dataRoot = path.resolve(config.dataRoot);
  const editorBaseUrl = (config.editorBaseUrl ?? DEFAULT_EDITOR_URL).replace(/\/+$/, "");
  const acceptsImages = config.acceptsImages !== false;
  const log = config.log ?? stderrLog;
  const presentation =
    config.presentation ?? createPresentationRun({ repoRoot: config.repoRoot ?? resolveRepoRoot(moduleDir()) });
  const sessions = new Map<string, McpSession>();
  const options = {
    dataRoot,
    editorBaseUrl,
    presentation,
    acceptsImages,
    allowedImportRoots: [...(config.allowedImportRoots ?? [])],
    log,
    ...(config.clientLabel ? { clientLabel: config.clientLabel } : {}),
    ...(config.writerLeaseTtlMs ? { writerLeaseTtlMs: config.writerLeaseTtlMs } : {}),
    ...(config.extraTools ? { extraTools: config.extraTools } : {}),
  };
  return {
    config: { dataRoot, editorBaseUrl, acceptsImages },
    createSession() {
      const session = new McpSession(options);
      sessions.set(session.id, session);
      return session;
    },
    session: (id) => sessions.get(id),
    closeSession(id) {
      const session = sessions.get(id);
      if (!session) return false;
      sessions.delete(id);
      session.close();
      return true;
    },
    closeAll() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
    get sessionCount() {
      return sessions.size;
    },
  };
}
