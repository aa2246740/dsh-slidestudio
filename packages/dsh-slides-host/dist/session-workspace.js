/** Public Workspace API only. Session headers keep their original cwd forever.
 * Slides generation sessions must not appear in the DSH Work sidebar: new
 * sessions are created with meta.origin "subagent" (hidden by the host), and
 * any legacy slides session that predates that is archived here at startup so
 * the sidebar stops listing it. SlideStudio-titled workspaces that hold only
 * slides sessions are deleted afterwards; workspaces containing a user's own
 * sessions are kept. */
export const SLIDES_WORKSPACE_TITLE = "演示文稿 · SlideStudio";
/** DSH hides subagent-origin sessions from every sidebar view; no parent on
 * purpose — the pool cwd is the only grouping signal we still rely on. */
export function slidesSessionMeta(cwd) {
    return { cwd, agentPreset: "slides", origin: "subagent" };
}
/** An archived session cannot run: the Harness gate rejects every pre-step.
 * Resume must unarchive first. */
export async function ensureSessionUnarchived(registry, sessionId) {
    if (registry?.archivedSessionIds.includes(sessionId)) {
        await registry.unarchiveSession(sessionId);
    }
}
/** A cwd belongs to our generation pool only under `<...>/output/dsh-slices`. */
const SLICES_CWD = /(^|[\\/])output[\\/]dsh-slices[\\/]?$/;
function isSlidesSession(header, owned) {
    if (header.agentPreset !== "slides")
        return false;
    return owned.has(header.id) || (!!header.cwd && SLICES_CWD.test(header.cwd));
}
/** Archive every pre-subagent slides session the host still lists, then remove
 * SlideStudio-titled workspaces that hold only slides sessions. Per-session
 * and per-workspace failures are recorded and never stop the sweep. */
export async function hideSlidesSessions(registry, headers, owned) {
    let archived = 0;
    let removedWorkspaces = 0;
    const failures = [];
    const slidesIds = new Set();
    for (const header of headers) {
        if (!isSlidesSession(header, owned))
            continue;
        slidesIds.add(header.id);
        if (header.origin === "subagent" || header.parentSession)
            continue;
        if (registry.archivedSessionIds.includes(header.id))
            continue;
        try {
            await registry.archiveSession(header.id);
            archived++;
        }
        catch (error) {
            failures.push(`${header.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    for (const workspace of registry.list()) {
        if (workspace.title !== SLIDES_WORKSPACE_TITLE)
            continue;
        if (!workspace.sessionIds.every((id) => slidesIds.has(id)))
            continue;
        try {
            if (await registry.delete(workspace.id))
                removedWorkspaces++;
        }
        catch (error) {
            failures.push(`${workspace.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { archived, removedWorkspaces, failures };
}
//# sourceMappingURL=session-workspace.js.map