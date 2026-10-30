import { describe, expect, it } from 'vitest'
import { createTranslator } from '../../../../shared/i18n'
import { displaySpeakerLabel } from '../speaker-label'

describe('speaker UI labels', () => {
  it('translates generated defaults but never user-authored names', () => {
    const t = createTranslator('de')
    expect(displaySpeakerLabel('Speaker', undefined, t)).toBe(t('speaker.unknown'))
    expect(displaySpeakerLabel('me', undefined, t)).toBe(t('speaker.me'))
    expect(displaySpeakerLabel('speaker_2', undefined, t)).toBe(t('speaker.number', { number: 2 }))
    expect(displaySpeakerLabel('me', { label: 'Me' }, t)).toBe(t('speaker.me'))
    expect(displaySpeakerLabel('speaker_2', { label: 'Speaker 2' }, t)).toBe(
      t('speaker.number', { number: 2 })
    )
    expect(displaySpeakerLabel('me', { label: 'Me', customLabel: true }, t)).toBe('Me')
    expect(displaySpeakerLabel('speaker_2', { label: 'Alex' }, t)).toBe('Alex')
  })
})
