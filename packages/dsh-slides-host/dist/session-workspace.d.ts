/** Public Workspace API only. Session headers keep their original cwd forever. */
export interface SlidesWorkspaceRegistry {
    create(path: string, title?: string): Promise<{
        attachSession(sessionId: string): Promise<void>;
    }>;
}
export interface SlidesSessionHeader {
    id: string;
    cwd?: string;
    agentPreset?: string;
}
/** Adopt old bound sessions at their actual cwd; never rewrite history or titles
 * of existing user workspaces. The registry validates membership by cwd. */
export declare function organizeSlidesSessions(registry: SlidesWorkspaceRegistry, headers: readonly SlidesSessionHeader[], owned: ReadonlySet<string>): Promise<{
    attached: number;
    failures: string[];
}>;
//# sourceMappingURL=session-workspace.d.ts.map