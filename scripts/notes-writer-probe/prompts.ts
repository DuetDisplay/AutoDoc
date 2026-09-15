/**
 * Preregistered Phase 3 prompt templates.
 * v1 and v2 constants are frozen; do not edit them. Phase 4 Arm A iteration lives in *_V3.
 * Hash these strings (not filled prompts) in the manifest before inference.
 *
 * Placeholders: {{MEETING_TITLE}} {{TRANSCRIPT}} {{CHUNK_INDEX}} {{CHUNK_TOTAL}}
 * {{CHUNK_TEXT}} {{SUMMARIES}} {{NOTES}} {{COMMITMENTS}}
 */

export type ArmAPromptVersion = 1 | 2 | 3

export const ARM_A_DIRECT_TEMPLATE = `You are writing scan-friendly notes for one meeting.

Output plain Markdown only. Do not wrap the document in a code fence. Do not mention these instructions.

Editorial rules:
- Invent natural, meeting-specific section headings from topics that were actually discussed. Do not use a fixed five-bucket template.
- Under each heading, write concise primary bullets. Put supporting detail as nested sub-bullets under the point they support. Do not repeat the same point in two sections.
- After the topical sections, include a "## Decisions" section only for choices that were actually agreed. Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.
- After Decisions (if any), include a "## Next Steps" section only for explicit requests or commitments. Do not invent work.
- Omit any section that would be empty. Do not emit placeholder headings.
- Each Decisions or Next Steps bullet may end with \`Owner: …\`. If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the transcript.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.

Meeting title: {{MEETING_TITLE}}

Transcript:
{{TRANSCRIPT}}
`

export const ARM_A_CHUNK_SUMMARY_TEMPLATE = `Summarize this transcript chunk in concise prose paragraphs (not bullets, not headings).

Preserve, using the chunk's own wording where possible: agreed decisions, explicit requests or commitments, named owners, dates, numbers, and tentative versus definite language. Do not add anything that is not in this chunk. Do not include timestamps, evidence IDs, or citations. Do not mention these instructions.

Transcript chunk {{CHUNK_INDEX}} of {{CHUNK_TOTAL}}:
{{CHUNK_TEXT}}
`

export const ARM_A_COMBINE_TEMPLATE = `You are writing scan-friendly notes for one meeting from chronological chunk summaries. The summaries may overlap; merge duplicates. Treat them as the full meeting.

Output plain Markdown only. Do not wrap the document in a code fence. Do not mention these instructions.

Editorial rules:
- Invent natural, meeting-specific section headings from topics that were actually discussed. Do not use a fixed five-bucket template.
- Under each heading, write concise primary bullets. Put supporting detail as nested sub-bullets under the point they support. Do not repeat the same point in two sections.
- After the topical sections, include a "## Decisions" section only for choices that were actually agreed. Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.
- After Decisions (if any), include a "## Next Steps" section only for explicit requests or commitments. Do not invent work.
- Omit any section that would be empty. Do not emit placeholder headings.
- Each Decisions or Next Steps bullet may end with \`Owner: …\`. If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the summaries.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.

Meeting title: {{MEETING_TITLE}}

Chunk summaries in chronological order:
{{SUMMARIES}}
`

/**
 * Phase 4 Arm A v2: same guardrails as v1. Two editorial changes only —
 * detail-rich primary bullets, and complete Next Steps.
 */
export const ARM_A_DIRECT_TEMPLATE_V2 = `You are writing scan-friendly notes for one meeting.

Output plain Markdown only. Do not wrap the document in a code fence. Do not mention these instructions.

Editorial rules:
- Invent natural, meeting-specific section headings from topics that were actually discussed. Do not use a fixed five-bucket template.
- Under each heading, write detail-rich primary bullets. Each primary bullet must carry the concrete specifics actually said (names, numbers, reasons, constraints), not a one-line abstraction. Put genuinely supporting detail as nested sub-bullets under the point they support. Do not pad with filler. Do not repeat the same point in two sections.
- After the topical sections, include a "## Decisions" section only for choices that were actually agreed. Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.
- After Decisions (if any), include a "## Next Steps" section only for explicit requests or commitments. Do not invent work.
- In Next Steps, include every explicit request or commitment from the meeting. Each bullet must have enough context to act on (what, and for whom or why if stated). Brevity must never drop a commitment.
- Omit any section that would be empty. Do not emit placeholder headings.
- Each Decisions or Next Steps bullet may end with \`Owner: …\`. If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the transcript.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.

Meeting title: {{MEETING_TITLE}}

Transcript:
{{TRANSCRIPT}}
`

