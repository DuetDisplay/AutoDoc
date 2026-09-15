import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { planArmA, planArmACombine, armAPromptTokensWithoutTranscript } from './arm-a.ts'
import { loadArmBInput, planArmB } from './arm-b.ts'
import { planArmC, armCPromptTokensWithoutTranscript } from './arm-c.ts'
import { loadArmDCommitments, loadArmDNotes, planArmD } from './arm-d.ts'
import {
  armERetrySeed,
  catalogStats,
  planArmEGroup,
  planArmERestyle,
  catalogTextById,
  containsCatalogItemId,
  splitLegacyItems,
  type ArmECallPlan
} from './arm-e.ts'
import {
  armFRetrySeed,
  joinNotesDocument,
  judgeCompression,
  passthroughRaw,
  planArmFCompress,
  reconstructWith,
  sectionBody,
  splitNotesDocument,
  stripEmittedHeading,
  type ArmFCallPlan
} from './arm-f.ts'
import {
  applyArmGAsync,
  evaluateArmGGates,
  formatGateMarkdown,
  nsCatalogId,
  parseWorkstreamGroupingJson,
  planArmGNsGroup,
  stripCatalogItemIds,
  workstreamGroupsToIndices,
  type ActionItem
} from './arm-g.ts'
import { parseRunArgs, UsageError, type RunOptions } from './cli.ts'
import { composeDocument, renderUnrestyledItems, unionNextSteps } from './compose.ts'
import {
  ARM_A_NUM_PREDICT,
  ARM_C_NUM_PREDICT,
  ARM_E_GUARD_VERSION,
  ARM_F_GUARD_VERSION,
  ARM_F_WORD_RATIO_PACK,
  ARM_F_WORD_RATIO_TARGET,
  ARM_G_GROUP_MODEL,
  ARM_G_GUARD_VERSION,
  ARM_G_INPUT_PROJECTION_DESCRIPTION,
  DEFAULT_SEED,
  STOP_CONDITIONS
} from './constants.ts'
import { parseCoverageKey, scoreCoverage } from './coverage.ts'
import { extraFacts, factsPass, missingFacts } from './facts.ts'
import { fallbackBucketGroups, parseGroupingJson, type CatalogItem, type TopicGroup } from './groups.ts'
import { sha256Utf8 } from './hash.ts'
import {
  buildManifest,
  ensureNewPrivateOutputDir,
  writeManifestFile,
  type WriterManifest
} from './manifest.ts'
import { OllamaClient, type GenerateResult, type OllamaTimings } from './ollama-client.ts'
import { sanitizeMarkdown, shapeIssues } from './sanitize.ts'
import { countWords } from './tokens.ts'
import { loadFixtureProjection } from './transcript-projection.ts'
import { renderVerifiedMarkdown, verifyCommitments } from './verify-commitments.ts'

function worktreeFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
}

async function writePrivate(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { mode: 0o600 })
  await chmod(filePath, 0o600)
}

function printInspect(label: string, record: Record<string, unknown>): void {
  process.stdout.write(`${label}\n${JSON.stringify(record, null, 2)}\n`)
}

async function writeCallArtifacts(
  output: string,
  prefix: string,
  result: GenerateResult
): Promise<void> {
  await writePrivate(path.join(output, `${prefix}.raw.jsonl`), result.rawBody)
  await writePrivate(
    path.join(output, `${prefix}.timings.json`),
    `${JSON.stringify(result.timings, null, 2)}\n`
  )
}

function summarizeTimings(label: string, timings: OllamaTimings): Record<string, unknown> {
  return {
    label,
    wallClockMs: timings.wallClockMs,
    loadDurationMs: timings.loadDurationMs,
    promptEvalDurationMs: timings.promptEvalDurationMs,
    evalDurationMs: timings.evalDurationMs,
    totalDurationMs: timings.totalDurationMs,
    promptEvalCount: timings.promptEvalCount,
    evalCount: timings.evalCount,
    doneReason: timings.doneReason
  }
}

