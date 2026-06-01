import { BrowserWindow, screen, ipcMain } from 'electron'

let notificationWindow: BrowserWindow | null = null
let notificationKind: NotificationKind | null = null
let autoDismissTimer: ReturnType<typeof setTimeout> | null = null
let cleanupListeners: (() => void) | null = null
let suppressAppActivationUntil = 0

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface NotificationOptions {
  title: string
  body: string
  bodyTitle?: string
  bodySuffix?: string
  primaryActionLabel: string
  onPrimaryAction: () => void
  onDismiss: () => void
  kind?: NotificationKind
  autoDismissMs?: number
}

export type NotificationKind = 'meeting-detection' | 'notes-ready'

export function shouldSuppressNotificationActivation(): boolean {
  if (suppressAppActivationUntil > 0) {
    if (Date.now() <= suppressAppActivationUntil) {
      return true
    }
    suppressAppActivationUntil = 0
  }

  return false
}

function clearAutoDismissTimer(): void {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer)
    autoDismissTimer = null
  }
}

export function showNotificationWindow(options: NotificationOptions): void {
  if (notificationWindow) {
    clearAutoDismissTimer()
    cleanupListeners?.()
    cleanupListeners = null
    notificationWindow.close()
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workArea
  const winWidth = 400
  const winHeight = 128 // Extra space for multi-line text, transparent padding, and shadow
  const x = Math.round(workArea.x + (workArea.width - winWidth) / 2)
  const y = workArea.y + 8

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false, // We draw our own shadow via CSS
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  notificationWindow = win
  notificationKind = options.kind ?? null

  const handlePrimaryAction = (): void => {
    try {
      options.onPrimaryAction()
    } finally {
      animateOut()
    }
  }
  const handleDismiss = (): void => {
    try {
      suppressAppActivationUntil = Date.now() + 1_000
      options.onDismiss()
    } finally {
      animateOut()
    }
  }

  ipcMain.once('notification:primary-action', handlePrimaryAction)
  ipcMain.once('notification:dismiss', handleDismiss)

  const cleanup = (): void => {
    ipcMain.removeListener('notification:primary-action', handlePrimaryAction)
    ipcMain.removeListener('notification:dismiss', handleDismiss)
  }
  cleanupListeners = cleanup

  win.on('closed', () => {
    cleanup()
    if (cleanupListeners === cleanup) {
      cleanupListeners = null
    }
    if (notificationWindow === win) {
      clearAutoDismissTimer()
      notificationWindow = null
      notificationKind = null
    }
  })

  const title = escapeHtml(options.title)
  const body = escapeHtml(options.body)
  const subtitle =
    options.bodyTitle && options.bodySuffix
      ? `<div class="subtitle has-note-title">${escapeHtml(`${options.bodyTitle} ${options.bodySuffix}`)}</div>`
      : `<div class="subtitle">${body}</div>`
  const primaryActionLabel = escapeHtml(options.primaryActionLabel)

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: transparent;
    overflow: hidden;
    -webkit-user-select: none;
    cursor: default;
  }
  body { padding: 6px 12px 20px; }

  .toast {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 14px 14px 16px;
    background: rgba(255, 255, 255, 0.98);
    backdrop-filter: blur(24px) saturate(1.4);
    -webkit-backdrop-filter: blur(24px) saturate(1.4);
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 16px;
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.10),
      0 4px 12px rgba(0, 0, 0, 0.04),
      0 0 0 0.5px rgba(0, 0, 0, 0.03);
    animation: slideDown 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    font-family: 'DM Sans', system-ui, sans-serif;
  }

  @keyframes slideDown {
    from { transform: translateY(-100%) scale(0.96); opacity: 0; }
    to { transform: translateY(0) scale(1); opacity: 1; }
  }

  @keyframes slideUp {
    from { transform: translateY(0) scale(1); opacity: 1; }
    to { transform: translateY(-100%) scale(0.96); opacity: 0; }
  }

  .toast.dismissing {
    animation: slideUp 0.25s cubic-bezier(0.4, 0, 1, 1) forwards;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #7A9E7E;
    flex-shrink: 0;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.85); }
  }

  .text { flex: 1; min-width: 0; }

  .title {
    font-size: 13px;
    font-weight: 600;
    color: #1A1A17;
    letter-spacing: -0.02em;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .subtitle {
    font-size: 11.5px;
    color: #86837e;
    line-height: 1.25;
    margin-top: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .subtitle.has-note-title {
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    white-space: normal;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .btn-record {
    padding: 7px 16px;
    border-radius: 10px;
    border: none;
    background: #1A1A17;
    color: white;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }
  .btn-record:hover { background: #3d3b37; }
  .btn-record:active { transform: scale(0.97); }

  .btn-x {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: #c4c1bc;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
    font-family: inherit;
  }
  .btn-x:hover { background: rgba(0,0,0,0.05); color: #86837e; }
  .btn-x svg { width: 12px; height: 12px; }
</style>
</head>
<body>
  <div class="toast">
    <div class="dot"></div>
    <div class="text">
      <div class="title">${title}</div>
      ${subtitle}
    </div>
    <div class="actions">
      <button class="btn-record" id="primary-action">${primaryActionLabel}</button>
      <button class="btn-x" id="dismiss">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
        </svg>
      </button>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    function dismiss(channel) {
      const toast = document.querySelector('.toast');
      if (channel === 'notification:dismiss') {
        ipcRenderer.send(channel);
        return;
      }
      toast.classList.add('dismissing');
      toast.addEventListener('animationend', () => ipcRenderer.send(channel), { once: true });
    }
    document.getElementById('primary-action').onclick = () => dismiss('notification:primary-action');
    document.getElementById('dismiss').onclick = () => dismiss('notification:dismiss');
  </script>
</body>
</html>`

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  win.once('ready-to-show', () => {
    if (notificationWindow === win) {
      win.showInactive()
    }
  })

  const autoDismissMs = options.autoDismissMs ?? 30_000
  autoDismissTimer = setTimeout(() => {
    if (notificationWindow === win) {
      handleDismiss()
    }
  }, autoDismissMs)
}

function animateOut(): void {
  if (!notificationWindow) return
  const win = notificationWindow
  win.webContents
    .executeJavaScript(
      `
    new Promise(resolve => {
      const toast = document.querySelector('.toast');
      if (!toast || toast.classList.contains('dismissing')) { resolve(); return; }
      toast.classList.add('dismissing');
      toast.addEventListener('animationend', resolve, { once: true });
    })
  `
    )
    .then(() => {
      if (!win.isDestroyed()) win.close()
    })
    .catch(() => {
      if (!win.isDestroyed()) win.close()
    })
}

export function hideNotificationWindow(kind?: NotificationKind): void {
  if (kind && notificationKind !== kind) {
    return
  }

  if (notificationWindow) {
    animateOut()
  }
}
