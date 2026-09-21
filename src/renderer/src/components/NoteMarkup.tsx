import type { ReactNode } from 'react'

export function renderNoteMarkup(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, index) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part)
    if (bold) {
      return (
        <strong key={index} className="font-semibold text-ink">
          {bold[1]}
        </strong>
      )
    }
    return <span key={index}>{part}</span>
  })
}
