import { app, ipcMain } from 'electron'
import { join } from 'path'
import type { OllamaProvider } from '../services/llm'
import type { CalendarEvent } from '../../shared/types'
import type { CalendarManager } from '../services/calendar-manager'
import { logAutodocEvent, logAutodocFailure } from '../services/autodoc-log'
import {
  ChatRecordingIndex,
  type ChatClarificationOption,
  type ChatRetrievalResult,
  detectChatIntent,
  extractQuestionTerms,
  scoreMeetingRelevance,
  scoreTextRelevance,
  sortMeetingsByQuestion
} from '../services/chat-retrieval'
import { normalizeRecordingSearchText } from '../services/recording-title'
import { OllamaEmbeddingProvider } from '../services/ollama-embedding'
import { classifyChatTurn, type ChatTurnSession } from '../services/chat-turn-classifier'

const CHAT_SYSTEM_PROMPT = `You are AutoDoc's AI assistant. You help users understand their meetings by answering questions based on meeting transcripts, notes, and their calendar.

Rules:
- Answer concisely and directly based on the meeting data provided
- If the answer isn't in the provided context, say so honestly and do not infer it from unrelated meetings
- Reference specific meetings when relevant
- When the user asks what meetings they had or have in a time window, use calendar events as the source of truth when available; local recordings are only the recorded subset
- When the user asks for content from meetings in a time window, use the calendar list to decide which meetings are in scope, then answer only from matched local notes/transcripts for those meetings
- For calendar inventory or schedule questions, list the calendar events directly and do not mention missing transcripts or notes unless the user asks for meeting content
- Do not end with generic follow-up offers like "would you like to know more"
- Treat each "## Meeting" block as a separate meeting record
- For questions about what was discussed or what happened in a matched meeting, summarize the available structured notes across decisions, action items, information, discussion, and status updates
- For multi-meeting synthesis, group claims by meeting or theme, cite the meeting titles, and only merge themes that appear in the provided notes/transcripts
- Use structured notes as the primary source for matched meetings; use transcript excerpts as backup when notes are missing or do not answer the question
- Preserve useful evidence type when it matters: decisions are decisions, action items are tasks, and transcript excerpts are lower-confidence backup
- Do not combine notes from one meeting with a different calendar event unless the title and date clearly match
- If a matching meeting says no transcript or notes are available, say that plainly instead of inferring details from another meeting
- Do not label meetings as duplicates unless the context explicitly says they are duplicate records
- Use plain language, not jargon`

const RECENT_CALENDAR_DAYS = 7
const CALENDAR_TITLE_LOOKBACK_DAYS = 30
const CALENDAR_FETCH_TIMEOUT_MS = 1_500
const CALENDAR_FAILURE_BACKOFF_MS = 2 * 60_000
const USE_MODEL_CHAT_PLANNER = process.env.AUTODOC_ASK_AI_PLANNER !== '0'
const CHAT_CONTEXT_CHAR_LIMIT = Number(process.env.AUTODOC_ASK_AI_CONTEXT_CHARS ?? 14_000)
const CHAT_OLLAMA_NUM_CTX = Number(process.env.AUTODOC_ASK_AI_NUM_CTX ?? 4096)
const CHAT_OLLAMA_NUM_PREDICT = Number(process.env.AUTODOC_ASK_AI_NUM_PREDICT ?? 512)
const CHAT_OLLAMA_TEMPERATURE = Number(process.env.AUTODOC_ASK_AI_TEMPERATURE ?? 0)
const CHAT_OLLAMA_KEEP_ALIVE = process.env.AUTODOC_ASK_AI_KEEP_ALIVE ?? '10m'

type ChatPlanTimeRange =
  | 'none'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'upcoming'
  | 'recent'
type CalendarTimeDirection = 'past' | 'future' | 'full'

interface ChatRetrievalPlan {
  needsCalendar: boolean
  needsRecordings: boolean
  timeRange: ChatPlanTimeRange
  recordingSearchQuery: string
  evidenceMode: 'inventory' | 'notes' | 'transcript' | 'mixed'
  reason: string
}

interface ChatHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ChatConversationState {
  lastCalendarEvents: CalendarEvent[]
  lastRecordingIds: string[]
  lastRecordingTitles: string[]
  focusedRecordingIds: string[]
  lastClarificationOptions: ChatClarificationOption[]
}

interface FastPlanDecision {
  plan: ChatRetrievalPlan
  confidence: 'high' | 'low'
}

interface OllamaRuntime {
  waitUntilReady(): Promise<void>
  isServerRunning(): Promise<boolean>
  getBaseUrl(): string
}

interface ChatStreamPayload {
  requestId: string
  content: string
}

interface ChatDonePayload {
  requestId: string
  content: string
  clarificationOptions?: ChatClarificationOption[]
}

interface ChatErrorPayload {
  requestId: string
  error: string
}

interface ChatCanceledPayload {
  requestId: string
}

interface PreparedChatContext {
  directAnswer: string | null
  context: string
  clarificationOptions?: ChatClarificationOption[]
}

export { extractQuestionTerms, scoreMeetingRelevance, sortMeetingsByQuestion }

