import { contextBridge, ipcRenderer } from 'electron'
import type { IpcSendEvents, IpcInvokeEvents, IpcInvokeReturns, IpcOnEvents } from './ipc'

const api = {
  send<K extends keyof IpcSendEvents>(
    channel: K,
    ...args: IpcSendEvents[K]
  ): void {
    ipcRenderer.send(channel, ...args)
  },

  invoke<K extends keyof IpcInvokeEvents>(
    channel: K,
    ...args: IpcInvokeEvents[K]
  ): Promise<IpcInvokeReturns[K]> {
    return ipcRenderer.invoke(channel, ...args)
  },

  on<K extends keyof IpcOnEvents>(
    channel: K,
    listener: (...args: IpcOnEvents[K]) => void
  ): () => void {
    const wrapped = (_e: Electron.IpcRendererEvent, ...args: IpcOnEvents[K]): void =>
      listener(...args)
    ipcRenderer.on(channel, wrapped as never)
    return () => ipcRenderer.removeListener(channel, wrapped as never)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
