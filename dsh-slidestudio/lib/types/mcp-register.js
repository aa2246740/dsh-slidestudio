import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeatureFlags } from '../../scripts/lib/feature-flags.mjs';
import { logger } from './logger.js';
/** Server key and tool namespace registered with the DSH MCP manager. */
export const SLIDES_MCP_SERVER_NAME = 'slidestudio';
/** Matches DSH rc.5 `mcp-client` template syntax (`${...}`), which has no escape form. */
const TEMPLATE_SYNTAX = /\$\{[^}]*\}/;
const defaultFlag = (repoRoot) => loadFeatureFlags(repoRoot).get('mcp_register') === true;
/** Prefer the bundled package, fall back to the checkout workspace build. */
export function resolveSlidesMcpCli(repoRoot, exists = existsSync) {
    const candidates = [
        join(repoRoot, 'node_modules', '@open-slidestudio', 'slides-mcp', 'dist', 'cli.js'),
        join(repoRoot, 'packages', 'slides-mcp', 'dist', 'cli.js'),
    ];
    return candidates.find((file) => exists(file));
}
/**
 * Build a DSH 0.2.2-rc.5 `McpServerRegistration` guaranteed free of `${...}`
 * template tokens (which rc.5 rejects or expands as `${credential:...}`).
 * Paths in `dataRoot`/`editorOrigin`/`repoRoot` containing `${...}` are
 * base64url-encoded via `--config-b64`; if `execPath` or `cliPath` itself
 * contains `${...}`, returns `undefined` so the caller fails closed.
 */
export function slidesMcpRegistration(options, cliPath, execPath = process.execPath) {
    if (TEMPLATE_SYNTAX.test(execPath) || TEMPLATE_SYNTAX.test(cliPath))
        return undefined;
    const needsEncoding = TEMPLATE_SYNTAX.test(options.dataRoot) ||
        TEMPLATE_SYNTAX.test(options.editorOrigin) ||
        TEMPLATE_SYNTAX.test(options.repoRoot);
    if (needsEncoding) {
        const encoded = Buffer.from(JSON.stringify({
            dataRoot: options.dataRoot,
            editorBaseUrl: options.editorOrigin,
            repoRoot: options.repoRoot,
        }), 'utf8').toString('base64url');
        return {
            transport: 'stdio',
            command: execPath,
            args: [cliPath, '--config-b64', encoded],
        };
    }
    return {
        transport: 'stdio',
        command: execPath,
        args: [cliPath, '--data-root', options.dataRoot, '--editor-url', options.editorOrigin],
        cwd: options.repoRoot,
    };
}
/**
 * Optionally contribute the bundled slides-mcp server to the DSH MCP manager
 * (`mcpManager.register`, DSH 0.2.2-rc.5+) for this plugin's lifetime. Off by
 * default behind the `mcp_register` flag. On hosts without the manager (rc.2)
 * it logs a warning and returns without side effects; a registration failure
 * (for example a user-configured server with the same name) never blocks the
 * plugin from loading.
 */
export function registerSlidesMcp(ctx, options, deps = {}) {
    const log = deps.log ?? ((level, event, fields) => logger.log(level, event, fields));
    if (!(deps.flagEnabled ?? defaultFlag)(options.repoRoot))
        return 'disabled';
    const manager = ctx.get('mcpManager');
    if (!manager || typeof manager.register !== 'function') {
        log('warn', 'mcp_manager_unavailable', { server: SLIDES_MCP_SERVER_NAME });
        return 'mcp_manager_unavailable';
    }
    const cliPath = resolveSlidesMcpCli(options.repoRoot, deps.exists);
    if (!cliPath) {
        log('warn', 'slides_mcp_cli_missing', { server: SLIDES_MCP_SERVER_NAME });
        return 'slides_mcp_cli_missing';
    }
    const entry = slidesMcpRegistration(options, cliPath, deps.execPath);
    if (!entry) {
        log('warn', 'mcp_register_template_path_refused', { server: SLIDES_MCP_SERVER_NAME });
        return 'template_path_refused';
    }
    ctx.effect(() => {
        let dispose;
        try {
            dispose = manager.register(SLIDES_MCP_SERVER_NAME, entry);
            log('info', 'mcp_registered', { server: SLIDES_MCP_SERVER_NAME });
        }
        catch (error) {
            log('warn', 'mcp_register_failed', {
                server: SLIDES_MCP_SERVER_NAME,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
        return () => {
            try {
                dispose?.();
            }
            catch (error) {
                log('warn', 'mcp_unregister_failed', { reason: error instanceof Error ? error.message : String(error) });
            }
        };
    });
    return 'registered';
}
//# sourceMappingURL=mcp-register.js.map