export function registerChatIpc(
  recordingsBaseDir: string,
  ollamaManager: OllamaRuntime,
  ollamaProvider: OllamaProvider,
  calendarManager: CalendarManager
): void {
  const recordingIndex = new ChatRecordingIndex(recordingsBaseDir, {
    watch: true,
    embeddingProvider: new OllamaEmbeddingProvider(ollamaManager.getBaseUrl()),
    embeddingCachePath: join(app.getPath('userData'), 'cache', 'ask-ai-embeddings.json')
  })
  const chatSessions = new Map<number, ChatConversationState>()
  const activeChatRequests = new Map<string, AbortController>()
  let calendarFailureUntil = 0

  const loadCalendarContextDataWithBackoff = async (): Promise<{
    recentEvents: CalendarEvent[]
    upcomingEvents: CalendarEvent[]
    skippedByBackoff: boolean
    elapsedMs: number
  }> => {
    const startedAt = Date.now()
    if (Date.now() < calendarFailureUntil) {
      return { recentEvents: [], upcomingEvents: [], skippedByBackoff: true, elapsedMs: 0 }
    }

    try {
      const [recentEvents, upcomingEvents] = await Promise.all([
        withTimeout(calendarManager.fetchAllRecentEvents(CALENDAR_TITLE_LOOKBACK_DAYS)),
        withTimeout(calendarManager.fetchAllUpcomingEvents())
      ])
      return {
        recentEvents,
        upcomingEvents,
        skippedByBackoff: false,
        elapsedMs: Date.now() - startedAt
      }
    } catch {
      calendarFailureUntil = Date.now() + CALENDAR_FAILURE_BACKOFF_MS
      return {
        recentEvents: [],
        upcomingEvents: [],
        skippedByBackoff: false,
        elapsedMs: Date.now() - startedAt
      }
    }
  }

  const prepareChatContext = async (
    question: string,
    history: ChatHistoryMessage[],
    session: ChatConversationState,
    signal?: AbortSignal
  ): Promise<{
    directAnswer: string | null
    context: string
    clarificationOptions?: ChatClarificationOption[]
  }> => {
    const turn = classifyChatTurn(question, history, toClassifierSession(session))

    if (turn.kind === 'acknowledgement') {
      logAutodocEvent({
        area: 'chat',
        message: 'chat routed without retrieval',
        context: {
          route: 'conversational-acknowledgement',
          questionLength: question.length
        }
      })
      return { directAnswer: "You're welcome.", context: '' }
    }

    if (turn.kind === 'smalltalk') {
      logAutodocEvent({
        area: 'chat',
        message: 'chat routed without retrieval',
        context: { route: 'smalltalk', topic: turn.topic, questionLength: question.length }
      })
      return { directAnswer: buildSmalltalkAnswer(turn.topic), context: '' }
    }

    if (turn.kind === 'count_confirmation') {
      const directAnswer = formatCountConfirmationAnswer({
        label: turn.scope === 'calendar' ? 'calendar meeting' : 'local recording',
        actualCount:
          turn.scope === 'calendar'
            ? session.lastCalendarEvents.length
            : session.lastRecordingIds.length,
        referencedCount: turn.referencedCount
      })
      logAutodocEvent({
        area: 'chat',
        message: 'chat routed without retrieval',
        context: {
          route: 'count-confirmation',
          scope: turn.scope,
          questionLength: question.length,
          previousCalendarCount: session.lastCalendarEvents.length,
          previousRecordingCount: session.lastRecordingIds.length
        }
      })
      return { directAnswer, context: '' }
    }

    if (turn.kind === 'reference') {
      return prepareMeetingScopedContext(question, turn.meetingIds, session, turn.followUp)
    }

    if (turn.kind === 'scoped_followup') {
      return prepareMeetingScopedContext(question, turn.meetingIds, session, true)
    }

    const intent = detectChatIntent(question)
    if (intent === 'count' || intent === 'list') {
      clearConversationScope(session)
      const meetingContext = await recordingIndex.buildContext(question, [])
      rememberRecordingList(
        session,
        meetingContext.diagnostics.matchedMeetingIds,
        meetingContext.diagnostics.matchedTitles
      )
      session.focusedRecordingIds = []
      updateClarificationState(session, meetingContext)
      logAutodocEvent({
        area: 'chat',
        message: 'chat retrieval completed',
        context: {
          ...meetingContext.diagnostics,
          calendarElapsedMs: 0,
          calendarSkippedByDirectIntent: true,
          calendarSkippedByBackoff: false,
          calendarRecentCount: 0,
          calendarUpcomingCount: 0
        }
      })

      return {
        directAnswer: meetingContext.directAnswer,
        context: meetingContext.context,
        clarificationOptions: meetingContext.clarificationOptions
      }
    }

    const localExactContext = await recordingIndex.buildExactTitleContext(question, [])
    if (localExactContext) {
      session.lastCalendarEvents = []
      rememberRecordingList(
        session,
        localExactContext.diagnostics.selectedMeetingIds,
        localExactContext.diagnostics.selectedTitles
      )
      session.focusedRecordingIds = localExactContext.diagnostics.selectedMeetingIds
      updateClarificationState(session, localExactContext)
      logAutodocEvent({
        area: 'chat',
        message: 'chat retrieval completed',
        context: {
          ...localExactContext.diagnostics,
          calendarElapsedMs: 0,
          calendarSkippedByLocalExactMatch: true,
          calendarSkippedByBackoff: false,
          calendarRecentCount: 0,
          calendarUpcomingCount: 0
        }
      })

      return {
        directAnswer: localExactContext.directAnswer,
        context: localExactContext.context,
        clarificationOptions: localExactContext.clarificationOptions
      }
    }

    const scopedContext = await prepareConversationScopedContext(question, session)
    if (scopedContext) return scopedContext

    const fastPlan = buildFastRetrievalPlan(question)
    if (fastPlan.confidence === 'high') {
      const plannedContext = await preparePlannedChatContext(
        question,
        fastPlan.plan,
        'fast',
        session
      )
      if (plannedContext.directAnswer || plannedContext.context.trim().length > 0) {
        return plannedContext
      }
    }

    if (USE_MODEL_CHAT_PLANNER) {
      await waitForOllama(ollamaManager)
      const plan = await buildChatRetrievalPlan({
        baseUrl: ollamaManager.getBaseUrl(),
        model: ollamaProvider.getModel(),
        question,
        history,
        signal
      })
      const plannedContext = await preparePlannedChatContext(question, plan, 'model', session)
      if (plannedContext.directAnswer || plannedContext.context.trim().length > 0) {
        return plannedContext
      }
    }

    const localMeetingContext = await recordingIndex.buildContext(question, [])
    if (shouldUseLocalRecordingContext(question, localMeetingContext)) {
      updateClarificationState(session, localMeetingContext)
      logAutodocEvent({
        area: 'chat',
        message: 'chat retrieval completed',
        context: {
          ...localMeetingContext.diagnostics,
          calendarElapsedMs: 0,
          calendarSkippedByLocalRecordingEvidence: true,
          calendarSkippedByBackoff: false,
          calendarRecentCount: 0,
          calendarUpcomingCount: 0
        }
      })

      return {
        directAnswer: localMeetingContext.directAnswer,
        context: localMeetingContext.context,
        clarificationOptions: localMeetingContext.clarificationOptions
      }
    }

    const { recentEvents, upcomingEvents, skippedByBackoff, elapsedMs } =
      await loadCalendarContextDataWithBackoff()
    const meetingContext = await recordingIndex.buildContext(question, recentEvents)
    updateClarificationState(session, meetingContext)
    const calendarContext = formatCalendarContext(recentEvents, upcomingEvents, question)
    const context = [meetingContext.context, calendarContext].filter(Boolean).join('\n\n---\n\n')

    logAutodocEvent({
      area: 'chat',
      message: 'chat retrieval completed',
      context: {
        ...meetingContext.diagnostics,
        calendarElapsedMs: elapsedMs,
        calendarSkippedByBackoff: skippedByBackoff,
        calendarRecentCount: recentEvents.length,
        calendarUpcomingCount: upcomingEvents.length
      }
    })

    return {
      directAnswer: meetingContext.directAnswer,
      context,
      clarificationOptions: meetingContext.clarificationOptions
    }
  }

  // Recording coreference / implicit follow-ups are resolved up front by the
  // turn classifier; this builds the answer for the recordings it selected.
  const prepareMeetingScopedContext = async (
    question: string,
    meetingIds: string[],
    session: ChatConversationState,
    followUp: boolean
  ): Promise<PreparedChatContext> => {
    const meetingContext = await recordingIndex.buildContextForMeetingIds(
      buildScopedQuestion(question, session, followUp),
      meetingIds,
      session.lastCalendarEvents
    )
    mergeScopedRecordingList(
      session,
      meetingContext.diagnostics.selectedMeetingIds,
      meetingContext.diagnostics.selectedTitles
    )
    session.focusedRecordingIds = meetingContext.diagnostics.selectedMeetingIds
    updateClarificationState(session, meetingContext)
    logAutodocEvent({
      area: 'chat',
      message: 'chat retrieval completed',
      context: {
        ...meetingContext.diagnostics,
        conversationScopedFollowUp: true,
        scopedToFocusedRecordings: true,
        calendarElapsedMs: 0,
        calendarSkippedByBackoff: false,
        calendarRecentCount: session.lastCalendarEvents.length,
        calendarUpcomingCount: 0
      }
    })
    return {
      directAnswer: meetingContext.directAnswer,
      context: meetingContext.context,
      clarificationOptions: meetingContext.clarificationOptions
    }
  }

  // Calendar-list follow-ups (e.g. "which of those had notes?") remain here;
  // recording references/follow-ups are handled by the classifier dispatch.
  const prepareConversationScopedContext = async (
    question: string,
    session: ChatConversationState
  ): Promise<PreparedChatContext | null> => {
    if (session.lastCalendarEvents.length === 0) return null
    if (shouldStartNewConversationScope(question)) return null
    if (hasFreshSearchTerms(normalizeRecordingSearchText(question))) return null

    if (asksForNotesInPreviousSet(question) && session.lastCalendarEvents.length > 0) {
      const meetingContext = await recordingIndex.buildNoteAvailabilityForCalendarEvents(
        session.lastCalendarEvents,
        session.lastCalendarEvents
      )
      rememberRecordingList(
        session,
        meetingContext.diagnostics.selectedMeetingIds,
        meetingContext.diagnostics.selectedTitles
      )
      session.focusedRecordingIds = meetingContext.diagnostics.selectedMeetingIds
      updateClarificationState(session, meetingContext)
      logAutodocEvent({
        area: 'chat',
        message: 'chat retrieval completed',
        context: {
          ...meetingContext.diagnostics,
          conversationScopedFollowUp: true,
          calendarElapsedMs: 0,
          calendarSkippedByBackoff: false,
          calendarRecentCount: session.lastCalendarEvents.length,
          calendarUpcomingCount: 0
        }
      })
      return {
        directAnswer: meetingContext.directAnswer,
        context: meetingContext.context,
        clarificationOptions: meetingContext.clarificationOptions
      }
    }

    if (session.lastCalendarEvents.length > 0 && shouldUseConversationScope(question)) {
      const meetingContext = await recordingIndex.buildContextForCalendarEvents(
        question,
        session.lastCalendarEvents,
        session.lastCalendarEvents
      )
      rememberRecordingList(
        session,
        meetingContext.diagnostics.selectedMeetingIds,
        meetingContext.diagnostics.selectedTitles
      )
      session.focusedRecordingIds = meetingContext.diagnostics.selectedMeetingIds
      updateClarificationState(session, meetingContext)
      logAutodocEvent({
        area: 'chat',
        message: 'chat retrieval completed',
        context: {
          ...meetingContext.diagnostics,
          conversationScopedFollowUp: true,
          scopedToPreviousCalendarList: true,
          calendarElapsedMs: 0,
          calendarSkippedByBackoff: false,
          calendarRecentCount: session.lastCalendarEvents.length,
          calendarUpcomingCount: 0
        }
      })
      return {
        directAnswer: null,
        context: meetingContext.context,
        clarificationOptions: meetingContext.clarificationOptions
      }
    }

    return null
  }

  const preparePlannedChatContext = async (
    question: string,
    plan: ChatRetrievalPlan,
    plannerSource: 'fast' | 'model' | 'fallback',
    session: ChatConversationState
  ): Promise<PreparedChatContext> => {
    let calendarElapsedMs = 0
    let calendarSkippedByBackoff = false
    let calendarRecentCount = 0
    let calendarUpcomingCount = 0
    let recentEvents: CalendarEvent[] = []
    let upcomingEvents: CalendarEvent[] = []
    let selectedCalendarEvents: CalendarEvent[] = []
    const contextParts = [
      `Retrieval plan selected by ${plannerSource} planner: ${JSON.stringify(plan)}`
    ]

    if (plan.needsCalendar) {
      const calendarData = await loadCalendarContextDataWithBackoff()
      recentEvents = calendarData.recentEvents
      upcomingEvents = calendarData.upcomingEvents
      calendarElapsedMs = calendarData.elapsedMs
      calendarSkippedByBackoff = calendarData.skippedByBackoff
      calendarRecentCount = recentEvents.length
      calendarUpcomingCount = upcomingEvents.length
      const calendarContext = formatCalendarContext(
        recentEvents,
        upcomingEvents,
        questionForPlanTimeRange(question, plan.timeRange)
      )
      if (calendarContext) contextParts.push(calendarContext)
      selectedCalendarEvents = selectCalendarInventoryEvents({
        recentEvents,
        upcomingEvents,
        question,
        timeRange: plan.timeRange
      })
    }

    if (isDirectCalendarInventoryPlan(plan)) {
      const directAnswer = formatCalendarInventoryAnswer({
        recentEvents,
        upcomingEvents,
        question,
        timeRange: plan.timeRange,
        skippedByBackoff: calendarSkippedByBackoff
      })
      logChatRetrieval({
        meetingContext: null,
        contextLength: contextParts.join('\n\n---\n\n').length,
        plan,
        plannerSource,
        calendarElapsedMs,
        calendarSkippedByBackoff,
        calendarRecentCount,
        calendarUpcomingCount
      })
      session.lastCalendarEvents = selectedCalendarEvents
      rememberRecordingList(session, [], [])
      session.focusedRecordingIds = []
      session.lastClarificationOptions = []
      return { directAnswer, context: '' }
    }

    let meetingContext: ChatRetrievalResult | null = null
    if (plan.needsRecordings) {
      meetingContext =
        plan.needsCalendar &&
        selectedCalendarEvents.length > 0 &&
        shouldScopeRecordingsToCalendarEvents(question, selectedCalendarEvents)
          ? await recordingIndex.buildContextForCalendarEvents(
              question,
              selectedCalendarEvents,
              selectedCalendarEvents
            )
          : await recordingIndex.buildContext(
              buildRecordingRetrievalQuestion(question, plan),
              recentEvents
            )
      if (meetingContext.context) contextParts.push(meetingContext.context)
      if (meetingContext.directAnswer)
        contextParts.push(`Local recording answer: ${meetingContext.directAnswer}`)
      rememberRecordingList(
        session,
        meetingContext.diagnostics.selectedMeetingIds,
        meetingContext.diagnostics.selectedTitles
      )
      session.focusedRecordingIds = meetingContext.diagnostics.selectedMeetingIds
      updateClarificationState(session, meetingContext)
      if (selectedCalendarEvents.length > 0) {
        session.lastCalendarEvents = selectedCalendarEvents
      }
    }

    logChatRetrieval({
      meetingContext,
      contextLength: contextParts.join('\n\n---\n\n').length,
      plan,
      plannerSource,
      calendarElapsedMs,
      calendarSkippedByBackoff,
      calendarRecentCount,
      calendarUpcomingCount
    })

    return {
      directAnswer: meetingContext?.directAnswer ?? null,
      context: contextParts.join('\n\n---\n\n'),
      clarificationOptions: meetingContext?.clarificationOptions
    }
  }

  ipcMain.handle('chat:send', async (_event, question: string): Promise<string> => {
    const session = getChatSession(chatSessions, _event.sender?.id ?? 0)
    const { directAnswer, context } = await prepareChatContext(question, [], session)
    if (directAnswer) return directAnswer

    await waitForOllama(ollamaManager)
    return completeOllamaChat({
      baseUrl: ollamaManager.getBaseUrl(),
      model: ollamaProvider.getModel(),
      question,
      context,
      history: []
    })
  })

  ipcMain.handle('chat:new', (event): void => {
    const session = getChatSession(chatSessions, event.sender.id)
    clearConversationScope(session)
  })

  ipcMain.handle('chat:cancel', (_event, requestId: string): void => {
    const controller = activeChatRequests.get(requestId)
    if (controller) {
      controller.abort()
      activeChatRequests.delete(requestId)
    }
  })

  ipcMain.handle(
    'chat:send-stream',
    async (
      event,
      requestId: string,
      question: string,
      history: ChatHistoryMessage[] = []
    ): Promise<void> => {
      const sender = event.sender
      const session = getChatSession(chatSessions, sender.id)
      const controller = new AbortController()
      activeChatRequests.set(requestId, controller)
      let normalizedHistoryLength = 0

      try {
        const normalizedHistory = normalizeChatHistory(history)
        normalizedHistoryLength = normalizedHistory.length
        const { directAnswer, context, clarificationOptions } = await prepareChatContext(
          question,
          normalizedHistory,
          session,
          controller.signal
        )
        if (directAnswer) {
          sender.send('chat:chunk', {
            requestId,
            content: directAnswer
          } satisfies ChatStreamPayload)
          sender.send('chat:done', {
            requestId,
            content: directAnswer,
            clarificationOptions
          } satisfies ChatDonePayload)
          return
        }

        await waitForOllama(ollamaManager)
        let content = ''
        await streamOllamaChat({
          baseUrl: ollamaManager.getBaseUrl(),
          model: ollamaProvider.getModel(),
          question,
          context,
          history: normalizedHistory,
          signal: controller.signal,
          onChunk: (chunk) => {
            content += chunk
            sender.send('chat:chunk', { requestId, content: chunk } satisfies ChatStreamPayload)
          }
        })
        sender.send('chat:done', { requestId, content } satisfies ChatDonePayload)
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          sender.send('chat:canceled', { requestId } satisfies ChatCanceledPayload)
          return
        }
        logChatFailure(error, {
          requestId,
          route: 'chat:send-stream',
          questionLength: question.length,
          historyCount: normalizedHistoryLength
        })
        sender.send('chat:error', {
          requestId,
          error: error instanceof Error ? error.message : String(error)
        } satisfies ChatErrorPayload)
      } finally {
        activeChatRequests.delete(requestId)
      }
    }
  )

  ipcMain.handle(
    'chat:select-recording-stream',
    async (
      event,
      requestId: string,
      meetingId: string,
      question: string,
      history: ChatHistoryMessage[] = []
    ): Promise<void> => {
      const sender = event.sender
      const session = getChatSession(chatSessions, sender.id)
      const controller = new AbortController()
      activeChatRequests.set(requestId, controller)
      let normalizedHistoryLength = 0

      try {
        const normalizedHistory = normalizeChatHistory(history)
        normalizedHistoryLength = normalizedHistory.length
        const meetingContext = await recordingIndex.buildContextForMeetingIds(
          `Use the selected meeting to answer this question: ${question}`,
          [meetingId],
          session.lastCalendarEvents
        )
        rememberRecordingList(
          session,
          meetingContext.diagnostics.selectedMeetingIds,
          meetingContext.diagnostics.selectedTitles
        )
        session.focusedRecordingIds = meetingContext.diagnostics.selectedMeetingIds
        updateClarificationState(session, meetingContext)
        logAutodocEvent({
          area: 'chat',
          message: 'chat retrieval completed',
          context: {
            ...meetingContext.diagnostics,
            selectedFromClarification: true,
            calendarElapsedMs: 0,
            calendarSkippedByBackoff: false,
            calendarRecentCount: session.lastCalendarEvents.length,
            calendarUpcomingCount: 0
          }
        })

        if (meetingContext.directAnswer) {
          sender.send('chat:chunk', {
            requestId,
            content: meetingContext.directAnswer
          } satisfies ChatStreamPayload)
          sender.send('chat:done', {
            requestId,
            content: meetingContext.directAnswer,
            clarificationOptions: meetingContext.clarificationOptions
          } satisfies ChatDonePayload)
          return
        }

        await waitForOllama(ollamaManager)
        let content = ''
        await streamOllamaChat({
          baseUrl: ollamaManager.getBaseUrl(),
          model: ollamaProvider.getModel(),
          question,
          context: meetingContext.context,
          history: normalizedHistory,
          signal: controller.signal,
          onChunk: (chunk) => {
            content += chunk
            sender.send('chat:chunk', { requestId, content: chunk } satisfies ChatStreamPayload)
          }
        })
        sender.send('chat:done', { requestId, content } satisfies ChatDonePayload)
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          sender.send('chat:canceled', { requestId } satisfies ChatCanceledPayload)
          return
        }
        logChatFailure(error, {
          requestId,
          route: 'chat:select-recording-stream',
          questionLength: question.length,
          historyCount: normalizedHistoryLength,
          selectedMeetingId: meetingId
        })
        sender.send('chat:error', {
          requestId,
          error: error instanceof Error ? error.message : String(error)
        } satisfies ChatErrorPayload)
      } finally {
        activeChatRequests.delete(requestId)
      }
    }
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function logChatFailure(
  error: unknown,
  context: {
    requestId: string
    route: 'chat:send-stream' | 'chat:select-recording-stream'
    questionLength: number
    historyCount: number
    selectedMeetingId?: string
  }
): void {
  logAutodocFailure({
    area: 'chat',
    message: 'Ask AI chat request failed',
    error,
    meetingId: context.selectedMeetingId,
    context
  })
}