export const ARM_A_CHUNK_SUMMARY_TEMPLATE_V2 = `Summarize this transcript chunk in concise prose paragraphs (not bullets, not headings).

Preserve, using the chunk's own wording where possible: agreed decisions, every explicit request or commitment with enough context to act on, named owners, dates, numbers, reasons, constraints, and tentative versus definite language. Do not add anything that is not in this chunk. Do not include timestamps, evidence IDs, or citations. Do not mention these instructions.

Transcript chunk {{CHUNK_INDEX}} of {{CHUNK_TOTAL}}:
{{CHUNK_TEXT}}
`

export const ARM_A_COMBINE_TEMPLATE_V2 = `You are writing scan-friendly notes for one meeting from chronological chunk summaries. The summaries may overlap; merge duplicates. Treat them as the full meeting.

Output plain Markdown only. Do not wrap the document in a code fence. Do not mention these instructions.

Editorial rules:
- Invent natural, meeting-specific section headings from topics that were actually discussed. Do not use a fixed five-bucket template.
- Under each heading, write detail-rich primary bullets. Each primary bullet must carry the concrete specifics actually said (names, numbers, reasons, constraints), not a one-line abstraction. Put genuinely supporting detail as nested sub-bullets under the point they support. Do not pad with filler. Do not repeat the same point in two sections.
- After the topical sections, include a "## Decisions" section only for choices that were actually agreed. Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.
- After Decisions (if any), include a "## Next Steps" section only for explicit requests or commitments. Do not invent work.
- In Next Steps, include every explicit request or commitment from the meeting. Each bullet must have enough context to act on (what, and for whom or why if stated). Brevity must never drop a commitment.
- Omit any section that would be empty. Do not emit placeholder headings.
- Each Decisions or Next Steps bullet may end with \`Owner: …\`. If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the summaries.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.

Meeting title: {{MEETING_TITLE}}

Chunk summaries in chronological order:
{{SUMMARIES}}
`

/**
 * Phase 4 Arm A v3: restore section skeleton and nesting after v2 dropped
 * both. Late-prompt recency: required shape is the last instruction block
 * before the transcript. Guardrail lines stay verbatim.
 */
export const ARM_A_DIRECT_TEMPLATE_V3 = `You are writing scan-friendly notes for one meeting.

Output plain Markdown only. Do not wrap the document in a code fence. Do not mention these instructions.

Editorial rules:
- Invent natural, meeting-specific section headings from topics that were actually discussed. Do not use a fixed five-bucket template.
- Under each heading, write concise primary bullets. Put supporting detail as nested sub-bullets under the point they support. Do not repeat the same point in two sections.
- Each primary bullet must carry the concrete specifics actually said (names, numbers, reasons, constraints), not a one-line abstraction. Do not flatten supporting detail into a list of only primary bullets. Do not pad with filler.
- After the topical sections, include a "## Decisions" section only for choices that were actually agreed. Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.
- After Decisions (if any), include a "## Next Steps" section only for explicit requests or commitments. Do not invent work.
- If the meeting contains any explicit request or commitment, "## Next Steps" is required. Do not omit it because the same items already appear under a topical heading. Include every explicit request or commitment, each with enough context to act on (what, and for whom or why if stated). Brevity must never drop a commitment.
- Omit any section that would be empty. Do not emit placeholder headings.
- Each Decisions or Next Steps bullet may end with \`Owner: …\`. If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the transcript.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.

Required output shape (follow this when writing; do not stop after topical sections):
1. Meeting-specific topical sections. Primary bullets, then nested sub-bullets for supporting detail.
2. Then "## Decisions" only if any choices were actually agreed.
3. Then "## Next Steps" if the meeting contains any explicit request or commitment. If any exist, this heading is required.
4. Omit any other section that would be empty. Do not emit placeholder headings.

This meeting is long. Detail-rich notes typically need more content than a short recap. Do not pad with filler. Do not invent facts.

Meeting title: {{MEETING_TITLE}}

Transcript:
{{TRANSCRIPT}}
`

