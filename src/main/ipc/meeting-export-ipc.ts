import { randomUUID } from 'crypto'
import { open, rename, unlink } from 'fs/promises'
import { basename, dirname, join } from 'path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  session,
  type SaveDialogOptions,
  type WebContents
} from 'electron'
import type {
  MeetingCopyNotesFailureCode,
  MeetingCopyNotesRequest,
  MeetingCopyNotesResult,
  MeetingExportFailureCode,
  MeetingExportFormat,
  MeetingExportRequest,
  MeetingExportResult
} from '../../shared/types'
import {
  createMeetingExportSuggestedFilename,
  hasMeetingExportNotes,
  meetingExportExtension,
  renderMeetingExportDocx,
  renderMeetingExportHtml,
  renderMeetingExportMarkdown,
  renderMeetingExportPlainText,
  type MeetingExportSnapshot
} from '../services/meeting-export'
import { loadMeetingExportSnapshot } from '../services/meeting-export-sources'

const EXPORT_FORMATS = ['markdown', 'pdf', 'docx'] as const satisfies readonly MeetingExportFormat[]
const EXPORT_RENDER_SCHEME = 'autodoc-export'
const EXPORT_RENDER_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// Custom schemes must be registered before Electron's ready event. `standard`
// is the only privilege this document-only scheme needs for Chromium to parse
// and navigate its URL; CSP remains enforced and no fetch, storage, service
// worker, or CSP-bypass privileges are granted.
protocol.registerSchemesAsPrivileged([
  { scheme: EXPORT_RENDER_SCHEME, privileges: { standard: true } }
])

type ShowSaveDialog = (
  parent: BrowserWindow,
  options: SaveDialogOptions
) => Promise<Electron.SaveDialogReturnValue>

export interface RegisterMeetingExportIpcOptions {
  recordingsBaseDir: string
  isTrustedSender: (sender: WebContents) => boolean
  loadSnapshot?: (recordingsBaseDir: string, meetingId: string) => Promise<MeetingExportSnapshot>
  showSaveDialog?: ShowSaveDialog
  renderPdf?: (html: string) => Promise<Buffer>
  writeExportFile?: (filePath: string, data: Buffer) => Promise<void>
  writeClipboard?: (content: { text: string; html: string }) => void
  getDocumentsPath?: () => string
  getParentWindow?: (sender: WebContents) => BrowserWindow | null
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function isMeetingExportRequest(value: unknown): value is MeetingExportRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return (
      keys.length === 2 &&
      keys[0] === 'format' &&
      keys[1] === 'meetingId' &&
      typeof record.meetingId === 'string' &&
      EXPORT_FORMATS.some((format) => format === record.format)
    )
  } catch {
    return false
  }
}

function isMeetingCopyNotesRequest(value: unknown): value is MeetingCopyNotesRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    return keys.length === 1 && keys[0] === 'meetingId' && typeof record.meetingId === 'string'
  } catch {
    return false
  }
}

function exportFailure(code: MeetingExportFailureCode): MeetingExportResult {
  return { status: 'failed', code }
}

function copyFailure(code: MeetingCopyNotesFailureCode): MeetingCopyNotesResult {
  return { status: 'failed', code }
}

function mapWriteFailure(error: unknown): MeetingExportFailureCode {
  if (isNodeError(error, 'ENOSPC') || isNodeError(error, 'EDQUOT')) return 'disk-full'
  if (isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM') || isNodeError(error, 'EROFS')) {
    return 'permission-denied'
  }
  return 'write-failed'
}

function saveDialogOptions(
  snapshot: MeetingExportSnapshot,
  format: MeetingExportFormat,
  documentsPath: string
): SaveDialogOptions {
  const extension = meetingExportExtension(format)
  const formatName = format === 'markdown' ? 'Markdown' : format === 'pdf' ? 'PDF' : 'Word Document'
  return {
    title: 'Export notes',
    buttonLabel: 'Export',
    defaultPath: join(
      documentsPath,
      createMeetingExportSuggestedFilename(snapshot.detail.title, format)
    ),
    message: 'Choose where to save these notes.',
    filters: [{ name: formatName, extensions: [extension] }],
    properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent']
  }
}

