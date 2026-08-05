import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function updateReadmeReleaseLinks(readme, { releaseTag, dmgAsset, windowsAsset }) {
  const version = releaseTag.replace(/^v/, '')
  const releasePageUrl = 'https://github.com/DuetDisplay/AutoDoc/releases/latest'
  const dmgUrl = `https://github.com/DuetDisplay/AutoDoc/releases/download/${releaseTag}/${dmgAsset}`
  const windowsUrl = `https://github.com/DuetDisplay/AutoDoc/releases/download/${releaseTag}/${windowsAsset}`

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
    /^## \[.*Download AutoDoc for macOS\]\([^)]+\)$/m,
    `## [⬇️ Download AutoDoc for macOS](${dmgUrl})`,
    'download section heading link'
  )

  replaceRequired(
    /^1\. (?:\*\*Download(?: for macOS)?\*\*|On the \[latest release\]\([^)]+\), download (?:the macOS\b|`[^`]+\.dmg`)).*$/m,
    `1. On the [latest release](${releasePageUrl}), download \`${dmgAsset}\`.`,
    'macOS download install step'
  )

  replaceRequired(
    /^## \[.*Download AutoDoc for Windows\]\([^)]+\)$/m,
    `## [⬇️ Download AutoDoc for Windows](${windowsUrl})`,
    'Windows download section heading link'
  )

  replaceRequired(
    /^1\. (?:\*\*Download for Windows\*\*|On the \[latest release\]\([^)]+\), download (?:the Windows\b|`[^`]+-setup\.exe`)).*$/m,
    `1. On the [latest release](${releasePageUrl}), download \`${windowsAsset}\`.`,
    'Windows download install step'
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