function getChatSession(
  sessions: Map<number, ChatConversationState>,
  webContentsId: number
): ChatConversationState {
  let session = sessions.get(webContentsId)
  if (!session) {
    session = {
      lastCalendarEvents: [],
      lastRecordingIds: [],
      lastRecordingTitles: [],
      focusedRecordingIds: [],
      lastClarificationOptions: []
    }
    sessions.set(webContentsId, session)
  }
  return session
}

function clearConversationScope(session: ChatConversationState): void {
  session.lastCalendarEvents = []
  session.lastRecordingIds = []
  session.lastRecordingTitles = []
  session.focusedRecordingIds = []
  session.lastClarificationOptions = []
}

function updateClarificationState(
  session: ChatConversationState,
  result: ChatRetrievalResult
): void {
  session.lastClarificationOptions = result.clarificationOptions ?? []
}

function toClassifierSession(session: ChatConversationState): ChatTurnSession {
  return {
    recordingIds: session.lastRecordingIds,
    recordingTitles: session.lastRecordingTitles,
    calendarEventCount: session.lastCalendarEvents.length,
    focusedRecordingIds: session.focusedRecordingIds,
    lastTurnWasClarification: session.lastClarificationOptions.length > 0
  }
}

function rememberRecordingList(
  session: ChatConversationState,
  ids: string[],
  titles: string[]
): void {
  // Keep the two arrays index-aligned so title coreference resolves the right id.
  session.lastRecordingIds = ids
  session.lastRecordingTitles = ids.map((_, index) => titles[index] ?? '')
}

