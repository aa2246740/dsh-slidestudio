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

  it('does not spawn again after stop during cooldown or after disposal', async () => {
    let clock = 0
    const ports: number[] = []
    const children: ChildProcess[] = []
    let releaseSleep: () => void = () => {}
    let sleepStarted: () => void = () => {}
    const sleepStartedP = new Promise<void>((resolve) => {
      sleepStarted = resolve
    })
    const supervisor = createEditorSupervisor({
      repoRoot: '/repo',
      dataRoot: '/data',
      port: 56200,
      cooldownMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        sleepStarted()
        await new Promise<void>((resolve) => {
          releaseSleep = resolve
        })
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
    children[0].emit('exit', 1, null)
    const restarted = supervisor.ensure()
    await sleepStartedP
    await supervisor.stop()
    releaseSleep()
    expect(await restarted).toBe(false)
    expect(ports).toEqual([56200])
    expect(await supervisor.ensure()).toBe(false)
    expect(ports).toEqual([56200])
  })

  it('kills an in-flight restart when stop races the health check', async () => {
    const children: ChildProcess[] = []
    let releaseWait: (ok: boolean) => void = () => {}
    const waitGate = new Promise<boolean>((resolve) => {
      releaseWait = resolve
    })
    let waitStarted: () => void = () => {}
    const waitStartedP = new Promise<void>((resolve) => {
      waitStarted = resolve
    })
    const supervisor = createEditorSupervisor({
      repoRoot: '/repo',
      dataRoot: '/data',
      port: 56200,
      cooldownMs: 0,
      start: () => {
        const child = fakeChild()
        children.push(child)
        return child
      },
      wait: () => {
        waitStarted()
        return waitGate
      },
    })

    const pending = supervisor.ensure()
    await waitStartedP
    await supervisor.stop()
    releaseWait(true)
    expect(await pending).toBe(false)
    expect(children).toHaveLength(1)
    expect(children[0].exitCode).not.toBeNull()
    expect(await supervisor.ensure()).toBe(false)
    expect(children).toHaveLength(1)
  })

  it('escalates to SIGKILL when health failure is ignored and stop can still reach the child', async () => {
    const signals: Array<NodeJS.Signals | number> = []
    const child = new EventEmitter() as ChildProcess
    child.killed = false
    child.exitCode = null
    child.signalCode = null
    child.kill = ((signal?: NodeJS.Signals | number) => {
      const name = signal ?? 'SIGTERM'
      signals.push(name)
      if (name === 'SIGKILL' || name === 9) {
        child.killed = true
        child.exitCode = 1
        child.signalCode = 'SIGKILL'
        child.emit('exit', 1, 'SIGKILL')
      }
      return true
    }) as ChildProcess['kill']
    let releaseWait: (ok: boolean) => void = () => {}
    const waitGate = new Promise<boolean>((resolve) => {
      releaseWait = resolve
    })
    let waitStarted: () => void = () => {}
    const waitStartedP = new Promise<void>((resolve) => {
      waitStarted = resolve
    })
    const supervisor = createEditorSupervisor({
      repoRoot: '/repo',
      dataRoot: '/data',
      port: 56200,
      cooldownMs: 0,
      killGraceMs: 30,
      start: () => child,
      wait: () => {
        waitStarted()
        return waitGate
      },
    })

    const pending = supervisor.ensure()
    await waitStartedP
    releaseWait(false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(signals).toEqual(['SIGTERM'])
    expect(child.exitCode).toBeNull()
    await supervisor.stop()
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.exitCode).toBe(1)
    expect(await pending).toBe(false)
    expect(await supervisor.ensure()).toBe(false)
  })
})
