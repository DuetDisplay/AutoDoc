import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  RELEASE_END,
  RELEASE_START,
  releaseAnnouncement,
  releaseTeaser,
  syncReadmeRelease
} from '../sync-readme-release.mjs'
import { verifyReadmeReleaseLinks } from '../update-readme-release-links.mjs'

const release = {
  tag_name: 'v1.3.0',
  draft: false,
  prerelease: false,
  body: '# AutoDoc 1.3.0\n\nMeetings in your selected language.\nAI processing stays local.\n\n### Changes\n\n- New language selection.'
}
const readme = `Keep this introduction.\n\n${RELEASE_START}\nOld announcement.\n${RELEASE_END}\n\nKeep this historical [v1.2.0](https://github.com/DuetDisplay/AutoDoc/releases/tag/v1.2.0) citation.\n`

test('generates a one-sentence teaser and changes only the managed block', () => {
  const updated = syncReadmeRelease(readme, release)
  assert.match(updated, /\*\*New in v1\.3\.0:\*\* Meetings in your selected language\./)
  assert.match(
    updated,
    /Read the latest release notes\]\(https:\/\/github\.com\/DuetDisplay\/AutoDoc\/releases\/latest\)/
  )
  assert.equal(updated.split(RELEASE_START)[0], readme.split(RELEASE_START)[0])
  assert.equal(updated.split(RELEASE_END)[1], readme.split(RELEASE_END)[1])
  assert.doesNotMatch(updated, /### Changes/)
  assert.doesNotMatch(updated, /AI processing stays local/)
})

test('a repeated run leaves the README unchanged', () => {
  const updated = syncReadmeRelease(readme, release)
  assert.equal(syncReadmeRelease(updated, release), updated)
})

test('editing the release paragraph updates the existing announcement', () => {
  const updated = syncReadmeRelease(readme, release)
  assert.match(
    syncReadmeRelease(updated, { ...release, body: 'Corrected release summary.' }),
    /Corrected release summary\./
  )
})

test('drafts, prereleases, and releases without prose preserve the previous announcement', () => {
  for (const changes of [
    { draft: true },
    { prerelease: true },
    { body: '' },
    { body: '# v1.3.0\n\n- A generated change list without an introduction.' }
  ]) {
    assert.equal(syncReadmeRelease(readme, { ...release, ...changes }), readme)
  }
})

test('handles CRLF release notes', () => {
  assert.equal(
    releaseAnnouncement({ ...release, body: release.body.replaceAll('\n', '\r\n') }),
    releaseAnnouncement(release)
  )
})

test('rejects missing, duplicate, or reversed marker pairs', () => {
  for (const malformed of [
    'Unmanaged README',
    `${readme}\n${RELEASE_START}`,
    `${readme}\n${RELEASE_END}`,
    `${RELEASE_END}\n${RELEASE_START}`
  ]) {
    assert.throws(
      () => syncReadmeRelease(malformed, release),
      /exactly one ordered latest-release marker pair/
    )
  }
})

test('rejects invalid stable tags and summary marker injection', () => {
  assert.throws(
    () => releaseAnnouncement({ ...release, tag_name: 'v1.3.0\nother=value' }),
    /stable v-prefixed release tag/
  )
  assert.throws(
    () => releaseAnnouncement({ ...release, body: 'Summary. <!-- latest-release:end -->' }),
    /HTML comments/
  )
})

test('a generated announcement passes the repository release-link checks', () => {
  const current = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  assert.doesNotThrow(() => verifyReadmeReleaseLinks(syncReadmeRelease(current, release)))
})

test('source links cannot reintroduce a pinned release destination', () => {
  const current = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  const updated = syncReadmeRelease(current, {
    ...release,
    body: 'See [this release](https://github.com/DuetDisplay/AutoDoc/releases/tag/v1.2.0).'
  })
  assert.doesNotThrow(() => verifyReadmeReleaseLinks(updated))
  assert.doesNotMatch(updated, /releases\/tag\//)
})

test('the 1.3.0 release produces the approved short teaser', () => {
  const body = `# AutoDoc 1.3.0: Meetings in your language

AutoDoc now supports 27 meeting languages, including Spanish, French, German, Japanese, Simplified Chinese, and Korean. Transcription and AI processing stay on your computer.

### Multilingual meetings

- Choose your language during setup or in Settings.

### Better notes

- Improved checks help remove unsupported claims from meeting overviews.

### Known issues

Some languages have transcription or notes limitations.`
  assert.equal(releaseTeaser(body), '27 meeting languages and improved meeting notes.')
})

test('long source sentences use feature headings rather than partial claims', () => {
  const body = `This deliberately lengthy introduction describes many detailed changes, requirements, caveats, and conditions that would take substantially more than sixteen words to preserve without changing their meaning.

### Faster transcription

### GPU acceleration`
  assert.equal(releaseTeaser(body), 'Faster transcription and GPU acceleration.')
})

test('teasers stay within the length limits even when every source phrase is long', () => {
  const teaser = releaseTeaser('A very long explanation '.repeat(30))
  assert.equal(teaser, 'See what’s new in this release.')
  assert.ok(teaser.length <= 120)
  assert.ok(teaser.split(/\s+/).length <= 16)
})

test('feature headings work without an opening paragraph and exclude limitations', () => {
  assert.equal(
    releaseTeaser(
      '### Faster search\n\n- Results load sooner.\n\n### Known issues\n\n- A limitation.'
    ),
    'Faster search.'
  )
})

test('retains numbers and does not treat generic changelog headings as benefits', () => {
  assert.equal(
    releaseTeaser(
      'AutoDoc adds 12 export formats, including PDF and Word.\n\n### Added\n\n### Fixed\n\n### Download'
    ),
    '12 export formats.'
  )
})
