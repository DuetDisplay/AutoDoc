import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { load } = require('js-yaml')
const root = process.cwd()
const config = load(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8'))

describe('Windows speech packaging', () => {
  it.each([
    'resources/transcription-worker.py',
    'resources/whisper_turbo_contract.py',
    'resources/whisper-cpp-turbo-transcribe.py'
  ])('includes %s on disk for the Python runtime', (relativePath) => {
    const filePath = resolve(root, relativePath)
    const stat = statSync(filePath)
    for (const patterns of [config.files, config.asarUnpack]) {
      const filter = new FileMatcher(root, root, (pattern) => pattern, patterns).createFilter()
      expect(filter(filePath, stat)).toBe(true)
    }
  })
})
