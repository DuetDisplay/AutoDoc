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
  MeetingExportFormat,
  MeetingExportRequest,
  MeetingExportResult,
  MeetingExportVariant
} from '../../../shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  constructBrowserWindow: vi.fn(),
  fromWebContents: vi.fn(),
  appGetPath: vi.fn(),
  dialogShowSaveDialog: vi.fn(),
  loadSnapshotFromSource: vi.fn(),
  loadSnapshot: vi.fn(),
  showSaveDialog: vi.fn(),
  renderPdf: vi.fn(),
  writeExportFile: vi.fn(),
  getDocumentsPath: vi.fn(),
  getParentWindow: vi.fn(),
  createSuggestedFilename: vi.fn(),
  meetingExportExtension: vi.fn(),
  renderMarkdown: vi.fn(),
  renderDocx: vi.fn(),
  renderHtml: vi.fn(),
  atomicOpen: vi.fn(),
  actualOpen: undefined as typeof import('fs/promises').open | undefined
}))

vi.mock('electron', () => {
  function BrowserWindowMock(options: unknown): unknown {
    return mocks.constructBrowserWindow(options)
  }
  BrowserWindowMock.fromWebContents = mocks.fromWebContents

  return {
    app: { getPath: mocks.appGetPath },
    BrowserWindow: BrowserWindowMock,
    dialog: { showSaveDialog: mocks.dialogShowSaveDialog },
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
  meetingExportExtension: mocks.meetingExportExtension,
  renderMeetingExportMarkdown: mocks.renderMarkdown,
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
  notes: {} as NonNullable<MeetingExportSnapshot['notes']>,
  transcript: [],
  speakers: {}
} satisfies MeetingExportSnapshot

function request(
  format: MeetingExportFormat = 'markdown',
  variant: MeetingExportVariant = 'full'
): MeetingExportRequest {
  return { meetingId: 'meeting-123', format, variant }
}

function getHandler(): (
  event: { sender: Sender },
  rawRequest: unknown
) => Promise<MeetingExportResult> {
  const handler = mocks.handlers.get('meeting:export')
  if (!handler) throw new Error('Missing meeting:export IPC handler')
  return handler as (event: { sender: Sender }, rawRequest: unknown) => Promise<MeetingExportResult>
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
  mocks.getDocumentsPath.mockReturnValue('/documents')
  mocks.getParentWindow.mockReturnValue(parentWindow)
  mocks.createSuggestedFilename.mockImplementation(
    (title: string, format: MeetingExportFormat, variant: MeetingExportVariant) =>
      `${title}-${variant}.${format === 'markdown' ? 'md' : format}`
  )
  mocks.meetingExportExtension.mockImplementation((format: MeetingExportFormat) =>
    format === 'markdown' ? 'md' : format
  )
  mocks.renderMarkdown.mockReturnValue('markdown output')
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
      { meetingId: 123, format: 'markdown', variant: 'full' },
      { meetingId: 'meeting-123', format: 'html', variant: 'full' },
      { meetingId: 'meeting-123', format: 'pdf', variant: 'verbose' },
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
          },
          variant: { enumerable: true, value: 'full' }
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

      await expect(invoke(request(format, 'concise'))).resolves.toEqual({
        status: 'cancelled'
      })

      expect(mocks.createSuggestedFilename).toHaveBeenCalledWith(
        'Weekly product sync',
        format,
        'concise'
      )
      expect(mocks.showSaveDialog).toHaveBeenCalledWith(parentWindow, {
        title: 'Export meeting',
        buttonLabel: 'Export',
        defaultPath: join('/documents', `Weekly product sync-concise.${extension}`),
        message: 'Choose where to save this meeting export.',
        filters: [{ name: filterName, extensions: [extension] }],
        properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent']
      })
    }
  )

  it('silently cancels before rendering, opening a PDF window, or writing', async () => {
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    register()

    await expect(invoke(request('pdf', 'full'))).resolves.toEqual({ status: 'cancelled' })

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

    await expect(invoke(request('pdf', 'full'))).resolves.toEqual({
      status: 'failed',
      code: 'write-failed'
    })

    expect(mocks.renderHtml).not.toHaveBeenCalled()
    expect(mocks.renderPdf).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).not.toHaveBeenCalled()
  })

  it('renders markdown with the requested variant', async () => {
    register()

    await expect(invoke(request('markdown', 'concise'))).resolves.toEqual({ status: 'saved' })

    expect(mocks.renderMarkdown).toHaveBeenCalledWith(snapshot, 'concise')
    expect(mocks.renderDocx).not.toHaveBeenCalled()
    expect(mocks.renderHtml).not.toHaveBeenCalled()
    expect(mocks.renderPdf).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).toHaveBeenCalledWith(
      '/exports/meeting',
      Buffer.from('markdown output')
    )
  })

  it('renders DOCX with the requested variant', async () => {
    const docx = Buffer.from('distinct docx output')
    mocks.renderDocx.mockResolvedValueOnce(docx)
    register()

    await expect(invoke(request('docx', 'full'))).resolves.toEqual({ status: 'saved' })

    expect(mocks.renderDocx).toHaveBeenCalledWith(snapshot, 'full')
    expect(mocks.renderMarkdown).not.toHaveBeenCalled()
    expect(mocks.renderHtml).not.toHaveBeenCalled()
    expect(mocks.renderPdf).not.toHaveBeenCalled()
    expect(mocks.writeExportFile).toHaveBeenCalledWith('/exports/meeting', docx)
  })

  it('renders PDF HTML with the requested variant and dispatches it to the PDF renderer', async () => {
    const pdf = Buffer.from('distinct pdf output')
    mocks.renderPdf.mockResolvedValueOnce(pdf)
    register()

    await expect(invoke(request('pdf', 'concise'))).resolves.toEqual({ status: 'saved' })

    expect(mocks.renderHtml).toHaveBeenCalledWith(snapshot, 'concise')
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
    mocks.loadSnapshot.mockResolvedValueOnce({
      ...snapshot,
      notes: null,
      transcript: []
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

describe('renderMeetingExportPdf', () => {
  function pdfWindow() {
    return {
      loadURL: vi.fn().mockResolvedValue(undefined),
      webContents: {
        printToPDF: vi.fn().mockResolvedValue(Buffer.from('rendered pdf'))
      },
      isDestroyed: vi.fn(() => false),
      destroy: vi.fn()
    }
  }

  it('creates a hidden hardened window and always destroys it after success', async () => {
    const window = pdfWindow()
    mocks.constructBrowserWindow.mockReturnValueOnce(window)

    await expect(renderMeetingExportPdf('<html>Meeting</html>')).resolves.toEqual(
      Buffer.from('rendered pdf')
    )

    expect(mocks.constructBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        show: false,
        webPreferences: expect.objectContaining({
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: false
        })
      })
    )
    expect(window.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html/))
    expect(window.webContents.printToPDF).toHaveBeenCalledWith(
      expect.objectContaining({
        pageSize: 'Letter',
        printBackground: true,
        displayHeaderFooter: true
      })
    )
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('destroys the hidden window when loading the export HTML fails', async () => {
    const window = pdfWindow()
    window.loadURL.mockRejectedValueOnce(new Error('load failed'))
    mocks.constructBrowserWindow.mockReturnValueOnce(window)

    await expect(renderMeetingExportPdf('<html>Meeting</html>')).rejects.toThrow('load failed')

    expect(window.webContents.printToPDF).not.toHaveBeenCalled()
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('destroys the hidden window when PDF printing fails', async () => {
    const window = pdfWindow()
    window.webContents.printToPDF.mockRejectedValueOnce(new Error('print failed'))
    mocks.constructBrowserWindow.mockReturnValueOnce(window)

    await expect(renderMeetingExportPdf('<html>Meeting</html>')).rejects.toThrow('print failed')

    expect(window.destroy).toHaveBeenCalledOnce()
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