function buildSmalltalkAnswer(topic: 'greeting' | 'capability'): string {
  if (topic === 'capability') {
    return "I'm AutoDoc's meeting assistant. Ask me what was discussed in a meeting, who owns an action item, decisions and deadlines, or what's on your calendar — I'll answer from your local recordings and notes."
  }
  return 'Hi! Ask me anything about your meetings — what was discussed, your action items and owners, or what you have coming up on your calendar.'
}

function formatCountConfirmationAnswer(params: {
  label: string
  actualCount: number
  referencedCount: number | null
}): string {
  const pluralLabel = `${params.label}${params.actualCount === 1 ? '' : 's'}`
  if (params.referencedCount == null || params.referencedCount === params.actualCount) {
    return `Yes, you have ${params.actualCount} ${pluralLabel} in that list.`
  }
  return `Not quite - you have ${params.actualCount} ${pluralLabel} in that list.`
}

function normalizeChatHistory(history: ChatHistoryMessage[]): ChatHistoryMessage[] {
  return history
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0
    )
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 2_000)
    }))
}

function asksForNotesInPreviousSet(question: string): boolean {
  const normalized = normalizeRecordingSearchText(question)
  const hasPreviousSetCue = /\b(which|what|ones|those|these|them|of those|from that list)\b/.test(
    normalized
  )
  return hasPreviousSetCue && /\b(notes?|recordings?|transcripts?)\b/.test(normalized)
}

function shouldStartNewConversationScope(question: string): boolean {
  const normalized = normalizeRecordingSearchText(question)
  if (isMeetingInventoryQuestion(question)) return true
  if (isCalendarScheduleQuestion(normalized)) return true
  if (detectChatIntent(question) === 'count' || detectChatIntent(question) === 'list') return true
  if (
    /\b(all recordings|every recording|recording inventory|library|all meetings|every meeting)\b/.test(
      normalized
    )
  ) {
    return true
  }
  if (/\b(today|yesterday|last week|this month|last month|upcoming|tomorrow)\b/.test(normalized)) {
    return true
  }
  if (/\bnext (week|month|meeting|call)\b/.test(normalized)) {
    return true
  }

  return false
}

function shouldUseConversationScope(question: string): boolean {
  const normalized = normalizeRecordingSearchText(question)
  return (
    isImplicitFollowUpQuestion(normalized) ||
    hasContextReference(normalized) ||
    extractOrdinalReference(question) != null
  )
}

