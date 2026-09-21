import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OLLAMA_MODEL,
  LEGACY_OLLAMA_MODEL,
  LOW_SPEC_MAC_OLLAMA_MODEL
} from '../../../shared/constants'
import {
  isModelInstalled,
  resolveNotesModelMigration,
  shouldOfferNotesEngineUpgradeBanner
} from '../notes-model-migration'

describe('notes-model-migration', () => {
  it('treats tagged names as installed', () => {
    expect(isModelInstalled(['qwen3:4b-instruct:latest'], DEFAULT_OLLAMA_MODEL)).toBe(true)
    expect(isModelInstalled(['llama3.1:latest'], LEGACY_OLLAMA_MODEL)).toBe(true)
    expect(isModelInstalled(['llama3.2:3b'], LEGACY_OLLAMA_MODEL)).toBe(false)
  })

  it('uses Qwen and deletes leftover llama when Qwen is already on disk', () => {
    expect(
      resolveNotesModelMigration({
        preferredModel: DEFAULT_OLLAMA_MODEL,
        installedModels: ['qwen3:4b-instruct', 'llama3.1', 'llama3.2:3b']
      })
    ).toEqual({
      activeModel: DEFAULT_OLLAMA_MODEL,
      pullModel: DEFAULT_OLLAMA_MODEL,
      leftoverModels: [LEGACY_OLLAMA_MODEL, LOW_SPEC_MAC_OLLAMA_MODEL],
      pullBeforeReady: false,
      usingLegacyFallback: false
    })
  })

  it('keeps llama until Qwen lands, then pulls Qwen in the background', () => {
    expect(
      resolveNotesModelMigration({
        preferredModel: DEFAULT_OLLAMA_MODEL,
        installedModels: ['llama3.1:latest']
      })
    ).toEqual({
      activeModel: LEGACY_OLLAMA_MODEL,
      pullModel: DEFAULT_OLLAMA_MODEL,
      leftoverModels: [],
      pullBeforeReady: false,
      usingLegacyFallback: true
    })
  })

  it('blocks ready on a new install until Qwen is pulled', () => {
    expect(
      resolveNotesModelMigration({
        preferredModel: DEFAULT_OLLAMA_MODEL,
        installedModels: []
      })
    ).toEqual({
      activeModel: DEFAULT_OLLAMA_MODEL,
      pullModel: DEFAULT_OLLAMA_MODEL,
      leftoverModels: [],
      pullBeforeReady: true,
      usingLegacyFallback: false
    })
  })

  it('never pulls Qwen on the 8 GB profile', () => {
    expect(
      resolveNotesModelMigration({
        preferredModel: LOW_SPEC_MAC_OLLAMA_MODEL,
        installedModels: ['llama3.1']
      })
    ).toEqual({
      activeModel: LOW_SPEC_MAC_OLLAMA_MODEL,
      pullModel: LOW_SPEC_MAC_OLLAMA_MODEL,
      leftoverModels: [],
      pullBeforeReady: true,
      usingLegacyFallback: false
    })
  })

  it('hides the upgrade banner for new installs and 8 GB Macs', () => {
    expect(
      shouldOfferNotesEngineUpgradeBanner({
        onboardingComplete: true,
        isLowSpec: false,
        preferredModel: DEFAULT_OLLAMA_MODEL,
        installedModels: [DEFAULT_OLLAMA_MODEL],
        readyDismissed: false,
        upgradeEligible: false
      })
    ).toBe(false)

    expect(
      shouldOfferNotesEngineUpgradeBanner({
        onboardingComplete: true,
        isLowSpec: true,
        preferredModel: LOW_SPEC_MAC_OLLAMA_MODEL,
        installedModels: [],
        readyDismissed: false,
        upgradeEligible: true
      })
    ).toBe(false)
  })

  it('shows the upgrade banner while an updater is still on leftover llama', () => {
    expect(
      shouldOfferNotesEngineUpgradeBanner({
        onboardingComplete: true,
        isLowSpec: false,
        preferredModel: DEFAULT_OLLAMA_MODEL,
        installedModels: [LEGACY_OLLAMA_MODEL],
        readyDismissed: false,
        upgradeEligible: false
      })
    ).toBe(true)
  })
})
