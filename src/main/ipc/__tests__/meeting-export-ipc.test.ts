import {
  mkdtemp,
  readFile,
  readdir,
  rename as renameFile,
  rm,
  unlink as unlinkFile,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type {
  MeetingCopyNotesResult,
  MeetingExportFormat,
  MeetingExportRequest,
  MeetingExportResult
} from '../../../shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  constructBrowserWindow: vi.fn(),
  fromPartition: vi.fn(),
  fromWebContents: vi.fn(),
  appGetPath: vi.fn(),
  clipboardWrite: vi.fn(),
  dialogShowSaveDialog: vi.fn(),
  loadSnapshotFromSource: vi.fn(),
  loadSnapshot: vi.fn(),
  showSaveDialog: vi.fn(),
  renderPdf: vi.fn(),
  writeExportFile: vi.fn(),
  getDocumentsPath: vi.fn(),
  getParentWindow: vi.fn(),
  createSuggestedFilename: vi.fn(),
  hasExportNotes: vi.fn(),
  meetingExportExtension: vi.fn(),
  renderMarkdown: vi.fn(),
  renderPlainText: vi.fn(),
  renderDocx: vi.fn(),
  renderHtml: vi.fn(),
  atomicOpen: vi.fn(),
  actualOpen: undefined as typeof import('fs/promises').open | undefined,
  privilegedSchemeRegistrations: [] as unknown[]
}))

vi.mock('electron', () => {
  function BrowserWindowMock(options: unknown): unknown {
    return mocks.constructBrowserWindow(options)
  }
  BrowserWindowMock.fromWebContents = mocks.fromWebContents

  return {
    app: { getPath: mocks.appGetPath },
    BrowserWindow: BrowserWindowMock,
    clipboard: { write: mocks.clipboardWrite },
    dialog: { showSaveDialog: mocks.dialogShowSaveDialog },
    protocol: {
      registerSchemesAsPrivileged: vi.fn((schemes: unknown) => {
        mocks.privilegedSchemeRegistrations.push(schemes)
      })
    },
    session: { fromPartition: mocks.fromPartition },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        mocks.handlers.set(channel, handler)
      })
    }
  }
})

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  mocks.actualOpen = actual.open
  return { ...actual, open: mocks.atomicOpen }
})

vi.mock('../../services/meeting-export', () => ({
  createMeetingExportSuggestedFilename: mocks.createSuggestedFilename,
  hasMeetingExportNotes: mocks.hasExportNotes,
  meetingExportExtension: mocks.meetingExportExtension,
  renderMeetingExportMarkdown: mocks.renderMarkdown,
  renderMeetingExportPlainText: mocks.renderPlainText,
  renderMeetingExportDocx: mocks.renderDocx,
  renderMeetingExportHtml: mocks.renderHtml
}))

vi.mock('../../services/meeting-export-sources', () => ({
  loadMeetingExportSnapshot: mocks.loadSnapshotFromSource
}))

import {
  registerMeetingExportIpc,
  renderMeetingExportPdf,
  writeExportFileAtomically,
  type RegisterMeetingExportIpcOptions
} from '../meeting-export-ipc'
import type { MeetingExportSnapshot } from '../../services/meeting-export'

type Sender = { id: number }

const trustedSender: Sender = { id: 1 }
const untrustedSender: Sender = { id: 2 }
const parentWindow = { isDestroyed: vi.fn(() => false) } as unknown as BrowserWindow
const snapshot = {
  detail: {
    title: 'Weekly product sync',
    sourceName: 'Product sync',
    date: Date.UTC(2026, 7, 23, 14, 30),
    durationSeconds: 3_600
  },
  notes: {
    normalizedSchemaVersion: 1,
    meetingId: 'meeting-123',
    source: { format: 'legacy-segments', adapterVersion: 1 },
    sourceTranscriptRevision: null,
    sourceAttributionRevision: null,
    revision: `legacy-sha256:${'a'.repeat(64)}`,
    overview: {
      text: 'The team agreed on the export plan.',
      sources: [],
      provenance: 'legacy'
    },
    keyTakeaways: [],
    sections: [],
    decisions: [],
    nextSteps: []
  } as NonNullable<MeetingExportSnapshot['notes']>
} satisfies MeetingExportSnapshot

