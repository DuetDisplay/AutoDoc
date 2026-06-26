import { describe, expect, it } from 'vitest'
import { createSentryStubRuntime } from '../sentry-stub'

describe('sentry stub runtime', () => {
  it('returns the active withScope scope from getCurrentScope', () => {
    const runtime = createSentryStubRuntime('/tmp/autodoc-sentry-stub.jsonl')
    const isolationScope = runtime.getIsolationScope()
    let scopedScope: ReturnType<typeof runtime.getCurrentScope> | null = null

    runtime.withScope((scope) => {
      scopedScope = runtime.getCurrentScope()
      expect(scopedScope).toBe(scope)
    })

    expect(scopedScope).not.toBeNull()
    expect(runtime.getCurrentScope()).toBe(isolationScope)
  })
})
