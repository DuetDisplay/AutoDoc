export interface IpcSendEvents {
  'window:minimize': []
  'window:maximize': []
  'window:close': []
}

export interface IpcInvokeEvents {
  'app:get-version': []
}

export interface IpcInvokeReturns {
  'app:get-version': string
}

export interface IpcOnEvents {
  'recording:status-changed': [status: string]
}