function hasContextReference(normalizedQuestion: string): boolean {
  return /\b(it|that|those|these|them|there|same|above|previous|earlier|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|for me|for us|the list|that list|this meeting|that meeting|these meetings|those meetings)\b/.test(
    normalizedQuestion
  )
}

function isShortContextualQuestion(normalizedQuestion: string): boolean {
  const words = normalizedQuestion.split(' ').filter(Boolean)
  return words.length > 0 && words.length <= 8
}

function mergeScopedRecordingList(
  session: ChatConversationState,
  selectedIds: string[],
  selectedTitles: string[]
): void {
  if (session.lastRecordingIds.length === 0) {
    rememberRecordingList(session, selectedIds, selectedTitles)
    return
  }
  if (selectedIds.length === 0) return

  const mergedIds = [...session.lastRecordingIds]
  const mergedTitles = [...session.lastRecordingTitles]
  selectedIds.forEach((id, index) => {
    if (!mergedIds.includes(id)) {
      mergedIds.push(id)
      mergedTitles.push(selectedTitles[index] ?? '')
    }
  })
  rememberRecordingList(session, mergedIds, mergedTitles)
}

function extractOrdinalReference(question: string): number | null {
  const normalized = normalizeRecordingSearchText(question)
  const numeric = normalized.match(/\b(?:number|#)?\s*([1-9][0-9]?)\b/)
  if (numeric) return Number(numeric[1]) - 1

  const ordinals: Array<[RegExp, number]> = [
    [/\b1st\b/, 0],
    [/\bfirst\b/, 0],
    [/\b2nd\b/, 1],
    [/\bsecond\b/, 1],
    [/\b3rd\b/, 2],
    [/\bthird\b/, 2],
    [/\b4th\b/, 3],
    [/\bfourth\b/, 3],
    [/\b5th\b/, 4],
    [/\bfifth\b/, 4],
    [/\b6th\b/, 5],
    [/\bsixth\b/, 5],
    [/\b7th\b/, 6],
    [/\bseventh\b/, 6],
    [/\b8th\b/, 7],
    [/\beighth\b/, 7],
    [/\b9th\b/, 8],
    [/\bninth\b/, 8],
    [/\b10th\b/, 9],
    [/\btenth\b/, 9]
  ]
  return ordinals.find(([pattern]) => pattern.test(normalized))?.[1] ?? null
}

function isImplicitFollowUpQuestion(normalizedQuestion: string): boolean {
  if (
    /\b(anything else|what else|more|details|elaborate|what about that|that meeting|this meeting|it)\b/.test(
      normalizedQuestion
    )
  )
    return true

  return isShortContextualQuestion(normalizedQuestion) && !hasFreshSearchTerms(normalizedQuestion)
}

function hasFreshSearchTerms(normalizedQuestion: string): boolean {
  const genericFollowUpTerms = new Set([
    'action',
    'actions',
    'assigned',
    'blocker',
    'blockers',
    'deadline',
    'deadlines',
    'decision',
    'decisions',
    'detail',
    'details',
    'due',
    'item',
    'items',
    'more',
    'next',
    'note',
    'notes',
    'owner',
    'owners',
    'owns',
    'recap',
    'risk',
    'risks',
    'status',
    'step',
    'steps',
    'summary',
    'task',
    'tasks',
    'todo',
    'todos',
    'transcript',
    'transcripts',
    'appreciate',
    'awesome',
    'can',
    'cool',
    'could',
    'got',
    'ok',
    'okay',
    'please',
    'show',
    'sounds',
    'thank',
    'thanks',
    'thx',
    'would',
    'you'
  ])

  return extractQuestionTerms(normalizedQuestion).some((term) => !genericFollowUpTerms.has(term))
}

function buildScopedQuestion(
  question: string,
  session: ChatConversationState,
  followUp: boolean
): string {
  if (followUp) {
    return `${question} Summarize any additional relevant notes from the selected meeting.`
  }
  if (session.lastRecordingIds.length > 0) {
    return `${question} Answer using the selected meeting from the previous turn.`
  }
  return question
}

function buildRecordingRetrievalQuestion(question: string, plan: ChatRetrievalPlan): string {
  if (!plan.recordingSearchQuery || plan.timeRange !== 'none') return question
  return `${question}\n\nSearch focus: ${plan.recordingSearchQuery}`
}

function shouldScopeRecordingsToCalendarEvents(
  question: string,
  selectedCalendarEvents: CalendarEvent[]
): boolean {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  if (/\bmock\b/.test(normalizedQuestion)) return false

  const specificTerms = extractQuestionTerms(question).filter(
    (term) =>
      !new Set([
        'action',
        'actions',
        'agenda',
        'call',
        'calls',
        'content',
        'discuss',
        'discussed',
        'item',
        'items',
        'meeting',
        'meetings',
        'note',
        'notes',
        'recap',
        'summary',
        'summarize',
        'sync',
        'task',
        'tasks',
        'this',
        'week',
        'weeks'
      ]).has(term)
  )

  if (specificTerms.length === 0) return true

  const calendarText = selectedCalendarEvents
    .map((event) => `${event.title} ${event.attendees.join(' ')}`)
    .join(' ')
  return specificTerms.every((term) => scoreTextRelevance(calendarText, term) > 0)
}

function logChatRetrieval(params: {
  meetingContext: ChatRetrievalResult | null
  contextLength: number
  plan: ChatRetrievalPlan
  plannerSource: 'fast' | 'model' | 'fallback'
  calendarElapsedMs: number
  calendarSkippedByBackoff: boolean
  calendarRecentCount: number
  calendarUpcomingCount: number
}): void {
  logAutodocEvent({
    area: 'chat',
    message: 'chat retrieval completed',
    context: {
      ...(params.meetingContext?.diagnostics ?? {
        intent: 'broad',
        inventoryCount: 0,
        matchedCount: 0,
        selectedContextCount: 0,
        matchMode: 'ranked',
        matchedMeetingIds: [],
        matchedTitles: [],
        selectedMeetingIds: [],
        selectedTitles: [],
        inventoryElapsedMs: 0,
        selectionElapsedMs: 0,
        summaryElapsedMs: 0,
        cacheHits: 0,
        cacheMisses: 0,
        promptChars: params.contextLength
      }),
      agenticRetrievalEnabled: true,
      plannerSource: params.plannerSource,
      retrievalPlan: params.plan,
      calendarElapsedMs: params.calendarElapsedMs,
      calendarSkippedByBackoff: params.calendarSkippedByBackoff,
      calendarRecentCount: params.calendarRecentCount,
      calendarUpcomingCount: params.calendarUpcomingCount
    }
  })
}

function shouldUseLocalRecordingContext(question: string, result: ChatRetrievalResult): boolean {
  if (result.directAnswer) return true
  if (result.diagnostics.selectedContextCount === 0 || result.context.trim().length === 0) {
    return false
  }

  if (isMeetingInventoryQuestion(question)) return false

  const normalizedQuestion = normalizeRecordingSearchText(question)
  const asksPrimarilyForCalendar =
    /\b(calendar|schedule|scheduled|upcoming|next meeting|next call|tomorrow)\b/.test(
      normalizedQuestion
    )

  return !asksPrimarilyForCalendar
}

export function isMeetingInventoryQuestion(question: string): boolean {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  if (isRecordingContentQuestion(normalizedQuestion)) return false

  const asksMeetings = /\b(meetings?|calls?|standups?|syncs?)\b/.test(normalizedQuestion)
  const asksInventory =
    /\b(what|which|list|show|had|have|how many|count|number of|was on|were on)\b/.test(
      normalizedQuestion
    ) || /\b(schedule|calendar)\b/.test(normalizedQuestion)
  const hasTimeWindow =
    /\b(today|yesterday|this weeks?|last week|this months?|last month|tomorrow|upcoming|recent)\b/.test(
      normalizedQuestion
    )

  return asksMeetings && asksInventory && hasTimeWindow
}

export function buildFastRetrievalPlan(question: string): FastPlanDecision {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  const timeRange = detectPlanTimeRange(question)
  const recordingSearchQuery = stripPlannerQuestionWords(normalizedQuestion)

  if (isTimeWindowMeetingContentQuestion(normalizedQuestion, timeRange)) {
    return {
      confidence: 'high',
      plan: {
        needsCalendar: false,
        needsRecordings: true,
        timeRange,
        recordingSearchQuery,
        evidenceMode: normalizedQuestion.includes('transcript') ? 'transcript' : 'mixed',
        reason: 'Meeting content question scoped to local recordings by timestamp.'
      }
    }
  }

  if (isMeetingInventoryQuestion(question)) {
    return {
      confidence: 'high',
      plan: {
        needsCalendar: true,
        needsRecordings: false,
        timeRange,
        recordingSearchQuery: '',
        evidenceMode: 'inventory',
        reason: 'Calendar or meeting inventory question.'
      }
    }
  }

  if (isRecordingContentQuestion(normalizedQuestion)) {
    return {
      confidence: 'high',
      plan: {
        needsCalendar: false,
        needsRecordings: true,
        timeRange,
        recordingSearchQuery,
        evidenceMode: normalizedQuestion.includes('transcript') ? 'transcript' : 'mixed',
        reason: 'Meeting content question over local notes or transcripts.'
      }
    }
  }

  if (isCalendarScheduleQuestion(normalizedQuestion)) {
    return {
      confidence: 'high',
      plan: {
        needsCalendar: true,
        needsRecordings: false,
        timeRange,
        recordingSearchQuery: '',
        evidenceMode: 'inventory',
        reason: 'Calendar or meeting inventory question.'
      }
    }
  }

  return { confidence: 'low', plan: buildFallbackRetrievalPlan(question) }
}

function isTimeWindowMeetingContentQuestion(
  normalizedQuestion: string,
  timeRange: ChatPlanTimeRange
): boolean {
  if (timeRange === 'none') return false
  if (!/\b(meetings?|calls?|standups?|syncs?)\b/.test(normalizedQuestion)) return false
  return isRecordingContentQuestion(normalizedQuestion)
}

function isCalendarScheduleQuestion(normalizedQuestion: string): boolean {
  if (
    /\b(upcoming|next meeting|next call|tomorrow|schedule|scheduled)\b/.test(normalizedQuestion)
  ) {
    return true
  }

  return (
    /\bcalendar\b/.test(normalizedQuestion) &&
    /\b(what|which|list|show|on|in)\b/.test(normalizedQuestion)
  )
}

function isRecordingContentQuestion(normalizedQuestion: string): boolean {
  return (
    /\b(discuss|discussed|talk|talked|mention|mentioned|cover|covered|review|reviewed|address|addressed|happened|recap|summarize|summary|notes?|transcript)\b/.test(
      normalizedQuestion
    ) ||
    /\b(which|what)\s+(meeting|meetings|call|calls|standup|standups|sync|syncs)\b.*\b(about|related|involved|focused|included)\b/.test(
      normalizedQuestion
    ) ||
    /\b(action items?|actions?|tasks?|todos?|follow ups?|next steps?|assigned|owner|owns|responsible|due|deadline|decision|decisions|decided|status|blockers?|risks?)\b/.test(
      normalizedQuestion
    )
  )
}

function isDirectCalendarInventoryPlan(plan: ChatRetrievalPlan): boolean {
  return plan.needsCalendar && !plan.needsRecordings && plan.evidenceMode === 'inventory'
}

function formatCalendarInventoryAnswer(params: {
  recentEvents: CalendarEvent[]
  upcomingEvents: CalendarEvent[]
  question: string
  timeRange: ChatPlanTimeRange
  skippedByBackoff: boolean
}): string {
  if (params.skippedByBackoff) {
    return 'I could not refresh your calendar right now, so I cannot reliably list those meetings.'
  }

  const events = selectCalendarInventoryEvents(params)

  const rangeLabel = formatPlanTimeRangeLabel(
    params.timeRange,
    detectCalendarTimeDirection(params.question)
  )
  if (events.length === 0) {
    return `I did not find any calendar meetings${rangeLabel ? ` ${rangeLabel}` : ''}.`
  }

  const lines = events.map((event) => {
    const start = new Date(event.startTime)
    const end = new Date(event.endTime)
    const dateStr = start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    })
    const timeStr = `${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    return `- ${dateStr}, ${timeStr}: ${event.title}`
  })

  return `I found ${events.length} calendar meeting${events.length === 1 ? '' : 's'}${rangeLabel ? ` ${rangeLabel}` : ''}:\n\n${lines.join('\n')}`
}

function selectCalendarInventoryEvents(params: {
  recentEvents: CalendarEvent[]
  upcomingEvents: CalendarEvent[]
  question: string
  timeRange: ChatPlanTimeRange
}): CalendarEvent[] {
  return filterCalendarEventsByPlanTimeRange(
    dedupeCalendarEvents([...params.recentEvents, ...params.upcomingEvents]),
    params.timeRange,
    params.question
  ).sort((a, b) => a.startTime - b.startTime)
}

function dedupeCalendarEvents(events: CalendarEvent[]): CalendarEvent[] {
  const byId = new Map<string, CalendarEvent>()
  for (const event of events) {
    byId.set(event.id, event)
  }
  return [...byId.values()]
}

function filterCalendarEventsByPlanTimeRange(
  events: CalendarEvent[],
  timeRange: ChatPlanTimeRange,
  question: string
): CalendarEvent[] {
  if (timeRange === 'none') return filterCalendarEventsForQuestionWindow(events, question)

  const now = new Date()
  const range = getPlanTimeRangeBounds(timeRange, now, detectCalendarTimeDirection(question))
  if (!range) return filterCalendarEventsForQuestionWindow(events, question)

  return events.filter((event) => event.startTime >= range.start && event.startTime < range.end)
}

function getPlanTimeRangeBounds(
  timeRange: ChatPlanTimeRange,
  now: Date,
  direction: CalendarTimeDirection = 'full'
): { start: number; end: number } | null {
  const start = new Date(now)
  const end = new Date(now)

  switch (timeRange) {
    case 'today':
      start.setHours(0, 0, 0, 0)
      end.setTime(start.getTime())
      end.setDate(start.getDate() + 1)
      return applyCalendarTimeDirection(
        { start: start.getTime(), end: end.getTime() },
        now,
        direction
      )
    case 'yesterday':
      start.setDate(now.getDate() - 1)
      start.setHours(0, 0, 0, 0)
      end.setTime(start.getTime())
      end.setDate(start.getDate() + 1)
      return { start: start.getTime(), end: end.getTime() }
    case 'this_week': {
      const day = start.getDay()
      const diffToMonday = day === 0 ? 6 : day - 1
      start.setDate(start.getDate() - diffToMonday)
      start.setHours(0, 0, 0, 0)
      end.setTime(start.getTime())
      end.setDate(start.getDate() + 7)
      return applyCalendarTimeDirection(
        { start: start.getTime(), end: end.getTime() },
        now,
        direction
      )
    }
    case 'last_week': {
      const day = start.getDay()
      const diffToMonday = day === 0 ? 6 : day - 1
      start.setDate(start.getDate() - diffToMonday - 7)
      start.setHours(0, 0, 0, 0)
      end.setTime(start.getTime())
      end.setDate(start.getDate() + 7)
      return { start: start.getTime(), end: end.getTime() }
    }
    case 'this_month':
      start.setTime(new Date(now.getFullYear(), now.getMonth(), 1).getTime())
      end.setTime(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime())
      return applyCalendarTimeDirection(
        { start: start.getTime(), end: end.getTime() },
        now,
        direction
      )
    case 'last_month':
      start.setTime(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime())
      end.setTime(new Date(now.getFullYear(), now.getMonth(), 1).getTime())
      return { start: start.getTime(), end: end.getTime() }
    case 'upcoming':
      start.setTime(now.getTime())
      end.setTime(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      return { start: start.getTime(), end: end.getTime() }
    case 'recent':
      start.setTime(now.getTime() - RECENT_CALENDAR_DAYS * 24 * 60 * 60 * 1000)
      end.setTime(now.getTime())
      return { start: start.getTime(), end: end.getTime() }
    case 'none':
      return null
  }
}

function applyCalendarTimeDirection(
  range: { start: number; end: number },
  now: Date,
  direction: CalendarTimeDirection
): { start: number; end: number } {
  if (direction === 'past') return { ...range, end: Math.min(range.end, now.getTime()) }
  if (direction === 'future') return { ...range, start: Math.max(range.start, now.getTime()) }
  return range
}

function detectCalendarTimeDirection(question: string): CalendarTimeDirection {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  if (/\b(upcoming|next|will|tomorrow|later)\b/.test(normalizedQuestion)) return 'future'
  if (/\b(did|had|was|were|past)\b/.test(normalizedQuestion)) return 'past'
  if (/\bdo i have|what do i have|what meetings do i have\b/.test(normalizedQuestion)) {
    return 'future'
  }
  return 'full'
}

function formatPlanTimeRangeLabel(
  timeRange: ChatPlanTimeRange,
  direction: CalendarTimeDirection = 'full'
): string {
  switch (timeRange) {
    case 'today':
      return 'today'
    case 'yesterday':
      return 'yesterday'
    case 'this_week':
      if (direction === 'past') return 'so far this week'
      if (direction === 'future') return 'coming up this week'
      return 'this week'
    case 'last_week':
      return 'last week'
    case 'this_month':
      if (direction === 'past') return 'so far this month'
      if (direction === 'future') return 'coming up this month'
      return 'this month'
    case 'last_month':
      return 'last month'
    case 'upcoming':
      return 'upcoming'
    case 'recent':
      return 'recently'
    case 'none':
      return ''
  }
}

async function waitForOllama(ollamaManager: OllamaRuntime): Promise<void> {
  try {
    await ollamaManager.waitUntilReady()
  } catch {
    const running = await ollamaManager.isServerRunning()
    if (!running) throw new Error('Ollama is not running. Please start Ollama and try again.')
  }
}

async function buildChatRetrievalPlan(params: {
  baseUrl: string
  model: string
  question: string
  history: ChatHistoryMessage[]
  signal?: AbortSignal
}): Promise<ChatRetrievalPlan> {
  try {
    const res = await fetch(`${params.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: params.signal,
      body: JSON.stringify({
        model: params.model,
        messages: buildPlannerMessages(params.question, params.history),
        stream: false,
        keep_alive: CHAT_OLLAMA_KEEP_ALIVE,
        format: 'json',
        options: {
          temperature: 0,
          num_ctx: 2048,
          num_predict: 512
        }
      })
    })

    if (!res.ok) throw new Error(`Ollama returned ${res.status}`)
    const data = (await res.json()) as { message?: { content?: string } }
    return parseChatRetrievalPlan(data.message?.content ?? '', params.question)
  } catch (error) {
    if (params.signal?.aborted) throw error
    return buildFallbackRetrievalPlan(params.question)
  }
}

