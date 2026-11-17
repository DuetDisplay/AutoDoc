import * as Sentry from '@sentry/electron/renderer'

/**
 * Records clicks only on controls with a label written for Sentry. Visible text, aria-labels and
 * titles can hold window and meeting titles, which must not leave the device.
 */
export function installSemanticClickBreadcrumbs(isEnabled: () => boolean): void {
  document.addEventListener(
    'click',
    (event) => {
      if (!isEnabled()) return

      const target = event.target
      if (!(target instanceof Element)) return

      const clickable = target.closest('[data-sentry-label]')
      const label = clickable?.getAttribute('data-sentry-label')
      if (!clickable || !label) return

      Sentry.addBreadcrumb({
        category: 'ui.action',
        level: 'info',
        message: label,
        data: {
          action: 'click',
          tagName: clickable.tagName.toLowerCase(),
          path: window.location.hash || window.location.pathname
        }
      })
    },
    { capture: true }
  )
}