interface AtomicWriteOperations {
  open: (filePath: string, flags: string, mode: number) => ReturnType<typeof open>
  rename: (source: string, destination: string) => Promise<void>
  unlink: (filePath: string) => Promise<void>
}

export async function writeExportFileAtomically(
  filePath: string,
  data: Buffer,
  operations: AtomicWriteOperations = { open, rename, unlink }
): Promise<void> {
  const operationId = randomUUID()
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.autodoc-${operationId}.tmp`)
  const backupPath = join(dirname(filePath), `.${basename(filePath)}.autodoc-${operationId}.bak`)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  let tempExists = false
  let backupExists = false
  let replacementInstalled = false
  try {
    handle = await operations.open(tempPath, 'wx', 0o600)
    tempExists = true
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null

    try {
      await operations.rename(tempPath, filePath)
    } catch (error) {
      if (
        !isNodeError(error, 'EEXIST') &&
        !isNodeError(error, 'EPERM') &&
        !isNodeError(error, 'EACCES')
      ) {
        throw error
      }
      // The native save dialog already obtained overwrite consent. Windows may
      // still refuse rename-over-existing. Move the prior export aside first so
      // it can be restored if installing the complete, synced replacement fails.
      await operations.rename(filePath, backupPath)
      backupExists = true
      try {
        await operations.rename(tempPath, filePath)
        tempExists = false
        replacementInstalled = true
      } catch (replacementError) {
        try {
          await operations.rename(backupPath, filePath)
          backupExists = false
        } catch (restoreError) {
          throw new AggregateError(
            [replacementError, restoreError],
            'Failed to install the export and restore the previous file'
          )
        }
        throw replacementError
      }
      await operations.unlink(backupPath)
      backupExists = false
    }
    tempExists = false
  } finally {
    await handle?.close().catch(() => undefined)
    if (tempExists) await operations.unlink(tempPath).catch(() => undefined)
    if (backupExists && replacementInstalled) {
      await operations.unlink(backupPath).catch(() => undefined)
    }
  }
}

export async function renderMeetingExportPdf(html: string): Promise<Buffer> {
  const partition = `autodoc-export-${randomUUID()}`
  const renderUrl = `${EXPORT_RENDER_SCHEME}://document/${randomUUID()}`
  const renderSession = session.fromPartition(partition)
  const renderProtocol = renderSession.protocol
  let protocolHandled = false
  let pdfWindow: BrowserWindow | null = null

  try {
    // Keep large exports in memory without relying on Chromium's
    // size-limited data: URL navigation or writing sensitive meeting text to a
    // plaintext temporary file. The unique, non-persistent partition confines
    // this handler to the hidden export window.
    renderProtocol.handle(EXPORT_RENDER_SCHEME, (request) => {
      if (request.url !== renderUrl) {
        return new Response(null, { status: 404 })
      }
      return new Response(html, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': EXPORT_RENDER_CSP,
          'Content-Type': 'text/html; charset=utf-8'
        }
      })
    })
    protocolHandled = true

    // Register the handler before constructing the window. Chromium can begin
    // initializing a window's session as soon as BrowserWindow is created; a
    // handler added afterward can miss the first custom-scheme navigation.
    pdfWindow = new BrowserWindow({
      show: false,
      width: 816,
      height: 1056,
      webPreferences: {
        session: renderSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        backgroundThrottling: false
      }
    })

    await pdfWindow.loadURL(renderUrl)
    return await pdfWindow.webContents.printToPDF({
      pageSize: 'Letter',
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="position:relative;width:100%;height:12px;color:#6B6A63;font:9px Arial,sans-serif"><span style="position:absolute;left:.65in">AutoDoc meeting export</span><span style="position:absolute;right:.65in;white-space:nowrap"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      generateTaggedPDF: true,
      generateDocumentOutline: true
    })
  } finally {
    try {
      if (protocolHandled) renderProtocol.unhandle(EXPORT_RENDER_SCHEME)
    } finally {
      if (pdfWindow && !pdfWindow.isDestroyed()) pdfWindow.destroy()
    }
  }
}