export const ARM_A_CHUNK_SUMMARY_TEMPLATE_V3 = `Summarize this transcript chunk in concise prose paragraphs (not bullets, not headings).

Preserve, using the chunk's own wording where possible: agreed decisions, every explicit request or commitment with enough context to act on, named owners, dates, numbers, reasons, constraints, and tentative versus definite language. Do not add anything that is not in this chunk. Do not include timestamps, evidence IDs, or citations. Do not mention these instructions.

Transcript chunk {{CHUNK_INDEX}} of {{CHUNK_TOTAL}}:
{{CHUNK_TEXT}}
`

export const ARM_A_COMBINE_TEMPLATE_V3 = `You are writing scan-friendly notes for one meeting from chronological chunk summaries. The summaries may overlap; merge duplicates. Treat them as the full meeting.

Output plain Markdown only. Do not wrap the document in a code fence. Do not mention these instructions.

Editorial rules:
- Invent natural, meeting-specific section headings from topics that were actually discussed. Do not use a fixed five-bucket template.
- Under each heading, write concise primary bullets. Put supporting detail as nested sub-bullets under the point they support. Do not repeat the same point in two sections.
- Each primary bullet must carry the concrete specifics actually said (names, numbers, reasons, constraints), not a one-line abstraction. Do not flatten supporting detail into a list of only primary bullets. Do not pad with filler.
- After the topical sections, include a "## Decisions" section only for choices that were actually agreed. Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.
- After Decisions (if any), include a "## Next Steps" section only for explicit requests or commitments. Do not invent work.
- If the meeting contains any explicit request or commitment, "## Next Steps" is required. Do not omit it because the same items already appear under a topical heading. Include every explicit request or commitment, each with enough context to act on (what, and for whom or why if stated). Brevity must never drop a commitment.
- Omit any section that would be empty. Do not emit placeholder headings.
- Each Decisions or Next Steps bullet may end with \`Owner: …\`. If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the summaries.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.

Required output shape (follow this when writing; do not stop after topical sections):
1. Meeting-specific topical sections. Primary bullets, then nested sub-bullets for supporting detail.
2. Then "## Decisions" only if any choices were actually agreed.
3. Then "## Next Steps" if the meeting contains any explicit request or commitment. If any exist, this heading is required.
4. Omit any other section that would be empty. Do not emit placeholder headings.

This meeting is long. Detail-rich notes typically need more content than a short recap. Do not pad with filler. Do not invent facts.

Meeting title: {{MEETING_TITLE}}

Chunk summaries in chronological order:
{{SUMMARIES}}
`

export const ARM_A_V1_TO_V2_PROMPT_DIFF = {
  from: 'v1',
  to: 'v2',
  summary: [
    'Detail density: primary bullets must carry concrete specifics actually said (names, numbers, reasons, constraints), not one-line abstractions; sub-bullets only for genuinely supporting detail; do not pad with filler.',
    'Next Steps completeness: include every explicit request or commitment, each with enough context to act on (what, and for whom or why if stated). Brevity must never drop a commitment.',
    'Chunk-summary Preserve list expanded to match: every commitment with actable context, plus reasons and constraints.'
  ],
  unchangedGuardrails: [
    'Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.',
    'Do not invent work.',
    'Omit any section that would be empty. Do not emit placeholder headings.',
    'Owner suffix: omit entirely if unstated; never write null; never invent a name, owner, date, number, or deadline.',
    'Do not add any fact, name, number, owner, date, or causal claim that is not in the transcript/summaries.',
    'Do not change tentative language into definite language.',
    'Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.'
  ]
} as const

