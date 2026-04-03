import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron'

let pickerWindow: BrowserWindow | null = null
let cleanupListeners: (() => void) | null = null

interface PickerSource {
  id: string
  name: string
  thumbnailDataUrl: string
}

interface PickerOptions {
  suggestedId: string | null
  onSelect: (sourceId: string, sourceName: string) => void
  onDismiss: () => void
}

export async function showPickerWindow(options: PickerOptions): Promise<void> {
  if (pickerWindow) {
    pickerWindow.close()
  }

  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
  })

  const pickerSources: PickerSource[] = sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnailDataUrl: s.thumbnail.toDataURL(),
  }))

  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workArea
  const winWidth = Math.min(720, workArea.width - 80)
  const winHeight = Math.min(520, workArea.height - 80)
  const x = Math.round(workArea.x + (workArea.width - winWidth) / 2)
  const y = Math.round(workArea.y + (workArea.height - winHeight) / 2)

  pickerWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  const handleSelect = (_event: Electron.IpcMainEvent, sourceId: string, sourceName: string) => {
    options.onSelect(sourceId, sourceName)
    closePickerWindow()
  }
  const handleDismiss = () => {
    options.onDismiss()
    closePickerWindow()
  }

  ipcMain.on('picker:select', handleSelect)
  ipcMain.once('picker:dismiss', handleDismiss)

  cleanupListeners = () => {
    ipcMain.removeListener('picker:select', handleSelect)
    ipcMain.removeListener('picker:dismiss', handleDismiss)
  }

  pickerWindow.on('closed', () => {
    cleanupListeners?.()
    cleanupListeners = null
    pickerWindow = null
  })

  const sourcesJson = JSON.stringify(pickerSources).replace(/</g, '\\u003c')
  const suggestedId = options.suggestedId
    ? JSON.stringify(options.suggestedId).replace(/</g, '\\u003c')
    : 'null'

  const html = buildPickerHtml(sourcesJson, suggestedId)

  pickerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  pickerWindow.once('ready-to-show', () => {
    pickerWindow?.show()
    pickerWindow?.focus()
  })
}

export function hidePickerWindow(): void {
  closePickerWindow()
}

function closePickerWindow(): void {
  if (!pickerWindow) return
  const win = pickerWindow
  win.webContents.executeJavaScript(`
    new Promise(resolve => {
      const panel = document.querySelector('.panel');
      if (!panel) { resolve(); return; }
      panel.style.animation = 'fadeOut 0.15s ease forwards';
      panel.addEventListener('animationend', resolve, { once: true });
    })
  `).then(() => {
    if (!win.isDestroyed()) win.close()
  }).catch(() => {
    if (!win.isDestroyed()) win.close()
  })
}

function buildPickerHtml(sourcesJson: string, suggestedId: string): string {
  return `<!DOCTYPE html>
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
    font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
  }
  body { padding: 12px; height: 100vh; }

  @keyframes fadeIn {
    from { opacity: 0; transform: scale(0.96); }
    to { opacity: 1; transform: scale(1); }
  }
  @keyframes fadeOut {
    from { opacity: 1; transform: scale(1); }
    to { opacity: 0; transform: scale(0.96); }
  }

  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: rgba(255, 255, 255, 0.98);
    backdrop-filter: blur(24px) saturate(1.4);
    -webkit-backdrop-filter: blur(24px) saturate(1.4);
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 16px;
    box-shadow:
      0 28px 80px rgba(0, 0, 0, 0.18),
      0 8px 24px rgba(0, 0, 0, 0.06),
      0 0 0 0.5px rgba(0, 0, 0, 0.04);
    animation: fadeIn 0.2s ease;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px 14px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
    flex-shrink: 0;
  }

  .header-text h2 {
    font-size: 13px;
    font-weight: 600;
    color: #1A1A17;
    letter-spacing: -0.02em;
  }

  .header-text p {
    font-size: 11px;
    color: #86837e;
    margin-top: 2px;
    line-height: 1.4;
  }

  .btn-close {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: #c4c1bc;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
    font-size: 18px;
    line-height: 1;
    flex-shrink: 0;
  }
  .btn-close:hover { background: rgba(0,0,0,0.05); color: #86837e; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    padding: 16px 18px;
    overflow-y: auto;
    flex: 1;
  }

  .source {
    border: 1.5px solid rgba(0, 0, 0, 0.06);
    border-radius: 12px;
    overflow: hidden;
    cursor: pointer;
    transition: all 0.15s ease;
    background: white;
  }
  .source:hover {
    border-color: rgba(0, 0, 0, 0.12);
    background: #FAFAF8;
  }
  .source:active { transform: scale(0.98); }
  .source.suggested {
    border-color: #1A1A17;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.04);
  }
  .source.starting {
    opacity: 0.6;
    pointer-events: none;
  }

  .source img {
    width: 100%;
    height: 120px;
    object-fit: cover;
    border-bottom: 1px solid rgba(0, 0, 0, 0.04);
    display: block;
  }

  .source-info {
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .source-name {
    font-size: 12px;
    font-weight: 500;
    color: #1A1A17;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  .badge {
    flex-shrink: 0;
    padding: 2px 7px;
    border-radius: 99px;
    background: rgba(122, 158, 126, 0.12);
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #5B8C6A;
  }

  .starting-text {
    font-size: 10.5px;
    color: #86837e;
    padding: 0 12px 8px;
  }
</style>
</head>
<body>
  <div class="panel">
    <div class="header">
      <div class="header-text">
        <h2>Select the meeting window</h2>
        <p>Choose which window to record for AI notes</p>
      </div>
      <button class="btn-close" id="dismiss">&times;</button>
    </div>
    <div class="grid" id="grid"></div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const sources = ${sourcesJson};
    const suggestedId = ${suggestedId};
    let starting = false;

    const grid = document.getElementById('grid');
    sources.forEach(s => {
      const card = document.createElement('div');
      card.className = 'source' + (s.id === suggestedId ? ' suggested' : '');
      card.innerHTML =
        '<img src="' + s.thumbnailDataUrl + '" alt="" />' +
        '<div class="source-info">' +
          '<span class="source-name">' + escapeHtml(s.name) + '</span>' +
          (s.id === suggestedId ? '<span class="badge">Suggested</span>' : '') +
        '</div>';
      card.addEventListener('click', () => {
        if (starting) return;
        starting = true;
        card.classList.add('starting');
        card.insertAdjacentHTML('beforeend', '<div class="starting-text">Starting\\u2026</div>');
        ipcRenderer.send('picker:select', s.id, s.name);
      });
      grid.appendChild(card);
    });

    document.getElementById('dismiss').onclick = () => ipcRenderer.send('picker:dismiss');

    function escapeHtml(text) {
      const el = document.createElement('span');
      el.textContent = text;
      return el.innerHTML;
    }
  </script>
</body>
</html>`
}
