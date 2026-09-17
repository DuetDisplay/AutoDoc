/* eslint-disable @typescript-eslint/no-require-imports */
// Opt-in test boundary: real model loading, but DML transcribe requests receive
// Jamal's device-hung error. CPU requests execute unchanged in the real worker.
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const spawn = cp.spawn
cp.spawn = function (file, args, options) {
  const child = spawn.call(this, file, args, options)
  if (!Array.isArray(args) || !args.some((arg) => String(arg).endsWith('transcription-worker.py')))
    return child
  let device
  const write = child.stdin.write.bind(child.stdin)
  child.stdin.write = function (data, ...rest) {
    const request = JSON.parse(String(data))
    if (request.op === 'load') device = request.device
    const probe = request.op === 'transcribe' && path.basename(request.audio) === 'probe.wav'
    const cpuFailure =
      request.op === 'transcribe' &&
      device === 'cpu' &&
      !probe &&
      fs.existsSync(path.join(process.env.AUTODOC_TEST_USER_DATA_DIR, 'inject-cpu-failure'))
    const injected =
      request.op === 'transcribe' &&
      device === 'dml' &&
      !probe &&
      !fs.existsSync(path.join(process.env.AUTODOC_TEST_USER_DATA_DIR, 'allow-gpu-transcription'))
    if (request.op === 'load' || request.op === 'transcribe') {
      fs.appendFileSync(
        path.join(process.env.AUTODOC_TEST_USER_DATA_DIR, 'worker-requests.jsonl'),
        JSON.stringify({
          op: request.op,
          device,
          computeType: request.computeType,
          threads: request.threads,
          probe,
          injected
        }) + '\n'
      )
    }
    if (injected || cpuFailure) {
      setImmediate(() =>
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: cpuFailure
                ? 'Injected CPU reprocessing failure'
                : '[ONNXRuntimeError] : 1 : FAIL : Non-zero status code returned while running MemcpyToHost node. DmlExecutionProvider 887A0006 The GPU will not respond to more commands, most likely because of an invalid command passed by the calling application.'
            }) + '\n'
          )
        )
      )
      return true
    }
    return write(data, ...rest)
  }
  return child
}