export const ARM_A_V2_TO_V3_PROMPT_DIFF = {
  from: 'v2',
  to: 'v3',
  summary: [
    'Restored v1 nesting sentence verbatim: concise primary bullets plus supporting detail as nested sub-bullets. Added an explicit do-not-flatten rule.',
    'Next Steps is non-droppable when any explicit request or commitment exists; do not fold those items only into topical sections.',
    'Required output skeleton (topical → Decisions if any → Next Steps if any commitments) restated as the final instruction block before the transcript, for 8B recency.',
    'Soft length cue only: a long meeting typically needs more than a short recap. No hard word/token target. Anti-invention guardrails unchanged and kept verbatim.'
  ],
  unchangedGuardrails: [
    'Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.',
    'Do not invent work.',
    'Omit any section that would be empty. Do not emit placeholder headings.',
    'Owner suffix: omit entirely if unstated; never write null; never invent a name, owner, date, number, or deadline.',
    'Do not add any fact, name, number, owner, date, or causal claim that is not in the transcript/summaries.',
    'Do not change tentative language into definite language.',
    'Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.'
  ]
} as const

export interface ArmATemplateSet {
  direct: { name: string; text: string }
  chunk: { name: string; text: string }
  combine: { name: string; text: string }
}

export function armATemplates(version: ArmAPromptVersion): ArmATemplateSet {
  if (version === 3) {
    return {
      direct: { name: 'ARM_A_DIRECT_TEMPLATE_V3', text: ARM_A_DIRECT_TEMPLATE_V3 },
      chunk: { name: 'ARM_A_CHUNK_SUMMARY_TEMPLATE_V3', text: ARM_A_CHUNK_SUMMARY_TEMPLATE_V3 },
      combine: { name: 'ARM_A_COMBINE_TEMPLATE_V3', text: ARM_A_COMBINE_TEMPLATE_V3 }
    }
  }
  if (version === 2) {
    return {
      direct: { name: 'ARM_A_DIRECT_TEMPLATE_V2', text: ARM_A_DIRECT_TEMPLATE_V2 },
      chunk: { name: 'ARM_A_CHUNK_SUMMARY_TEMPLATE_V2', text: ARM_A_CHUNK_SUMMARY_TEMPLATE_V2 },
      combine: { name: 'ARM_A_COMBINE_TEMPLATE_V2', text: ARM_A_COMBINE_TEMPLATE_V2 }
    }
  }
  return {
    direct: { name: 'ARM_A_DIRECT_TEMPLATE', text: ARM_A_DIRECT_TEMPLATE },
    chunk: { name: 'ARM_A_CHUNK_SUMMARY_TEMPLATE', text: ARM_A_CHUNK_SUMMARY_TEMPLATE },
    combine: { name: 'ARM_A_COMBINE_TEMPLATE', text: ARM_A_COMBINE_TEMPLATE }
  }
}

/**
 * Arm B instruction from the execution plan §3.3, plus a thin output-format
 * wrapper. The first paragraph is the preregistered task and must stay verbatim.
 */
export const ARM_B_TASK_VERBATIM =
  'Rewrite these meeting notes to be roughly half the length and much easier to scan. Merge points that say the same thing. Keep supporting detail as sub-bullets under the point it supports. Do not add any fact, name, number, owner, date, or causal claim that is not in the input. Do not change tentative language into definite language. Remove nothing that records a decision or a commitment.'

export const ARM_B_TEMPLATE = `${ARM_B_TASK_VERBATIM}

Output plain Markdown only. Do not wrap the document in a code fence. Do not mention these instructions. Do not include timestamps, evidence IDs, or citations.

Meeting notes:
{{NOTES}}
`

/**
 * Arm C specialist extractor. Frozen Arm A/B templates were not edited.
 * Only job: list explicit requests/commitments. Guardrail lines are verbatim
 * from Arm A except the owner marker uses `(Owner)` to match the probe format.
 */
