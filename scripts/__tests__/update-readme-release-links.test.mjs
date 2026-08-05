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
[![Download AutoDoc for macOS](docs/assets/badges/download-macos.svg)](https://github.com/DuetDisplay/AutoDoc/releases/latest) [![Download AutoDoc for Windows](docs/assets/badges/download-windows.svg)](https://github.com/DuetDisplay/AutoDoc/releases/latest)

[![Latest release](https://img.shields.io/github/v/release/DuetDisplay/AutoDoc?style=flat-square&label=release&color=7A9E7E&labelColor=555555)](https://github.com/DuetDisplay/AutoDoc/releases/latest)

## [⬇️ Download AutoDoc for macOS](https://github.com/DuetDisplay/AutoDoc/releases/latest)

1. On the [latest release](https://github.com/DuetDisplay/AutoDoc/releases/latest), download the macOS \`.dmg\` asset.

## [⬇️ Download AutoDoc for Windows](https://github.com/DuetDisplay/AutoDoc/releases/latest)

1. On the [latest release](https://github.com/DuetDisplay/AutoDoc/releases/latest), download the Windows \`.exe\` installer asset.
`

test('updates both platform assets with the current README layout', () => {
  const { readme, version } = updateReadmeReleaseLinks(originalReadme, release)

  assert.equal(version, '1.1.0')
  assert.match(readme, /releases\/download\/v1\.1\.0\/autodoc-1\.1\.0\.dmg/)
  assert.match(readme, /releases\/download\/v1\.1\.0\/autodoc-1\.1\.0-setup\.exe/)
  assert.match(readme, /download `autodoc-1\.1\.0\.dmg`/)
  assert.match(readme, /download `autodoc-1\.1\.0-setup\.exe`/)
  assert.match(readme, /img\.shields\.io\/github\/v\/release\/DuetDisplay\/AutoDoc/)
})

test('is idempotent once both download badges exist', () => {
  const first = updateReadmeReleaseLinks(originalReadme, release).readme
  const second = updateReadmeReleaseLinks(first, release).readme

  assert.equal(second, first)
})

test('continues to support legacy download markers', () => {
  const legacyReadme = originalReadme
    .replace(
      '[![Download AutoDoc for Windows](docs/assets/badges/download-windows.svg)](https://github.com/DuetDisplay/AutoDoc/releases/latest)',
      '<img src="docs/assets/badges/windows-coming-soon.svg" alt="Windows Coming Soon!" />'
    )
    .replace(
      '1. On the [latest release](https://github.com/DuetDisplay/AutoDoc/releases/latest), download the macOS `.dmg` asset.',
      '1. **Download for macOS** `autodoc-1.0.0.dmg`.'
    )
    .replace(
      '1. On the [latest release](https://github.com/DuetDisplay/AutoDoc/releases/latest), download the Windows `.exe` installer asset.',
      '1. **Download for Windows** `autodoc-1.0.0-setup.exe`.'
    )

  const { readme } = updateReadmeReleaseLinks(legacyReadme, release)

  assert.match(readme, /autodoc-1\.1\.0\.dmg/)
  assert.match(readme, /autodoc-1\.1\.0-setup\.exe/)
  assert.doesNotMatch(readme, /windows-coming-soon\.svg/)
})

test('supports the current repository README layout', () => {
  const currentReadme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  const { readme } = updateReadmeReleaseLinks(currentReadme, release)

  assert.match(readme, /releases\/download\/v1\.1\.0\/autodoc-1\.1\.0\.dmg/)
  assert.match(readme, /autodoc-1\.1\.0-setup\.exe/)
  assert.match(readme, /img\.shields\.io\/github\/v\/release\/DuetDisplay\/AutoDoc/)
})
