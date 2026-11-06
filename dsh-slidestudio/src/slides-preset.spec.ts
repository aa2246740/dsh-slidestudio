import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { registerSlidesPreset } from './slides-preset.js'

it('registers a slides persona without runtime template variables', () => {
  const register = vi.fn(
    (_definition: {
      id: string
      plugins: Array<{
        id: string
        config?: { prefix: string; complete: boolean; includeRuntimeContext: boolean }
      }>
    }) =>
      () => {},
  )
  const ctx = {
    get: () => ({ register }),
    effect: (setup: () => () => void) => setup(),
  } as unknown as Context

  registerSlidesPreset(ctx)

  expect(register).toHaveBeenCalledOnce()
  const [preset] = register.mock.calls[0]!
  expect(preset.id).toBe('slides')
  const persona = preset.plugins.find((plugin) => plugin.id === 'persona')?.config
  expect(persona?.prefix).toMatch(/^You are the DSH SlideStudio slides director\./)
  expect(persona?.prefix).not.toMatch(/\{\{[^}]+\}\}/)
  expect(persona?.complete).toBe(true)
  expect(persona?.includeRuntimeContext).toBe(false)
})
