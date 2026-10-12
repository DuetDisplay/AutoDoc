const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const sharp = require('sharp');
const root = __dirname;
const ffmpeg = path.join(root, '../research/bin/ffmpeg.exe');
const ffprobe = path.join(root, '../research/bin/ffprobe.exe');
const movie = path.join(root, 'autodoc-future-you.mp4');
const run = (args) => execFileSync(ffmpeg, ['-hide_banner', ...args], {encoding: 'utf8'});
(async () => {
  const meta = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', movie], {encoding: 'utf8'}));
  const video = meta.streams.find(s => s.codec_type === 'video');
  const audio = meta.streams.find(s => s.codec_type === 'audio');
  if (video.width !== 1920 || video.height !== 1080 || video.nb_frames !== '960' || Math.abs(Number(meta.format.duration) - 32) > .05 || !audio) throw new Error('Unexpected render metadata');
  run(['-v', 'error', '-i', movie, '-f', 'null', '-']);
  const stamps = [1, 3, 4.05, 5.5, 7.9, 8.15, 9.2, 12, 15.5, 18.5, 20, 22, 24.9, 25.5, 27, 31.8];
  const tiles = [];
  for (const [i, time] of stamps.entries()) {
    const file = path.join(root, `qa/frame-${String(i).padStart(2, '0')}.jpg`);
    run(['-v', 'error', '-y', '-ss', String(time), '-i', movie, '-frames:v', '1', '-q:v', '2', file]);
    const label = Buffer.from(`<svg width="480" height="34"><rect width="480" height="34" fill="#203b2d"/><text x="14" y="24" font-family="Arial" font-size="19" fill="#f5f3e9">${time.toFixed(2)}s</text></svg>`);
    const tile = await sharp(file).resize(480,270).extend({bottom: 34, background: '#203b2d'}).composite([{input: label, left: 0, top: 270}]).jpeg().toBuffer();
    tiles.push({input: tile, left: (i % 4) * 480, top: Math.floor(i / 4) * 304});
  }
  await sharp({create:{width:1920,height:1216,channels:3,background:'#203b2d'}}).composite(tiles).jpeg({quality:90}).toFile(path.join(root, 'qa/contact-sheet.jpg'));
  fs.copyFileSync(path.join(root, 'qa/frame-01.jpg'), path.join(root, 'poster.jpg'));
  fs.writeFileSync(path.join(root, 'qa/metadata.json'), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify({duration:meta.format.duration,width:video.width,height:video.height,frames:video.nb_frames,audio:audio.codec_name,bytes:meta.format.size,decode:'passed',contactSheet:'qa/contact-sheet.jpg'}));
})();
