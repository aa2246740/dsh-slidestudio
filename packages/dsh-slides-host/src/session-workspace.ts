/** Public Workspace API only. Session headers keep their original cwd forever.
 * Slides generation sessions must not appear in the DSH Work sidebar: new
 * sessions are created with meta.origin "subagent" (hidden by the host), and
 * any legacy slides session that predates that is archived here at startup so
 * the sidebar stops listing it. SlideStudio-titled workspaces that hold only
 * slides sessions are deleted afterwards; workspaces containing a user's own
 * sessions are kept. */
export const SLIDES_WORKSPACE_TITLE = "演示文稿 · SlideStudio";

export interface SlidesWorkspaceRegistry {
  list(): readonly {
    id: string;
    path: string;
    title: string;
    sessionIds: readonly string[];
  }[];
  delete(id: string): Promise<boolean>;
  readonly archivedSessionIds: readonly string[];
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;
}

export interface SlidesSessionHeader {
  id: string;
  cwd?: string;
  agentPreset?: string;
  origin?: string;
  parentSession?: string;
}

/** DSH hides subagent-origin sessions from every sidebar view; no parent on
 * purpose — the pool cwd is the only grouping signal we still rely on. */
export function slidesSessionMeta(cwd: string): {
  cwd: string;
  agentPreset: "slides";
  origin: "subagent";
} {
  return { cwd, agentPreset: "slides", origin: "subagent" };
}

/** An archived session cannot run: the Harness gate rejects every pre-step.
 * Resume must unarchive first. */
export async function ensureSessionUnarchived(
  registry: SlidesWorkspaceRegistry | undefined,
  sessionId: string,
): Promise<void> {
  if (registry?.archivedSessionIds.includes(sessionId)) {
    await registry.unarchiveSession(sessionId);
  }
}

/** Legacy sessions predate `origin: "subagent"`, so unarchiving one for a
 * resume makes it visible in the Work sidebar. This tracker re-archives it
 * once the turn settles, so a hidden session stays hidden between runs.
 * `ensureRunnable` also awaits any archive still in flight and runs before
 * every resume and every live-agent followup: an archive landing between the
 * idle event and the next user message must not gate that followup. */
export class LegacySessionHider {
  private readonly pending = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly registry: () => SlidesWorkspaceRegistry | undefined,
    private readonly isBusy: (sessionId: string) => boolean,
    private readonly warn: (message: string) => void = console.warn,
  ) {}

  async ensureRunnable(sessionId: string): Promise<void> {
    await this.inflight.get(sessionId);
    const registry = this.registry();
    const wasArchived = registry?.archivedSessionIds.includes(sessionId) === true;
    await ensureSessionUnarchived(registry, sessionId);
    if (wasArchived) this.pending.add(sessionId);
  }

  /** Call when a session goes idle or is disposed. Re-archives only sessions
   * `ensureRunnable` unarchived; sessions still busy keep their mark until a
   * later settle. */
  onSettled(sessionId: string): void {
    if (!this.pending.has(sessionId)) return;
    const registry = this.registry();
    // An in-flight archive already hides the session, so the mark is stale.
    if (!registry || this.inflight.has(sessionId)) {
      this.pending.delete(sessionId);
      return;
    }
    if (this.isBusy(sessionId)) return;
    this.pending.delete(sessionId);
    const op = Promise.resolve()
      .then(() => registry.archiveSession(sessionId))
      .catch((error: unknown) => {
        this.warn(
          `[slides-host] re-archive ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, op);
  }
}

/** A cwd belongs to our generation pool only under `<...>/output/dsh-slices`. */
const SLICES_CWD = /(^|[\\/])output[\\/]dsh-slices[\\/]?$/;

function isSlidesSession(header: SlidesSessionHeader, owned: ReadonlySet<string>): boolean {
  if (header.agentPreset !== "slides") return false;
  return owned.has(header.id) || (!!header.cwd && SLICES_CWD.test(header.cwd));
}

/** Archive every pre-subagent slides session the host still lists, then remove
 * SlideStudio-titled workspaces that hold only slides sessions. Per-session
 * and per-workspace failures are recorded and never stop the sweep. */
export async function hideSlidesSessions(
  registry: SlidesWorkspaceRegistry,
  headers: readonly SlidesSessionHeader[],
  owned: ReadonlySet<string>,
): Promise<{ archived: number; removedWorkspaces: number; failures: string[] }> {
  let archived = 0;
  let removedWorkspaces = 0;
  const failures: string[] = [];
  const slidesIds = new Set<string>();
  for (const header of headers) {
    if (!isSlidesSession(header, owned)) continue;
    slidesIds.add(header.id);
    if (header.origin === "subagent" || header.parentSession) continue;
    if (registry.archivedSessionIds.includes(header.id)) continue;
    try {
      await registry.archiveSession(header.id);
      archived++;
    } catch (error) {
      failures.push(`${header.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const workspace of registry.list()) {
    if (workspace.title !== SLIDES_WORKSPACE_TITLE) continue;
    if (!workspace.sessionIds.every((id) => slidesIds.has(id))) continue;
    try {
      if (await registry.delete(workspace.id)) removedWorkspaces++;
    } catch (error) {
      failures.push(
        `${workspace.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { archived, removedWorkspaces, failures };
}
