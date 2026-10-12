const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const root = __dirname;
const ffmpeg = path.join(root, '../research/bin/ffmpeg.exe');
// Continuous native capture: trim idle lead-in only. The genuine timestamp
// click occurs four seconds into this excerpt, eight seconds into the film.
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '26.7814', '-i', path.join(root, '../assets/shared-native-capture.mp4'), '-t', '21', '-vf', 'fps=30', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(root, 'public/native-recall.mp4')], {stdio: 'inherit'});
// Original local sound accents; no external music, voices or licensed samples.
const sr = 48000, seconds = 32, pcm = new Float64Array(sr * seconds);
const pluck = (time, hz, gain, length = .25) => {
  const start = Math.round(time * sr);
  for (let i = 0; i < sr * length && start + i < pcm.length; i++) {
    const t = i / sr;
    const env = Math.min(1, t / .006) * Math.exp(-t * 14) * Math.min(1, (length - t) / .02);
    pcm[start + i] += gain * env * (Math.sin(2 * Math.PI * hz * t) + .16 * Math.sin(2 * Math.PI * hz * 2 * t));
  }
};
pluck(.16, 392, .11); pluck(1.5, 294, .10); pluck(4, 196, .08);
pluck(8, 880, .07, .12); pluck(8.2, 523.25, .06); pluck(8.32, 659.25, .055);
pluck(18.2, 392, .08); pluck(19.2, 523.25, .08); pluck(21.1, 659.25, .08);
pluck(25.04, 261.63, .06, .8); pluck(25.12, 392, .055, .8); pluck(25.23, 523.25, .05, .8);
const buffer = Buffer.alloc(44 + pcm.length * 2);
buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
buffer.writeUInt32LE(sr, 24); buffer.writeUInt32LE(sr * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
buffer.write('data', 36); buffer.writeUInt32LE(pcm.length * 2, 40);
for (let i = 0; i < pcm.length; i++) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
fs.writeFileSync(path.join(root, 'public/sound-design.wav'), buffer);
console.log('Prepared native footage and original sound design.');
