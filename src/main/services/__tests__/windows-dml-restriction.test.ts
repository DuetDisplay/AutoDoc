import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readDmlRestriction, writeDmlRestriction } from '../windows-dml-restriction'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('pins only the failed recording and retains its pin across subsequent reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autodoc-recovery-test-'))
  roots.push(root)
  const first = join(root, 'first')
  const second = join(root, 'second')
  await mkdir(first)
  await mkdir(second)
  const pin = join(first, 'transcription-recovery.json')
  const metadata = join(first, 'metadata.json')
  await writeFile(metadata, 'keep')
  expect(await readDmlRestriction(pin)).toBeNull()
  await writeDmlRestriction(pin)
  expect(await readDmlRestriction(pin)).toEqual({
    version: 1,
    backend: 'parakeet-cpu',
    reason: 'gpu-failure'
  })
  expect(await readDmlRestriction(join(second, 'transcription-recovery.json'))).toBeNull()
  expect(await readDmlRestriction(pin)).not.toBeNull()
  expect(await readFile(metadata, 'utf8')).toBe('keep')
})

it('does not silently discard corrupt or unsupported pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autodoc-recovery-test-'))
  roots.push(root)
  const file = join(root, 'transcription-recovery.json')
  for (const value of ['{', '{"version":2}', 'null', '{"version":1,"backend":"parakeet-gpu"}']) {
    await writeFile(file, value)
    await expect(readDmlRestriction(file)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(value)
  }
})
