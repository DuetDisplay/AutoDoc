import { translatePlural } from '../../../shared/i18n'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { toCountBucket, trackEvent } from '../services/analytics'
import { recordDiagnosticAction } from '../services/diagnostic-trail'
import { useSearchStore } from '../stores/search'
import { useI18n } from '../services/i18n'
import { dateLocaleForUiLanguage } from '../../../shared/ui-language'
import type { MessageKey } from '../../../shared/i18n'

export function Search() {
  const { language, t } = useI18n()
  const dateLocale = dateLocaleForUiLanguage(language)
  const { query, results, searched, setQuery, setResults } = useSearchStore()
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestRef = useRef<symbol | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const doSearch = useCallback(
    async (q: string, request: symbol) => {
      if (!q.trim()) {
        setResults([], false)
        return
      }
      setSearching(true)
      setFailed(false)
      const isCurrent = () =>
        requestRef.current === request && useSearchStore.getState().query === q
      try {
        const res = await window.electronAPI.invoke('search:query', q)
        if (!isCurrent()) return
        setResults(res, true)
        recordDiagnosticAction({
          category: 'search',
          action: 'search_performed',
          details: {
            queryLength: q.trim().length,
            resultCount: res.length
          }
        })
        trackEvent('search_performed', { result_count_bucket: toCountBucket(res.length) })
      } catch (err) {
        if (!isCurrent()) return
        setResults([], false)
        setFailed(true)
        console.error('Search failed:', err)
      } finally {
        if (isCurrent()) setSearching(false)
      }
    },
    [setResults]
  )

  useEffect(() => {
    const request = Symbol()
    requestRef.current = request
    clearTimeout(debounceRef.current)
    setFailed(false)
    setResults([], false)
    setSearching(Boolean(query.trim()))
    if (!query.trim()) {
      setResults([], false)
      return
    }
    debounceRef.current = setTimeout(() => doSearch(query, request), 300)
    return () => {
      clearTimeout(debounceRef.current)
      requestRef.current = null
    }
  }, [query, language, doSearch, setResults])

  const highlightMatch = (text: string) => {
    if (!query.trim()) return text
    const terms = query.trim().split(/\s+/)
    const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const regex = new RegExp(`(${pattern})`, 'gi')
    const parts = text.split(regex)
    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className="bg-sage/20 text-ink rounded px-0.5">
          {part}
        </mark>
      ) : (
        part
      )
    )
  }

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0)

  return (
    <div className="flex flex-col h-full">
      <PageHeader title={t('search.title')} />
      <div className="px-6 pt-4 pb-2">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <textarea
            rows={1}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault()
            }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('search.placeholderMeetings')}
            placeholder={t('search.placeholderMeetings')}
            className="block w-full min-w-0 min-h-[44px] max-h-40 resize-none [field-sizing:content] pl-10 pr-4 py-2.5 bg-bg-card border-2 border-control-border rounded-lg text-[13px] text-ink placeholder:text-ink-faint focus:outline-2 focus:outline-offset-2 focus:outline-sage transition-colors"
            autoFocus
          />
        </div>
        {searched && (
          <p className="text-[11px] text-ink-faint mt-2">
            {translatePlural(language, 'matches', totalMatches)}{' '}
            {translatePlural(language, 'acrossMeetings', results.length)}
          </p>
        )}
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto px-6 pb-6">
        {failed && (
          <div role="alert" className="py-8 text-center text-[13px] text-clay-dark">
            <p>{t('search.failed')}</p>
            <button
              type="button"
              onClick={() => {
                const request = Symbol()
                requestRef.current = request
                void doSearch(query, request)
              }}
              className="mt-3 rounded-lg px-3 py-2 text-sage-dark underline focus-visible:outline-2 focus-visible:outline-sage"
            >
              {t('meeting.tryAgain')}
            </button>
          </div>
        )}
        {searching && (
          <div className="flex items-center justify-center py-12">
            <p className="text-ink-muted text-[13px]">{t('search.searching')}</p>
          </div>
        )}

        {!searching && searched && results.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <p className="min-w-0 max-w-full text-ink-muted text-[13px] text-pretty [overflow-wrap:anywhere]">
              {t('search.noResults', { query })}
            </p>
          </div>
        )}

        {!searching && !failed && !searched && (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <svg
              className="w-10 h-10 text-ink-faint/40"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <p className="text-ink-faint text-[13px]">{t('search.emptyHint')}</p>
          </div>
        )}

        {!searching && results.length > 0 && (
          <div className="flex flex-col gap-3">
            {results.map((result) => (
              <div
                key={result.meetingId}
                className="bg-bg-card border border-border rounded-xl overflow-hidden"
              >
                <Link
                  to={`/recordings/${result.meetingId}`}
                  className="block px-4 py-3 border-b border-border/50 hover:bg-bg-accent/40 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sage"
                >
                  <div className="text-[13px] font-semibold text-ink text-pretty [overflow-wrap:anywhere]">
                    {result.title}
                  </div>
                  <div className="text-[11px] text-ink-faint mt-0.5">
                    {new Date(result.date).toLocaleDateString(dateLocale, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric'
                    })}
                    {' · '}
                    {result.matches.length === 1
                      ? t('search.matchOne')
                      : t('search.matchOther', { count: result.matches.length })}
                  </div>
                </Link>
                <div className="px-4 py-2 flex flex-col">
                  {result.matches.map((match, i) => {
                    const tab = match.type === 'segment' ? 'notes' : 'transcript'
                    const highlight = encodeURIComponent(match.text.slice(0, 80))
                    return (
                      <Link
                        key={i}
                        className="flex min-w-0 items-start gap-2 py-1.5 px-1 -mx-1 rounded-md hover:bg-bg-accent/60 transition-colors focus-visible:outline-2 focus-visible:outline-sage"
                        to={`/recordings/${result.meetingId}?tab=${tab}&highlight=${highlight}`}
                      >
                        <span
                          className={`shrink-0 mt-0.5 max-w-full text-[10px] font-medium px-1.5 py-0.5 rounded text-pretty [overflow-wrap:anywhere] ${
                            match.type === 'segment'
                              ? 'bg-dusk-light text-dusk-dark'
                              : 'bg-sage-light text-sage-dark'
                          }`}
                        >
                          {match.type === 'segment'
                            ? match.category
                              ? t(`segment.${match.category}` as MessageKey)
                              : t('search.note')
                            : t('search.transcript')}
                        </span>
                        <span className="min-w-0 text-[12px] text-ink-muted leading-relaxed [overflow-wrap:anywhere]">
                          {highlightMatch(match.text)}
                        </span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