async function runArmA(options: RunOptions): Promise<void> {
  if (!options.fixture) throw new UsageError('Arm A requires `--fixture`')
  const projection = await loadFixtureProjection(
    options.fixture,
    armAPromptTokensWithoutTranscript(options.promptVersion),
    ARM_A_NUM_PREDICT
  )
  const plan = planArmA(projection, options.temperature, options.promptVersion, options.seed)
  const inspectRecord = {
    arm: 'a',
    temperature: options.temperature,
    promptVersion: options.promptVersion,
    seed: options.seed,
    mode: plan.mode,
    callCount: plan.mode === 'single-call' ? 1 : plan.calls.length + 1,
    projection: projection.stats,
    templates: plan.calls.map((item) => ({
      role: item.role,
      templateName: item.templateName,
      templateSha256: item.templateSha256,
      filledPromptSha256: item.filledPromptSha256
    }))
  }
  if (options.inspect) {
    printInspect('Arm A inspect (no inference)', inspectRecord)
    return
  }
  if (!options.out) throw new UsageError('Writer run requires `--out`')

  const output = await ensureNewPrivateOutputDir(options.out, worktreeFromHere())
  const client = new OllamaClient(options.host)
  const [ollamaVersion, model] = await Promise.all([
    client.version(),
    client.modelIdentity(options.model)
  ])
  const first = plan.calls[0]
  if (!first) throw new Error('Arm A plan produced no calls')
  const manifest: WriterManifest = buildManifest({
    arm: 'a',
    temperature: options.temperature,
    seed: options.seed,
    model,
    ollamaVersion,
    options: first.request.options,
    stopConditions: STOP_CONDITIONS,
    filledPromptSha256: sha256Utf8(plan.calls.map((item) => item.filledPromptSha256).join('\n')),
    projectionStats: projection.stats,
    promptVersion: options.promptVersion
  })
  await writeManifestFile(output, manifest)
  await writePrivate(
    path.join(output, 'inspect.json'),
    `${JSON.stringify(inspectRecord, null, 2)}\n`
  )

  const timingRows: Record<string, unknown>[] = []
  if (plan.mode === 'single-call') {
    const result = await client.generate({
      ...first.request,
      model: options.model,
      stream: options.stream
    })
    await writeCallArtifacts(output, 'call-01-direct', result)
    await writePrivate(
      path.join(output, 'candidate.md'),
      result.text.endsWith('\n') ? result.text : `${result.text}\n`
    )
    timingRows.push(summarizeTimings('direct', result.timings))
  } else {
    const summaries: string[] = []
    for (const [index, item] of plan.calls.entries()) {
      const result = await client.generate({
        ...item.request,
        model: options.model,
        stream: options.stream
      })
      const seq = String(index + 1).padStart(2, '0')
      await writeCallArtifacts(output, `call-${seq}-chunk`, result)
      summaries.push(result.text)
      timingRows.push(summarizeTimings(`chunk-${seq}`, result.timings))
    }
    const combine = planArmACombine(
      projection,
      options.temperature,
      summaries,
      options.promptVersion,
      options.seed
    )
    const combined = await client.generate({
      ...combine.request,
      model: options.model,
      stream: options.stream
    })
    await writeCallArtifacts(output, 'call-combine', combined)
    await writePrivate(
      path.join(output, 'combine-filled-prompt.sha256'),
      `${combine.filledPromptSha256}\n`
    )
    await writePrivate(
      path.join(output, 'candidate.md'),
      combined.text.endsWith('\n') ? combined.text : `${combined.text}\n`
    )
    timingRows.push(summarizeTimings('combine', combined.timings))
  }
  await writePrivate(path.join(output, 'timings.json'), `${JSON.stringify(timingRows, null, 2)}\n`)
  process.stdout.write(
    `Arm A run complete. Calls: ${timingRows.length}. performanceEligible=false.\n`
  )
}

async function runArmB(options: RunOptions): Promise<void> {
  if (!options.input) throw new UsageError('Arm B requires `--input`')
  const notes = await loadArmBInput(options.input)
  const plan = planArmB(notes, options.temperature)
  const inspectRecord = {
    arm: 'b',
    temperature: options.temperature,
    mode: plan.mode,
    inputCharCount: plan.inputCharCount,
    inputWordCount: plan.inputWordCount,
    inputEstimatedTokens: plan.inputEstimatedTokens,
    templateSha256: plan.templateSha256,
    filledPromptSha256: plan.filledPromptSha256,
    options: plan.request.options
  }
  if (options.inspect) {
    printInspect('Arm B inspect (no inference)', inspectRecord)
    return
  }
  if (!options.out) throw new UsageError('Writer run requires `--out`')

  const output = await ensureNewPrivateOutputDir(options.out, worktreeFromHere())
  const client = new OllamaClient(options.host)
  const [ollamaVersion, model] = await Promise.all([
    client.version(),
    client.modelIdentity(options.model)
  ])
  const manifest = buildManifest({
    arm: 'b',
    temperature: options.temperature,
    seed: DEFAULT_SEED,
    model,
    ollamaVersion,
    options: plan.request.options,
    stopConditions: STOP_CONDITIONS,
    filledPromptSha256: plan.filledPromptSha256,
    projectionStats: {
      description: 'V3 candidate markdown (B2), not the transcript',
      inputCharCount: plan.inputCharCount,
      inputWordCount: plan.inputWordCount,
      inputEstimatedTokens: plan.inputEstimatedTokens,
      mode: 'single-call'
    }
  })
  await writeManifestFile(output, manifest)
  await writePrivate(
    path.join(output, 'inspect.json'),
    `${JSON.stringify(inspectRecord, null, 2)}\n`
  )
  const result = await client.generate({
    ...plan.request,
    model: options.model,
    stream: options.stream
  })
  await writeCallArtifacts(output, 'call-01-compress', result)
  await writePrivate(
    path.join(output, 'candidate.md'),
    result.text.endsWith('\n') ? result.text : `${result.text}\n`
  )
  await writePrivate(
    path.join(output, 'timings.json'),
    `${JSON.stringify([summarizeTimings('compress', result.timings)], null, 2)}\n`
  )
  process.stdout.write('Arm B run complete. Calls: 1. performanceEligible=false.\n')
}

