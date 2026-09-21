import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  state: vi.fn(),
  submit: vi.fn(),
  storeOptions: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.1.1' },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('electron-store', () => ({
  default: class {
    constructor(options: unknown) {
      mocks.storeOptions(options)
    }
    get() {
      return undefined
    }
    set() {
      return undefined
    }
  }
}))
vi.mock('../../services/crypto', () => ({
  getKey: () => Buffer.alloc(32, 1),
  initializeEncryption: vi.fn(async () => {})
}))
vi.mock('../../services/notes-repository', () => ({
  NotesRepository: class {
    readV2() {
      return null
    }
  }
}))
vi.mock('../../services/notes-feedback', () => ({
  NotesFeedbackService: class {
    state = mocks.state
    submit = mocks.submit
  }
}))
import { registerNotesFeedbackIpc } from '../notes-feedback-ipc'

const sender = { mainFrame: {} }
beforeEach(() => {
  vi.clearAllMocks()
  registerNotesFeedbackIpc({
    recordingsBaseDir: '/unused',
    isTrustedSender: (value) => value === sender,
    analyticsEnabled: () => false
  })
})

it('blocks other windows and subframes without reading notes or sending', async () => {
  for (const event of [
    { sender: { mainFrame: {} }, senderFrame: {} },
    { sender, senderFrame: {} }
  ]) {
    expect(await mocks.handlers.get('notes-feedback:send')!(event, {})).toMatchObject({
      status: 'failed'
    })
    expect(await mocks.handlers.get('notes-feedback:state')!(event, 'm', 'g')).toMatchObject({
      available: false
    })
  }
  expect(mocks.submit).not.toHaveBeenCalled()
  expect(mocks.state).not.toHaveBeenCalled()
})

it('accepts only the trusted main frame and encrypts local pending feedback', async () => {
  const event = { sender, senderFrame: sender.mainFrame }
  await mocks.handlers.get('notes-feedback:send')!(event, { rating: 'useful' })
  expect(mocks.submit).toHaveBeenCalledWith({ rating: 'useful' })
  expect(mocks.storeOptions).toHaveBeenCalledWith(
    expect.objectContaining({
      encryptionKey: Buffer.alloc(32, 1),
      accessPropertiesByDotNotation: false
    })
  )
})
