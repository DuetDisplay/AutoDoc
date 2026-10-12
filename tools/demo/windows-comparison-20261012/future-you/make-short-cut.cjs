const fs = require('fs');
const path = require('path');
const root = __dirname;
// Preserve the approved visual direction and the complete original composition.
let source = fs.readFileSync(path.join(root, 'src/Composition.tsx'), 'utf8');
const changes = [
  ['[1.45 * fps, 1.62 * fps]', '[1.15 * fps, 1.32 * fps]'],
  ['[1.45 * fps, 1.77 * fps]', '[1.15 * fps, 1.47 * fps]'],
  ['[13.8 * fps, 14.45 * fps]', '[5.3 * fps, 5.75 * fps]'],
  ["const caption = f < 2.6 * fps ? 'The note says “this version.”' : f < 4.25 * fps ? 'Past you left a timestamp.' : f < 9.8 * fps ? 'And the whole picture.' : 'The words. The screen. The exact moment.';", "const caption = f < 2 * fps ? 'The note says “this version.”' : f < 3.2 * fps ? 'Past you left a timestamp.' : 'And the whole picture.';"],
  ["src={staticFile('native-recall.mp4')} muted", "src={staticFile('native-recall.mp4')} trimBefore={fps} muted"],
  ['[14.25 * fps, 14.5 * fps]', '[5.65 * fps, 5.85 * fps]'],
  ['[15.2 * fps, 15.43 * fps]', '[6.2 * fps, 6.4 * fps]'],
  ['[15.2 * fps, 15.6 * fps]', '[6.2 * fps, 6.5 * fps]'],
  ['[17.1 * fps, 17.35 * fps]', '[7.05 * fps, 7.25 * fps]'],
  ['[.65 * fps, .9 * fps]', '[.3 * fps, .5 * fps]'],
  ['[1.2 * fps, 1.5 * fps]', '[.65 * fps, .85 * fps]'],
  ['durationInFrames={4 * fps}', 'durationInFrames={3 * fps}'],
  ['from={4 * fps} durationInFrames={21 * fps}', 'from={3 * fps} durationInFrames={9 * fps}'],
  ['from={25 * fps} durationInFrames={7 * fps}', 'from={12 * fps} durationInFrames={4 * fps}'],
  ["staticFile('sound-design.wav')", "staticFile('sound-design-short.wav')"],
  ['export const MyComposition', 'export const MyShortComposition'],
  ['id="FutureYou"', 'id="FutureYouShort"'],
  ['durationInFrames={960}', 'durationInFrames={480}'],
];
for (const [from, to] of changes) {
  if (!source.includes(from)) throw new Error(`Original source changed: ${from}`);
  source = source.replaceAll(from, to);
}
source = source.split('\n').filter(line => !line.includes('A familiar conversation with yourself.')).join('\n');
fs.writeFileSync(path.join(root, 'src/Short.tsx'), source);
// Retimed original tonal accents, with the click aligned to the real UI action.
const sr = 48000, pcm = new Float64Array(sr * 16);
const pluck = (time, hz, gain, length = .25) => {
  const start = Math.round(time * sr);
  for (let i = 0; i < sr * length && start + i < pcm.length; i++) {
    const t = i / sr;
    const env = Math.min(1, t / .006) * Math.exp(-t * 14) * Math.min(1, (length - t) / .02);
    pcm[start + i] += gain * env * (Math.sin(2 * Math.PI * hz * t) + .16 * Math.sin(2 * Math.PI * hz * 2 * t));
  }
};
pluck(.16, 392, .11); pluck(1.2, 294, .10); pluck(3, 196, .08);
pluck(6, 880, .07, .12); pluck(6.2, 523.25, .06); pluck(6.32, 659.25, .055);
pluck(8.65, 392, .08); pluck(9.2, 523.25, .08); pluck(10.05, 659.25, .08);
pluck(12.04, 261.63, .06, .8); pluck(12.12, 392, .055, .8); pluck(12.23, 523.25, .05, .8);
const buffer = Buffer.alloc(44 + pcm.length * 2);
buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
buffer.writeUInt32LE(sr, 24); buffer.writeUInt32LE(sr * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
buffer.write('data', 36); buffer.writeUInt32LE(pcm.length * 2, 40);
for (let i = 0; i < pcm.length; i++) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
fs.writeFileSync(path.join(root, 'public/sound-design-short.wav'), buffer);
// Same export checks, sampled around the new scene boundaries and actual click.
let qa = fs.readFileSync(path.join(root, 'check-render.cjs'), 'utf8')
  .replaceAll('autodoc-future-you.mp4', 'autodoc-future-you-short.mp4')
  .replace("video.nb_frames !== '960'", "video.nb_frames !== '480'")
  .replace('Number(meta.format.duration) - 32', 'Number(meta.format.duration) - 16')
  .replace('const stamps = [1, 3, 4.05, 5.5, 7.9, 8.15, 9.2, 12, 15.5, 18.5, 20, 22, 24.9, 25.5, 27, 31.8];', 'const stamps = [.8, 2.5, 2.97, 3.1, 4.5, 5.9, 6.15, 7.5, 8.8, 9.6, 10.5, 11.9, 12.1, 13, 14, 15.9];')
  .replaceAll('qa/', 'qa-short/')
  .replace("'poster.jpg'", "'poster-short.jpg'");
fs.mkdirSync(path.join(root, 'qa-short'), {recursive:true});
fs.writeFileSync(path.join(root, 'check-short.cjs'), qa);
console.log('Created 16-second cut; the genuine timestamp click lands at 6 seconds.');
