import fs from 'node:fs'

const releaseTag = process.env.RELEASE_TAG?.trim()
const dmgAsset = process.env.DMG_ASSET?.trim()

if (!releaseTag) {
  throw new Error('RELEASE_TAG is required')
}

if (!dmgAsset) {
  throw new Error('DMG_ASSET is required')
}

const readmePath = new URL('../README.md', import.meta.url)
const version = releaseTag.replace(/^v/, '')
const badgeVersion = releaseTag.replace(/-/g, '--')
const releasePageUrl = 'https://github.com/DuetDisplay/AutoDoc/releases/latest'
const dmgUrl = `https://github.com/DuetDisplay/AutoDoc/releases/download/${releaseTag}/${dmgAsset}`
const releaseBadgeUrl = `https://img.shields.io/badge/release-${badgeVersion}-7A9E7E?style=flat-square&labelColor=555555`

let readme = fs.readFileSync(readmePath, 'utf8')

function replaceRequired(pattern, replacement, description) {
  if (!pattern.test(readme)) {
    throw new Error(`Could not find ${description} in README.md`)
  }

  readme = readme.replace(pattern, replacement)
}

replaceRequired(
  /\[!\[Download AutoDoc for macOS\]\(docs\/assets\/badges\/download-macos\.svg\)\]\([^)]+\)/,
  `[![Download AutoDoc for macOS](docs/assets/badges/download-macos.svg)](${dmgUrl})`,
  'header download badge link'
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

fs.writeFileSync(readmePath, readme)
console.log(`Updated README.md for ${releaseTag} (${dmgAsset}, version ${version})`)
