import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Regression guard: @sentry/electron v7 throws if init() runs after the app
// 'ready' event. Sentry initialization (and the synchronous consent read that
// precedes it) must therefore happen at module evaluation time in
// src/main/index.ts — i.e. as top-level statements — and must NOT be invoked
// from inside the app.whenReady() handler (or any other callback that runs
// after 'ready'). Previously the init call lived inside whenReady, the SDK
// threw, the catch swallowed it, and Sentry stayed off in every packaged
// build on both Windows and macOS.

// Resolved from the repo root, which is vitest's cwd for this config.
const INDEX_PATH = join(process.cwd(), 'src', 'main', 'index.ts')

interface CallSite {
  name: string
  isTopLevel: boolean
  position: number
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function collectCallSites(sourceFile: ts.SourceFile, functionNames: string[]): CallSite[] {
  const callSites: CallSite[] = []

  const visit = (node: ts.Node, insideFunction: boolean): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      functionNames.includes(node.expression.text)
    ) {
      callSites.push({
        name: node.expression.text,
        isTopLevel: !insideFunction,
        position: node.getStart(sourceFile)
      })
    }
    const nextInsideFunction = insideFunction || isFunctionLike(node)
    ts.forEachChild(node, (child) => visit(child, nextInsideFunction))
  }

  visit(sourceFile, false)
  return callSites
}

function parseMainIndex(): ts.SourceFile {
  const source = readFileSync(INDEX_PATH, 'utf-8')
  return ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
}

describe('main process Sentry initialization ordering', () => {
  const sourceFile = parseMainIndex()
  const callSites = collectCallSites(sourceFile, [
    'initializeMainSentry',
    'readInitialAnalyticsConsent',
    'readInitialDiagnosticLogUploadConsent'
  ])

  it('calls initializeMainSentry at module top level (before the app ready event)', () => {
    const initCalls = callSites.filter((site) => site.name === 'initializeMainSentry')
    expect(initCalls.length).toBeGreaterThan(0)
    expect(
      initCalls.some((site) => site.isTopLevel),
      'initializeMainSentry() must be invoked as a top-level statement so it runs ' +
        "during module evaluation, before Electron's 'ready' event fires"
    ).toBe(true)
  })

  it('does not call initializeMainSentry from inside any callback (e.g. app.whenReady)', () => {
    const nestedInitCalls = callSites.filter(
      (site) => site.name === 'initializeMainSentry' && !site.isTopLevel
    )
    expect(
      nestedInitCalls,
      'initializeMainSentry() must not be called from inside a function or callback: ' +
        "@sentry/electron v7 throws when init() runs after the 'ready' event, which " +
        'permanently disables Sentry in packaged builds'
    ).toEqual([])
  })

  it('reads analytics consent at top level before initializing Sentry', () => {
    const topLevelInit = callSites.find(
      (site) => site.name === 'initializeMainSentry' && site.isTopLevel
    )
    const topLevelConsentRead = callSites.find(
      (site) => site.name === 'readInitialAnalyticsConsent' && site.isTopLevel
    )
    const topLevelLogUploadConsentRead = callSites.find(
      (site) => site.name === 'readInitialDiagnosticLogUploadConsent' && site.isTopLevel
    )

    expect(topLevelInit).toBeDefined()
    expect(
      topLevelConsentRead,
      'analytics consent must be read at module top level so early crash events ' +
        'from consenting users are not dropped by the beforeSend consent gate'
    ).toBeDefined()
    expect(topLevelLogUploadConsentRead).toBeDefined()
    expect(topLevelConsentRead!.position).toBeLessThan(topLevelInit!.position)
    expect(topLevelLogUploadConsentRead!.position).toBeLessThan(topLevelInit!.position)
  })

  it('does not double-read initial consent (single top-level read only)', () => {
    const consentReads = callSites.filter((site) => site.name === 'readInitialAnalyticsConsent')
    expect(consentReads).toHaveLength(1)
    expect(consentReads[0].isTopLevel).toBe(true)
  })
})