function buildPlannerMessages(
  question: string,
  history: ChatHistoryMessage[] = []
): Array<{ role: string; content: string }> {
  const historyText = formatConversationHistory(history)
  return [
    {
      role: 'system',
      content: `You plan retrieval for a local meeting assistant. Do not answer the user's question.

Available data sources:
- calendar: meeting schedule, attendees, dates, upcoming/recent events
- recordings: local recorded meetings with titles, dates, notes, transcripts
- notes: structured JSON notes with decisions, action items, information, discussion, status updates, owners, deadlines, and topics
- transcripts: raw transcript text, useful when notes may miss details

Choose the minimum data needed. Use calendar when the user asks what meetings they had/have, asks about schedule, or asks for meetings in a date range. Use recordings/notes/transcripts when the user asks what happened, who owns something, due dates, decisions, topics discussed, or details from meeting content.

Return only JSON with this shape:
{
  "needsCalendar": true,
  "needsRecordings": true,
  "timeRange": "none|today|yesterday|this_week|last_week|this_month|last_month|upcoming|recent",
  "recordingSearchQuery": "short content search query, or empty string",
  "evidenceMode": "inventory|notes|transcript|mixed",
  "reason": "brief reason"
}`
    },
    {
      role: 'user',
      content: historyText
        ? `Recent conversation:\n${historyText}\n\nCurrent question: ${question}`
        : question
    }
  ]
}

