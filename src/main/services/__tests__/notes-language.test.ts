import { describe, expect, it } from 'vitest'
import { MEETING_LANGUAGE_DEFINITIONS } from '../../../shared/meeting-language'
import {
  activeMeetingLanguage,
  appendMeetingLanguageDirective,
  isEnglishMeetingJob,
  meetingOutputTokenCap,
  notesLanguageContextFromMeetingLanguage,
  runWithMeetingLanguage
} from '../notes-language'

describe('notesLanguageContextFromMeetingLanguage', () => {
  it.each([undefined, null, '', 'auto', 'en', ' EN '])('keeps %s on the English path', (value) => {
    expect(notesLanguageContextFromMeetingLanguage(value)).toBe('english')
  })

  it('switches only for a supported non-English language', () => {
    expect(notesLanguageContextFromMeetingLanguage('de')).toBe('non-english')
  })
})

describe('appendMeetingLanguageDirective', () => {
  it.each([undefined, null, 'en', 'xx'])('returns the prompt unchanged for %s', (language) => {
    const prompt = 'Summarize the notes.\nNOTES:\n- one'
    expect(appendMeetingLanguageDirective(prompt, language)).toBe(prompt)
  })

  it('appends the exact named German directive last', () => {
    expect(appendMeetingLanguageDirective('PROMPT', 'de')).toBe(
      'PROMPT\n\nThe transcript is in German. Write the entire response in German, including every string value. JSON keys stay exactly as specified in English. Do not translate names, product names or technical terms.'
    )
  })

  it.each(MEETING_LANGUAGE_DEFINITIONS.filter(({ code }) => code !== 'en'))(
    'names $label, never its ISO code',
    ({ code, label }) => {
      const directive = appendMeetingLanguageDirective('', code)
      expect(directive).toContain(`The transcript is in ${label}.`)
      expect(directive).not.toMatch(new RegExp(`\\b${code}\\b`))
    }
  )
})

describe('runWithMeetingLanguage', () => {
  it('defaults to English outside any job', () => {
    expect(activeMeetingLanguage()).toBe('en')
    expect(isEnglishMeetingJob()).toBe(true)
  })

  it('normalizes legacy and invalid values to English', () => {
    expect(runWithMeetingLanguage(undefined, () => activeMeetingLanguage())).toBe('en')
    expect(runWithMeetingLanguage('klingon', () => activeMeetingLanguage())).toBe('en')
  })

  it('keeps concurrent jobs isolated across awaits', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1))
    const observe = (language: string) =>
      runWithMeetingLanguage(language, async () => {
        const seen = [activeMeetingLanguage()]
        await tick()
        seen.push(activeMeetingLanguage())
        return seen
      })

    const [german, english, bulgarian] = await Promise.all([
      observe('de'),
      observe('en'),
      observe('bg')
    ])
    expect(german).toEqual(['de', 'de'])
    expect(english).toEqual(['en', 'en'])
    expect(bulgarian).toEqual(['bg', 'bg'])
    expect(activeMeetingLanguage()).toBe('en')
  })
})

describe('meetingOutputTokenCap', () => {
  it('keeps English caps and scales every other language the same way', () => {
    expect(meetingOutputTokenCap(256)).toBe(256)
    expect(runWithMeetingLanguage('en', () => meetingOutputTokenCap(256))).toBe(256)
    for (const language of ['de', 'bg', 'ja', 'ko']) {
      expect(runWithMeetingLanguage(language, () => meetingOutputTokenCap(256))).toBe(768)
    }
  })
})
