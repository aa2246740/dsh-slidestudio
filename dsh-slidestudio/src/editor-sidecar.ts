import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { logger } from './logger.js'

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

/** Lazily spawns the editor sidecar on its own loopback port. */
export function startEditorSidecar(repoRoot: string, dataRoot: string, port: number): ChildProcess | undefined {
  const server = join(repoRoot, 'apps/native-web/src/server.mjs')
  if (!existsSync(server)) {
    logger.log('warn', 'editor_sidecar_missing')
    return undefined
  }
  const child = spawn(process.execPath, [server], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), OPEN_SLIDESTUDIO_ROOT: repoRoot, SLIDESTUDIO_DATA_DIR: dataRoot },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  child.on('error', (error) => {
    logger.error(error, { operation: 'editor_sidecar_start' })
  })
  child.on('exit', (code, signal) => {
    logger.log('warn', 'editor_sidecar_exit', { code, signal })
  })
  return child
}

/** Pipes one request to the editor sidecar; mirrors the standalone shell's product proxy. */
export function proxyToSidecar(req: IncomingMessage, res: ServerResponse, editorOrigin: string): void {
  const upstream = new URL(req.url ?? '/', editorOrigin)
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lowered = key.toLowerCase()
    if (HOP_HEADERS.has(lowered) || value === undefined) continue
    headers[lowered] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  headers.host = upstream.host
  // The sidecar rejects cross-site mutations when Origin disagrees with Host;
  // the host's own guard already covers the browser-to-host hop, so present the
  // request to the sidecar as same-origin.
  headers.origin = upstream.origin
  const proxy = httpRequest(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: `${upstream.pathname}${upstream.search}`,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )
  proxy.setTimeout(30_000, () => proxy.destroy(new Error('editor sidecar timeout')))
  req.on('aborted', () => proxy.destroy())
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end('editor sidecar unreachable')
  })
  req.pipe(proxy)
}
