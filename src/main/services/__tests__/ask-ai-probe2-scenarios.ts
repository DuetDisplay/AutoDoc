/**
 * PROBE2 usability probe for Ask AI — a SECOND set of 50 scenarios with zero
 * overlap with either `ask-ai-live-scenarios.ts` (engineered matrix) or
 * `ask-ai-fresh-scenarios.ts` (fresh probe). New phrasings and angles:
 * absence/anti-fabrication variety, present-existence yes/no, ownership
 * reformulations, decision/rationale, open-items/status, cross-meeting
 * synthesis, time-of-day ordering, new coreference phrasings, conversational
 * closings, out-of-scope sanity, and format transforms.
 *
 * Every predicate stays grounded in the same 4 fixtures (imported from
 * ask-ai-live-scenarios) so a failure maps to a real conversational gap.
 * Not a test file itself (no `.test.ts`).
 */
import type { Scenario } from './ask-ai-live-scenarios'

const lc = (s: string): string => s.toLowerCase()
const has =
  (...tokens: string[]) =>
  (a: string): boolean =>
    tokens.every((t) => lc(a).includes(t))
const hasAny =
  (...tokens: string[]) =>
  (a: string): boolean =>
    tokens.some((t) => lc(a).includes(t))
const lacks =
  (...tokens: string[]) =>
  (a: string): boolean =>
    tokens.every((t) => !lc(a).includes(t))
const all =
  (...checks: Array<(a: string) => boolean>) =>
  (a: string): boolean =>
    checks.every((c) => c(a))
const nonEmpty = (a: string): boolean => a.trim().length > 0 && !a.startsWith('__')
const shortReply =
  (max = 400) =>
  (a: string): boolean =>
    a.trim().length > 0 && a.length < max
// Validate an actual word ceiling (the scenario asks for "under 10 words"); a
// small tolerance absorbs connectives without letting a paragraph pass.
const maxWords =
  (max: number) =>
  (a: string): boolean => {
    const words = a.trim().split(/\s+/).filter(Boolean)
    return words.length > 0 && words.length <= max
  }
const expressesAbsence = (a: string): boolean =>
  /\b(no|not|don'?t|doesn'?t|didn'?t|can'?t|cannot|couldn'?t|won'?t|isn'?t|aren'?t|nothing|none|unable|without|n'?t (find|see|have))\b|no (record|mention|data|info|results?|meetings?|events?|recordings?)/i.test(
    a
  )

// The four fixture "areas". A genuine cross-meeting synthesis should touch at
// least two distinct areas rather than collapsing onto one.
const AREA_TOKENS: string[][] = [
  ['roadmap', 'priya', 'q3', 'sequencing', 'milestone'],
  ['casey', 'escalation', 'support', 'queue', 'customer'],
  ['onboarding', 'copy', 'illustration', 'calmer', 'design'],
  ['oauth', 'consent', 'scope', 'calendar', 'google', 'auth']
]
const coversAreas =
  (min: number) =>
  (a: string): boolean => {
    const l = lc(a)
    return AREA_TOKENS.filter((group) => group.some((t) => l.includes(t))).length >= min
  }
// A closing/acknowledgement reply should be short and must NOT re-dump meeting
// facts from the prior answer.
const isClosing = all(
  nonEmpty,
  shortReply(200),
  lacks('roadmap', 'priya', 'onboarding', 'illustration', 'consent', 'oauth', '1.', '2.')
)
// Off-topic asks must not invent meeting content.
const noMeetingFabrication = lacks(
  'roadmap',
  'priya',
  'escalation',
  'casey',
  'onboarding',
  'illustration',
  'oauth',
  'consent'
)