export function parseChatRetrievalPlan(raw: string, question: string): ChatRetrievalPlan {
  try {
    const parsed = JSON.parse(raw) as Partial<ChatRetrievalPlan>
    const fallback = buildFallbackRetrievalPlan(question)
    return {
      needsCalendar:
        typeof parsed.needsCalendar === 'boolean' ? parsed.needsCalendar : fallback.needsCalendar,
      needsRecordings:
        typeof parsed.needsRecordings === 'boolean'
          ? parsed.needsRecordings
          : fallback.needsRecordings,
      timeRange: normalizePlanTimeRange(parsed.timeRange, fallback.timeRange),
      recordingSearchQuery:
        typeof parsed.recordingSearchQuery === 'string'
          ? parsed.recordingSearchQuery.trim().slice(0, 240)
          : fallback.recordingSearchQuery,
      evidenceMode: normalizeEvidenceMode(parsed.evidenceMode, fallback.evidenceMode),
      reason:
        typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 240) : fallback.reason
    }
  } catch {
    return buildFallbackRetrievalPlan(question)
  }
}

export function buildFallbackRetrievalPlan(question: string): ChatRetrievalPlan {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  const calendarInventory = isMeetingInventoryQuestion(question)
  return {
    needsCalendar:
      calendarInventory ||
      /\b(calendar|schedule|scheduled|upcoming|tomorrow|next meeting|next call)\b/.test(
        normalizedQuestion
      ),
    needsRecordings: !calendarInventory,
    timeRange: detectPlanTimeRange(question),
    recordingSearchQuery: calendarInventory ? '' : stripPlannerQuestionWords(normalizedQuestion),
    evidenceMode: calendarInventory ? 'inventory' : 'mixed',
    reason: 'Fallback plan based on source and time-window cues.'
  }
}

function normalizePlanTimeRange(
  value: ChatRetrievalPlan['timeRange'] | undefined,
  fallback: ChatPlanTimeRange
): ChatPlanTimeRange {
  const allowed = new Set<ChatPlanTimeRange>([
    'none',
    'today',
    'yesterday',
    'this_week',
    'last_week',
    'this_month',
    'last_month',
    'upcoming',
    'recent'
  ])
  return value && allowed.has(value) ? value : fallback
}

function normalizeEvidenceMode(
  value: ChatRetrievalPlan['evidenceMode'] | undefined,
  fallback: ChatRetrievalPlan['evidenceMode']
): ChatRetrievalPlan['evidenceMode'] {
  return value === 'inventory' || value === 'notes' || value === 'transcript' || value === 'mixed'
    ? value
    : fallback
}

function detectPlanTimeRange(question: string): ChatPlanTimeRange {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  if (normalizedQuestion.includes('yesterday')) return 'yesterday'
  if (normalizedQuestion.includes('today')) return 'today'
  if (normalizedQuestion.includes('last week')) return 'last_week'
  if (/\bthis weeks?\b/.test(normalizedQuestion)) return 'this_week'
  if (normalizedQuestion.includes('last month')) return 'last_month'
  if (/\bthis months?\b/.test(normalizedQuestion)) return 'this_month'
  if (normalizedQuestion.includes('upcoming') || normalizedQuestion.includes('tomorrow')) {
    return 'upcoming'
  }
  if (normalizedQuestion.includes('recent')) return 'recent'
  return 'none'
}

