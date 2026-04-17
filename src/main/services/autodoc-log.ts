import { app } from 'electron'
import { appendFile, mkdir, rename, rm, stat } from 'fs/promises'
import { join } from 'path'
import { captureError } from './sentry-reporter'

const LOG_DIR_NAME = 'logs'
const LOG_BASENAME = 'autodocLog'
const LOG_EXTENSION = '.log'
const MAX_LOG_BYTES = 1_000_000
const MAX_ROTATED_FILES = 3

type LogArea =
  | 'app'
  | 'calendar'
  | 'recording'
  | 'transcription'
  | 'segmentation'
  | 'ollama'
  | 'whisper'
  | 'diarization'
  | 'detection'

interface LogEntryInput {
  area: LogArea
  message: string
  error?: unknown
  meetingId?: string
  context?: Record<string, unknown>
}

interface SerializedError {
  name?: string
  message: string
  stack?: string
}

let writeQueue = Promise.resolve()

export function getAutodocLogPath(): string {
  return join(getLogsDir(), `${LOG_BASENAME}${LOG_EXTENSION}`)
}

export function logAutodocFailure(entry: LogEntryInput): void {
  const serializedError = serializeError(entry.error)
  const line = buildLogLine({
    level: 'error',
    area: entry.area,
    message: entry.message,
    meetingId: entry.meetingId,
    error: serializedError,
    context: entry.context,
  })

  captureError(entry.error ?? entry.message, {
    area: entry.area,
    meetingId: entry.meetingId,
    extra: {
      message: entry.message,
      error: serializedError,
      context: entry.context ?? null,
    },
  })

  writeQueue = writeQueue
    .then(() => appendLogLine(line))
    .catch(() => {})
}

export function logAutodocEvent(entry: Omit<LogEntryInput, 'error'> & { level?: 'info' | 'warn' }): void {
  const line = buildLogLine({
    level: entry.level ?? 'info',
    area: entry.area,
    message: entry.message,
    meetingId: entry.meetingId,
    error: null,
    context: entry.context,
  })

  writeQueue = writeQueue
    .then(() => appendLogLine(line))
    .catch(() => {})
}

async function appendLogLine(line: string): Promise<void> {
  const logDir = getLogsDir()
  const logPath = getAutodocLogPath()

  await mkdir(logDir, { recursive: true })

  const size = await stat(logPath).then((result) => result.size).catch(() => 0)
  if (size + Buffer.byteLength(line, 'utf-8') > MAX_LOG_BYTES) {
    await rotateLogs(logPath)
  }

  await appendFile(logPath, line, 'utf-8')
}

function buildLogLine(entry: {
  level: 'info' | 'warn' | 'error'
  area: LogArea
  message: string
  meetingId?: string
  error: SerializedError | null
  context?: Record<string, unknown>
}): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: entry.level,
    area: entry.area,
    message: entry.message,
    meetingId: entry.meetingId ?? null,
    error: entry.error,
    context: entry.context ?? null,
  })}\n`
}

async function rotateLogs(logPath: string): Promise<void> {
  await rm(rotatedLogPath(MAX_ROTATED_FILES), { force: true })

  for (let index = MAX_ROTATED_FILES - 1; index >= 1; index -= 1) {
    const source = rotatedLogPath(index)
    const destination = rotatedLogPath(index + 1)
    const exists = await stat(source).then(() => true).catch(() => false)
    if (exists) {
      await rename(source, destination)
    }
  }

  const currentExists = await stat(logPath).then(() => true).catch(() => false)
  if (currentExists) {
    await rename(logPath, rotatedLogPath(1))
  }
}

function rotatedLogPath(index: number): string {
  return join(getLogsDir(), `${LOG_BASENAME}.${index}${LOG_EXTENSION}`)
}

function getLogsDir(): string {
  if (app.isReady()) {
    return join(app.getPath('userData'), LOG_DIR_NAME)
  }

  const roamingAppData = process.env.APPDATA
  if (roamingAppData) {
    return join(roamingAppData, 'AutoDoc', LOG_DIR_NAME)
  }

  return join(process.cwd(), LOG_DIR_NAME)
}

function serializeError(error: unknown): SerializedError | null {
  if (error == null) return null

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.slice(0, 4000),
    }
  }

  return {
    message: String(error),
  }
}
