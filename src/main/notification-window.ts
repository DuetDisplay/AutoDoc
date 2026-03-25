import { BrowserWindow, screen, ipcMain } from 'electron'

let notificationWindow: BrowserWindow | null = null
let cleanupListeners: (() => void) | null = null

interface NotificationOptions {
  title: string
  body: string
  onRecord: () => void
  onDismiss: () => void
}

export function showNotificationWindow(options: NotificationOptions): void {
  if (notificationWindow) {
    notificationWindow.close()
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth } = primaryDisplay.workAreaSize
  const winWidth = 400
  const winHeight = 100 // Extra space for transparent padding + shadow
  const x = Math.round((screenWidth - winWidth) / 2)
  const y = 0

  notificationWindow = new BrowserWindow({
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
      contextIsolation: false,
    },
  })

  const handleRecord = () => {
    options.onRecord()
    hideNotificationWindow()
  }
  const handleDismiss = () => {
    options.onDismiss()
    hideNotificationWindow()
  }

  ipcMain.once('notification:record', handleRecord)
  ipcMain.once('notification:dismiss', handleDismiss)

  cleanupListeners = () => {
    ipcMain.removeListener('notification:record', handleRecord)
    ipcMain.removeListener('notification:dismiss', handleDismiss)
  }

  notificationWindow.on('closed', () => {
    cleanupListeners?.()
    cleanupListeners = null
    notificationWindow = null
  })

  const title = options.title.replace(/'/g, '&#39;').replace(/"/g, '&quot;')
  const body = options.body.replace(/'/g, '&#39;').replace(/"/g, '&quot;')

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
    animation: slideDown 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif;
  }

  @keyframes slideDown {
    from { transform: translateY(-16px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #ef4444;
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
    color: #1a1a1a;
    letter-spacing: -0.02em;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .subtitle {
    font-size: 11.5px;
    color: #86837e;
    line-height: 1.3;
    margin-top: 1px;
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
    background: #1a1a1a;
    color: white;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }
  .btn-record:hover { background: #333; }
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
      <div class="subtitle">${body}</div>
    </div>
    <div class="actions">
      <button class="btn-record" id="record">Start AI Notes</button>
      <button class="btn-x" id="dismiss">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
        </svg>
      </button>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    document.getElementById('record').onclick = () => ipcRenderer.send('notification:record');
    document.getElementById('dismiss').onclick = () => ipcRenderer.send('notification:dismiss');
  </script>
</body>
</html>`

  notificationWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  notificationWindow.once('ready-to-show', () => {
    notificationWindow?.showInactive()
  })

  // Auto-dismiss after 30 seconds
  setTimeout(() => {
    if (notificationWindow) {
      options.onDismiss()
      hideNotificationWindow()
    }
  }, 30_000)
}

export function hideNotificationWindow(): void {
  if (notificationWindow) {
    notificationWindow.close()
    notificationWindow = null
  }
}
