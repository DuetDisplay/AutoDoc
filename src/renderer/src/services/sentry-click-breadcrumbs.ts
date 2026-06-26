import * as Sentry from '@sentry/electron/renderer'

const CLICKABLE_SELECTOR = [
  '[data-sentry-label]',
  'button',
  'a[href]',
  'input[type="button"]',
  'input[type="submit"]',
  '[role="button"]',
].join(',')

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function getElementLabel(element: Element): string | null {
  const labeledElement = element as HTMLElement
  const explicitLabel = labeledElement.getAttribute('data-sentry-label')
    ?? labeledElement.getAttribute('aria-label')
    ?? labeledElement.getAttribute('title')

  if (explicitLabel) {
    const collapsed = collapseWhitespace(explicitLabel)
    if (collapsed.length > 0) return collapsed
  }

  if (labeledElement instanceof HTMLInputElement) {
    const inputLabel = labeledElement.value || labeledElement.name
    if (inputLabel) {
      const collapsed = collapseWhitespace(inputLabel)
      if (collapsed.length > 0) return collapsed
    }
  }

  const text = collapseWhitespace(labeledElement.textContent ?? '')
  if (text.length > 0) {
    return text.slice(0, 120)
  }

  return labeledElement.id ? `#${labeledElement.id}` : null
}

export function installSemanticClickBreadcrumbs(isEnabled: () => boolean): void {
  document.addEventListener('click', (event) => {
    if (!isEnabled()) return

    const target = event.target
    if (!(target instanceof Element)) return

    const clickable = target.closest(CLICKABLE_SELECTOR)
    if (!clickable) return

    const label = getElementLabel(clickable)
    if (!label) return

    Sentry.addBreadcrumb({
      category: 'ui.action',
      level: 'info',
      message: label,
      data: {
        action: 'click',
        tagName: clickable.tagName.toLowerCase(),
        path: window.location.hash || window.location.pathname,
      },
    })
  }, { capture: true })
}
