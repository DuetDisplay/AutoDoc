export const DEFAULT_HOST = '127.0.0.1:11438'
export const DEFAULT_MODEL = 'llama3.1:latest'

export const CONTEXT_8K_TOKENS = 8192
export const CONTEXT_32K_TOKENS = 32768

/** Fixed Phase 3 chunk hierarchy. Do not retune per result. */
export const CHUNK_TARGET_TOKENS = 4000
export const CHUNK_OVERLAP_TOKENS = 400
export const CHUNKING_POLICY_VERSION = 'phase3-fixed-v1'

export const ARM_A_NUM_CTX = CONTEXT_32K_TOKENS
export const ARM_A_NUM_PREDICT = 4096
export const ARM_A_CHUNK_NUM_CTX = CONTEXT_8K_TOKENS
export const ARM_A_CHUNK_NUM_PREDICT = 1024
export const ARM_A_COMBINE_NUM_CTX = 16384
export const ARM_A_COMBINE_NUM_PREDICT = ARM_A_NUM_PREDICT

export const ARM_B_NUM_CTX = 16384
export const ARM_B_NUM_PREDICT = 2048

export const ARM_C_NUM_CTX = CONTEXT_32K_TOKENS
export const ARM_C_NUM_PREDICT = 2048

export const ARM_D_NUM_CTX = 16384
export const ARM_D_NUM_PREDICT = 4096

export const ARM_E_GROUP_NUM_CTX = 8192
export const ARM_E_GROUP_NUM_PREDICT = 1024
export const ARM_E_RESTYLE_NUM_CTX = 8192
export const ARM_E_RESTYLE_NUM_PREDICT = 1024
export const ARM_E_RETRY_SEED = 1337
/** Bumped when Arm E fact/grouping/verifier guards are calibrated. */
export const ARM_E_GUARD_VERSION = 3

export const SMOKE_NUM_CTX = 2048
export const SMOKE_NUM_PREDICT = 10

export const DEFAULT_SEED = 42
export const ALLOWED_TEMPERATURES = [0, 0.4] as const
export type AllowedTemperature = (typeof ALLOWED_TEMPERATURES)[number]

export const STOP_CONDITIONS: readonly string[] = []

/**
 * Single-call if estimated prompt+input+num_predict fits in 32K with this
 * leftover budget. Fixed before any writer run; not tuned per transcript.
 */
export const SINGLE_CALL_LEFTOVER_HEADROOM_TOKENS = 1024

export const INPUT_PROJECTION_DESCRIPTION =
  'Speaker-labeled plaintext turns from decrypted transcript.json; ' +
  'Me/Them labels; meeting title from fixture metadata; timestamps stripped; ' +
  'no user notes; no calendar attendees; no evidence IDs.'

export const ARM_D_INPUT_PROJECTION_DESCRIPTION =
  'Legacy 1.1.1 notes markdown plus a deterministically verified commitment list; ' +
  'not the transcript; no user notes; no calendar attendees; no evidence IDs.'

export const ARM_E_INPUT_PROJECTION_DESCRIPTION =
  'Legacy 1.1.1 MeetingSegments JSON parsed into discrete items; grouping call sees titles/first-lines only; ' +
  'per-topic restyle sees that topic\'s full item texts; Decisions and Next Steps composed in code from ' +
  'legacy buckets plus a deterministically verified extractor list; no user notes; no calendar attendees; no evidence IDs.'

export const ARM_F_NUM_CTX = 8192
export const ARM_F_NUM_PREDICT = 1024
export const ARM_F_RETRY_SEED = 1337
/** Same calibrated number/name guard as Arm E. */
export const ARM_F_GUARD_VERSION = 3
export const ARM_F_WORD_RATIO_PACK = 0.75
export const ARM_F_WORD_RATIO_TARGET = 0.65

export const ARM_F_INPUT_PROJECTION_DESCRIPTION =
  'Passing Arm E candidate markdown; compression sees one topical section at a time; ' +
  'Decisions and Next Steps pass through byte-identical; no user notes; no calendar attendees; no evidence IDs.'

/** Same calibrated number/name guard as Arm E/F. */
export const ARM_G_GUARD_VERSION = 3
export const ARM_G_WORD_RATIO_PACK = 0.75

export const ARM_G_INPUT_PROJECTION_DESCRIPTION =
  'Passing Arm F candidate markdown; deterministic NS/Decision workstream dedup; ' +
  'optional one grouping call if Next Steps stay above 6 items; no user notes; no calendar attendees; no evidence IDs.'

export const ARM_G_GROUP_MODEL = 'qwen3:4b-instruct'
export const ARM_G_GROUP_NUM_CTX = 4096
export const ARM_G_GROUP_NUM_PREDICT = 512