async function runArmC(options: RunOptions): Promise<void> {
  if (!options.fixture) throw new UsageError('Arm C requires `--fixture`')
  const projection = await loadFixtureProjection(
    options.fixture,
    armCPromptTokensWithoutTranscript(),
    ARM_C_NUM_PREDICT
  )
  const plan = planArmC(projection, options.temperature, options.seed)
  const inspectRecord = {
    arm: 'c',
    temperature: options.temperature,
    seed: options.seed,
    mode: plan.mode,
    callCount: 1,
    projection: projection.stats,
    templates: [
      {
        role: 'extract',
        templateName: plan.templateName,
        templateSha256: plan.templateSha256,
        filledPromptSha256: plan.filledPromptSha256
      }
    ]
  }
  if (options.inspect) {
    printInspect('Arm C inspect (no inference)', inspectRecord)
    return
  }
  if (!options.out) throw new UsageError('Writer run requires `--out`')

  const output = await ensureNewPrivateOutputDir(options.out, worktreeFromHere())
  const client = new OllamaClient(options.host)
  const [ollamaVersion, model] = await Promise.all([
    client.version(),
    client.modelIdentity(options.model)
  ])
  const manifest: WriterManifest = buildManifest({
    arm: 'c',
    temperature: options.temperature,
    seed: options.seed,
    model,
    ollamaVersion,
    options: plan.request.options,
    stopConditions: STOP_CONDITIONS,
    filledPromptSha256: plan.filledPromptSha256,
    projectionStats: projection.stats
  })
  await writeManifestFile(output, manifest)
  await writePrivate(
    path.join(output, 'inspect.json'),
    `${JSON.stringify(inspectRecord, null, 2)}\n`
  )
  const result = await client.generate({
    ...plan.request,
    model: options.model,
    stream: options.stream
  })
  await writeCallArtifacts(output, 'call-01-extract', result)
  await writePrivate(
    path.join(output, 'candidate.md'),
    result.text.endsWith('\n') ? result.text : `${result.text}\n`
  )
  await writePrivate(
    path.join(output, 'timings.json'),
    `${JSON.stringify([summarizeTimings('extract', result.timings)], null, 2)}\n`
  )
  process.stdout.write('Arm C run complete. Calls: 1. performanceEligible=false.\n')
}

async function runArmD(options: RunOptions): Promise<void> {
  if (!options.input) throw new UsageError('Arm D requires `--input` (legacy notes)')
  if (!options.commitments) throw new UsageError('Arm D requires `--commitments`')
  const notes = await loadArmDNotes(options.input)
  const commitments = await loadArmDCommitments(options.commitments)
  const plan = planArmD(notes, commitments, options.temperature, options.seed)
  const inspectRecord = {
    arm: 'd',
    temperature: options.temperature,
    seed: options.seed,
    mode: plan.mode,
    notesCharCount: plan.notesCharCount,
    notesWordCount: plan.notesWordCount,
    notesEstimatedTokens: plan.notesEstimatedTokens,
    commitmentsCharCount: plan.commitmentsCharCount,
    commitmentsWordCount: plan.commitmentsWordCount,
    commitmentsEstimatedTokens: plan.commitmentsEstimatedTokens,
    templateName: plan.templateName,
    templateSha256: plan.templateSha256,
    filledPromptSha256: plan.filledPromptSha256,
    options: plan.request.options
  }
  if (options.inspect) {
    printInspect('Arm D inspect (no inference)', inspectRecord)
    return
  }
  if (!options.out) throw new UsageError('Writer run requires `--out`')

  const output = await ensureNewPrivateOutputDir(options.out, worktreeFromHere())
  const client = new OllamaClient(options.host)
  const [ollamaVersion, model] = await Promise.all([
    client.version(),
    client.modelIdentity(options.model)
  ])
  const manifest = buildManifest({
    arm: 'd',
    temperature: options.temperature,
    seed: options.seed,
    model,
    ollamaVersion,
    options: plan.request.options,
    stopConditions: STOP_CONDITIONS,
    filledPromptSha256: plan.filledPromptSha256,
    projectionStats: {
      description: 'Legacy 1.1.1 notes plus verified commitments, not the transcript',
      notesCharCount: plan.notesCharCount,
      notesWordCount: plan.notesWordCount,
      notesEstimatedTokens: plan.notesEstimatedTokens,
      commitmentsCharCount: plan.commitmentsCharCount,
      commitmentsWordCount: plan.commitmentsWordCount,
      commitmentsEstimatedTokens: plan.commitmentsEstimatedTokens,
      mode: 'single-call'
    }
  })
  await writeManifestFile(output, manifest)
  await writePrivate(
    path.join(output, 'inspect.json'),
    `${JSON.stringify(inspectRecord, null, 2)}\n`
  )
  const result = await client.generate({
    ...plan.request,
    model: options.model,
    stream: options.stream
  })
  await writeCallArtifacts(output, 'call-01-restyle', result)
  await writePrivate(
    path.join(output, 'candidate.md'),
    result.text.endsWith('\n') ? result.text : `${result.text}\n`
  )
  await writePrivate(
    path.join(output, 'timings.json'),
    `${JSON.stringify([summarizeTimings('restyle', result.timings)], null, 2)}\n`
  )
  process.stdout.write('Arm D run complete. Calls: 1. performanceEligible=false.\n')
}

