import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { copyPackagedConfig, PUBLISHED_FILES } from '../scripts/release.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('release package', () => {
  it('includes config/feature-flags.json in the packed tarball', () => {
    expect(PUBLISHED_FILES).toContain('config')
    const stage = mkdtempSync(path.join(tmpdir(), 'slidestudio-pack-'))
    scratch.push(stage)
    const pkg = path.join(stage, 'package')
    mkdirSync(pkg, { recursive: true })
    copyPackagedConfig(pkg)
    expect(readFileSync(path.join(pkg, 'config/feature-flags.json'), 'utf8')).toBe(
      readFileSync(path.join(repoRoot, 'config/feature-flags.json'), 'utf8'),
    )
    writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'dsh-slidestudio', version: '0.0.0', files: PUBLISHED_FILES }),
    )
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: pkg,
        encoding: 'utf8',
      }),
    ) as Array<{ files: Array<{ path: string }> }>
    expect(packed[0].files.map((file) => file.path)).toContain('config/feature-flags.json')
  })
})
