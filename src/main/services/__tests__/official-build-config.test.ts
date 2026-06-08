import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('official build config', () => {
  it('does not infer official builds from git remotes', () => {
    const configSource = readFileSync(resolve(process.cwd(), 'electron.vite.config.ts'), 'utf8')

    expect(configSource).not.toContain('child_process')
    expect(configSource).not.toContain('git')
    expect(configSource).not.toContain('remote')
    expect(configSource).not.toContain('get-url')
  })
})
