/** Server key and tool namespace registered with the DSH MCP manager. */
export declare const SLIDES_MCP_SERVER_NAME = "slidestudio";
/** The DSH 0.2.2-rc.5 `McpServerRegistration` subset this plugin uses (stdio only). */
export type SlidesMcpRegistration = {
    transport: 'stdio';
    command: string;
    args: string[];
    cwd?: string;
};
/** The slice of the cordis Context this module touches. */
export type McpRegisterContext = {
    get(name: string): unknown;
    effect(execute: () => () => void): unknown;
};
export type McpRegisterOptions = {
    repoRoot: string;
    dataRoot: string;
    editorOrigin: string;
};
export type McpRegisterDeps = {
    flagEnabled?: (repoRoot: string) => boolean;
    exists?: (file: string) => boolean;
    execPath?: string;
    log?: (level: string, event: string, fields?: Record<string, unknown>) => void;
};
export type McpRegisterOutcome = 'disabled' | 'mcp_manager_unavailable' | 'slides_mcp_cli_missing' | 'template_path_refused' | 'registered';
/** Prefer the bundled package, fall back to the checkout workspace build. */
export declare function resolveSlidesMcpCli(repoRoot: string, exists?: (file: string) => boolean): string | undefined;
/**
 * Build a DSH 0.2.2-rc.5 `McpServerRegistration` guaranteed free of `${...}`
 * template tokens (which rc.5 rejects or expands as `${credential:...}`).
 * Paths in `dataRoot`/`editorOrigin`/`repoRoot` containing `${...}` are
 * base64url-encoded via `--config-b64`; if `execPath` or `cliPath` itself
 * contains `${...}`, returns `undefined` so the caller fails closed.
 */
export declare function slidesMcpRegistration(options: McpRegisterOptions, cliPath: string, execPath?: string): SlidesMcpRegistration | undefined;
/**
 * Optionally contribute the bundled slides-mcp server to the DSH MCP manager
 * (`mcpManager.register`, DSH 0.2.2-rc.5+) for this plugin's lifetime. Off by
 * default behind the `mcp_register` flag. On hosts without the manager (rc.2)
 * it logs a warning and returns without side effects; a registration failure
 * (for example a user-configured server with the same name) never blocks the
 * plugin from loading.
 */
export declare function registerSlidesMcp(ctx: McpRegisterContext, options: McpRegisterOptions, deps?: McpRegisterDeps): McpRegisterOutcome;
//# sourceMappingURL=mcp-register.d.ts.map