function catalogById(catalog: readonly CatalogItem[]): Map<string, CatalogItem> {
  return new Map(catalog.map((row) => [row.id, row]))
}

function itemsForGroup(
  group: TopicGroup,
  byId: Map<string, CatalogItem>
): CatalogItem[] {
  return group.ids
    .map((id) => byId.get(id))
    .filter((row): row is CatalogItem => row !== undefined)
}

async function runArmE(options: RunOptions): Promise<void> {
  if (!options.input) throw new UsageError('Arm E requires `--input` (legacy segments JSON)')
  if (!options.extractor) throw new UsageError('Arm E requires `--extractor`')
  if (!options.fixture) throw new UsageError('Arm E requires `--fixture`')

  const segments = JSON.parse(await readFile(path.resolve(options.input), 'utf8')) as unknown
  const split = splitLegacyItems(segments)
  const extractorMarkdown = await readFile(path.resolve(options.extractor), 'utf8')
  const projection = await loadFixtureProjection(options.fixture, 0, 0)
  const utterances = projection.turns.map((turn) => turn.text)
  const verified = verifyCommitments(extractorMarkdown, utterances)
  const groupPlan = planArmEGroup(split.topical, options.seed)
  const inspectRecord = {
    arm: 'e',
    temperature: options.temperature,
    seed: options.seed,
    retrySeed: armERetrySeed(),
    groupingTemperature: 0,
    guardVersion: ARM_E_GUARD_VERSION,
    topicalItemCount: split.topical.length,
    decisionCount: split.decisions.length,
    actionCount: split.actions.length,
    demotedCount: split.demotedCount,
    extractedCount: verified.extracted.length,
    verifiedCount: verified.kept.length,
    rejectedCount: verified.extracted.length - verified.kept.length,
    catalog: catalogStats(split.topical),
    groupTemplateName: groupPlan.templateName,
    groupTemplateSha256: groupPlan.templateSha256,
    groupFilledPromptSha256: groupPlan.filledPromptSha256,
    restyleTemplateSha256: planArmERestyle('Topic', split.topical.slice(0, 1), options.temperature, options.seed)
      .templateSha256
  }
  if (options.inspect) {
    printInspect('Arm E inspect (no inference)', inspectRecord)
    return
  }
  if (!options.out) throw new UsageError('Writer run requires `--out`')

  const output = await ensureNewPrivateOutputDir(options.out, worktreeFromHere())
  const client = new OllamaClient(options.host)
  const [ollamaVersion, model] = await Promise.all([
    client.version(),
    client.modelIdentity(options.model)
  ])
  const manifest = buildManifest({
    arm: 'e',
    temperature: options.temperature,
    seed: options.seed,
    model,
    ollamaVersion,
    options: groupPlan.request.options,
    stopConditions: STOP_CONDITIONS,
    filledPromptSha256: groupPlan.filledPromptSha256,
    projectionStats: {
      description: 'Legacy segments plus verified extractor commitments; grouping titles only',
      topicalItemCount: split.topical.length,
      decisionCount: split.decisions.length,
      actionCount: split.actions.length,
      verifiedCount: verified.kept.length,
      mode: 'chunked-restyle'
    }
  })
  await writeManifestFile(output, manifest)
  await writePrivate(path.join(output, 'inspect.json'), `${JSON.stringify(inspectRecord, null, 2)}\n`)
  await writePrivate(path.join(output, 'verified-commitments.md'), renderVerifiedMarkdown(verified.kept))
  await writePrivate(
    path.join(output, 'verified-report.json'),
    `${JSON.stringify(
      {
        extractedCount: verified.extracted.length,
        keptCount: verified.kept.length,
        rejectedCount: verified.extracted.length - verified.kept.length,
        decisions: verified.decisions
      },
      null,
      2
    )}\n`
  )

  const wallStarted = Date.now()
  const timingRows: Record<string, unknown>[] = []
  const callLog: Record<string, unknown>[] = []

  const runCall = async (
    prefix: string,
    plan: ArmECallPlan,
    label: string
  ): Promise<GenerateResult> => {
    const result = await client.generate({
      ...plan.request,
      model: options.model,
      stream: options.stream
    })
    await writeCallArtifacts(output, prefix, result)
    timingRows.push({ ...summarizeTimings(label, result.timings), seed: plan.seed, temperature: plan.temperature })
    callLog.push({
      label,
      prefix,
      templateName: plan.templateName,
      templateSha256: plan.templateSha256,
      filledPromptSha256: plan.filledPromptSha256,
      seed: plan.seed,
      temperature: plan.temperature,
      doneReason: result.timings.doneReason,
      evalCount: result.timings.evalCount,
      wallClockMs: result.timings.wallClockMs
    })
    return result
  }

  const topicalIds = split.topical.map((row) => row.id)
  let grouping = await runCall('call-01-group', groupPlan, 'group')
  let groupingValidation = parseGroupingJson(grouping.text, topicalIds, split.topical)
  let groupingAttempt = 1
  if (!groupingValidation.ok) {
    const retryPlan = planArmEGroup(split.topical, armERetrySeed())
    grouping = await runCall('call-01b-group-retry', retryPlan, 'group-retry')
    groupingValidation = parseGroupingJson(grouping.text, topicalIds, split.topical)
    groupingAttempt = 2
  }
  const groupingFallback = !groupingValidation.ok
  const groups = groupingFallback
    ? fallbackBucketGroups(split.topical)
    : groupingValidation.groups
  await writePrivate(
    path.join(output, 'grouping.json'),
    `${JSON.stringify(
      {
        attempt: groupingAttempt,
        fallback: groupingFallback,
        reason: groupingValidation.reason,
        groupCount: groups.length,
        remainderCount: groupingValidation.remainderIds.length,
        remainderIds: groupingValidation.remainderIds
      },
      null,
      2
    )}\n`
  )

  await writePrivate(
    path.join(output, 'catalog.json'),
    `${JSON.stringify(
      split.topical.map((row) => ({ id: row.id, titleLine: row.titleLine, fullText: row.fullText })),
      null,
      2
    )}\n`
  )

  const byId = catalogById(split.topical)
  const sectionBodies: { name: string; markdown: string; source: 'restyle' | 'fallback'; retried: boolean }[] =
    []
  for (const [index, group] of groups.entries()) {
    const seq = String(index + 1).padStart(2, '0')
    const members = itemsForGroup(group, byId)
    const inputText = members.map((row) => row.fullText).join('\n')
    const firstPlan = planArmERestyle(group.name, members, options.temperature, options.seed)
    let restyle = await runCall(`call-${seq}-restyle`, firstPlan, `restyle-${seq}`)
    let retried = false
    let source: 'restyle' | 'fallback' = 'restyle'
    let markdown = sanitizeMarkdown(restyle.text)
    if (!factsPass(inputText, markdown) || containsCatalogItemId(markdown)) {
      const retryPlan = planArmERestyle(group.name, members, options.temperature, armERetrySeed())
      restyle = await runCall(`call-${seq}b-restyle-retry`, retryPlan, `restyle-${seq}-retry`)
      retried = true
      markdown = sanitizeMarkdown(restyle.text)
      if (!factsPass(inputText, markdown) || containsCatalogItemId(markdown)) {
        source = 'fallback'
        markdown = renderUnrestyledItems(members.map((row) => row.item))
      }
    }
    const judged = source === 'fallback' ? sanitizeMarkdown(restyle.text) : markdown
    const missing = missingFacts(inputText, judged)
    sectionBodies.push({ name: group.name, markdown, source, retried })
    await writePrivate(
      path.join(output, `section-${seq}.json`),
      `${JSON.stringify(
        {
          name: group.name,
          itemCount: members.length,
          ids: members.map((row) => row.id),
          items: members.map((row) => ({ id: row.id, titleLine: row.titleLine, fullText: row.fullText })),
          source,
          retried,
          missingNumberCount: missing.numbers.length,
          missingNameCount: missing.names.length
        },
        null,
        2
      )}\n`
    )
  }

  const nextSteps = unionNextSteps(split.actions, verified.kept)
  const candidate = sanitizeMarkdown(
    composeDocument({
      title: projection.title,
      sections: sectionBodies.map((section) => ({ name: section.name, markdown: section.markdown })),
      decisions: split.decisions,
      nextSteps
    })
  )
  const wallClockMs = Date.now() - wallStarted
  await writePrivate(
    path.join(output, 'candidate.md'),
    candidate.endsWith('\n') ? candidate : `${candidate}\n`
  )
  await writePrivate(path.join(output, 'timings.json'), `${JSON.stringify(timingRows, null, 2)}\n`)
  await writePrivate(
    path.join(output, 'compose-report.json'),
    `${JSON.stringify(
      {
        wallClockMs,
        callCount: timingRows.length,
        groupingAttempt,
        groupingFallback,
        groupingReason: groupingValidation.reason,
        groupCount: groups.length,
        sections: sectionBodies.map((section) => ({
          nameLength: section.name.length,
          source: section.source,
          retried: section.retried
        })),
        restyleFallbackCount: sectionBodies.filter((section) => section.source === 'fallback').length,
        restyleRetryCount: sectionBodies.filter((section) => section.retried).length,
        decisionCount: split.decisions.length,
        nextStepCount: nextSteps.length,
        wordCount: countWords(candidate),
        shapeIssues: shapeIssues(candidate)
      },
      null,
      2
    )}\n`
  )
  await writePrivate(path.join(output, 'calls.json'), `${JSON.stringify(callLog, null, 2)}\n`)
  process.stdout.write(
    `Arm E run complete. Calls: ${timingRows.length}. wallClockMs=${wallClockMs}. performanceEligible=false.\n`
  )
}

