import { afterEach, describe, expect, it } from 'vitest'
import { applyDocumentLanguage } from '../document-language'
import { meetingLanguageLabel, meetingLanguageName } from '../meeting-language-name'

afterEach(() => applyDocumentLanguage('en'))

describe('meetingLanguageLabel (AD-193)', () => {
  it.each([
    ['ru', 'Английский'],
    ['fr', 'Anglais'],
    ['es', 'Inglés']
  ] as const)('capitalises the standalone label in %s', (language, expected) => {
    expect(meetingLanguageLabel('en', language)).toBe(expected)
  })

  it.each(['ja', 'zh-Hans', 'ko'] as const)('leaves %s unchanged', (language) => {
    expect(meetingLanguageLabel('en', language)).toBe(meetingLanguageName('en', language))
  })

  it('capitalises only the first letter of a multi-word name', () => {
    expect(meetingLanguageLabel('zh-Hans', 'ru')).toBe(
      meetingLanguageName('zh-Hans', 'ru').replace(/^./u, (c) => c.toLocaleUpperCase('ru'))
    )
    expect(meetingLanguageLabel('zh-Hans', 'ru')).toMatch(/^К/)
  })

  it('keeps the sentence form lowercase for names inserted mid-sentence', () => {
    expect(meetingLanguageName('en', 'ru')).toBe('английский')
    expect(meetingLanguageName('en', 'fr')).toBe('anglais')
    expect(meetingLanguageName('en', 'es')).toBe('inglés')
  })
})
