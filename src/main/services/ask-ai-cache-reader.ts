import { Worker } from 'node:worker_threads'
import { getKey } from './crypto'

export interface PackedAskAiCache {
  version: string
  keys: string[]
  offsets: Uint32Array
  values: Float64Array
  coveredMeetingIds?: string[]
}

// Only the encrypted derived cache is read here. The key crosses an in-memory
// worker boundary; plaintext and key material never go through a temporary file.
const reader = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
try {
  const buf = fs.readFileSync(workerData.file);
  if (buf.length < 32 || buf.subarray(0,4).toString() !== 'ADOC') throw Error('Invalid encrypted cache');
  const cipher = crypto.createDecipheriv('aes-256-gcm', workerData.key, buf.subarray(4,16));
  cipher.setAAD(Buffer.from(path.basename(workerData.file), 'utf8'));
  cipher.setAuthTag(buf.subarray(16,32));
  const data = JSON.parse(Buffer.concat([cipher.update(buf.subarray(32)), cipher.final()]).toString('utf8'));
  const keys = [], rows = [], offsets = new Uint32Array(data.rows.length + 1);
  let size = 0;
  for (const [key, vector] of data.rows) {
    const values = vector.slice(0, workerData.limit || vector.length);
    if (!values.length || values.some(v => !Number.isFinite(v))) throw Error('Invalid cached embedding');
    const norm = Math.sqrt(values.reduce((sum,v) => sum + v*v, 0));
    if (!Number.isFinite(norm) || norm === 0) throw Error('Invalid cached embedding');
    keys.push(key); rows.push(values.map(v => v/norm)); size += values.length;
    offsets[keys.length] = size;
  }
  const values = new Float64Array(size);
  rows.forEach((row,i) => values.set(row, offsets[i]));
  parentPort.postMessage({ version:data.version, keys, offsets, values, coveredMeetingIds:data.coveredMeetingIds }, [offsets.buffer, values.buffer]);
} finally { workerData.key.fill(0); }
`

export function readAskAiCache(file: string): Promise<PackedAskAiCache> {
  const key = Buffer.from(getKey())
  let worker: Worker
  try {
    worker = new Worker(reader, {
      eval: true,
      workerData: { file, key, limit: Number(process.env.AUTODOC_ASK_AI_VECTOR_DIM) || 0 }
    })
  } finally {
    key.fill(0)
  }
  return new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(Error('Cache reader exited'))
    })
  })
}
