/**
 * FRESH usability probe for Ask AI — 50 scenarios with intentionally ZERO
 * overlap with the engineered matrix in `ask-ai-live-scenarios.ts` (no reused
 * phrasings, and new angles: person-centric retrieval, existence/yes-no,
 * time-ordering, decision rationale, status/blockers, formatting requests,
 * capability boundaries, cross-meeting comparison, fresh anti-fabrication, and
 * new coreference phrasings).
 *
 * Goal: estimate how often a real user hits an edge case vs a correct answer on
 * UNSEEN input. Every predicate stays grounded in the same 4 fixtures (imported
 * from ask-ai-live-scenarios) so a failure maps to a real conversational gap.
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
const expressesAbsence = (a: string): boolean =>
  /\b(no|not|don'?t|doesn'?t|didn'?t|can'?t|cannot|couldn'?t|won'?t|isn'?t|aren'?t|nothing|none|unable|without|n'?t (find|see|have))\b|no (record|mention|data|info|results?|meetings?|events?|recordings?)/i.test(
    a
  )
// A capability the local app can't perform (delete/email/schedule/join) should
// be declined rather than hallucinated as done.
const declines = (a: string): boolean =>
  hasAny(
    "can't",
    'cannot',
    'unable',
    "don't have",
    "don't currently",
    'not able',
    "i'm not able",
    'no ability',
    'not something i can',
    'sorry'
  )(a)

// Fixtures (newest -> oldest): roadmap (Q3/Priya), support (Casey escalation,
// due Friday), design (onboarding copy/calmer illustrations), calendar
// (Google OAuth consent-screen before launch). Calendar events are mocked empty.
export const FRESH_SCENARIOS: Scenario[] = [
  // ---- Person-centric retrieval -------------------------------------------
  {
    id: 'person-priya-working-on',
    category: 'person',
    turns: [
      {
        question: 'what is Priya working on?',
        check: hasAny('milestone', 'tracker', 'roadmap', 'q3', 'sequenc')
      }
    ]
  },
  {
    id: 'person-casey-meeting',
    category: 'person',
    turns: [
      {
        question: 'which meeting is Casey part of?',
        check: hasAny('support', 'triage', 'escalation', 'customer', 'queue')
      }
    ]
  },
  {
    id: 'person-casey-responsible',
    category: 'person',
    turns: [
      {
        question: 'what is Casey responsible for?',
        check: hasAny('escalation', 'follow', 'customer', 'queue', 'priority')
      }
    ]
  },

  // ---- Existence / yes-no -------------------------------------------------
  {
    id: 'exists-oauth',
    category: 'existence',
    turns: [
      {
        question: 'did we discuss OAuth anywhere?',
        check: hasAny('oauth', 'calendar', 'consent', 'scope', 'auth')
      }
    ]
  },
  {
    id: 'exists-onboarding',
    category: 'existence',
    turns: [
      {
        question: 'is there anything about onboarding in my notes?',
        check: hasAny('onboarding', 'copy', 'design', 'illustration')
      }
    ]
  },
  {
    id: 'exists-customer-queue',
    category: 'existence',
    turns: [
      {
        question: 'do any meetings mention a customer queue?',
        check: hasAny('queue', 'customer', 'support', 'escalation', 'priority')
      }
    ]
  },
  {
    id: 'exists-consent-screen',
    category: 'existence',
    turns: [
      {
        question: 'was a consent screen brought up at all?',
        check: hasAny('consent', 'oauth', 'calendar', 'scope', 'auth')
      }
    ]
  },

  // ---- Time / ordering ----------------------------------------------------
  {
    id: 'time-oldest',
    category: 'time',
    turns: [
      {
        question: 'what is the oldest recording I have?',
        check: hasAny('calendar', 'oauth', 'auth', 'consent')
      }
    ]
  },
  {
    id: 'time-first-that-day',
    category: 'time',
    turns: [
      {
        question: 'which meeting happened first?',
        check: hasAny('calendar', 'oauth', 'auth', 'consent')
      }
    ]
  },
  {
    id: 'time-when-roadmap',
    category: 'time',
    turns: [
      {
        question: 'when did the roadmap review take place?',
        check: hasAny('jun', 'june', 'morning', '10', '1')
      }
    ]
  },

  // ---- Decision / rationale ----------------------------------------------
  {
    id: 'rationale-illustrations',
    category: 'rationale',
    turns: [
      {
        question: 'why did the team choose the calmer illustrations?',
        check: hasAny('calmer', 'illustration', 'design', 'onboarding')
      }
    ]
  },
  {
    id: 'rationale-onboarding-change',
    category: 'rationale',
    turns: [
      {
        question: 'what changed with the onboarding copy?',
        check: hasAny('rewrote', 'rewrite', 'copy', 'onboarding', 'design')
      }
    ]
  },
  {
    id: 'rationale-roadmap-key-decision',
    category: 'rationale',
    turns: [
      {
        question: 'what is the key decision from the roadmap review?',
        check: hasAny('q3', 'sequenc', 'roadmap', 'locked', 'milestone')
      }
    ]
  },

  // ---- Status / blockers / priority --------------------------------------
  {
    id: 'status-most-pressing',
    category: 'status',
    turns: [
      {
        question: 'what is the most pressing item I need to handle?',
        check: hasAny('escalation', 'casey', 'priority', 'customer', 'follow')
      }
    ]
  },
  {
    id: 'status-blocking-launch',
    category: 'status',
    turns: [
      {
        question: 'is anything blocking the launch?',
        check: hasAny('oauth', 'consent', 'calendar', 'launch', 'scope')
      }
    ]
  },
  {
    id: 'status-left-before-launch',
    category: 'status',
    turns: [
      {
        question: "what's left to do before launch?",
        check: hasAny('oauth', 'consent', 'calendar', 'escalation', 'follow', 'scope')
      }
    ]
  },
  {
    id: 'status-queue',
    category: 'status',
    turns: [
      {
        question: 'what is the status of the priority customer queue?',
        check: hasAny('escalation', 'casey', 'follow', 'customer', 'queue')
      }
    ]
  },

  // ---- Formatting requests -----------------------------------------------
  {
    id: 'format-roadmap-bullets',
    category: 'formatting',
    turns: [
      {
        question: 'give me the roadmap review as bullet points',
        check: hasAny('q3', 'roadmap', 'priya', 'milestone', 'sequenc')
      }
    ]
  },
  {
    id: 'format-support-checklist',
    category: 'formatting',
    turns: [
      {
        question: 'show the support action items as a checklist',
        check: hasAny('escalation', 'casey', 'follow', 'customer')
      }
    ]
  },

  // ---- Cross-meeting / aggregate -----------------------------------------
  {
    id: 'aggregate-main-topics',
    category: 'aggregate',
    turns: [
      {
        question: 'what are the main topics across my recordings?',
        check: hasAny('roadmap', 'support', 'design', 'oauth', 'onboarding', 'escalation')
      }
    ]
  },
  {
    id: 'aggregate-rundown',
    category: 'aggregate',
    turns: [
      {
        question: 'give me a quick rundown of everything I recorded',
        check: hasAny('roadmap', 'support', 'design', 'onboarding', 'escalation', 'oauth')
      }
    ]
  },
  {
    id: 'aggregate-which-about-design',
    category: 'aggregate',
    turns: [
      {
        question: 'which recordings are about design?',
        check: hasAny('design', 'onboarding', 'illustration', 'copy')
      }
    ]
  },

  // ---- Capability boundaries (must decline, not pretend) -----------------
  {
    id: 'cap-delete',
    category: 'capability',
    turns: [{ question: 'can you delete the support triage recording?', check: declines }]
  },
  {
    id: 'cap-email',
    category: 'capability',
    turns: [{ question: 'can you email the roadmap summary to my team?', check: declines }]
  },
  {
    id: 'cap-schedule',
    category: 'capability',
    turns: [
      {
        question: 'can you schedule a follow-up meeting for me?',
        check: all(nonEmpty, hasAny("can't", 'cannot', 'unable', 'not able', 'calendar', 'sorry'))
      }
    ]
  },

  // ---- Out-of-scope (fresh) ----------------------------------------------
  {
    id: 'oos-weather',
    category: 'out-of-scope',
    turns: [
      {
        question: 'what is the weather like today?',
        check: all(
          nonEmpty,
          hasAny(
            'weather',
            'meeting',
            'recording',
            'calendar',
            "don't",
            "can't",
            'cannot',
            'not able',
            'focus',
            'help you with',
            'unable'
          )
        )
      }
    ]
  },
  {
    id: 'oos-translate',
    category: 'out-of-scope',
    turns: [
      {
        question: 'how do you say hello in Spanish?',
        check: all(
          nonEmpty,
          hasAny('hola', 'meeting', 'recording', "don't", 'cannot', 'focus', 'help you with')
        )
      }
    ]
  },

  // ---- Anti-fabrication (fresh subjects) ---------------------------------
  {
    id: 'fab-hiring',
    category: 'grounding',
    turns: [
      {
        question: 'what did we decide about hiring?',
        check: all(expressesAbsence, lacks('q3', 'casey', 'onboarding', 'oauth'))
      }
    ]
  },
  {
    id: 'fab-mobile-app',
    category: 'grounding',
    turns: [
      {
        question: 'who is leading the mobile app project?',
        check: all(expressesAbsence, lacks('priya', 'casey'))
      }
    ]
  },
  {
    id: 'fab-marketing-budget',
    category: 'grounding',
    turns: [{ question: 'what is our marketing budget?', check: expressesAbsence }]
  },
  {
    id: 'fab-sarah',
    category: 'grounding',
    turns: [
      {
        question: 'what did Sarah commit to in her meeting?',
        check: all(expressesAbsence, lacks('casey', 'priya'))
      }
    ]
  },
  {
    id: 'fab-qa-results',
    category: 'grounding',
    turns: [{ question: 'summarize the QA test results for me', check: expressesAbsence }]
  },

  // ---- Quantity / extraction (fresh) -------------------------------------
  {
    id: 'extract-design-biggest',
    category: 'extraction',
    turns: [
      {
        question: 'what is the single biggest takeaway from the design sync?',
        check: hasAny('onboarding', 'illustration', 'copy', 'calmer', 'design')
      }
    ]
  },
  {
    id: 'extract-roadmap-three',
    category: 'extraction',
    turns: [
      {
        question: 'give me three things from the roadmap review',
        check: hasAny('q3', 'roadmap', 'priya', 'milestone', 'sequenc')
      }
    ]
  },

  // ---- Sentiment / inference ---------------------------------------------
  {
    id: 'infer-most-urgent',
    category: 'inference',
    turns: [
      {
        question: 'which meeting sounds the most urgent?',
        check: hasAny('support', 'escalation', 'priority', 'customer')
      }
    ]
  },

  // ---- First-turn ambiguity (no antecedent) ------------------------------
  {
    id: 'ambig-summarize-it',
    category: 'ambiguity',
    turns: [
      {
        question: 'can you summarize it?',
        check: all(
          nonEmpty,
          hasAny(
            'which',
            'recordings',
            'list',
            'four',
            '4',
            'roadmap',
            'support',
            'design',
            'specify'
          )
        )
      }
    ]
  },

  // ---- Misc realistic single-turns ---------------------------------------
  {
    id: 'misc-remind-design',
    category: 'recall',
    turns: [
      {
        question: 'remind me what the design sync was about',
        check: hasAny('onboarding', 'illustration', 'copy', 'design')
      }
    ]
  },
  {
    id: 'misc-priya-tracker',
    category: 'existence',
    turns: [
      {
        question: 'did Priya mention the milestone tracker?',
        check: hasAny('milestone', 'tracker', 'priya', 'roadmap')
      }
    ]
  },
  {
    id: 'misc-oauth-work',
    category: 'recall',
    turns: [
      {
        question: 'tell me about the OAuth work',
        check: hasAny('oauth', 'consent', 'scope', 'calendar', 'launch')
      }
    ]
  },
  {
    id: 'misc-prioritize',
    category: 'status',
    turns: [
      {
        question: 'what should I prioritize from these meetings?',
        check: hasAny('escalation', 'casey', 'oauth', 'consent', 'priority', 'follow')
      }
    ]
  },
  {
    id: 'misc-compare-two',
    category: 'comparison',
    turns: [
      {
        question: 'what is the difference between the roadmap review and the design sync?',
        check: all(
          hasAny('q3', 'roadmap', 'priya', 'milestone', 'sequenc'),
          hasAny('onboarding', 'illustration', 'copy', 'design')
        )
      }
    ]
  },

  // ---- Smalltalk / meta (fresh phrasings) --------------------------------
  {
    id: 'meta-whats-your-name',
    category: 'smalltalk',
    turns: [
      {
        question: "what's your name?",
        check: hasAny('autodoc', 'assistant', 'meeting', 'help', 'notes', 'recording')
      }
    ]
  },
  {
    id: 'meta-how-do-i-use',
    category: 'smalltalk',
    turns: [
      {
        question: 'how should I use you?',
        check: hasAny('meeting', 'recording', 'note', 'calendar', 'ask', 'action item', 'summar')
      }
    ]
  },

  {
    id: 'person-who-to-talk-escalation',
    category: 'person',
    turns: [{ question: 'who should I talk to about the escalation?', check: has('casey') }]
  },

  // ---- Multi-turn coreference (new phrasings vs the engineered matrix) ----
  {
    id: 'coref-thats-for',
    category: 'coreference',
    turns: [
      { question: 'who owns the escalation follow-up?', check: () => true },
      {
        question: "what's that for?",
        check: hasAny('customer', 'queue', 'priority', 'escalation')
      }
    ]
  },
  {
    id: 'coref-whos-driving-it',
    category: 'coreference',
    turns: [
      { question: 'summarize the roadmap review', check: () => true },
      { question: "who's driving it?", check: has('priya') }
    ]
  },
  {
    id: 'coref-and-the-design-sync',
    category: 'coreference',
    turns: [
      { question: 'what was decided about the roadmap?', check: () => true },
      {
        question: 'what about the design sync?',
        check: hasAny('onboarding', 'illustration', 'copy', 'design')
      }
    ]
  },
  {
    id: 'coref-when-does-that-need-done',
    category: 'coreference',
    turns: [
      { question: 'what is Casey responsible for?', check: () => true },
      {
        question: 'when does that need to be done?',
        check: hasAny('friday', 'due', 'deadline')
      }
    ]
  },

  // ---- Acknowledgement (fresh phrasings) ---------------------------------
  {
    id: 'ack-perfect-thats-all',
    category: 'acknowledgement',
    turns: [
      { question: 'list my recordings', check: () => true },
      { question: "perfect, that's all I needed", check: all(nonEmpty, shortReply(220)) }
    ]
  },
  {
    id: 'ack-got-it-thanks',
    category: 'acknowledgement',
    turns: [
      { question: 'how many recordings do I have?', check: () => true },
      { question: 'got it, thanks a lot', check: all(nonEmpty, shortReply(200)) }
    ]
  }
]
