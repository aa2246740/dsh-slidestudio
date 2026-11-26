import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerSlidesMcp,
  resolveSlidesMcpCli,
  SLIDES_MCP_SERVER_NAME,
  type McpRegisterContext,
  type SlidesMcpRegistration,
} from './mcp-register.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const OPTIONS = { repoRoot: '/repo', dataRoot: '/data', editorOrigin: 'http://127.0.0.1:56200' }
const BUNDLED_CLI = '/repo/node_modules/@open-slidestudio/slides-mcp/dist/cli.js'

function fakeContext(services: Record<string, unknown> = {}) {
  const disposers: Array<() => void> = []
  const ctx: McpRegisterContext = {
    get: (name) => services[name],
    effect(execute) {
      disposers.push(execute())
      return undefined
    },
  }
  return { ctx, disposers }
}

function deps(overrides: Record<string, unknown> = {}) {
  const log = vi.fn()
  return {
    log,
    deps: {
      flagEnabled: () => true,
      exists: (file: string) => file === BUNDLED_CLI,
      execPath: '/usr/bin/node',
      log,
      ...overrides,
    },
  }
}

describe('optional DSH mcpManager.register integration', () => {
  it('does nothing while the mcp_register flag is off (the default)', () => {
    const register = vi.fn()
    const { ctx, disposers } = fakeContext({ mcpManager: { register } })
    const { deps: d, log } = deps({ flagEnabled: () => false })
    expect(registerSlidesMcp(ctx, OPTIONS, d)).toBe('disabled')
    expect(register).not.toHaveBeenCalled()
    expect(disposers).toHaveLength(0)
    expect(log).not.toHaveBeenCalled()
  })

  it('reads the flag from config/feature-flags.json and its env override', () => {
    const root = mkdtempSync(join(tmpdir(), 'slidestudio-mcp-flag-'))
    scratch.push(root)
    mkdirSync(join(root, 'config'))
    writeFileSync(
      join(root, 'config/feature-flags.json'),
      JSON.stringify({ flags: { mcp_register: { default: false } } }),
    )
    const register = vi.fn(() => () => {})
    const { ctx } = fakeContext({ mcpManager: { register } })
    const d = { exists: () => false, log: vi.fn() }
    const options = { ...OPTIONS, repoRoot: root }
    expect(registerSlidesMcp(ctx, options, d)).toBe('disabled')
    vi.stubEnv('SLIDESTUDIO_FLAG_MCP_REGISTER', '1')
    try {
      expect(registerSlidesMcp(ctx, options, d)).toBe('slides_mcp_cli_missing')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('degrades on DSH rc.2: no mcpManager, or a manager without register, logs a warning and returns', () => {
    for (const services of [{}, { mcpManager: { list: () => [] } }]) {
      const { ctx, disposers } = fakeContext(services)
      const { deps: d, log } = deps()
      expect(registerSlidesMcp(ctx, OPTIONS, d)).toBe('mcp_manager_unavailable')
      expect(disposers).toHaveLength(0)
      expect(log).toHaveBeenCalledWith('warn', 'mcp_manager_unavailable', { server: SLIDES_MCP_SERVER_NAME })
    }
  })

  it('skips with a warning when the slides-mcp CLI is not built or bundled', () => {
    const register = vi.fn()
    const { ctx } = fakeContext({ mcpManager: { register } })
    const { deps: d, log } = deps({ exists: () => false })
    expect(registerSlidesMcp(ctx, OPTIONS, d)).toBe('slides_mcp_cli_missing')
    expect(register).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('warn', 'slides_mcp_cli_missing', { server: SLIDES_MCP_SERVER_NAME })
  })

  it('registers a strict rc.5 stdio McpServerRegistration and disposes it with the plugin', () => {
    const unregister = vi.fn()
    const register = vi.fn((_name: string, _entry: SlidesMcpRegistration) => unregister)
    const { ctx, disposers } = fakeContext({ mcpManager: { register } })
    const { deps: d } = deps()
    expect(registerSlidesMcp(ctx, OPTIONS, d)).toBe('registered')
    expect(register).toHaveBeenCalledTimes(1)
    const [name, entry] = register.mock.calls[0]!
    expect(name).toBe('slidestudio')
    expect(entry).toEqual({
      transport: 'stdio',
      command: '/usr/bin/node',
      args: [BUNDLED_CLI, '--data-root', '/data', '--editor-url', 'http://127.0.0.1:56200'],
      cwd: '/repo',
    })
    expect(Object.keys(entry).sort()).toEqual(['args', 'command', 'cwd', 'transport'])
    expect(JSON.stringify(entry)).not.toContain('${')
    expect(unregister).not.toHaveBeenCalled()
    for (const dispose of disposers) dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it('contains a register failure such as a user-configured server with the same name', () => {
    const register = vi.fn(() => {
      throw new Error('server name "slidestudio" is already configured')
    })
    const { ctx, disposers } = fakeContext({ mcpManager: { register } })
    const { deps: d, log } = deps()
    expect(() => registerSlidesMcp(ctx, OPTIONS, d)).not.toThrow()
    expect(log).toHaveBeenCalledWith(
      'warn',
      'mcp_register_failed',
      expect.objectContaining({ server: 'slidestudio', reason: expect.stringContaining('already configured') }),
    )
    expect(() => disposers.forEach((dispose) => dispose())).not.toThrow()
  })

  it('prefers the bundled CLI and falls back to the checkout workspace build', () => {
    expect(resolveSlidesMcpCli('/repo', (file) => file === BUNDLED_CLI)).toBe(BUNDLED_CLI)
    const checkout = '/repo/packages/slides-mcp/dist/cli.js'
    expect(resolveSlidesMcpCli('/repo', (file) => file === checkout)).toBe(checkout)
    expect(resolveSlidesMcpCli('/repo', () => false)).toBeUndefined()
  })

  it('base64url-encodes dataRoot containing ${...} template syntax so rc.5 neither rejects nor substitutes credentials', () => {
    for (const dataRoot of ['/tmp/${foo}/data', '/tmp/${credential:OPENAI_API_KEY}/data']) {
      const register = vi.fn(() => () => {})
      const { ctx } = fakeContext({ mcpManager: { register } })
      const { deps: d } = deps()
      expect(registerSlidesMcp(ctx, { ...OPTIONS, dataRoot }, d)).toBe('registered')
      const [, entry] = register.mock.calls[0]!
      expect(JSON.stringify(entry)).not.toContain('${')
      expect(entry.cwd).toBeUndefined()
      expect(entry.args[0]).toBe(BUNDLED_CLI)
      expect(entry.args[1]).toBe('--config-b64')
      const decoded = JSON.parse(Buffer.from(entry.args[2]!, 'base64url').toString('utf8')) as Record<string, string>
      expect(decoded).toEqual({
        dataRoot,
        editorBaseUrl: OPTIONS.editorOrigin,
        repoRoot: OPTIONS.repoRoot,
      })
    }
  })

  it('fails closed when execPath or cliPath itself contains ${...} template syntax', () => {
    for (const bad of [
      { opts: { ...OPTIONS, repoRoot: '/tmp/${credential:SECRET}/repo' }, extra: { exists: () => true } },
      { opts: OPTIONS, extra: { execPath: '/tmp/${foo}/node' } },
    ]) {
      const register = vi.fn()
      const { ctx, disposers } = fakeContext({ mcpManager: { register } })
      const { deps: d, log } = deps(bad.extra)
      expect(registerSlidesMcp(ctx, bad.opts, d)).toBe('template_path_refused')
      expect(register).not.toHaveBeenCalled()
      expect(disposers).toHaveLength(0)
      expect(log).toHaveBeenCalledWith('warn', 'mcp_register_template_path_refused', { server: SLIDES_MCP_SERVER_NAME })
    }
  })
})