// Fixtures (newest -> oldest, all on Jun 1 2026): roadmap @10:00 (Q3 sequencing
// locked, Priya drives milestone tracker), support @09:00 (Casey owns escalation
// follow-up for priority customer queue), design @08:00 (rewrote onboarding copy,
// chose calmer illustration set), calendar @07:00 (Google OAuth scopes need a
// consent-screen update before launch). Calendar events are mocked empty.
export const PROBE2_SCENARIOS: Scenario[] = [
  // ---- Anti-fabrication: topics that are NOT in the data -------------------
  {
    id: 'absent-pricing',
    category: 'absence',
    turns: [
      { question: 'what did we decide about pricing?', check: all(nonEmpty, expressesAbsence) }
    ]
  },
  {
    id: 'absent-budget',
    category: 'absence',
    turns: [
      {
        question: 'was the budget discussed in any of my meetings?',
        check: all(nonEmpty, expressesAbsence)
      }
    ]
  },
  {
    id: 'absent-hiring',
    category: 'absence',
    turns: [
      { question: 'any notes on hiring or headcount?', check: all(nonEmpty, expressesAbsence) }
    ]
  },
  {
    id: 'absent-security',
    category: 'absence',
    turns: [
      { question: 'what came up about the security audit?', check: all(nonEmpty, expressesAbsence) }
    ]
  },
  {
    id: 'absent-marketing',
    category: 'absence',
    turns: [
      {
        question: 'did we talk about the marketing launch campaign?',
        check: all(nonEmpty, expressesAbsence)
      }
    ]
  },
  {
    id: 'absent-mobile',
    category: 'absence',
    turns: [
      {
        question: 'is there anything about the mobile app?',
        check: all(nonEmpty, expressesAbsence)
      }
    ]
  },
  {
    id: 'absent-perf',
    category: 'absence',
    turns: [
      {
        question: 'what were the performance benchmark numbers?',
        check: all(nonEmpty, expressesAbsence)
      }
    ]
  },
  {
    id: 'absent-pto',
    category: 'absence',
    turns: [
      { question: 'did anyone mention vacation schedules?', check: all(nonEmpty, expressesAbsence) }
    ]
  },
  {
    id: 'absent-api',
    category: 'absence',
    turns: [
      {
        question: 'what did we say about the API redesign?',
        check: all(nonEmpty, expressesAbsence)
      }
    ]
  },

  // ---- Existence (topics that ARE present) --------------------------------
  {
    id: 'exists-onboarding',
    category: 'existence',
    turns: [
      {
        question: 'do I have anything about onboarding?',
        check: hasAny('onboarding', 'copy', 'illustration', 'design', 'yes')
      }
    ]
  },
  {
    id: 'exists-auth',
    category: 'existence',
    turns: [
      {
        question: 'is there a recording that touches authentication?',
        check: hasAny('oauth', 'auth', 'consent', 'calendar', 'google', 'yes')
      }
    ]
  },
  {
    id: 'exists-roadmap',
    category: 'existence',
    turns: [
      {
        question: 'anything in my notes about the product roadmap?',
        check: hasAny('roadmap', 'q3', 'sequencing', 'priya', 'yes')
      }
    ]
  },
  {
    id: 'exists-escalation',
    category: 'existence',
    turns: [
      {
        question: 'do any meetings cover customer escalations?',
        check: hasAny('escalation', 'casey', 'support', 'customer', 'queue', 'yes')
      }
    ]
  },
  {
    id: 'exists-google',
    category: 'existence',
    turns: [
      {
        question: 'which recording mentions Google?',
        check: hasAny('oauth', 'consent', 'calendar', 'google', 'auth')
      }
    ]
  },

  // ---- Ownership reformulations -------------------------------------------
  {
    id: 'own-queue',
    category: 'person',
    turns: [{ question: "who's handling the priority customer queue?", check: has('casey') }]
  },
  {
    id: 'own-tracker',
    category: 'person',
    turns: [{ question: "who's responsible for the milestone tracker?", check: has('priya') }]
  },
  {
    id: 'own-roadmap-name',
    category: 'person',
    turns: [{ question: 'whose name came up in the roadmap review?', check: has('priya') }]
  },
  {
    id: 'own-followup-person',
    category: 'person',
    turns: [{ question: 'who do I follow up with about the escalation?', check: has('casey') }]
  },
  {
    id: 'own-priya-where',
    category: 'person',
    turns: [
      {
        question: 'is Priya involved in support or roadmap?',
        check: hasAny('roadmap', 'milestone', 'q3')
      }
    ]
  },

  // ---- Decisions / rationale ---------------------------------------------
  {
    id: 'dec-q3-locked',
    category: 'decision',
    turns: [
      { question: 'what got locked for Q3?', check: hasAny('sequencing', 'roadmap', 'locked') }
    ]
  },
  {
    id: 'dec-illustration',
    category: 'decision',
    turns: [
      {
        question: 'which illustration set did we go with?',
        check: hasAny('calmer', 'illustration')
      }
    ]
  },
  {
    id: 'dec-onboarding-change',
    category: 'decision',
    turns: [
      {
        question: 'what change was made to the onboarding?',
        check: hasAny('copy', 'rewrote', 'rewrite', 'onboarding')
      }
    ]
  },
  {
    id: 'dec-oauth-why',
    category: 'rationale',
    turns: [
      {
        question: 'why does the OAuth need work before launch?',
        check: hasAny('consent', 'scope', 'launch')
      }
    ]
  },
  {
    id: 'dec-q3-plan',
    category: 'rationale',
    turns: [
      {
        question: "what's the plan for the Q3 roadmap?",
        check: hasAny('sequencing', 'locked', 'q3', 'priya')
      }
    ]
  },

  // ---- Status / open items -----------------------------------------------
  {
    id: 'status-outstanding',
    category: 'status',
    turns: [
      {
        question: "what's still outstanding?",
        check: hasAny('escalation', 'casey', 'follow', 'queue')
      }
    ]
  },
  {
    id: 'status-blockers-launch',
    category: 'status',
    turns: [
      {
        question: 'any blockers before launch?',
        check: hasAny('oauth', 'consent', 'scope', 'launch')
      }
    ]
  },
  {
    id: 'status-attention',
    category: 'status',
    turns: [
      {
        question: 'what needs my attention?',
        check: hasAny('escalation', 'casey', 'follow', 'oauth')
      }
    ]
  },
  {
    id: 'status-forgetting',
    category: 'status',
    turns: [
      {
        question: "is there a follow-up I'm forgetting?",
        check: hasAny('escalation', 'casey', 'follow', 'queue')
      }
    ]
  },

  // ---- Cross-meeting synthesis -------------------------------------------
  {
    id: 'syn-one-liners',
    category: 'synthesis',
    turns: [{ question: 'give me a one-line summary of each recording', check: coversAreas(3) }]
  },
  {
    id: 'syn-themes',
    category: 'synthesis',
    turns: [{ question: 'what are the common threads across my meetings?', check: coversAreas(2) }]
  },
  {
    id: 'syn-compare',
    category: 'synthesis',
    turns: [
      {
        question: 'compare the roadmap and support meetings',
        check: all(hasAny('roadmap', 'priya', 'q3'), hasAny('support', 'casey', 'escalation'))
      }
    ]
  },
  {
    id: 'syn-prioritize',
    category: 'synthesis',
    turns: [
      {
        question: 'across all my recordings, what should I prioritize?',
        check: all(nonEmpty, coversAreas(1))
      }
    ]
  },

  // ---- Time / ordering (within the same day) -----------------------------
  {
    id: 'time-earliest-day',
    category: 'time',
    turns: [
      {
        question: 'which meeting was earliest in the day?',
        check: hasAny('calendar', 'oauth', 'consent', 'auth')
      }
    ]
  },
  {
    id: 'time-last-that-day',
    category: 'time',
    turns: [
      {
        question: 'what was the last thing I recorded that day?',
        check: hasAny('roadmap', 'priya', 'q3', 'sequencing')
      }
    ]
  },
  {
    id: 'time-same-day',
    category: 'time',
    turns: [
      {
        question: 'were these all recorded on the same day?',
        check: hasAny('yes', 'same', 'june', 'jun', 'all')
      }
    ]
  },

  // ---- Coreference (new phrasings, multi-turn) ---------------------------
  {
    id: 'coref-design-change',
    category: 'coreference',
    turns: [
      { question: 'tell me about the design sync', check: () => true },
      {
        question: 'what did we change there?',
        check: hasAny('onboarding', 'copy', 'illustration', 'calmer')
      }
    ]
  },
  {
    id: 'coref-roadmap-lead',
    category: 'coreference',
    turns: [
      { question: 'pull up the roadmap review', check: () => true },
      { question: "who's leading that?", check: has('priya') }
    ]
  },
  {
    id: 'coref-support-followup',
    category: 'coreference',
    turns: [
      { question: 'show the support triage', check: () => true },
      { question: "what's the follow-up?", check: hasAny('escalation', 'casey', 'queue') }
    ]
  },
  {
    id: 'coref-calendar-block',
    category: 'coreference',
    turns: [
      { question: 'open the calendar auth review', check: () => true },
      { question: "what's blocking it?", check: hasAny('consent', 'scope', 'launch', 'oauth') }
    ]
  },
  {
    id: 'coref-newest-summarize',
    category: 'coreference',
    turns: [
      { question: "what's my newest recording?", check: () => true },
      { question: 'summarize it', check: hasAny('roadmap', 'priya', 'q3', 'sequencing') }
    ]
  },

  // ---- Conversational closings -------------------------------------------
  {
    id: 'close-thats-all',
    category: 'acknowledgement',
    turns: [
      { question: 'how many recordings do I have?', check: () => true },
      { question: "perfect, that's all I needed", check: isClosing }
    ]
  },
  {
    id: 'close-cheers',
    category: 'acknowledgement',
    turns: [
      { question: 'list my recordings', check: () => true },
      { question: 'great, cheers', check: isClosing }
    ]
  },
  {
    id: 'close-awesome-thanks',
    category: 'acknowledgement',
    turns: [
      { question: 'who owns the escalation?', check: () => true },
      { question: 'awesome, thanks', check: isClosing }
    ]
  },

  // ---- Out-of-scope sanity (must not fabricate meeting data) --------------
  {
    id: 'oos-math',
    category: 'out-of-scope',
    turns: [{ question: "what's 15% of 200?", check: all(nonEmpty, noMeetingFabrication) }]
  },
  {
    id: 'oos-funfact',
    category: 'out-of-scope',
    turns: [{ question: 'tell me a fun fact', check: all(nonEmpty, noMeetingFabrication) }]
  },
  {
    id: 'oos-capital',
    category: 'out-of-scope',
    turns: [
      {
        question: 'what is the capital of France?',
        check: all(
          nonEmpty,
          hasAny('paris', 'meeting', 'recording', 'help', 'assist', "can't", 'calendar')
        )
      }
    ]
  },

  // ---- Format / transform -------------------------------------------------
  {
    id: 'fmt-single-sentence',
    category: 'formatting',
    turns: [
      { question: 'who owns the escalation?', check: () => true },
      {
        question: 'put that in a single sentence',
        check: all(hasAny('casey', 'escalation'), shortReply(240))
      }
    ]
  },
  {
    id: 'fmt-under-ten-words',
    category: 'formatting',
    turns: [
      {
        question: 'summarize the roadmap review in under 10 words',
        check: all(hasAny('roadmap', 'priya', 'q3', 'sequencing'), maxWords(12))
      }
    ]
  },
  {
    id: 'fmt-bullet',
    category: 'formatting',
    turns: [
      {
        question: 'give me the design decision as a bullet point',
        check: hasAny('onboarding', 'copy', 'illustration', 'calmer')
      }
    ]
  },
  {
    id: 'fmt-checklist',
    category: 'formatting',
    turns: [
      {
        question: 'list the action items as a checklist',
        check: hasAny('casey', 'escalation', 'follow', 'queue')
      }
    ]
  }
]
