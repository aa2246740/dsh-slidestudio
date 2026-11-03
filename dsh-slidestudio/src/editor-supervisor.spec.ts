import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./editor-sidecar.js', () => ({
  startEditorSidecar: vi.fn(),
  proxyToSidecar: vi.fn(),
}))
vi.mock('./sidecar-ready.js', () => ({
  waitForEditor: vi.fn(async () => true),
}))
vi.mock('@open-slidestudio/dsh-slides-host', () => ({ apply: vi.fn() }))
vi.mock('./logger.js', () => ({
  logger: { log: vi.fn(), error: vi.fn(), observe: vi.fn(), snapshot: () => ({ app: 'slidestudio-plugin' }) },
}))
vi.mock('./slides-preset.js', () => ({ registerSlidesPreset: vi.fn() }))
vi.mock('./data-directory.js', () => ({ resolveDataDirectory: () => '/tmp/data' }))

import { createEditorSupervisor } from './dsh-slidestudio.js'

function fakeChild() {
  const child = new EventEmitter() as ChildProcess
  child.killed = false
  child.exitCode = null
  child.kill = ((signal?: NodeJS.Signals | number) => {
    void signal
    child.killed = true
    child.exitCode = 1
    child.emit('exit', 1, null)
    return true
  }) as ChildProcess['kill']
  return child
}

describe('editor sidecar supervisor', () => {
  it('resets the port and retries after an unexpected exit once the cooldown elapses', async () => {
    let clock = 1_000
    const ports: number[] = []
    const children: ChildProcess[] = []
    const supervisor = createEditorSupervisor({
      repoRoot: '/repo',
      dataRoot: '/data',
      port: 56200,
      cooldownMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      start: (_root, _data, port) => {
        ports.push(port)
        const child = fakeChild()
        children.push(child)
        return child
      },
      wait: async () => true,
    })

    expect(await supervisor.ensure()).toBe(true)
    expect(supervisor.origin()).toBe('http://127.0.0.1:56200')
    children[0].emit('exit', 1, null)
    expect(await supervisor.ensure()).toBe(true)
    expect(ports).toEqual([56200, 56200])
    expect(clock).toBe(1_500)
    expect(supervisor.origin()).toBe('http://127.0.0.1:56200')
  })

  it('does not latch a failed health check', async () => {
    let clock = 0
    let attempts = 0
    const supervisor = createEditorSupervisor({
      repoRoot: '/repo',
      dataRoot: '/data',
      port: 56200,
      cooldownMs: 200,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      start: () => fakeChild(),
      wait: async () => {
        attempts += 1
        return attempts > 1
      },
    })

    expect(await supervisor.ensure()).toBe(false)
    expect(await supervisor.ensure()).toBe(true)
    expect(attempts).toBe(2)
    expect(supervisor.origin()).toBe('http://127.0.0.1:56200')
  })
})
