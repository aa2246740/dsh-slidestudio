import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDataDirectory } from './data-directory.js'
import { waitForEditor } from './sidecar-ready.js'
import { logger } from './logger.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'slidestudio-lifecycle-'))
  scratch.push(dir)
  return { dir, home: join(dir, 'home'), product: join(dir, 'product') }
}

describe('plugin workspace lifecycle', () => {
  it('keeps state outside the versioned install and reuses the saved directory', () => {
    const { home, product } = fixture()
    const root = resolveDataDirectory(product, home)
    expect(root).toBe(join(home, 'data/dsh-slidestudio/workspace'))
    expect(resolveDataDirectory(join(product, 'new-version'), home)).toBe(root)
    expect(JSON.parse(readFileSync(join(home, 'data/dsh-slidestudio/workspace.json'), 'utf8')).root).toBe(root)
  })
  it('preserves linked projects and accepts only absolute overrides', () => {
    const { dir, home, product } = fixture()
    mkdirSync(join(product, 'output/dsh-slices'), { recursive: true })
    expect(resolveDataDirectory(product, home)).toBe(product)
    expect(resolveDataDirectory(product, home, join(dir, 'override'))).toBe(join(dir, 'override'))
    expect(() => resolveDataDirectory(product, home, 'relative')).toThrow('absolute')
  })
  it('fails explicitly on corrupt pointers or missing user work', () => {
    const { home, product, dir } = fixture()
    const state = join(home, 'data/dsh-slidestudio')
    mkdirSync(state, { recursive: true })
    const pointer = join(state, 'workspace.json')
    writeFileSync(pointer, '{"root":"relative"}')
    expect(() => resolveDataDirectory(product, home)).toThrow('Invalid')
    writeFileSync(pointer, JSON.stringify({ root: join(dir, 'missing') }))
    expect(() => resolveDataDirectory(product, home)).toThrow('missing')
  })
  it('uses a dedicated categorical logger without private provider messages', () => {
    const sink = vi.spyOn(console, 'log').mockImplementation(() => {})
    logger.error(new Error('private slide prompt'))
    logger.log('info', 'plugin_loaded')
    expect(sink.mock.calls.flat().join('')).not.toContain('private slide prompt')
    expect(logger.snapshot().app).toBe('slidestudio-plugin')
  })
})

describe('plugin sidecar HTTP integration', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
  })
  it('waits for a delayed startup and does not accept an unhealthy response', async () => {
    server = createServer((_req, res) => {
      res.writeHead(503)
      res.end()
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test port missing')
    const origin = `http://127.0.0.1:${address.port}`
    expect(await waitForEditor(origin, 120)).toBe(false)
    server.removeAllListeners('request')
    server.on('request', (_req, res) => {
      res.writeHead(200)
      res.end('{}')
    })
    expect(await waitForEditor(origin, 500)).toBe(true)
  })
  it('bounds startup when no sidecar is listening', async () => {
    server = createServer()
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test port missing')
    const port = address.port
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    expect(await waitForEditor(`http://127.0.0.1:${port}`, 120)).toBe(false)
  })
})
