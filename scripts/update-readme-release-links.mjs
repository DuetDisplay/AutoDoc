import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function updateReadmeReleaseLinks(readme, { releaseTag, dmgAsset, windowsAsset }) {
  const version = releaseTag.replace(/^v/, '')
  const badgeVersion = releaseTag.replace(/-/g, '--')
  const releasePageUrl = 'https://github.com/DuetDisplay/AutoDoc/releases/latest'
  const dmgUrl = `https://github.com/DuetDisplay/AutoDoc/releases/download/${releaseTag}/${dmgAsset}`
  const windowsUrl = `https://github.com/DuetDisplay/AutoDoc/releases/download/${releaseTag}/${windowsAsset}`
  const releaseBadgeUrl = `https://img.shields.io/badge/release-${badgeVersion}-7A9E7E?style=flat-square&labelColor=555555`

  function replaceRequired(pattern, replacement, description) {
    if (!pattern.test(readme)) {
      throw new Error(`Could not find ${description} in README.md`)
    }

    readme = readme.replace(pattern, replacement)
  }

  replaceRequired(
    /\[!\[Download AutoDoc for macOS\]\(docs\/assets\/badges\/download-macos\.svg\)\]\([^)]+\)/,
    `[![Download AutoDoc for macOS](docs/assets/badges/download-macos.svg)](${dmgUrl})`,
    'header macOS download badge link'
  )

  replaceRequired(
    /(?:\[!\[Download AutoDoc for Windows\]\(docs\/assets\/badges\/download-windows\.svg\)\]\([^)]+\)|<img src="docs\/assets\/badges\/windows-coming-soon\.svg" alt="Windows Coming Soon!" \/>)/,
    `[![Download AutoDoc for Windows](docs/assets/badges/download-windows.svg)](${windowsUrl})`,
    'header Windows download badge or coming-soon marker'
  )

  replaceRequired(
    /\[!\[Latest release\]\(https:\/\/img\.shields\.io\/badge\/release-[^)]+\)\]\(https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/latest\)/,
    `[![Latest release](${releaseBadgeUrl})](${releasePageUrl})`,
    'latest release badge'
  )

  replaceRequired(
    /^## \[.*Download AutoDoc for macOS\]\([^)]+\)$/m,
    `## [⬇️ Download AutoDoc for macOS](${dmgUrl})`,
    'download section heading link'
  )

  replaceRequired(
    /^1\. \*\*Download\*\* .*$/m,
    `1. **Download** \`${dmgAsset}\`, or browse the [Releases](${releasePageUrl}) page for a specific version.`,
    'download install step'
  )

  return { readme, version }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  const releaseTag = process.env.RELEASE_TAG?.trim()
  const dmgAsset = process.env.DMG_ASSET?.trim()
  const windowsAsset = process.env.WINDOWS_ASSET?.trim()

  if (!releaseTag) {
    throw new Error('RELEASE_TAG is required')
  }

  if (!dmgAsset) {
    throw new Error('DMG_ASSET is required')
  }

  if (!windowsAsset) {
    throw new Error('WINDOWS_ASSET is required')
  }

  const readmePath = new URL('../README.md', import.meta.url)
  const currentReadme = fs.readFileSync(readmePath, 'utf8')
  const result = updateReadmeReleaseLinks(currentReadme, {
    releaseTag,
    dmgAsset,
    windowsAsset
  })

  fs.writeFileSync(readmePath, result.readme)
  console.log(
    `Updated README.md for ${releaseTag} (${dmgAsset}, ${windowsAsset}, version ${result.version})`
  )
}
