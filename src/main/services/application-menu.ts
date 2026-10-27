import { app, Menu, type MenuItem, type MenuItemConstructorOptions } from 'electron'
import { tMain } from './ui-locale'
import type { MessageKey } from '../../shared/i18n'

const roleLabels: Record<string, MessageKey> = {
  filemenu: 'menu.file',
  editmenu: 'menu.edit',
  viewmenu: 'menu.view',
  windowmenu: 'menu.window',
  about: 'settings.about',
  services: 'menu.services',
  hide: 'menu.hide',
  hideothers: 'menu.hideOthers',
  unhide: 'menu.showAll',
  quit: 'ui.quit',
  close: 'common.close',
  undo: 'menu.undo',
  redo: 'menu.redo',
  cut: 'menu.cut',
  copy: 'menu.copy',
  paste: 'menu.paste',
  pasteandmatchstyle: 'menu.pasteMatchStyle',
  delete: 'common.delete',
  selectall: 'menu.selectAll',
  reload: 'menu.reload',
  forcereload: 'menu.forceReload',
  toggledevtools: 'menu.devTools',
  resetzoom: 'menu.actualSize',
  zoomin: 'menu.zoomIn',
  zoomout: 'menu.zoomOut',
  togglefullscreen: 'menu.fullscreen',
  minimize: 'menu.minimize',
  zoom: 'menu.zoom',
  front: 'menu.front',
  showsubstitutions: 'menu.showSubstitutions',
  togglesmartquotes: 'menu.smartQuotes',
  togglesmartdashes: 'menu.smartDashes',
  toggletextreplacement: 'menu.textReplacement',
  startspeaking: 'menu.startSpeaking',
  stopspeaking: 'menu.stopSpeaking'
}

/** Preserve Electron's native roles, platform actions and shortcuts, replacing only app copy. */
export function refreshApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  const menu = Menu.buildFromTemplate(template)
  const localize = (items: MenuItem[]) => {
    for (const item of items) {
      const key =
        roleLabels[item.role?.toLowerCase() ?? ''] ??
        (item.label === 'Substitutions'
          ? 'menu.substitutions'
          : item.label === 'Speech'
            ? 'menu.speech'
            : undefined)
      if (key) item.label = tMain(key, { app: app.getName() })
      if (item.submenu) localize(item.submenu.items)
    }
  }
  localize(menu.items)
  Menu.setApplicationMenu(menu)
}