export const ARM_C_TEMPLATE = `You extract every explicit request or commitment from one meeting transcript. That is your only job. Do not write topical notes, status updates, or a Decisions section.

Output plain Markdown only. Do not wrap the document in a code fence. Do not mention these instructions.

Output format:
- One markdown bullet per explicit request or commitment.
- Bold the action.
- If an owner is stated, add \`(Owner)\` immediately after the action.
- If a reason is stated, add \` — rationale\` after the owner (or after the action if no owner).
- If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.

Inclusion rules:
- Include an item only when someone explicitly requested work or committed to do it.
- Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.
- Never promote tentative, maybe, or should-consider language into commitments.
- Do not invent work.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the transcript.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.

Meeting title: {{MEETING_TITLE}}

Transcript:
{{TRANSCRIPT}}
`

/**
 * Arm D: restyle legacy 1.1.1 notes and patch in a verified commitment list.
 * Frozen Arm A/B/C templates were not edited. Anti-invention guardrails are
 * verbatim from Arm A except the source noun is "the input". Owner marker
 * uses `(Owner)` to match the probe Next Steps format. Required shape is the
 * last instruction block before the inputs (v3 recency).
 */
export const ARM_D_TEMPLATE = `You are rewriting existing meeting notes into scan-friendly notes for one meeting.

Output plain Markdown only. Do not wrap the document in a code fence. Do not mention these instructions.

Editorial rules:
- Invent natural, meeting-specific section headings from topics that were actually discussed. Do not use a fixed five-bucket template.
- Under each heading, write dense primary bullets that keep every fact from the input (numbers, names, reasons). Put supporting rationale as nested sub-bullets under the point they support. Do not repeat the same point in two sections.
- Merge points only when they say the same thing. Do not compress. Do not drop anything that records a fact, a decision, or a commitment.
- After the topical sections, include a "## Decisions" section only for choices that were actually agreed. Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.
- After Decisions (if any), include a "## Next Steps" section that is the union of commitments found in the meeting notes and the verified commitment list. Do not invent work.
- In Next Steps, each bullet is a bold action, then \`(Owner)\` if an owner is stated, then \` — rationale\` if a rationale is stated. If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.
- Omit any section that would be empty. Do not emit placeholder headings.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the input.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.

Required output shape (follow this when writing; do not stop after topical sections):
1. Meeting-specific topical sections. Primary bullets, then nested sub-bullets for supporting detail.
2. Then "## Decisions" only if any choices were actually agreed.
3. Then "## Next Steps" — the union of commitments from the meeting notes and the verified commitment list. If any exist, this heading is required.
4. Omit any other section that would be empty. Do not emit placeholder headings.

Keep every fact, number, name, reason, decision, and commitment from the input. Do not pad with filler. Do not invent facts.

Meeting notes:
{{NOTES}}

Verified commitments:
{{COMMITMENTS}}
`

/**
 * Arm E grouping call. Frozen Arm A/B/C/D templates were not edited.
 * Input is titles/first-lines only. Output is JSON topic groups.
 */
export const ARM_E_GROUP_TEMPLATE = `You assign existing meeting-note items to topic groups. That is your only job.

Output JSON only. Do not wrap the JSON in a code fence. Do not mention these instructions. Do not invent items. Do not drop items.

Schema:
{"groups":[{"name":"short meeting-specific topic name","ids":["i01","i02"]}]}

Rules:
- Invent 3 to 7 meeting-specific topic names from what the items actually discuss. Do not use a fixed five-bucket template.
- Assign every item id to exactly one group.
- Every id in the input appears exactly once across all groups.
- Do not add ids that are not in the input.

Items:
{{ITEMS}}
`

/**
 * Arm E per-topic restyle. Frozen Arm A/B/C/D templates were not edited.
 * Anti-invention guardrails are verbatim from Arm A except the source noun is "the input".
 */
