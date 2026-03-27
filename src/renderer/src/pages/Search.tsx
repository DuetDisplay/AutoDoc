import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { trackEvent } from '../services/analytics'
import { useSearchStore } from '../stores/search'

export function Search() {
  const { query, results, searched, setQuery, setResults } = useSearchStore()
  const [searching, setSearching] = useState(false)
  const navigate = useNavigate()
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([], false)
      return
    }
    setSearching(true)
    try {
      const res = await window.electronAPI.invoke('search:query', q)
      setResults(res, true)
      trackEvent('search_performed', { result_count: res.length })
    } catch (err) {
      console.error('Search failed:', err)
    } finally {
      setSearching(false)
    }
  }, [setResults])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (!query.trim()) {
      setResults([], false)
      return
    }
    debounceRef.current = setTimeout(() => doSearch(query), 300)
    return () => clearTimeout(debounceRef.current)
  }, [query, doSearch, setResults])

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
      ),
    )
  }

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0)

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Search" />
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
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across all meetings..."
            className="w-full pl-10 pr-4 py-2.5 bg-bg-card border border-border rounded-lg text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-sage transition-colors"
            autoFocus
          />
        </div>
        {searched && (
          <p className="text-[11px] text-ink-faint mt-2">
            {totalMatches} {totalMatches === 1 ? 'match' : 'matches'} across{' '}
            {results.length} {results.length === 1 ? 'meeting' : 'meetings'}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {searching && (
          <div className="flex items-center justify-center py-12">
            <p className="text-ink-muted text-[13px]">Searching...</p>
          </div>
        )}

        {!searching && searched && results.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <p className="text-ink-muted text-[13px]">
              No results found for &ldquo;{query}&rdquo;
            </p>
          </div>
        )}

        {!searching && !searched && (
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
            <p className="text-ink-faint text-[13px]">
              Search transcripts and meeting notes
            </p>
          </div>
        )}

        {!searching && results.length > 0 && (
          <div className="flex flex-col gap-3">
            {results.map((result) => (
              <div
                key={result.meetingId}
                className="bg-bg-card border border-border rounded-xl overflow-hidden"
              >
                <div
                  className="px-4 py-3 border-b border-border/50 cursor-pointer hover:bg-bg-accent/40 transition-colors"
                  onClick={() => navigate(`/recordings/${result.meetingId}`)}
                >
                  <div className="text-[13px] font-semibold text-ink">
                    {result.title}
                  </div>
                  <div className="text-[11px] text-ink-faint mt-0.5">
                    {new Date(result.date).toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                    {' · '}
                    {result.matches.length}{' '}
                    {result.matches.length === 1 ? 'match' : 'matches'}
                  </div>
                </div>
                <div className="px-4 py-2 flex flex-col">
                  {result.matches.map((match, i) => {
                    const tab = match.type === 'segment' ? 'notes' : 'transcript'
                    const highlight = encodeURIComponent(match.text.slice(0, 80))
                    return (
                      <div
                        key={i}
                        className="flex items-start gap-2 py-1.5 px-1 -mx-1 rounded-md cursor-pointer hover:bg-bg-accent/60 transition-colors"
                        onClick={() => navigate(`/recordings/${result.meetingId}?tab=${tab}&highlight=${highlight}`)}
                      >
                        <span
                          className={`shrink-0 mt-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded ${
                            match.type === 'segment'
                              ? 'bg-dusk/10 text-dusk'
                              : 'bg-sage/10 text-sage'
                          }`}
                        >
                          {match.type === 'segment'
                            ? match.category?.replace(/_/g, ' ') ?? 'note'
                            : 'transcript'}
                        </span>
                        <span className="text-[12px] text-ink-muted leading-relaxed">
                          {highlightMatch(match.text)}
                        </span>
                      </div>
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