function questionForPlanTimeRange(question: string, timeRange: ChatPlanTimeRange): string {
  if (timeRange === 'none') return question
  return `${question} ${timeRange.replace('_', ' ')}`
}

function stripPlannerQuestionWords(question: string): string {
  const stopWords = new Set([
    'what',
    'which',
    'who',
    'when',
    'where',
    'why',
    'how',
    'did',
    'was',
    'were',
    'the',
    'that',
    'this',
    'meeting',
    'meetings',
    'recording',
    'recordings',
    'action',
    'actions',
    'task',
    'tasks',
    'assigned',
    'owner',
    'due',
    'deadline',
    'date'
  ])
  return question
    .split(' ')
    .filter((word) => word.length >= 3 && !stopWords.has(word))
    .join(' ')
}

async function completeOllamaChat(params: {
  baseUrl: string
  model: string
  question: string
  context: string
  history: ChatHistoryMessage[]
}): Promise<string> {
  const res = await fetch(`${params.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      messages: buildChatMessages(
        limitChatContext(params.context),
        params.question,
        params.history
      ),
      stream: false,
      keep_alive: CHAT_OLLAMA_KEEP_ALIVE,
      options: buildAnswerOllamaOptions()
    })
  })

  if (!res.ok) {
    throw new Error(`Ollama returned ${res.status}`)
  }

  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content ?? 'No response from AI.'
}

async function streamOllamaChat(params: {
  baseUrl: string
  model: string
  question: string
  context: string
  history: ChatHistoryMessage[]
  onChunk: (chunk: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const res = await fetch(`${params.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      model: params.model,
      messages: buildChatMessages(
        limitChatContext(params.context),
        params.question,
        params.history
      ),
      stream: true,
      keep_alive: CHAT_OLLAMA_KEEP_ALIVE,
      options: buildAnswerOllamaOptions()
    })
  })

  if (!res.ok) {
    throw new Error(`Ollama returned ${res.status}`)
  }

  if (!res.body) {
    throw new Error('Ollama returned an empty stream')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const data = JSON.parse(trimmed) as {
        done?: boolean
        message?: { content?: string }
        error?: string
      }
      if (data.error) throw new Error(data.error)
      const content = data.message?.content
      if (content) params.onChunk(content)
    }
  }

  const tail = buffer.trim()
  if (tail) {
    const data = JSON.parse(tail) as { message?: { content?: string }; error?: string }
    if (data.error) throw new Error(data.error)
    if (data.message?.content) params.onChunk(data.message.content)
  }
}

function buildAnswerOllamaOptions(): Record<string, number> {
  return {
    temperature: CHAT_OLLAMA_TEMPERATURE,
    num_ctx: CHAT_OLLAMA_NUM_CTX,
    num_predict: CHAT_OLLAMA_NUM_PREDICT,
    top_p: 0.9,
    repeat_penalty: 1.05
  }
}

function limitChatContext(context: string): string {
  if (context.length <= CHAT_CONTEXT_CHAR_LIMIT) return context
  return `${context.slice(0, CHAT_CONTEXT_CHAR_LIMIT).trim()}\n\n[Context truncated to keep the local answer model fast. Answer only from the visible context above.]`
}

function buildChatMessages(
  context: string,
  question: string,
  history: ChatHistoryMessage[] = []
): Array<{ role: string; content: string }> {
  const historyText = formatConversationHistory(history)
  return [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Here is context from the user's calendar and local recordings:\n\n${context}\n\n---\n\n${historyText ? `Recent conversation:\n${historyText}\n\n` : ''}User question: ${question}`
    }
  ]
}

function formatConversationHistory(history: ChatHistoryMessage[]): string {
  return history
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n')
}

function formatCalendarContext(
  recentEvents: CalendarEvent[],
  upcomingEvents: CalendarEvent[],
  question: string
): string {
  const now = new Date()
  const recentCutoff = now.getTime() - RECENT_CALENDAR_DAYS * 24 * 60 * 60 * 1000
  const recentEventsForContext = filterCalendarEventsForQuestionWindow(
    recentEvents.filter((event) => event.startTime >= recentCutoff),
    question
  )
  const upcomingEventsForContext = filterCalendarEventsForQuestionWindow(upcomingEvents, question)

  const formatEventLine = (event: CalendarEvent): string => {
    const start = new Date(event.startTime)
    const end = new Date(event.endTime)
    const dateStr = start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    })
    const timeStr = `${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    const attendeeStr = event.attendees.length > 0 ? ` (with ${event.attendees.join(', ')})` : ''
    return `- ${dateStr}, ${timeStr}: ${event.title}${attendeeStr}`
  }

  const sections: string[] = []
  if (recentEventsForContext.length > 0) {
    sections.push(
      `## Recent Calendar Events\n${recentEventsForContext.map(formatEventLine).join('\n')}`
    )
  }
  if (upcomingEventsForContext.length > 0) {
    sections.push(
      `## Upcoming Calendar Events\n${upcomingEventsForContext.map(formatEventLine).join('\n')}`
    )
  }

  if (sections.length === 0) return ''

  return `Calendar reference (as of ${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})\n\n${sections.join('\n\n')}`
}

function filterCalendarEventsForQuestionWindow(
  events: CalendarEvent[],
  question: string
): CalendarEvent[] {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  if (!normalizedQuestion) return filterCalendarEventsByQuestionRelevance(events, question)

  const now = new Date()
  let windowedEvents = events

  if (normalizedQuestion.includes('today')) {
    const today = now.toDateString()
    windowedEvents = events.filter((event) => new Date(event.startTime).toDateString() === today)
  } else if (normalizedQuestion.includes('yesterday')) {
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const yesterdayKey = yesterday.toDateString()
    windowedEvents = events.filter(
      (event) => new Date(event.startTime).toDateString() === yesterdayKey
    )
  } else if (/\bthis weeks?\b/.test(normalizedQuestion)) {
    const startOfWeek = new Date(now)
    const day = startOfWeek.getDay()
    const diffToMonday = day === 0 ? 6 : day - 1
    startOfWeek.setDate(startOfWeek.getDate() - diffToMonday)
    startOfWeek.setHours(0, 0, 0, 0)
    const endOfWeek = new Date(startOfWeek)
    endOfWeek.setDate(startOfWeek.getDate() + 7)
    windowedEvents = events.filter(
      (event) => event.startTime >= startOfWeek.getTime() && event.startTime < endOfWeek.getTime()
    )
  } else if (/\bthis months?\b/.test(normalizedQuestion)) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    windowedEvents = events.filter(
      (event) => event.startTime >= startOfMonth.getTime() && event.startTime < endOfMonth.getTime()
    )
  }

  return filterCalendarEventsByQuestionRelevance(windowedEvents, question)
}

function filterCalendarEventsByQuestionRelevance(
  events: CalendarEvent[],
  question: string
): CalendarEvent[] {
  const ranked = [...events].sort((a, b) => {
    const aScore = scoreTextRelevance(`${a.title} ${a.attendees.join(' ')}`, question)
    const bScore = scoreTextRelevance(`${b.title} ${b.attendees.join(' ')}`, question)
    if (aScore !== bScore) return bScore - aScore
    return b.startTime - a.startTime
  })

  const relevant = ranked.filter(
    (event) => scoreTextRelevance(`${event.title} ${event.attendees.join(' ')}`, question) > 0
  )

  return relevant.length > 0 ? relevant : ranked
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Calendar fetch timed out')),
          CALENDAR_FETCH_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