function request(format: MeetingExportFormat = 'markdown'): MeetingExportRequest {
  return { meetingId: 'meeting-123', format }
}

function getHandler(): (
  event: { sender: Sender },
  rawRequest: unknown
) => Promise<MeetingExportResult> {
  const handler = mocks.handlers.get('meeting:export')
  if (!handler) throw new Error('Missing meeting:export IPC handler')
  return handler as (event: { sender: Sender }, rawRequest: unknown) => Promise<MeetingExportResult>
}

function getCopyNotesHandler(): (
  event: { sender: Sender },
  rawRequest: unknown
) => Promise<MeetingCopyNotesResult> {
  const handler = mocks.handlers.get('meeting:copy-notes')
  if (!handler) throw new Error('Missing meeting:copy-notes IPC handler')
  return handler as (
    event: { sender: Sender },
    rawRequest: unknown
  ) => Promise<MeetingCopyNotesResult>
}

function register(overrides: Partial<RegisterMeetingExportIpcOptions> = {}): void {
  registerMeetingExportIpc({
    recordingsBaseDir: '/recordings',
    isTrustedSender: (sender) => sender === (trustedSender as unknown as typeof sender),
    loadSnapshot: mocks.loadSnapshot,
    showSaveDialog: mocks.showSaveDialog,
    renderPdf: mocks.renderPdf,
    writeExportFile: mocks.writeExportFile,
    getDocumentsPath: mocks.getDocumentsPath,
    getParentWindow: mocks.getParentWindow,
    ...overrides
  })
}

async function invoke(
  rawRequest: unknown,
  sender: Sender = trustedSender
): Promise<MeetingExportResult> {
  return getHandler()({ sender }, rawRequest)
}

async function invokeCopyNotes(
  rawRequest: unknown,
  sender: Sender = trustedSender
): Promise<MeetingCopyNotesResult> {
  return getCopyNotesHandler()({ sender }, rawRequest)
}

function nodeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

beforeEach(() => {
  mocks.handlers.clear()
  vi.clearAllMocks()

  mocks.loadSnapshot.mockResolvedValue(snapshot)
  mocks.showSaveDialog.mockResolvedValue({
    canceled: false,
    filePath: '/exports/meeting'
  })
  mocks.renderPdf.mockResolvedValue(Buffer.from('pdf output'))
  mocks.writeExportFile.mockResolvedValue(undefined)
  mocks.clipboardWrite.mockReturnValue(undefined)
  mocks.getDocumentsPath.mockReturnValue('/documents')
  mocks.getParentWindow.mockReturnValue(parentWindow)
  mocks.createSuggestedFilename.mockImplementation(
    (title: string, format: MeetingExportFormat) =>
      `${title}.${format === 'markdown' ? 'md' : format}`
  )
  mocks.hasExportNotes.mockReturnValue(true)
  mocks.meetingExportExtension.mockImplementation((format: MeetingExportFormat) =>
    format === 'markdown' ? 'md' : format
  )
  mocks.renderMarkdown.mockReturnValue('markdown output')
  mocks.renderPlainText.mockReturnValue('plain text output')
  mocks.renderDocx.mockResolvedValue(Buffer.from('docx output'))
  mocks.renderHtml.mockReturnValue('<html><body>PDF output</body></html>')
})

