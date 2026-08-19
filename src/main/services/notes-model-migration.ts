import {
  DEFAULT_OLLAMA_MODEL,
  LEGACY_OLLAMA_MODEL,
  LOW_SPEC_MAC_OLLAMA_MODEL
} from '../../shared/constants'

export interface NotesModelMigrationInput {
  preferredModel: string
  installedModels: readonly string[]
  legacyModel?: string
  lowSpecModel?: string
}

export interface NotesModelMigrationPlan {
  activeModel: string
  pullModel: string
  leftoverModels: string[]
  /** True when no usable notes model is on disk yet — block ready until pull finishes. */
  pullBeforeReady: boolean
  usingLegacyFallback: boolean
}

export function modelTagMatches(installed: string, wanted: string): boolean {
  if (installed === wanted) return true
  return installed.startsWith(`${wanted}:`)
}

export function isModelInstalled(installedModels: readonly string[], wanted: string): boolean {
  return installedModels.some((name) => modelTagMatches(name, wanted))
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.filter((model) => model.trim().length > 0))]
}

export function resolveNotesModelMigration(
  input: NotesModelMigrationInput
): NotesModelMigrationPlan {
  const preferred = input.preferredModel.trim() || DEFAULT_OLLAMA_MODEL
  const legacy = input.legacyModel ?? LEGACY_OLLAMA_MODEL
  const lowSpec = input.lowSpecModel ?? LOW_SPEC_MAC_OLLAMA_MODEL
  const installed = input.installedModels
  const hasPreferred = isModelInstalled(installed, preferred)
  const hasLegacy = isModelInstalled(installed, legacy)
  const isLowSpecPreferred = modelTagMatches(preferred, lowSpec) || preferred === lowSpec

  if (isLowSpecPreferred) {
    return {
      activeModel: preferred,
      pullModel: preferred,
      leftoverModels: hasPreferred ? uniqueModels([legacy]) : [],
      pullBeforeReady: !hasPreferred,
      usingLegacyFallback: false
    }
  }

  if (hasPreferred) {
    return {
      activeModel: preferred,
      pullModel: preferred,
      leftoverModels: uniqueModels([legacy, lowSpec]),
      pullBeforeReady: false,
      usingLegacyFallback: false
    }
  }

  if (hasLegacy) {
    return {
      activeModel: legacy,
      pullModel: preferred,
      leftoverModels: [],
      pullBeforeReady: false,
      usingLegacyFallback: true
    }
  }

  return {
    activeModel: preferred,
    pullModel: preferred,
    leftoverModels: [],
    pullBeforeReady: true,
    usingLegacyFallback: false
  }
}

export function shouldOfferNotesEngineUpgradeBanner(input: {
  onboardingComplete: boolean
  isLowSpec: boolean
  preferredModel: string
  installedModels: readonly string[]
  readyDismissed: boolean
  upgradeEligible: boolean
}): boolean {
  if (!input.onboardingComplete || input.isLowSpec) return false
  if (input.preferredModel === LOW_SPEC_MAC_OLLAMA_MODEL) return false
  if (input.readyDismissed && isModelInstalled(input.installedModels, input.preferredModel)) {
    return false
  }
  return (
    input.upgradeEligible ||
    isModelInstalled(input.installedModels, LEGACY_OLLAMA_MODEL) ||
    !isModelInstalled(input.installedModels, input.preferredModel)
  )
}
