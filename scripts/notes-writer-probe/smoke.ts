#!/usr/bin/env node
import { UsageError } from './cli.ts'
import {
  DEFAULT_HOST,
  DEFAULT_MODEL,
  DEFAULT_SEED,
  SMOKE_NUM_CTX,
  SMOKE_NUM_PREDICT,
  STOP_CONDITIONS
} from './constants.ts'
import { OllamaClient } from './ollama-client.ts'
import { SMOKE_PROMPT } from './prompts.ts'

function usage(): string {
  return [
    'Usage: npx --no-install vite-node scripts/notes-writer-probe/smoke.ts',
    '  [--host 127.0.0.1:11438]',
    '  [--model llama3.1:latest]',
    '',
    'Transport-only. Throwaway prompt. Does not write meeting notes.'
  ].join('\n')
}

function parseArgs(args: string[]): { host: string; model: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--host' || argument === '--model') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`Missing value for ${argument}`)
      }
      values.set(argument.slice(2), value)
      index += 1
      continue
    }
    throw new UsageError(`${usage()}\n\nUnknown argument: ${argument}`)
  }
  return {
    host: values.get('host') ?? DEFAULT_HOST,
    model: values.get('model') ?? DEFAULT_MODEL
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const client = new OllamaClient(options.host)
  const version = await client.version()
  process.stdout.write(`ollamaVersion=${version}\n`)
  const show = await client.show(options.model)
  const details = (show.details ?? {}) as Record<string, unknown>
  process.stdout.write(
    `show.ok family=${String(details.family ?? 'unknown')} params=${String(details.parameter_size ?? 'unknown')} quant=${String(details.quantization_level ?? 'unknown')}\n`
  )
  const identity = await client.modelIdentity(options.model)
  process.stdout.write(`model.tag=${identity.tag} digest=${identity.digest ?? 'none'}\n`)
  const result = await client.generate({
    model: options.model,
    prompt: SMOKE_PROMPT,
    stream: true,
    options: {
      num_ctx: SMOKE_NUM_CTX,
      num_predict: SMOKE_NUM_PREDICT,
      temperature: 0,
      seed: DEFAULT_SEED,
      stop: STOP_CONDITIONS
    }
  })
  const normalized = result.text.trim().toLowerCase()
  const matched = normalized === 'ready' || normalized.startsWith('ready')
  process.stdout.write(
    JSON.stringify(
      {
        smoke: 'transport',
        matchedReady: matched,
        outputChars: result.text.length,
        outputTrimmedChars: result.text.trim().length,
        timings: result.timings,
        rawBytes: Buffer.byteLength(result.rawBody, 'utf8')
      },
      null,
      2
    ) + '\n'
  )
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write('Smoke test failed. No meeting content was logged.\n')
  process.exitCode = 1
})
