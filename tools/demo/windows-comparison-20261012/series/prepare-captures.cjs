const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process');
const root=__dirname,ffmpeg=path.join(root,'../research/bin/ffmpeg.exe');
const publicDir=path.join(root,'../future-you/public/series');fs.mkdirSync(publicDir,{recursive:true});
const configs=[{key:'clicks',lead:2.5,native:9.7,intro:3,pull:6.8,duration:16.5},{key:'section',lead:1.7,native:8.4,intro:3.5,pull:5.3,duration:15.5},{key:'scroll',lead:1.7,native:7,intro:3.5,pull:4.8,duration:14}];
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest=[];
for(const c of configs){
 const log=fs.readFileSync(path.join(root,'qa',c.key+'-capture.log'),'utf8');
 const result=log.split(/\r?\n/).map(l=>{try{return JSON.parse(l)}catch{return null}}).find(x=>x?.event==='done'&&x.success);
 if(!result)throw new Error('Capture not completed: '+c.key);
 const start=Number(log.match(/"captureStartedAtMs":(\d+)/)?.[1]);
 const action=JSON.parse(fs.readFileSync(path.join(root,'qa',c.key+'-click.json'),'utf8'));
 const expected=(action.beforeMs-start)/1000;
 const raw=path.join(root,'assets',c.key+'-native-raw.mp4');fs.copyFileSync(result.screenVideoPath,raw);
 const pixels=execFileSync(ffmpeg,['-v','error','-i',raw,'-vf','fps=30,crop=4:4:240:250,scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 let frame=-1;
 for(let i=Math.max(0,Math.floor((expected-.5)*30));i<pixels.length/3;i++)if(pixels[i*3]<100&&pixels[i*3+1]<140&&pixels[i*3+2]<110){frame=i;break;}
 if(frame<0)throw new Error('Could not find actual native playback transition: '+c.key);
 const visible=frame/30,trim=Math.max(0,visible-c.lead);
 const out=path.join(publicDir,c.key+'-native.mp4');
 execFileSync(ffmpeg,['-v','error','-y','-ss',trim.toFixed(6),'-i',raw,'-t',String(c.native),'-vf','fps=30','-an','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart',out]);
 // Original local accents, synchronized to this film's actual reveal.
 const sr=48000,pcm=new Float64Array(Math.round(sr*c.duration));
 const pluck=(time,hz,gain,length=.25)=>{const start=Math.round(time*sr);for(let i=0;i<sr*length&&start+i<pcm.length;i++){const t=i/sr,env=Math.min(1,t/.006)*Math.exp(-t*14)*Math.min(1,(length-t)/.02);pcm[start+i]+=gain*env*(Math.sin(2*Math.PI*hz*t)+.16*Math.sin(2*Math.PI*hz*2*t));}};
 pluck(.16,392,.11);pluck(c.key==='clicks'?.85:1.1,294,.09);if(c.key==='scroll')pluck(2.1,246.94,.08);
 pluck(c.intro,196,.07);pluck(c.intro+c.lead,880,.07,.12);pluck(c.intro+c.lead+.2,523.25,.06);
 pluck(c.intro+c.pull+.3,392,.08);pluck(c.intro+c.pull+.8,523.25,.08);pluck(c.intro+c.pull+1.5,659.25,.075);
 pluck(c.intro+c.native+.04,261.63,.06,.8);pluck(c.intro+c.native+.12,392,.055,.8);pluck(c.intro+c.native+.23,523.25,.05,.8);
 const buffer=Buffer.alloc(44+pcm.length*2);buffer.write('RIFF',0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(sr,24);buffer.writeUInt32LE(sr*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(pcm.length*2,40);
 for(let i=0;i<pcm.length;i++)buffer.writeInt16LE(Math.round(Math.max(-1,Math.min(1,pcm[i]))*32767),44+i*2);
 fs.writeFileSync(path.join(publicDir,c.key+'-sound.wav'),buffer);
 manifest.push({...c,raw:path.relative(root,raw),rawSha256:hash(raw),captureStartedAtMs:start,action,firstPlaybackFrame:frame,firstPlaybackSeconds:visible,trimStartSeconds:trim,asset:'../future-you/public/series/'+c.key+'-native.mp4',assetSha256:hash(out),speed:1,fixture:'assets/'+c.key+'-meeting.mp4',seededNotes:true});
 console.log(c.key+': genuine playback reveal at '+(c.intro+c.lead)+'s');
}
fs.writeFileSync(path.join(root,'ASSET-MANIFEST.json'),JSON.stringify({method:'Real native AutoDoc captures with original fictional meeting recordings and seeded notes; no AI generation or transcription pipeline demonstrated.',stories:manifest},null,2));