async function runArmF(options: RunOptions): Promise<void> {
  if (!options.input) throw new UsageError('Arm F requires `--input` (Arm E candidate.md)')
  if (!options.coverageKey) throw new UsageError('Arm F requires `--coverage-key`')

  const candidate = await readFile(path.resolve(options.input), 'utf8')
  const keyMarkdown = await readFile(path.resolve(options.coverageKey), 'utf8')
  const coverageItems = parseCoverageKey(keyMarkdown)
  const chunks = splitNotesDocument(candidate)
  const topical = chunks.filter((chunk) => chunk.kind === 'topical')
  const baselineCoverage = scoreCoverage(candidate, coverageItems)
  const firstTopical = topical[0]
  const samplePlan = firstTopical
    ? planArmFCompress(firstTopical.name ?? 'Topic', sectionBody(firstTopical.raw), options.temperature, options.seed)
    : planArmFCompress('Topic', '* Keep the Orion soak.', options.temperature, options.seed)

  const inspectRecord = {
    arm: 'f',
    temperature: options.temperature,
    seed: options.seed,
    retrySeed: armFRetrySeed(),
    guardVersion: ARM_F_GUARD_VERSION,
    topicalSectionCount: topical.length,
    hasDecisions: chunks.some((chunk) => chunk.kind === 'decisions'),
    hasNextSteps: chunks.some((chunk) => chunk.kind === 'nextSteps'),
    inputWordCount: countWords(candidate),
    baselinePresent: baselineCoverage.present,
    baselinePartial: baselineCoverage.partial,
    baselineN: baselineCoverage.n,
    baselineStrict: baselineCoverage.strict,
    templateName: samplePlan.templateName,
    templateSha256: samplePlan.templateSha256,
    filledPromptSha256: samplePlan.filledPromptSha256
  }
  if (options.inspect) {
    printInspect('Arm F inspect (no inference)', inspectRecord)
    return
  }
  if (!options.out) throw new UsageError('Writer run requires `--out`')

  const output = await ensureNewPrivateOutputDir(options.out, worktreeFromHere())
  const client = new OllamaClient(options.host)
  const [ollamaVersion, model] = await Promise.all([
    client.version(),
    client.modelIdentity(options.model)
  ])
  const manifest = buildManifest({
    arm: 'f',
    temperature: options.temperature,
    seed: options.seed,
    model,
    ollamaVersion,
    options: samplePlan.request.options,
    stopConditions: STOP_CONDITIONS,
    filledPromptSha256: samplePlan.filledPromptSha256,
    projectionStats: {
      description: 'Passing Arm E candidate; per-section compression; Decisions/Next Steps pass through',
      topicalSectionCount: topical.length,
      inputWordCount: countWords(candidate),
      baselineStrict: baselineCoverage.strict,
      mode: 'section-compress'
    }
  })
  await writeManifestFile(output, manifest)
  await writePrivate(path.join(output, 'inspect.json'), `${JSON.stringify(inspectRecord, null, 2)}\n`)
  await writePrivate(
    path.join(output, 'source-candidate.sha256'),
    `${sha256Utf8(candidate)}\n`
  )

  const wallStarted = Date.now()
  const timingRows: Record<string, unknown>[] = []
  const callLog: Record<string, unknown>[] = []
  let working = chunks.map((chunk) => ({ ...chunk }))

  const runCall = async (
    prefix: string,
    plan: ArmFCallPlan,
    label: string
  ): Promise<GenerateResult> => {
    const result = await client.generate({
      ...plan.request,
      model: options.model,
      stream: options.stream
    })
    await writeCallArtifacts(output, prefix, result)
    timingRows.push({
      ...summarizeTimings(label, result.timings),
      seed: plan.seed,
      temperature: plan.temperature
    })
    callLog.push({
      label,
      prefix,
      templateName: plan.templateName,
      templateSha256: plan.templateSha256,
      filledPromptSha256: plan.filledPromptSha256,
      seed: plan.seed,
      temperature: plan.temperature,
      doneReason: result.timings.doneReason,
      evalCount: result.timings.evalCount,
      wallClockMs: result.timings.wallClockMs
    })
    return result
  }

  const sectionReports: Record<string, unknown>[] = []
  let topicalIndex = 0
  for (const [index, chunk] of working.entries()) {
    if (chunk.kind !== 'topical') continue
    topicalIndex += 1
    const seq = String(topicalIndex).padStart(2, '0')
    const inputText = sectionBody(chunk.raw)
    const wordsBefore = countWords(inputText)
    const firstPlan = planArmFCompress(chunk.name ?? 'Topic', inputText, options.temperature, options.seed)
    let compressed = await runCall(`call-${seq}-compress`, firstPlan, `compress-${seq}`)
    let retried = false
    let source: 'compress' | 'fallback' = 'compress'
    let markdown = stripEmittedHeading(compressed.text, chunk.name ?? '')
    let trial = reconstructWith(working, index, markdown)
    let judgment = judgeCompression({
      inputSection: inputText,
      compressed: markdown,
      trialDocument: joinNotesDocument(trial),
      baselineStrict: baselineCoverage.strict,
      coverageItems
    })
    if (!judgment.accept) {
      const retryPlan = planArmFCompress(
        chunk.name ?? 'Topic',
        inputText,
        options.temperature,
        armFRetrySeed()
      )
      compressed = await runCall(`call-${seq}b-compress-retry`, retryPlan, `compress-${seq}-retry`)
      retried = true
      markdown = stripEmittedHeading(compressed.text, chunk.name ?? '')
      trial = reconstructWith(working, index, markdown)
      judgment = judgeCompression({
        inputSection: inputText,
        compressed: markdown,
        trialDocument: joinNotesDocument(trial),
        baselineStrict: baselineCoverage.strict,
        coverageItems
      })
      if (!judgment.accept) {
        source = 'fallback'
        markdown = inputText
        trial = reconstructWith(working, index, markdown)
      }
    }
    working = trial
    const wordsAfter = countWords(sectionBody(working[index]?.raw ?? markdown))
    sectionReports.push({
      nameLength: (chunk.name ?? '').length,
      source,
      retried,
      reason: source === 'fallback' ? judgment.reason : 'ok',
      missingNumberCount: judgment.missingNumberCount,
      missingNameCount: judgment.missingNameCount,
      extraNumberCount: judgment.extraNumberCount,
      extraNameCount: judgment.extraNameCount,
      wordsBefore,
      wordsAfter,
      wordDelta: wordsAfter - wordsBefore,
      trialStrict: judgment.trialStrict
    })
    await writePrivate(
      path.join(output, `section-${seq}.json`),
      `${JSON.stringify(sectionReports[sectionReports.length - 1], null, 2)}\n`
    )
  }

  const finalMarkdown = joinNotesDocument(working)
  const candidateOut = finalMarkdown.endsWith('\n') ? finalMarkdown : `${finalMarkdown}\n`
  const finalCoverage = scoreCoverage(candidateOut, coverageItems)
  const extra = extraFacts(candidate, candidateOut)
  const wordCount = countWords(candidateOut)
  const inputWordCount = countWords(candidate)
  const wordRatio = inputWordCount === 0 ? 0 : wordCount / inputWordCount
  const decisionsIdentical = passthroughRaw(working, 'decisions') === passthroughRaw(chunks, 'decisions')
  const nextStepsIdentical = passthroughRaw(working, 'nextSteps') === passthroughRaw(chunks, 'nextSteps')
  const wallClockMs = Date.now() - wallStarted
  const shape = shapeIssues(candidateOut)
  const gate = {
    coverageVsUncompressed: finalCoverage.strict >= baselineCoverage.strict,
    decisionsIdentical,
    nextStepsIdentical,
    ungroundedNumberCount: extra.numbers.length,
    ungroundedNameCount: extra.names.length,
    ungroundedPass: extra.numbers.length === 0,
    shapeIssues: shape,
    wordCount,
    inputWordCount,
    wordRatio,
    wordPackPass: wordRatio <= ARM_F_WORD_RATIO_PACK,
    wordTargetPass: wordRatio <= ARM_F_WORD_RATIO_TARGET,
    acceptedCount: sectionReports.filter((row) => row.source === 'compress').length,
    fallbackCount: sectionReports.filter((row) => row.source === 'fallback').length
  }

  await writePrivate(path.join(output, 'candidate.md'), candidateOut)
  await writePrivate(path.join(output, 'timings.json'), `${JSON.stringify(timingRows, null, 2)}\n`)
  await writePrivate(
    path.join(output, 'coverage.json'),
    `${JSON.stringify(
      {
        baseline: {
          n: baselineCoverage.n,
          present: baselineCoverage.present,
          partial: baselineCoverage.partial,
          absent: baselineCoverage.absent,
          strict: baselineCoverage.strict,
          credit: baselineCoverage.credit
        },
        final: {
          n: finalCoverage.n,
          present: finalCoverage.present,
          partial: finalCoverage.partial,
          absent: finalCoverage.absent,
          strict: finalCoverage.strict,
          credit: finalCoverage.credit
        },
        items: finalCoverage.items.map((item) => ({ id: item.id, type: item.type, status: item.status }))
      },
      null,
      2
    )}\n`
  )
  await writePrivate(
    path.join(output, 'compose-report.json'),
    `${JSON.stringify(
      {
        wallClockMs,
        callCount: timingRows.length,
        sections: sectionReports,
        compressFallbackCount: gate.fallbackCount,
        compressRetryCount: sectionReports.filter((row) => row.retried).length,
        wordCount,
        inputWordCount,
        wordRatio,
        baselineStrict: baselineCoverage.strict,
        finalStrict: finalCoverage.strict,
        decisionsIdentical,
        nextStepsIdentical,
        shapeIssues: shape,
        gate
      },
      null,
      2
    )}\n`
  )
  await writePrivate(path.join(output, 'calls.json'), `${JSON.stringify(callLog, null, 2)}\n`)
  process.stdout.write(
    `Arm F run complete. Calls: ${timingRows.length}. wallClockMs=${wallClockMs}. performanceEligible=false.\n`
  )
}

