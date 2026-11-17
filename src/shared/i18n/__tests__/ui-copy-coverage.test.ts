import { askAiCountFilterCopy } from '../../../renderer/src/services/ask-ai-count-copy'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { UI_LANGUAGE_CODES } from '../../ui-language'
import { en } from '../messages/en'
import { localeCatalogs } from '../messages/locales'
import { translate, translatePlural } from '../index'
import { formatUiDuration } from '../format'

function rendererFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return ['__tests__', 'test'].includes(entry.name) ? [] : rendererFiles(path)
    return path.endsWith('.tsx') && !path.includes('.test.') ? [path] : []
  })
}

describe('complete UI localization', () => {
  it('has an explicit value and preserves every interpolation in every locale', () => {
    for (const language of UI_LANGUAGE_CODES.filter((value) => value !== 'en')) {
      const catalog = localeCatalogs[language]
      for (const [key, english] of Object.entries(en)) {
        expect(Object.hasOwn(catalog, key), `${language}: ${key} missing`).toBe(true)
        const value = translate(language, key as keyof typeof en)
        expect(value.trim(), `${language}: ${key}`).not.toBe('')
        expect(
          [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(),
          `${language}: ${key}`
        ).toEqual([...english.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort())
      }
    }
  })

  it('keeps newly added JSX copy and accessibility text in the catalogs', () => {
    const failures: string[] = []
    const brands = new Set(['AutoDoc', 'PDF', 'Word', 'Markdown', 'Ollama', 'Whisper'])
    const attributes = new Set([
      'title',
      'placeholder',
      'aria-label',
      'alt',
      'heading',
      'body',
      'deleteLabel'
    ])
    for (const file of rendererFiles(join(process.cwd(), 'src/renderer/src'))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      )
      const visit = (node: ts.Node): void => {
        const text = ts.isJsxText(node)
          ? node.text.trim()
          : ts.isJsxAttribute(node) &&
              attributes.has(node.name.getText(source)) &&
              node.initializer &&
              ts.isStringLiteral(node.initializer)
            ? node.initializer.text.trim()
            : ''
        if (/[A-Za-z]{2}/.test(text) && !brands.has(text)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          failures.push(`${file}:${line}: ${text}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(failures).toEqual([])
  })

  it('localizes current and saved native count filters without changing writer history', () => {
    const filterDescription =
      'attached saved recordings on or after 2026-09-01, on or before 2026-09-30, with all title terms "Atlas", with participant terms "Mira", whose notes or transcript contain all keyword terms "budget"'
    const summary = {
      count: 2,
      filterDescription,
      scoped: true,
      filter: {
        from: '2026-09-01',
        through: '2026-09-30',
        title: 'Atlas',
        participant: 'Mira',
        keyword: 'budget'
      }
    }
    const original = JSON.stringify(summary)
    for (const language of UI_LANGUAGE_CODES) {
      const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
        translate(language, key, params)
      const displayed = askAiCountFilterCopy(summary, t, language)
      expect(displayed).toBe(askAiCountFilterCopy({ count: 2, filterDescription }, t, language))
      if (language === 'en') expect(displayed).toBe(filterDescription)
      else {
        expect(displayed).not.toContain('saved recordings')
        expect(displayed).not.toContain('on or after')
        expect(displayed).toContain('Atlas')
        expect(displayed).toContain('Mira')
        expect(displayed).toContain('budget')
      }
    }
    expect(JSON.stringify(summary)).toBe(original)
  })

  it('uses the correct Russian plural category beyond a singular-versus-plural split', () => {
    expect(translatePlural('ru', 'meetings', 1)).toBe('1 встреча')
    expect(translatePlural('ru', 'meetings', 2)).toBe('2 встречи')
    expect(translatePlural('ru', 'meetings', 5)).toBe('5 встреч')
    expect(translatePlural('ru', 'meetings', 21)).toBe('21 встреча')
    expect(translatePlural('ru', 'attendees', 2)).toBe('2 участника')
  })

  it('formats durations using locale-specific unit names', () => {
    expect(formatUiDuration('de', 3660)).toContain('Std.')
    expect(formatUiDuration('ja', 3660)).toContain('時間')
    expect(formatUiDuration('ru', 3660)).toContain('ч')
  })

  it('uses locale-specific number and percent formatting', () => {
    expect(translate('de', 'upcoming.meetingCountOther', { count: 1234 })).toContain('1.234')
    expect(translate('fr', 'setup.downloadingEngine', { percent: 42 })).toContain(
      new Intl.NumberFormat('fr', { style: 'percent' }).format(0.42)
    )
  })
})
