const fs=require('fs'),path=require('path'),crypto=require('crypto'),sharp=require('../../../../node_modules/sharp'),{execFileSync,spawnSync}=require('child_process');
const root=__dirname,ffmpeg=path.join(root,'../research/bin/ffmpeg.exe'),ffprobe=path.join(root,'../research/bin/ffprobe.exe');
const cases=[{key:'clicks',duration:16.5,intro:3,click:5.5,payoff:9.8,end:12.7},{key:'section',duration:15.5,intro:3.5,click:5.2,payoff:8.8,end:11.9},{key:'scroll',duration:14,intro:3.5,click:5.2,payoff:8.3,end:10.5}];
(async()=>{
 const reviews=[];
 for(const c of cases){
  const dir=path.join(root,'qa',c.key);fs.mkdirSync(dir,{recursive:true});
  const video=path.join(root,'autodoc-'+c.key+'.mp4');
  const meta=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',video],{encoding:'utf8'}));
  const v=meta.streams.find(s=>s.codec_type==='video'),a=meta.streams.find(s=>s.codec_type==='audio');
  if(v.width!==1920||v.height!==1080||Number(v.nb_frames)!==c.duration*30||Math.abs(Number(meta.format.duration)-c.duration)>.05||!a)throw new Error('Wrong metadata '+c.key);
  execFileSync(ffmpeg,['-v','error','-i',video,'-f','null','-']);
  const black=spawnSync(ffmpeg,['-hide_banner','-i',video,'-vf','blackdetect=d=0.05:pix_th=0.08','-an','-f','null','-'],{encoding:'utf8'});
  if(black.status!==0||black.stderr.includes('black_start:'))throw new Error('Black/decode issue '+c.key);
  const times=[.6,1.6,c.intro-.1,c.intro+.6,c.click-.1,c.click+.2,c.click+1,c.click+2,c.payoff+.6,c.payoff+1.8,c.end+.9,c.duration-.1];
  const tiles=[];
  for(const[i,t]of times.entries()){
   const frame=path.join(dir,`frame-${String(i).padStart(2,'0')}.jpg`);
   execFileSync(ffmpeg,['-v','error','-y','-ss',String(t),'-i',video,'-frames:v','1','-q:v','2',frame]);
   const label=Buffer.from(`<svg width="480" height="34"><rect width="480" height="34" fill="#203b2d"/><text x="14" y="24" font-family="Arial" font-size="19" fill="#f5f3e9">${t.toFixed(2)}s</text></svg>`);
   const tile=await sharp(frame).resize(480,270).extend({bottom:34,background:'#203b2d'}).composite([{input:label,left:0,top:270}]).jpeg().toBuffer();
   tiles.push({input:tile,left:(i%4)*480,top:Math.floor(i/4)*304});
  }
  await sharp({create:{width:1920,height:912,channels:3,background:'#203b2d'}}).composite(tiles).jpeg({quality:90}).toFile(path.join(dir,'contact-sheet.jpg'));
  fs.copyFileSync(path.join(dir,'frame-02.jpg'),path.join(root,c.key+'-poster.jpg'));
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify(meta,null,2));
  reviews.push({...c,dimensions:[v.width,v.height],frames:v.nb_frames,bytes:meta.format.size,sha256:crypto.createHash('sha256').update(fs.readFileSync(video)).digest('hex'),decode:'passed',blackFrames:'none'});
  console.log(c.key+': '+meta.format.duration+'s, decode and black-frame checks passed');
 }
 fs.writeFileSync(path.join(root,'qa/render-checks.json'),JSON.stringify(reviews,null,2));
})();