async function renderExport(
  snapshot: MeetingExportSnapshot,
  format: MeetingExportFormat,
  renderPdf: (html: string) => Promise<Buffer>
): Promise<Buffer> {
  if (format === 'markdown') {
    return Buffer.from(renderMeetingExportMarkdown(snapshot), 'utf8')
  }
  if (format === 'docx') return renderMeetingExportDocx(snapshot)
  return renderPdf(renderMeetingExportHtml(snapshot))
}

export function registerMeetingExportIpc(options: RegisterMeetingExportIpcOptions): void {
  const loadSnapshot = options.loadSnapshot ?? loadMeetingExportSnapshot
  const showSaveDialog =
    options.showSaveDialog ??
    ((parent, dialogOptions) => dialog.showSaveDialog(parent, dialogOptions))
  const renderPdf = options.renderPdf ?? renderMeetingExportPdf
  const writeExportFile = options.writeExportFile ?? writeExportFileAtomically
  const writeClipboard =
    options.writeClipboard ??
    ((content: { text: string; html: string }) => clipboard.write(content))
  const getDocumentsPath = options.getDocumentsPath ?? (() => app.getPath('documents'))
  const getParentWindow =
    options.getParentWindow ?? ((sender: WebContents) => BrowserWindow.fromWebContents(sender))

  ipcMain.handle(
    'meeting:export',
    async (event, rawRequest: unknown): Promise<MeetingExportResult> => {
      if (!options.isTrustedSender(event.sender) || !isMeetingExportRequest(rawRequest)) {
        return exportFailure('invalid-request')
      }

      let snapshot: MeetingExportSnapshot
      try {
        snapshot = await loadSnapshot(options.recordingsBaseDir, rawRequest.meetingId)
        if (!hasMeetingExportNotes(snapshot)) {
          return exportFailure('nothing-to-export')
        }
      } catch {
        return exportFailure('render-failed')
      }

      let saveResult: Electron.SaveDialogReturnValue
      try {
        const parent = getParentWindow(event.sender)
        if (!parent || parent.isDestroyed()) return exportFailure('invalid-request')
        saveResult = await showSaveDialog(
          parent,
          saveDialogOptions(snapshot, rawRequest.format, getDocumentsPath())
        )
      } catch {
        return exportFailure('write-failed')
      }
      if (saveResult.canceled || !saveResult.filePath) return { status: 'cancelled' }

      let data: Buffer
      try {
        data = await renderExport(snapshot, rawRequest.format, renderPdf)
      } catch {
        return exportFailure('render-failed')
      }

      try {
        // The native dialog owns filename and overwrite consent. Write exactly
        // the path it returned so a post-dialog extension rewrite cannot target
        // a different, unconfirmed existing file.
        await writeExportFile(saveResult.filePath, data)
        return { status: 'saved' }
      } catch (error) {
        return exportFailure(mapWriteFailure(error))
      }
    }
  )

  ipcMain.handle(
    'meeting:copy-notes',
    async (event, rawRequest: unknown): Promise<MeetingCopyNotesResult> => {
      if (!options.isTrustedSender(event.sender) || !isMeetingCopyNotesRequest(rawRequest)) {
        return copyFailure('invalid-request')
      }

      let snapshot: MeetingExportSnapshot
      try {
        snapshot = await loadSnapshot(options.recordingsBaseDir, rawRequest.meetingId)
        if (!hasMeetingExportNotes(snapshot)) return copyFailure('nothing-to-copy')
      } catch {
        return copyFailure('copy-failed')
      }

      try {
        writeClipboard({
          text: renderMeetingExportPlainText(snapshot),
          html: renderMeetingExportHtml(snapshot)
        })
        return { status: 'copied' }
      } catch {
        return copyFailure('copy-failed')
      }
    }
  )
}
