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

// Match encryptJSON's ADOC/AAD and atomic replacement, keeping serialization
// and encryption off the main thread. Only packed buffers cross the boundary.
const writer = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
(async () => {
  let temp;
  try {
    const { file, version, keys, offsets, values, coveredMeetingIds } = workerData;
    const rows = keys.map((key,i) => [key, Array.from(values.subarray(offsets[i], offsets[i+1]))]);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', workerData.key, iv);
    cipher.setAAD(Buffer.from(path.basename(file), 'utf8'));
    const plaintext = Buffer.from(JSON.stringify({ version, rows, coveredMeetingIds }), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const output = Buffer.concat([Buffer.from('ADOC'), iv, cipher.getAuthTag(), encrypted]);
    temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.enc';
    try { await fs.writeFile(temp, output, { flag:'wx', mode:0o600 }); }
    catch (error) { if (error.code === 'EEXIST') temp = undefined; throw error; }
    for (const delay of [0,80,160,320,640]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try { await fs.rename(temp, file); temp = undefined; break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM','EBUSY','EACCES','ENOTEMPTY'].includes(error.code) || delay === 640) throw error;
      }
    }
    parentPort.postMessage(true);
  } finally {
    workerData.key.fill(0);
    if (temp) await fs.unlink(temp).catch(() => {});
  }
})().catch(error => { throw error; });
`

export function writeAskAiCache(
  file: string,
  version: string,
  vectors: ReadonlyMap<string, number[] | Float64Array>,
  coveredMeetingIds: string[]
): Promise<void> {
  const keys: string[] = [],
    offsets = new Uint32Array(vectors.size + 1)
  let size = 0
  for (const [key, vector] of vectors) {
    keys.push(key)
    size += vector.length
    offsets[keys.length] = size
  }
  // Transfer a packed copy, leaving live retrieval vectors intact.
  const values = new Float64Array(size)
  let i = 0
  for (const vector of vectors.values()) values.set(vector, offsets[i++])
  const key = Buffer.from(getKey())
  let worker: Worker
  try {
    worker = new Worker(writer, {
      eval: true,
      workerData: { file, key, version, keys, offsets, values, coveredMeetingIds },
      transferList: [offsets.buffer, values.buffer]
    })
  } finally {
    key.fill(0)
  }
  return new Promise((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(Error('Cache writer exited'))
    })
  })
}
