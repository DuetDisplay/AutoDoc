declare module 'ffmpeg-static' {
  const ffmpegStaticPath: string | null
  export default ffmpegStaticPath
}

declare module '@sentry/electron/main' {
  export interface SentryBreadcrumb {
    category?: string
    message?: string
    level?: string
    data?: Record<string, unknown>
  }

  export interface SentryEvent {
    server_name?: string
    [key: string]: unknown
  }

  export interface SentryScope {
    setTag(key: string, value: string): void
    setExtras(extras: Record<string, unknown>): void
  }

  export interface SentryInitOptions {
    dsn?: string
    environment?: string
    release?: string
    enabled?: boolean
    sendDefaultPii?: boolean
    beforeBreadcrumb?: (breadcrumb: SentryBreadcrumb) => SentryBreadcrumb | null
    beforeSend?: (event: SentryEvent) => SentryEvent | null
  }

  export function init(options: SentryInitOptions): void
  export function withScope(callback: (scope: SentryScope) => void): void
  export function captureException(error: unknown): void
  export function setContext(key: string, context: Record<string, unknown>): void
  export function setTag(key: string, value: string): void
  export function close(timeout?: number): Promise<boolean>
}

declare module '@sentry/electron/renderer' {
  export interface RendererSentryScope {
    setTag(key: string, value: string): void
    setExtras(extras: Record<string, unknown>): void
  }

  export interface RendererSentryBreadcrumb {
    category?: string
    message?: string
    level?: string
    data?: Record<string, unknown>
  }

  export interface RendererSentryEvent {
    extra?: Record<string, unknown>
    [key: string]: unknown
  }

  export interface RendererSentryInitOptions {
    beforeBreadcrumb?: (breadcrumb: RendererSentryBreadcrumb) => RendererSentryBreadcrumb | null
    beforeSend?: (event: RendererSentryEvent) => RendererSentryEvent | null
  }

  export function init(options?: RendererSentryInitOptions): void
  export function addBreadcrumb(breadcrumb: RendererSentryBreadcrumb): void
  export function withScope(callback: (scope: RendererSentryScope) => void): void
  export function captureException(error: unknown): void
}

declare module 'electron-updater' {
  export const autoUpdater: {
    autoDownload: boolean
    autoInstallOnAppQuit: boolean
    disableDifferentialDownload: boolean
    on(event: string, listener: (...args: unknown[]) => void): void
    checkForUpdates(): void
    quitAndInstall(): void
  }
}

declare module 'posthog-js' {
  export interface PostHogInstance {
    init(apiKey: string, options?: Record<string, unknown>): void
    capture(event: string, properties?: Record<string, unknown>): void
    identify(distinctId: string): void
    opt_in_capturing(): void
    opt_out_capturing(): void
    reset(): void
  }

  const posthog: PostHogInstance
  export default posthog
}
