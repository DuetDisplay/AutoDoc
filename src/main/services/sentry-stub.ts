import { appendFile, mkdir } from 'fs/promises'
import { dirname } from 'path'

type SentryEvent = Record<string, unknown>
type BeforeSend = (event: SentryEvent) => SentryEvent | null

export interface SentryStubEnvelope {
  type: 'exception' | 'message'
  error?: {
    name: string
    message: string
    stack?: string
  }
  message?: string
  level?: 'info' | 'warning' | 'error'
  event: SentryEvent
  attachments: Array<{
    filename: string
    contentType?: string
    data: string
  }>
}

interface ScopeState {
  tags: Record<string, string>
  extras: Record<string, unknown>
  attachments: Array<{
    filename: string
    contentType?: string
    data: string
  }>
}

interface StubScope extends ScopeState {
  clear(): void
  setTag(key: string, value: string): void
  setExtras(extras: Record<string, unknown>): void
  addAttachment(attachment: { filename: string; contentType?: string; data: string }): void
}

interface InitOptions {
  beforeSend?: BeforeSend
}

function createScope(): StubScope {
  const state: ScopeState = {
    tags: {},
    extras: {},
    attachments: []
  }

  return {
    ...state,
    clear() {
      this.tags = {}
      this.extras = {}
      this.attachments = []
    },
    setTag(key: string, value: string) {
      this.tags[key] = value
    },
    setExtras(extras: Record<string, unknown>) {
      this.extras = { ...extras }
    },
    addAttachment(attachment: { filename: string; contentType?: string; data: string }) {
      this.attachments.push({ ...attachment })
    }
  }
}

export function createSentryStubRuntime(stubPath: string) {
  let beforeSend: BeforeSend | undefined
  const globalTags: Record<string, string> = {}
  const globalContexts: Record<string, Record<string, unknown>> = {}
  const isolationScope = createScope()
  let activeScope: StubScope | null = null

  const writeEnvelope = async (envelope: SentryStubEnvelope): Promise<void> => {
    await mkdir(dirname(stubPath), { recursive: true })
    await appendFile(stubPath, `${JSON.stringify(envelope)}\n`, 'utf-8')
  }

  const buildEvent = (scope: StubScope): SentryEvent => {
    return {
      server_name: 'autodoc-sentry-stub',
      tags: {
        ...globalTags,
        ...scope.tags
      },
      extra: {
        ...scope.extras
      },
      contexts: {
        ...globalContexts
      }
    }
  }

  const recordEnvelope = (
    envelope: Omit<SentryStubEnvelope, 'event' | 'attachments'>,
    scope: StubScope
  ): void => {
    const baseEvent = buildEvent(scope)
    const filteredEvent = beforeSend ? beforeSend(baseEvent) : baseEvent
    if (!filteredEvent) {
      return
    }

    void writeEnvelope({
      ...envelope,
      event: filteredEvent,
      attachments: scope.attachments.map((attachment) => ({ ...attachment }))
    }).catch(() => {})
  }

  return {
    init(options: InitOptions) {
      beforeSend = options.beforeSend
    },
    withScope(callback: (scope: StubScope) => void) {
      const scope = createScope()
      activeScope = scope
      try {
        callback(scope)
      } finally {
        activeScope = null
      }
    },
    captureException(error: Error) {
      recordEnvelope(
        {
          type: 'exception',
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack
          }
        },
        activeScope ?? isolationScope
      )
    },
    captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info') {
      recordEnvelope(
        {
          type: 'message',
          message,
          level
        },
        activeScope ?? isolationScope
      )
    },
    setContext(key: string, data: Record<string, unknown>) {
      globalContexts[key] = { ...data }
    },
    setTag(key: string, value: string) {
      globalTags[key] = value
    },
    getIsolationScope() {
      return isolationScope
    },
    getCurrentScope() {
      return isolationScope
    }
  }
}
