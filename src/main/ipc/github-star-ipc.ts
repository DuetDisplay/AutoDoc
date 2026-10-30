import { ipcMain, shell, type WebContents } from 'electron'
import { AUTODOC_GITHUB_URL, type GithubStarPromptService } from '../services/github-star-prompt'

export function registerGithubStarIpc(
  service: GithubStarPromptService,
  isTrustedSender: (sender: WebContents) => boolean
): void {
  const validId = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= 128
  ipcMain.handle('github-star:reserve', async (event) =>
    isTrustedSender(event.sender) ? await service.reserve() : null
  )
  ipcMain.handle('github-star:confirm', async (event, id: unknown) =>
    isTrustedSender(event.sender) && validId(id) ? await service.confirm(id) : false
  )
  ipcMain.handle('github-star:cancel', (event, id: unknown) => {
    if (isTrustedSender(event.sender) && validId(id)) service.cancel(id)
  })
  ipcMain.handle('github-star:open', async (event): Promise<boolean> => {
    if (!isTrustedSender(event.sender)) return false
    try {
      await shell.openExternal(AUTODOC_GITHUB_URL)
      return true
    } catch {
      return false
    }
  })
}