describe('meeting export IPC', () => {
  it('rejects untrusted and malformed requests before reading meeting data', async () => {
    register()

    const unreadRequest = Object.defineProperties(
      {},
      {
        meetingId: {
          enumerable: true,
          get: () => {
            throw new Error('request should not be read')
          }
        }
      }
    )
    await expect(invoke(unreadRequest, untrustedSender)).resolves.toEqual({
      status: 'failed',
      code: 'invalid-request'
    })

    const malformedRequests: unknown[] = [
      null,
      [],
      { meetingId: 123, format: 'markdown' },
      { meetingId: 'meeting-123', format: 'html' },
      { meetingId: 'meeting-123', format: 'pdf', variant: 'full' },
      { ...request(), rendererChosenPath: '/private/renderer-controlled' }
    ]
    malformedRequests.push(
      Object.defineProperties(
        {},
        {
          format: { enumerable: true, value: 'markdown' },
          meetingId: {
            enumerable: true,
            get: () => {
              throw new Error('malicious accessor')
            }
          }
        }
      )
    )
    for (const malformedRequest of malformedRequests) {
      await expect(invoke(malformedRequest)).resolves.toEqual({
        status: 'failed',
        code: 'invalid-request'
      })
    }

    expect(mocks.loadSnapshot).not.toHaveBeenCalled()
    expect(mocks.getParentWindow).not.toHaveBeenCalled()
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).not.toHaveBeenCalled()
  })

  it.each([
    ['markdown', 'Markdown', 'md'],
    ['pdf', 'PDF', 'pdf'],
    ['docx', 'Word Document', 'docx']
  ] as const)(
    'uses a main-owned parent, filename, and filter for %s',
    async (format, filterName, extension) => {
      mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true })
      register()

      await expect(invoke(request(format))).resolves.toEqual({
        status: 'cancelled'
      })

      expect(mocks.createSuggestedFilename).toHaveBeenCalledWith('Weekly product sync', format)
      expect(mocks.showSaveDialog).toHaveBeenCalledWith(parentWindow, {
        title: 'Export notes',
        buttonLabel: 'Export',
        defaultPath: join('/documents', `Weekly product sync.${extension}`),
        message: 'Choose where to save these notes.',
        filters: [{ name: filterName, extensions: [extension] }],
        properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent']
      })
    }
  )

  it('silently cancels before rendering, opening a PDF window, or writing', async () => {
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    register()

    await expect(invoke(request('pdf'))).resolves.toEqual({ status: 'cancelled' })

    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.renderDocx).not.toHaveBeenCalled()
    expect(mocks.renderHtml).not.toHaveBeenCalled()
    expect(mocks.renderPdf).not.toHaveBeenCalled()
    expect(mocks.constructBrowserWindow).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).not.toHaveBeenCalled()
  })

  it('bounds native save dialog failures without rendering or writing', async () => {
    mocks.showSaveDialog.mockRejectedValueOnce(new Error('dialog unavailable'))
    register()

    await expect(invoke(request('pdf'))).resolves.toEqual({
      status: 'failed',
      code: 'write-failed'
    })

    expect(mocks.renderHtml).not.toHaveBeenCalled()
    expect(mocks.renderPdf).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).not.toHaveBeenCalled()
  })

  it('renders markdown for the meeting snapshot', async () => {
    register()

    await expect(invoke(request('markdown'))).resolves.toEqual({ status: 'saved' })

    expect(mocks.renderMarkdown).toHaveBeenCalledWith(snapshot)
    expect(mocks.renderDocx).not.toHaveBeenCalled()
    expect(mocks.renderHtml).not.toHaveBeenCalled()
    expect(mocks.renderPdf).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).toHaveBeenCalledWith(
      '/exports/meeting',
      Buffer.from('markdown output')
    )
  })

  it('renders DOCX for the meeting snapshot', async () => {
    const docx = Buffer.from('distinct docx output')
    mocks.renderDocx.mockResolvedValueOnce(docx)
    register()

    await expect(invoke(request('docx'))).resolves.toEqual({ status: 'saved' })

    expect(mocks.renderDocx).toHaveBeenCalledWith(snapshot)
    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.renderHtml).not.toHaveBeenCalled()
    expect(mocks.renderPdf).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).toHaveBeenCalledWith('/exports/meeting', docx)
  })

  it('renders PDF HTML and dispatches it to the PDF renderer', async () => {
    const pdf = Buffer.from('distinct pdf output')
    mocks.renderPdf.mockResolvedValueOnce(pdf)
    register()

    await expect(invoke(request('pdf'))).resolves.toEqual({ status: 'saved' })

    expect(mocks.renderHtml).toHaveBeenCalledWith(snapshot)
    expect(mocks.renderPdf).toHaveBeenCalledWith('<html><body>PDF output</body></html>')
    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.renderDocx).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).toHaveBeenCalledWith('/exports/meeting', pdf)
  })

  it('preserves an existing case-insensitive extension', async () => {
    mocks.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/exports/meeting.PDF'
    })
    register()

    await expect(invoke(request('pdf'))).resolves.toEqual({ status: 'saved' })

    expect(mocks.writeExportFile).toHaveBeenCalledWith('/exports/meeting.PDF', expect.any(Buffer))
  })

  it.each(['/exports/meeting', '/exports/report.txt'])(
    'writes exactly the native-dialog path without targeting an unconfirmed file: %s',
    async (filePath) => {
      mocks.showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath
      })
      register()

      await expect(invoke(request('docx'))).resolves.toEqual({ status: 'saved' })

      expect(mocks.writeExportFile).toHaveBeenCalledWith(filePath, expect.any(Buffer))
    }
  )

  it('returns nothing-to-export before opening a save dialog', async () => {
    mocks.hasExportNotes.mockReturnValueOnce(false)
    mocks.loadSnapshot.mockResolvedValueOnce({
      ...snapshot,
      notes: null
    })
    register()

    await expect(invoke(request())).resolves.toEqual({
      status: 'failed',
      code: 'nothing-to-export'
    })

    expect(mocks.getParentWindow).not.toHaveBeenCalled()
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).not.toHaveBeenCalled()
  })

  it('returns nothing-to-export for a structurally empty notes snapshot', async () => {
    const emptySnapshot = {
      ...snapshot,
      notes: {
        ...snapshot.notes,
        overview: null,
        keyTakeaways: [],
        sections: [],
        decisions: [],
        nextSteps: []
      }
    } satisfies MeetingExportSnapshot
    mocks.hasExportNotes.mockReturnValueOnce(false)
    mocks.loadSnapshot.mockResolvedValueOnce(emptySnapshot)
    register()

    await expect(invoke(request())).resolves.toEqual({
      status: 'failed',
      code: 'nothing-to-export'
    })

    expect(mocks.hasExportNotes).toHaveBeenCalledWith(emptySnapshot)
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
  })

  it('bounds snapshot failures as render-failed without opening a save dialog', async () => {
    mocks.loadSnapshot.mockRejectedValueOnce(new Error('snapshot unavailable'))
    register()

    await expect(invoke(request())).resolves.toEqual({
      status: 'failed',
      code: 'render-failed'
    })

    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).not.toHaveBeenCalled()
  })

  it('bounds notes inspection failures as render-failed without opening a save dialog', async () => {
    mocks.hasExportNotes.mockImplementationOnce(() => {
      throw new Error('invalid notes')
    })
    register()

    await expect(invoke(request())).resolves.toEqual({
      status: 'failed',
      code: 'render-failed'
    })

    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).not.toHaveBeenCalled()
  })

  it('bounds renderer failures as render-failed without writing a partial export', async () => {
    mocks.renderPdf.mockRejectedValueOnce(new Error('print failed'))
    register()

    await expect(invoke(request('pdf'))).resolves.toEqual({
      status: 'failed',
      code: 'render-failed'
    })

    expect(mocks.writeExportFile).not.toHaveBeenCalled()
  })

  it.each(['ENOSPC', 'EDQUOT'])('maps %s writes to disk-full', async (code) => {
    mocks.writeExportFile.mockRejectedValueOnce(nodeError(code))
    register()

    await expect(invoke(request())).resolves.toEqual({
      status: 'failed',
      code: 'disk-full'
    })
  })

  it.each(['EACCES', 'EPERM', 'EROFS'])('maps %s writes to permission-denied', async (code) => {
    mocks.writeExportFile.mockRejectedValueOnce(nodeError(code))
    register()

    await expect(invoke(request())).resolves.toEqual({
      status: 'failed',
      code: 'permission-denied'
    })
  })

  it('maps an unclassified write error to write-failed', async () => {
    mocks.writeExportFile.mockRejectedValueOnce(new Error('device disconnected'))
    register()

    await expect(invoke(request())).resolves.toEqual({
      status: 'failed',
      code: 'write-failed'
    })
  })
})

