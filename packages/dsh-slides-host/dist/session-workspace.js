/** Adopt old bound sessions at their actual cwd; never rewrite history or titles
 * of existing user workspaces. The registry validates membership by cwd. */
export async function organizeSlidesSessions(registry, headers, owned) {
    let attached = 0;
    const failures = [];
    const workspaces = new Map();
    for (const header of headers) {
        if (!owned.has(header.id) || header.agentPreset !== "slides" || !header.cwd)
            continue;
        try {
            let workspace = workspaces.get(header.cwd);
            if (!workspace) {
                workspace = registry.create(header.cwd, "演示文稿 · SlideStudio");
                workspaces.set(header.cwd, workspace);
            }
            await (await workspace).attachSession(header.id);
            attached++;
        }
        catch (error) {
            failures.push(`${header.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { attached, failures };
}
//# sourceMappingURL=session-workspace.js.map