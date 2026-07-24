import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { updateReadmeReleaseLinks } from '../update-readme-release-links.mjs'

const release = {
  releaseTag: 'v1.1.0',
  dmgAsset: 'autodoc-1.1.0.dmg',
  windowsAsset: 'autodoc-1.1.0-setup.exe'
}

const originalReadme = `
[![Download AutoDoc for macOS](docs/assets/badges/download-macos.svg)](https://example.com/old.dmg) <img src="docs/assets/badges/windows-coming-soon.svg" alt="Windows Coming Soon!" />

[![Latest release](https://img.shields.io/badge/release-v1.0.0-7A9E7E?style=flat-square&labelColor=555555)](https://github.com/DuetDisplay/AutoDoc/releases/latest)

## [⬇️ Download AutoDoc for macOS](https://example.com/old.dmg)

1. **Download** \`autodoc-1.0.0.dmg\`.
`

test('updates both platform assets and the release badge', () => {
  const { readme, version } = updateReadmeReleaseLinks(originalReadme, release)

  assert.equal(version, '1.1.0')
  assert.match(readme, /releases\/download\/v1\.1\.0\/autodoc-1\.1\.0\.dmg/)
  assert.match(readme, /releases\/download\/v1\.1\.0\/autodoc-1\.1\.0-setup\.exe/)
  assert.match(readme, /release-v1\.1\.0-/)
  assert.doesNotMatch(readme, /Windows Coming Soon/)
})

test('is idempotent once both download badges exist', () => {
  const first = updateReadmeReleaseLinks(originalReadme, release).readme
  const second = updateReadmeReleaseLinks(first, release).readme

  assert.equal(second, first)
})

test('supports the current repository README layout', () => {
  const currentReadme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  const { readme } = updateReadmeReleaseLinks(currentReadme, release)

  assert.match(readme, /autodoc-1\.1\.0-setup\.exe/)
  assert.doesNotMatch(readme, /windows-coming-soon\.svg/)
})