describe('meeting copy notes IPC', () => {
  it('copies notes as plain text only', async () => {
    register()

    await expect(invokeCopyNotes({ meetingId: 'meeting-123' })).resolves.toEqual({
      status: 'copied'
    })

    expect(mocks.loadSnapshot).toHaveBeenCalledWith('/recordings', 'meeting-123')
    expect(mocks.hasExportNotes).toHaveBeenCalledWith(snapshot)
    expect(mocks.renderPlainText).toHaveBeenCalledWith(snapshot)
    expect(mocks.renderHtml).not.toHaveBeenCalled()
    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.clipboardWrite).toHaveBeenCalledWith({
      text: 'plain text output'
    })
  })

  it('rejects untrusted and malformed requests before reading meeting data', async () => {
    register()

    const unreadRequest = Object.defineProperties(
      {},
      {
        meetingId: {
          enumerable: true,
          get: () => {
            throw new Error('request should not be read')
          }
        }
      }
    )
    await expect(invokeCopyNotes(unreadRequest, untrustedSender)).resolves.toEqual({
      status: 'failed',
      code: 'invalid-request'
    })

    const malformedRequests: unknown[] = [
      null,
      [],
      {},
      { meetingId: 123 },
      { meetingId: 'meeting-123', format: 'markdown' },
      Object.defineProperty({}, 'meetingId', {
        enumerable: true,
        get: () => {
          throw new Error('malicious accessor')
        }
      })
    ]
    for (const malformedRequest of malformedRequests) {
      await expect(invokeCopyNotes(malformedRequest)).resolves.toEqual({
        status: 'failed',
        code: 'invalid-request'
      })
    }

    expect(mocks.loadSnapshot).not.toHaveBeenCalled()
    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.clipboardWrite).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', null],
    [
      'structurally empty',
      {
        ...snapshot.notes,
        overview: null,
        keyTakeaways: [],
        sections: [],
        decisions: [],
        nextSteps: []
      }
    ]
  ])('returns nothing-to-copy for %s notes', async (_label, notes) => {
    const emptySnapshot = { ...snapshot, notes } as MeetingExportSnapshot
    mocks.loadSnapshot.mockResolvedValueOnce(emptySnapshot)
    mocks.hasExportNotes.mockReturnValueOnce(false)
    register()

    await expect(invokeCopyNotes({ meetingId: 'meeting-123' })).resolves.toEqual({
      status: 'failed',
      code: 'nothing-to-copy'
    })

    expect(mocks.hasExportNotes).toHaveBeenCalledWith(emptySnapshot)
    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.clipboardWrite).not.toHaveBeenCalled()
  })

  it('bounds snapshot failures as copy-failed', async () => {
    mocks.loadSnapshot.mockRejectedValueOnce(new Error('snapshot unavailable'))
    register()

    await expect(invokeCopyNotes({ meetingId: 'meeting-123' })).resolves.toEqual({
      status: 'failed',
      code: 'copy-failed'
    })

    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.clipboardWrite).not.toHaveBeenCalled()
  })

  it('bounds notes inspection failures as copy-failed', async () => {
    mocks.hasExportNotes.mockImplementationOnce(() => {
      throw new Error('invalid notes')
    })
    register()

    await expect(invokeCopyNotes({ meetingId: 'meeting-123' })).resolves.toEqual({
      status: 'failed',
      code: 'copy-failed'
    })

    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.clipboardWrite).not.toHaveBeenCalled()
  })

  it('bounds clipboard rendering failures as copy-failed', async () => {
    mocks.renderPlainText.mockImplementationOnce(() => {
      throw new Error('render failed')
    })
    register()

    await expect(invokeCopyNotes({ meetingId: 'meeting-123' })).resolves.toEqual({
      status: 'failed',
      code: 'copy-failed'
    })

    expect(mocks.clipboardWrite).not.toHaveBeenCalled()
  })

  it('bounds clipboard failures as copy-failed', async () => {
    mocks.clipboardWrite.mockImplementationOnce(() => {
      throw new Error('clipboard unavailable')
    })
    register()

    await expect(invokeCopyNotes({ meetingId: 'meeting-123' })).resolves.toEqual({
      status: 'failed',
      code: 'copy-failed'
    })

    expect(mocks.renderPlainText).toHaveBeenCalledWith(snapshot)
    expect(mocks.renderHtml).not.toHaveBeenCalled()
    expect(mocks.clipboardWrite).toHaveBeenCalledWith({
      text: 'plain text output'
    })
  })
})