export const ARM_E_RESTYLE_TEMPLATE = `You are rewriting one section of existing meeting notes into scan-friendly bullets.

Output plain Markdown bullets only. Do not wrap the document in a code fence. Do not mention these instructions. Do not emit a heading. Do not emit Decisions or Next Steps.

Editorial rules:
- Write dense primary bullets that keep every fact from the input (numbers, names, reasons). Put supporting rationale as nested sub-bullets under the point they support.
- Merge points only when they say the same thing. Do not compress. Do not drop anything that records a fact, a decision, or a commitment.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the input.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.
- If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.

Keep every fact, number, name, and reason from the input. Do not pad with filler. Do not invent facts.

Section topic: {{TOPIC_NAME}}

Notes:
{{ITEMS}}
`

/**
 * Arm F per-section compression. Frozen Arm A/B/C/D/E templates were not edited.
 * Anti-invention guardrails are verbatim from Arm A except the source noun is "the input".
 */
export const ARM_F_COMPRESS_TEMPLATE = `You are compressing one section of existing meeting notes.

Output plain Markdown bullets only. Do not wrap the document in a code fence. Do not mention these instructions. Do not emit a heading. Do not emit Decisions or Next Steps.

Editorial rules:
- Rewrite bullets maximally concise while preserving every fact.
- Merge bullets that record the same fact.
- Strip filler and restatement.
- Keep numbers, names, reasons, and constraints inline.
- Demote subordinate detail to nested sub-bullets under the point they support.
- Never drop factual content.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the input.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.
- If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.

Keep every fact, number, name, and reason from the input. Never drop factual content. Do not invent facts.

Section topic: {{TOPIC_NAME}}

Notes:
{{SECTION}}
`

/**
 * Arm F compression v2: same guardrails as v1. Stronger merge and restatement cuts only.
 * Frozen v1 string was not edited.
 */
export const ARM_F_COMPRESS_TEMPLATE_V2 = `You are compressing one section of existing meeting notes.

Output plain Markdown bullets only. Do not wrap the document in a code fence. Do not mention these instructions. Do not emit a heading. Do not emit Decisions or Next Steps.

Editorial rules:
- Rewrite bullets maximally concise while preserving every fact.
- Merge bullets that record the same topic into one primary bullet. Nested sub-bullets hold supporting detail. Do not leave parallel bullets that restate the same subject.
- Strip filler and restatement. Cut restated reasons, duplicated constraints, and repeated setup once the fact is already recorded.
- Keep numbers, names, reasons, and constraints inline.
- Demote subordinate detail to nested sub-bullets under the point they support.
- Never drop factual content.
- Do not add any fact, name, number, owner, date, or causal claim that is not in the input.
- Do not change tentative language into definite language.
- Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.
- If the owner is not stated, omit the owner suffix entirely. Never write \`null\`. Never invent a name, owner, date, number, or deadline.

Keep every fact, number, name, and reason from the input. Never drop factual content. Do not invent facts. Merge same-topic bullets. Cut restatement.

Section topic: {{TOPIC_NAME}}

Notes:
{{SECTION}}
`

/**
 * Arm G optional Next Steps workstream grouping. Frozen after first use.
 * Used only when deterministic clustering leaves more than 6 Next Steps.
 */
export const ARM_G_NS_GROUP_TEMPLATE = `You assign existing Next Steps items to workstream groups. That is your only job.

Output JSON only. Do not wrap the JSON in a code fence. Do not mention these instructions. Do not invent items. Do not drop items.

Schema:
{"groups":[{"name":"short deliverable name","ids":["n01","n02"]}]}

Rules:
- Group items that are steps toward the SAME deliverable or workstream. One group per deliverable.
- Prefer fewer groups when items share a concrete object (notes refactor, email campaign, a named PR).
- Do not group items that only share a generic verb such as review, add, implement, or investigate.
- Assign every item id to exactly one group.
- Every id in the input appears exactly once across all groups.
- Do not add ids that are not in the input.

Items:
{{ITEMS}}
`

export const SMOKE_PROMPT = 'Reply with the single word: ready'

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => {
    if (!(key in values)) {
      throw new Error(`Prompt template missing placeholder value: ${key}`)
    }
    return values[key]
  })
}