function round4UncompressedWords(inputWordCount: number): number {
  return Math.abs(inputWordCount - 1540) <= Math.abs(inputWordCount - 454) ? 1759 : 482
}

async function loadSourceCatalog(
  inputPath: string,
  fixturePath: string | null
): Promise<Record<string, string>> {
  if (fixturePath) {
    try {
      const raw = JSON.parse(await readFile(path.resolve(fixturePath), 'utf8')) as unknown
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'information' in raw) {
        return catalogTextById(splitLegacyItems(raw).topical)
      }
    } catch {
      // Fixture is not legacy segments; fall through to catalog.json search.
    }
  }
  let dir = path.dirname(inputPath)
  for (let hop = 0; hop < 4; hop += 1) {
    try {
      const rows = JSON.parse(await readFile(path.join(dir, 'catalog.json'), 'utf8')) as unknown
      if (Array.isArray(rows)) {
        const out: Record<string, string> = {}
        for (const row of rows) {
          if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
          const record = row as { id?: unknown; fullText?: unknown; titleLine?: unknown }
          if (typeof record.id !== 'string') continue
          const text =
            typeof record.fullText === 'string' && record.fullText.trim().length > 0
              ? record.fullText
              : typeof record.titleLine === 'string'
                ? record.titleLine
                : ''
          if (text.length > 0) out[record.id] = text
        }
        if (Object.keys(out).length > 0) return out
      }
    } catch {
      // Keep walking toward the eval-results root.
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return {}
}

async function runArmG(options: RunOptions): Promise<void> {
  if (!options.input) throw new UsageError('Arm G requires `--input` (Arm F candidate.md)')
  if (!options.coverageKey) throw new UsageError('Arm G requires `--coverage-key`')

  const candidate = await readFile(path.resolve(options.input), 'utf8')
  const keyMarkdown = await readFile(path.resolve(options.coverageKey), 'utf8')
  const coverageItems = parseCoverageKey(keyMarkdown)
  const sourceCatalog = await loadSourceCatalog(path.resolve(options.input), options.fixture)
  const baselineCoverage = scoreCoverage(stripCatalogItemIds(candidate), coverageItems)
  const inspectRecord = {
    arm: 'g',
    guardVersion: ARM_G_GUARD_VERSION,
    inference: 'optional-ns-group',
    groupModel: ARM_G_GROUP_MODEL,
    inputWordCount: countWords(candidate),
    baselinePresent: baselineCoverage.present,
    baselinePartial: baselineCoverage.partial,
    baselineN: baselineCoverage.n,
    baselineStrict: baselineCoverage.strict,
    inputProjection: ARM_G_INPUT_PROJECTION_DESCRIPTION
  }
  if (options.inspect) {
    printInspect('Arm G inspect (no inference)', inspectRecord)
    return
  }
  if (!options.out) throw new UsageError('Writer run requires `--out`')

  const output = await ensureNewPrivateOutputDir(options.out, worktreeFromHere())
  const wallStarted = Date.now()
  const client = new OllamaClient(options.host)
  const result = await applyArmGAsync(
    candidate,
    async (items: ActionItem[]) => {
      try {
        const plan = planArmGNsGroup(items)
        const generated = await client.generate({ ...plan.request, model: ARM_G_GROUP_MODEL, stream: false })
        const ids = items.map((_, index) => nsCatalogId(index))
        const parsed = parseWorkstreamGroupingJson(generated.text, ids)
        if (!parsed.ok) return null
        return workstreamGroupsToIndices(parsed.groups, ids)
      } catch {
        return null
      }
    },
    { sourceCatalog }
  )
  const gates = evaluateArmGGates(candidate, result.markdown, coverageItems)
  const finalCoverage = scoreCoverage(stripCatalogItemIds(result.markdown), coverageItems)
  const round4 = round4UncompressedWords(result.report.inputWordCount)
  const candidateOut = result.markdown.endsWith('\n') ? result.markdown : `${result.markdown}\n`
  const wallClockMs = Date.now() - wallStarted
  const gateMarkdown = formatGateMarkdown({
    meeting: path.basename(path.resolve(options.out)),
    gates,
    report: result.report,
    coverage: { input: baselineCoverage, output: finalCoverage },
    round4UncompressedWords: round4
  })

  await writePrivate(path.join(output, 'inspect.json'), `${JSON.stringify(inspectRecord, null, 2)}\n`)
  await writePrivate(path.join(output, 'candidate.md'), candidateOut)
  await writePrivate(path.join(output, 'report.json'), `${JSON.stringify(result.report, null, 2)}\n`)
  await writePrivate(path.join(output, 'gate.md'), gateMarkdown.endsWith('\n') ? gateMarkdown : `${gateMarkdown}\n`)
  process.stdout.write(
    `Arm G run complete. Calls: ${result.report.nsGroupingPath === 'model' ? 1 : 0}. grouping=${result.report.nsGroupingPath}. wallClockMs=${wallClockMs}. words=${result.report.outputWordCount}. guards=${gates.allPass ? 'pass' : 'fail'}. performanceEligible=false.\n`
  )
}

async function main(): Promise<void> {
  const options = parseRunArgs(process.argv.slice(2))
  if (options.arm === 'a') await runArmA(options)
  else if (options.arm === 'b') await runArmB(options)
  else if (options.arm === 'c') await runArmC(options)
  else if (options.arm === 'd') await runArmD(options)
  else if (options.arm === 'e') await runArmE(options)
  else if (options.arm === 'f') await runArmF(options)
  else await runArmG(options)
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write('Notes writer probe failed. No transcript or notes content was logged.\n')
  process.exitCode = 1
})
