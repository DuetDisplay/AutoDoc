import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyReadmeReleaseLinks } from './update-readme-release-links.mjs'

export const RELEASE_START = '<!-- latest-release:start -->'
export const RELEASE_END = '<!-- latest-release:end -->'
const latestReleaseUrl = 'https://github.com/DuetDisplay/AutoDoc/releases/latest'
const maxTeaserWords = 16
const maxTeaserCharacters = 120

function plainText(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function fitsTeaser(value) {
  return value.length < maxTeaserCharacters && value.split(/\s+/).length <= maxTeaserWords
}

export function releaseTeaser(body) {
  const notes = body.replace(/\r\n/g, '\n').trim()
  if (!notes) return null
  if (notes.includes('<!--') || notes.includes('-->')) {
    throw new Error('Release notes must not contain HTML comments')
  }

  // Extract source wording rather than copying an entire paragraph or calling
  // an AI service. Keep complete phrases; never truncate a claim mid-sentence.
  const paragraphs = notes.split(/\n\s*\n/)
  const summary = paragraphs.find(
    (paragraph) => !/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|<|```|~~~|>)/.test(paragraph.trim())
  )
  const headings = [...notes.matchAll(/^#{2,3}\s+(.+?)\s*#*$/gm)]
    .map((match) => plainText(match[1]).replace(/[.!?]+$/, ''))
    .filter(
      (heading) =>
        !/^(?:known issues?|limitations?|downloads?|installation|assets?|full changelog|changelog|added|changed|fixed|removed|deprecated|security|breaking changes?)\b/i.test(
          heading
        )
    )
  if (!summary && headings.length === 0) return null

  const firstSentence = plainText(summary ?? '').split(/(?<=[.!?])\s+/)[0]
  const lead = firstSentence
    .replace(
      /^AutoDoc(?:\s+v?\d+\.\d+\.\d+)?\s+(?:now\s+)?(?:supports|adds|introduces|includes|brings)\s+/i,
      ''
    )
    .replace(/,\s+(?:including|such as|for example)\b.*$/i, '')
    .replace(/[.!?]+$/, '')
  // The first feature heading normally elaborates the introduction. A second
  // heading supplies a distinct benefit, such as "Better notes" in 1.3.0.
  const secondary = headings[1]?.replace(/^Better notes$/i, 'improved meeting notes')
  const nounPhrase =
    /^AutoDoc(?:\s+v?\d+\.\d+\.\d+)?\s+(?:now\s+)?(?:supports|adds|introduces|includes|brings)\s+/i.test(
      firstSentence
    )
  const lowerInitial = (value) => value.replace(/^[A-Z](?=[a-z])/, (letter) => letter.toLowerCase())
  const combined = nounPhrase && lead && secondary ? `${lead} and ${lowerInitial(secondary)}` : ''
  const fromHeadings = headings
    .slice(0, 2)
    .map((heading, index) => (index ? lowerInitial(heading) : heading))
    .join(' and ')
  const candidates = [combined, lead, fromHeadings, headings[0]]
  const teaser = candidates.find((candidate) => candidate && fitsTeaser(candidate))
  return `${teaser ?? 'See what’s new in this release'}.`
}

export function releaseAnnouncement(release) {
  if (release.draft || release.prerelease) return null
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name ?? '')) {
    throw new Error('Expected a stable v-prefixed release tag')
  }

  const teaser = releaseTeaser(release.body ?? '')
  if (!teaser) return null
  return `${RELEASE_START}\n\n**New in ${release.tag_name}:** ${teaser} [Read the latest release notes](${latestReleaseUrl}).\n\n${RELEASE_END}`
}

export function syncReadmeRelease(readme, release) {
  const starts = readme.split(RELEASE_START).length - 1
  const ends = readme.split(RELEASE_END).length - 1
  const start = readme.indexOf(RELEASE_START)
  const end = readme.indexOf(RELEASE_END)
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new Error('README.md must contain exactly one ordered latest-release marker pair')
  }
  const announcement = releaseAnnouncement(release)
  if (!announcement) return readme
  return readme.slice(0, start) + announcement + readme.slice(end + RELEASE_END.length)
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const jsonFlag = process.argv.indexOf('--release-json')
  if (jsonFlag < 0 || !process.argv[jsonFlag + 1]) {
    throw new Error('Usage: node scripts/sync-readme-release.mjs --release-json <file>')
  }
  const release = JSON.parse(fs.readFileSync(process.argv[jsonFlag + 1], 'utf8'))
  const readmePath = new URL('../README.md', import.meta.url)
  const before = fs.readFileSync(readmePath, 'utf8')
  const after = syncReadmeRelease(before, release)
  verifyReadmeReleaseLinks(after)
  const changed = after !== before
  if (changed) fs.writeFileSync(readmePath, after)
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `updated=${changed}\n`)
  }
  console.log(
    changed
      ? `Updated README announcement for ${release.tag_name}.`
      : 'README announcement unchanged; no new stable release summary to publish.'
  )
}
