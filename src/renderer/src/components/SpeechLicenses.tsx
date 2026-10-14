import { useEffect, useState } from 'react'
import { speechLicenseNotices, type SpeechLicenseNotice } from '../../../shared/speech-licenses'

export function SpeechLicenses({ platform }: { platform: string }) {
  const [packages, setPackages] = useState<SpeechLicenseNotice[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    window.electronAPI.invoke('app:get-speech-runtime-licenses').then(setPackages, () => {
      setError('Runtime package notices are unavailable in this build.')
    })
  }, [])

  return (
    <div className="mt-3 max-h-96 overflow-y-auto rounded-xl border border-border-subtle bg-bg-card p-4 text-[12px] text-ink-muted">
      <p className="mb-4">
        Models and speech software shipped or downloaded for this platform. Installed components
        depend on the meeting language and hardware.
      </p>
      {speechLicenseNotices(platform).map((notice) => (
        <div key={notice.name} className="mb-4">
          <a
            href={notice.url}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-sage-dark underline"
          >
            {notice.name}
          </a>
          <p>
            {notice.licenseUrl ? (
              <a href={notice.licenseUrl} target="_blank" rel="noreferrer" className="underline">
                {notice.license}
              </a>
            ) : (
              notice.license
            )}
          </p>
          {notice.attribution && <p className="mt-1 leading-relaxed">{notice.attribution}</p>}
        </div>
      ))}
      <h4 className="font-semibold text-ink mb-2">Runtime packages and native libraries</h4>
      {error && <p role="status">{error}</p>}
      {packages.map((notice) => (
        <details key={`${notice.runtime}:${notice.name}`} className="mb-2">
          <summary className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50">
            {notice.name} {notice.version} · {notice.license}
          </summary>
          {notice.runtime && <p className="mt-1 text-ink-faint">{notice.runtime}</p>}
          <a
            href={notice.url}
            target="_blank"
            rel="noreferrer"
            className="text-sage-dark underline"
          >
            Source
          </a>
          {notice.attribution && <p className="mt-1 leading-relaxed">{notice.attribution}</p>}
          {notice.text && (
            <pre className="mt-2 whitespace-pre-wrap break-words text-[11px]">{notice.text}</pre>
          )}
        </details>
      ))}
    </div>
  )
}
