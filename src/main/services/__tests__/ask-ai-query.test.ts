import { describe, expect, it } from 'vitest'
import { parseAskAiQuestion } from '../ask-ai-query'

describe('parseAskAiQuestion', () => {
  it.each([
    ['how many recordings do I have?', 'count', [], false, 'recordings'],
    ['how many meetings did I have today?', 'count', [], true, 'recordings'],
    ['did I have any meetings today?', 'list', [], true, 'recordings'],
    ['what meetings did I have last week', 'list', [], true, 'recordings'],
    ['were there any recordings yesterday', 'list', [], true, 'recordings'],
    ['what are my most recent meetings?', 'list', [], false, 'recordings'],
    ['what was my most recent recording about?', 'latest', [], false, 'recordings'],
    ['what action items do I have?', 'actions', [], false, 'recordings'],
    ["what's on my calendar today", 'calendar', [], true, 'calendar'],
    [
      'compare the Keyboard QA Sync and the Latency Test',
      'compare',
      ['keyboard', 'sync', 'latency', 'test'],
      false,
      'recordings'
    ],
    [
      'did I talk about PKI in any meetings this week',
      'content',
      ['pki'],
      true,
      'recordings'
    ],
    ['have I ever talked about PKI?', 'content', ['pki'], false, 'recordings'],
    ['did we mention billing yesterday', 'content', ['billing'], true, 'recordings'],
    [
      'what did we say about RDP connection errors',
      'content',
      ['rdp', 'connection', 'errors'],
      false,
      'recordings'
    ],
    ['what happened in the Latency Test', 'content', ['latency', 'test'], false, 'recordings'],
    [
      'what was the Slack huddle in duet-display about',
      'content',
      ['slack', 'huddle', 'duet', 'display'],
      false,
      'recordings'
    ],
    ['did anyone talk about launch this month', 'content', ['launch'], true, 'recordings']
  ] as const)('%s → %s %j', (question, act, topicTerms, hasTimeWindow, source) => {
    const parsed = parseAskAiQuestion(question)
    expect(parsed.act).toBe(act)
    expect(parsed.topicTerms).toEqual([...topicTerms])
    expect(parsed.hasTimeWindow).toBe(hasTimeWindow)
    expect(parsed.source).toBe(source)
  })

  it('never treats speech verbs or time words as topic terms', () => {
    const talked = parseAskAiQuestion('did I talk about anything today')
    expect(talked.act).toBe('list')
    expect(talked.topicTerms).toEqual([])
    expect(talked.hasTimeWindow).toBe(true)
  })
})
