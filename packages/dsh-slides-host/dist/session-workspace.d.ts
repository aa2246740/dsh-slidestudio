/** Public Workspace API only. Session headers keep their original cwd forever.
 * Slides generation sessions must not appear in the DSH Work sidebar: new
 * sessions are created with meta.origin "subagent" (hidden by the host), and
 * any legacy slides session that predates that is archived here at startup so
 * the sidebar stops listing it. SlideStudio-titled workspaces that hold only
 * slides sessions are deleted afterwards; workspaces containing a user's own
 * sessions are kept. */
export declare const SLIDES_WORKSPACE_TITLE = "\u6F14\u793A\u6587\u7A3F \u00B7 SlideStudio";
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
export declare function slidesSessionMeta(cwd: string): {
    cwd: string;
    agentPreset: "slides";
    origin: "subagent";
};
/** An archived session cannot run: the Harness gate rejects every pre-step.
 * Resume must unarchive first. */
export declare function ensureSessionUnarchived(registry: SlidesWorkspaceRegistry | undefined, sessionId: string): Promise<void>;
/** Legacy sessions predate `origin: "subagent"`, so unarchiving one for a
 * resume makes it visible in the Work sidebar. This tracker re-archives it
 * once the turn settles, so a hidden session stays hidden between runs.
 * `ensureRunnable` also awaits any archive still in flight and runs before
 * every resume and every live-agent followup: an archive landing between the
 * idle event and the next user message must not gate that followup. */
export declare class LegacySessionHider {
    private readonly registry;
    private readonly isBusy;
    private readonly warn;
    private readonly pending;
    private readonly inflight;
    constructor(registry: () => SlidesWorkspaceRegistry | undefined, isBusy: (sessionId: string) => boolean, warn?: (message: string) => void);
    ensureRunnable(sessionId: string): Promise<void>;
    /** Call when a session goes idle or is disposed. Re-archives only sessions
     * `ensureRunnable` unarchived; sessions still busy keep their mark until a
     * later settle. */
    onSettled(sessionId: string): void;
}
/** Archive every pre-subagent slides session the host still lists, then remove
 * SlideStudio-titled workspaces that hold only slides sessions. Per-session
 * and per-workspace failures are recorded and never stop the sweep. */
export declare function hideSlidesSessions(registry: SlidesWorkspaceRegistry, headers: readonly SlidesSessionHeader[], owned: ReadonlySet<string>): Promise<{
    archived: number;
    removedWorkspaces: number;
    failures: string[];
}>;
//# sourceMappingURL=session-workspace.d.ts.map