describe('renderMeetingExportPdf', () => {
  function pdfWindow() {
    const protocol = {
      handle: vi.fn(),
      unhandle: vi.fn()
    }
    const renderSession = { protocol }
    mocks.fromPartition.mockReturnValueOnce(renderSession)
    return {
      loadURL: vi.fn().mockResolvedValue(undefined),
      webContents: {
        session: renderSession,
        printToPDF: vi.fn().mockResolvedValue(Buffer.from('rendered pdf'))
      },
      protocol,
      renderSession,
      isDestroyed: vi.fn(() => false),
      destroy: vi.fn()
    }
  }

  it('registers only the standard navigation privilege before Electron is ready', () => {
    expect(mocks.privilegedSchemeRegistrations).toContainEqual([
      { scheme: 'autodoc-export', privileges: { standard: true } }
    ])
  })

  it('creates a hidden hardened window and always destroys it after success', async () => {
    const window = pdfWindow()
    mocks.constructBrowserWindow.mockReturnValueOnce(window)

    const html = '<html>Meeting</html>'
    await expect(renderMeetingExportPdf(html)).resolves.toEqual(Buffer.from('rendered pdf'))

    expect(mocks.constructBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        show: false,
        webPreferences: expect.objectContaining({
          session: window.renderSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: false
        })
      })
    )
    expect(mocks.fromPartition).toHaveBeenCalledWith(
      expect.stringMatching(/^autodoc-export-[0-9a-f-]+$/)
    )
    expect(mocks.fromPartition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.constructBrowserWindow.mock.invocationCallOrder[0]
    )
    const browserWindowOptions = mocks.constructBrowserWindow.mock.calls[0]?.[0] as {
      webPreferences: Record<string, unknown>
    }
    expect(browserWindowOptions.webPreferences).not.toHaveProperty('partition')
    expect(window.protocol.handle).toHaveBeenCalledWith('autodoc-export', expect.any(Function))
    const renderUrl = window.loadURL.mock.calls[0]?.[0]
    expect(renderUrl).toMatch(/^autodoc-export:\/\/document\/[0-9a-f-]+$/)
    expect(renderUrl).not.toContain(html)

    const handler = window.protocol.handle.mock.calls[0]?.[1] as unknown as (request: {
      url: string
    }) => Response
    const response = await handler({ url: renderUrl })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    await expect(response.text()).resolves.toBe(html)

    const deniedResponse = await handler({ url: 'autodoc-export://document/not-this-export' })
    expect(deniedResponse.status).toBe(404)
    expect(window.webContents.printToPDF).toHaveBeenCalledWith(
      expect.objectContaining({
        pageSize: 'Letter',
        printBackground: true,
        displayHeaderFooter: true
      })
    )
    expect(window.protocol.unhandle).toHaveBeenCalledWith('autodoc-export')
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('serves large export HTML from memory without putting it in the navigation URL', async () => {
    const window = pdfWindow()
    mocks.constructBrowserWindow.mockReturnValueOnce(window)
    const html = `<!doctype html><html><body>${'Sensitive meeting content. '.repeat(24_000)}</body></html>`
    expect(Buffer.byteLength(html)).toBeGreaterThan(527 * 1024)

    await expect(renderMeetingExportPdf(html)).resolves.toEqual(Buffer.from('rendered pdf'))

    const renderUrl = window.loadURL.mock.calls[0]?.[0]
    expect(renderUrl).toMatch(/^autodoc-export:\/\/document\/[0-9a-f-]+$/)
    expect(renderUrl.length).toBeLessThan(100)
    const handler = window.protocol.handle.mock.calls[0]?.[1] as unknown as (request: {
      url: string
    }) => Response
    const response = await handler({ url: renderUrl })
    await expect(response.text()).resolves.toBe(html)
    expect(window.webContents.printToPDF).toHaveBeenCalledOnce()
    expect(window.protocol.unhandle).toHaveBeenCalledWith('autodoc-export')
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('destroys the hidden window when loading the export HTML fails', async () => {
    const window = pdfWindow()
    window.loadURL.mockRejectedValueOnce(new Error('load failed'))
    mocks.constructBrowserWindow.mockReturnValueOnce(window)

    await expect(renderMeetingExportPdf('<html>Meeting</html>')).rejects.toThrow('load failed')

    expect(window.webContents.printToPDF).not.toHaveBeenCalled()
    expect(window.protocol.unhandle).toHaveBeenCalledWith('autodoc-export')
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('destroys the hidden window when PDF printing fails', async () => {
    const window = pdfWindow()
    window.webContents.printToPDF.mockRejectedValueOnce(new Error('print failed'))
    mocks.constructBrowserWindow.mockReturnValueOnce(window)

    await expect(renderMeetingExportPdf('<html>Meeting</html>')).rejects.toThrow('print failed')

    expect(window.protocol.unhandle).toHaveBeenCalledWith('autodoc-export')
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('removes the in-memory protocol handler if window construction fails', async () => {
    const window = pdfWindow()
    mocks.constructBrowserWindow.mockImplementationOnce(() => {
      throw new Error('window construction failed')
    })

    await expect(renderMeetingExportPdf('<html>Meeting</html>')).rejects.toThrow(
      'window construction failed'
    )

    expect(window.protocol.handle).toHaveBeenCalledOnce()
    expect(window.protocol.unhandle).toHaveBeenCalledWith('autodoc-export')
    expect(window.destroy).not.toHaveBeenCalled()
  })
})

describe('writeExportFileAtomically', () => {
  it('cleans its sibling temp and preserves an existing destination on ENOSPC', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autodoc-export-ipc-'))
    const destination = join(directory, 'meeting.md')
    await writeFile(destination, 'existing export')

    const actualOpen = mocks.actualOpen
    if (!actualOpen) throw new Error('Actual fs.open implementation was not initialized')
    mocks.atomicOpen.mockImplementationOnce(
      async (filePath: string, flags: string, mode: number) => {
        const handle = await actualOpen(filePath, flags, mode)
        return {
          writeFile: vi.fn().mockRejectedValue(nodeError('ENOSPC')),
          sync: () => handle.sync(),
          close: () => handle.close()
        }
      }
    )

    try {
      await expect(
        writeExportFileAtomically(destination, Buffer.from('replacement export'))
      ).rejects.toMatchObject({ code: 'ENOSPC' })

      await expect(readFile(destination, 'utf8')).resolves.toBe('existing export')
      await expect(readdir(directory)).resolves.toEqual(['meeting.md'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('restores the previous destination if Windows replacement fails after backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autodoc-export-ipc-'))
    const destination = join(directory, 'meeting.md')
    await writeFile(destination, 'existing export')
    const actualOpen = mocks.actualOpen
    if (!actualOpen) throw new Error('Actual fs.open implementation was not initialized')
    let installAttempts = 0

    const renameWithWindowsFailure = vi.fn(async (source: string, target: string) => {
      if (target === destination && source.endsWith('.tmp')) {
        installAttempts += 1
        if (installAttempts === 1) throw nodeError('EPERM')
        throw nodeError('EIO')
      }
      await renameFile(source, target)
    })

    try {
      await expect(
        writeExportFileAtomically(destination, Buffer.from('replacement export'), {
          open: actualOpen,
          rename: renameWithWindowsFailure,
          unlink: unlinkFile
        })
      ).rejects.toMatchObject({ code: 'EIO' })

      await expect(readFile(destination, 'utf8')).resolves.toBe('existing export')
      await expect(readdir(directory)).resolves.toEqual(['meeting.md'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('removes its backup after a successful Windows-style replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autodoc-export-ipc-'))
    const destination = join(directory, 'meeting.md')
    await writeFile(destination, 'existing export')
    const actualOpen = mocks.actualOpen
    if (!actualOpen) throw new Error('Actual fs.open implementation was not initialized')
    let installAttempts = 0

    const renameWithWindowsFallback = vi.fn(async (source: string, target: string) => {
      if (target === destination && source.endsWith('.tmp')) {
        installAttempts += 1
        if (installAttempts === 1) throw nodeError('EPERM')
      }
      await renameFile(source, target)
    })

    try {
      await writeExportFileAtomically(destination, Buffer.from('replacement export'), {
        open: actualOpen,
        rename: renameWithWindowsFallback,
        unlink: unlinkFile
      })

      await expect(readFile(destination, 'utf8')).resolves.toBe('replacement export')
      await expect(readdir(directory)).resolves.toEqual(['meeting.md'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
