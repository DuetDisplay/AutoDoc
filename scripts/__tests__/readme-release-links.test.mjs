import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { verifyReadmeReleaseLinks } from '../update-readme-release-links.mjs'

const latestReleaseUrl = 'https://github.com/DuetDisplay/AutoDoc/releases/latest'

const requiredLines = [
  `[![Download AutoDoc for macOS](docs/assets/badges/download-macos.svg)](${latestReleaseUrl})`,
  `[![Download AutoDoc for Windows](docs/assets/badges/download-windows.svg)](${latestReleaseUrl})`,
  `[![Latest release](https://img.shields.io/github/v/release/DuetDisplay/AutoDoc?style=flat-square&label=release&color=7A9E7E&labelColor=555555)](${latestReleaseUrl})`,
  `## [⬇️ View the latest AutoDoc release](${latestReleaseUrl})`,
  `## [⬇️ Download AutoDoc for macOS](${latestReleaseUrl})`,
  `1. On the [latest release](${latestReleaseUrl}), download the macOS \`.dmg\` asset.`,
  `## [⬇️ Download AutoDoc for Windows](${latestReleaseUrl})`,
  `1. On the [latest release](${latestReleaseUrl}), download the Windows \`.exe\` installer asset.`
]

const canonicalReadme = requiredLines.join('\n\n')
const scriptPath = fileURLToPath(new URL('../update-readme-release-links.mjs', import.meta.url))
const readmePath = new URL('../../README.md', import.meta.url)

test('accepts the current repository README without modifying it', () => {
  const before = fs.readFileSync(readmePath, 'utf8')
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8'
  })
  const after = fs.readFileSync(readmePath, 'utf8')

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Verified 8 stable README release links/)
  assert.equal(after, before)
  assert.equal(verifyReadmeReleaseLinks(before).verifiedMarkerCount, 8)
})

for (const requiredLine of requiredLines) {
  test(`rejects a missing required marker: ${requiredLine.slice(0, 48)}`, () => {
    const incompleteReadme = canonicalReadme.replace(requiredLine, '')

    assert.throws(
      () => verifyReadmeReleaseLinks(incompleteReadme),
      /must contain exactly one .+; found 0/
    )
  })
}

test('rejects duplicate release markers', () => {
  const duplicateReadme = `${canonicalReadme}\n\n${requiredLines[0]}`

  assert.throws(
    () => verifyReadmeReleaseLinks(duplicateReadme),
    /must contain exactly one macOS header download badge linked to the latest release; found 2/
  )
})

const forbiddenValues = [
  'https://github.com/DuetDisplay/AutoDoc/releases/download/v1.1.1/autodoc-1.1.1.dmg',
  'autodoc-1.1.1.dmg',
  'autodoc-1.1.1-setup.exe',
  'https://img.shields.io/badge/release-v1.1.1-7A9E7E',
  'docs/assets/badges/windows-coming-soon.svg'
]

for (const forbiddenValue of forbiddenValues) {
  test(`rejects obsolete release-specific content: ${forbiddenValue}`, () => {
    assert.throws(
      () => verifyReadmeReleaseLinks(`${canonicalReadme}\n${forbiddenValue}`),
      /README\.md must not contain/
    )
  })
}
