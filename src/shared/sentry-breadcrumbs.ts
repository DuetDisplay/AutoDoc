type BreadcrumbLike = {
  category?: string
  message?: string
  level?: string
  data?: Record<string, unknown>
}

function sanitizeString(value: string): string {
  if (value.startsWith('data:')) {
    return '[data-url]'
  }

  return value
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item))
  }

  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = sanitizeValue(nestedValue)
    }
    return sanitized
  }

  return value
}

function isOllamaHealthPoll(data: Record<string, unknown>): boolean {
  return typeof data.url === 'string' && data.url.includes('127.0.0.1:11435/api/tags')
}

function isNoisyElectronLifecycle(message: string): boolean {
  return [
    'app.web-contents-created',
    'app.browser-window-created',
    'app.browser-window-focus',
    'app.browser-window-blur',
    'app.did-become-active',
    'app.did-resign-active',
    'powerMonitor.newListener',
    'renderer.dom-ready',
    'renderer.destroyed',
    'window.show',
    'window.hide',
    'window.focus',
    'window.blur',
    'window.close',
    'window.closed',
  ].includes(message)
}

export function normalizeSentryBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T | null {
  const category = breadcrumb.category ?? ''
  const message = breadcrumb.message ?? ''
  const level = breadcrumb.level ?? ''
  const data = (sanitizeValue(breadcrumb.data ?? {}) as Record<string, unknown>)

  if (category === 'console' && !['warning', 'error', 'fatal'].includes(level)) {
    return null
  }

  if (category === 'http' && isOllamaHealthPoll(data)) {
    return null
  }

  if (category === 'ui.click') {
    return null
  }

  if (category === 'ui' && isNoisyElectronLifecycle(message)) {
    return null
  }

  return {
    ...breadcrumb,
    message: sanitizeString(message),
    data,
  }
}
