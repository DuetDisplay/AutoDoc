import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Historical release workflows invoke this file after checking out current main.
// Keep it as a read-only compatibility entry point so those reruns can finish
// without attempting to push generated documentation to the protected branch.
const requiredMarkers = [
  {
    description: 'macOS header download badge linked to the latest release',
    pattern:
      /\[!\[Download AutoDoc for macOS\]\(docs\/assets\/badges\/download-macos\.svg\)\]\(https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/latest\)/g
  },
  {
    description: 'Windows header download badge linked to the latest release',
    pattern:
      /\[!\[Download AutoDoc for Windows\]\(docs\/assets\/badges\/download-windows\.svg\)\]\(https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/latest\)/g
  },
  {
    description: 'dynamic latest-release badge',
    pattern:
      /\[!\[Latest release\]\(https:\/\/img\.shields\.io\/github\/v\/release\/DuetDisplay\/AutoDoc\?[^)\n]+\)\]\(https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/latest\)/g
  },
  {
    description: 'central latest-release download link',
    pattern:
      /^## \[⬇️ View the latest AutoDoc release\]\(https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/latest\)$/gm
  },
  {
    description: 'macOS latest-release download heading',
    pattern:
      /^## \[⬇️ Download AutoDoc for macOS\]\(https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/latest\)$/gm
  },
  {
    description: 'macOS latest-release install step',
    pattern:
      /^1\. On the \[latest release\]\(https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/latest\), download the macOS `\.dmg` asset\.$/gm
  },
  {
    description: 'Windows latest-release download heading',
    pattern:
      /^## \[⬇️ Download AutoDoc for Windows\]\(https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/latest\)$/gm
  },
  {
    description: 'Windows latest-release install step',
    pattern:
      /^1\. On the \[latest release\]\(https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/latest\), download the Windows `\.exe` installer asset\.$/gm
  }
]

const forbiddenMarkers = [
  {
    description: 'version-pinned release download URL',
    pattern: /https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/download\//g
  },
  {
    description: 'version-pinned macOS installer name',
    pattern: /\bautodoc-\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?\.dmg\b/gi
  },
  {
    description: 'version-pinned Windows installer name',
    pattern: /\bautodoc-\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?-setup\.exe\b/gi
  },
  {
    description: 'static version release badge',
    pattern: /img\.shields\.io\/badge\/release-v/gi
  },
  {
    description: 'obsolete Windows coming-soon badge',
    pattern: /windows-coming-soon\.svg/gi
  }
]

function matchCount(value, pattern) {
  return value.match(pattern)?.length ?? 0
}

export function verifyReadmeReleaseLinks(readme) {
  for (const marker of requiredMarkers) {
    const count = matchCount(readme, marker.pattern)
    if (count !== 1) {
      throw new Error(`README.md must contain exactly one ${marker.description}; found ${count}`)
    }
  }

  for (const marker of forbiddenMarkers) {
    if (matchCount(readme, marker.pattern) > 0) {
      throw new Error(`README.md must not contain a ${marker.description}`)
    }
  }

  return { verifiedMarkerCount: requiredMarkers.length }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  const readmePath = new URL('../README.md', import.meta.url)
  const currentReadme = fs.readFileSync(readmePath, 'utf8')
  const result = verifyReadmeReleaseLinks(currentReadme)
  const releaseTag = process.env.RELEASE_TAG?.trim()
  const releaseContext = releaseTag ? ` for ${releaseTag}` : ''

  console.log(
    `Verified ${result.verifiedMarkerCount} stable README release links${releaseContext}.`
  )
}
