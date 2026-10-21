const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=__dirname,out=path.join(root,'out');
const run=args=>new Promise((resolve,reject)=>{const p=spawn('ffmpeg',['-y','-hide_banner','-loglevel','error',...args]);let err='';p.stderr.on('data',d=>err+=d);p.on('exit',c=>c?reject(Error(err)):resolve());});
const native=path.resolve(root,'../../../final/real-app-review/autodoc-native-raw.mp4');
const prepared="crop=2560:1536:0:64,pad=2880:1620:160:42:color=0xFAFAF7,scale=5760:3240:flags=bicubic";
const ease='(1-pow(1-clip((on-24)/60,0,1),3))';
const z=`(1+(2.322580645-1)*${ease})`;
const x=`(2880+(3280-2880)*${ease}-iw/(2*zoom))`;
const y=`(1620+(1393.5-1620)*${ease}-ih/(2*zoom))`;
const enc=['-an','-c:v','libx264','-crf','16','-preset','fast','-threads','4','-pix_fmt','yuv420p','-r','60','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv'];
async function main(){
 fs.mkdirSync(out,{recursive:true});
 fs.mkdirSync(path.resolve(root,'../../../final/real-app-review'),{recursive:true});
 await Promise.all([
  run(['-loop','1','-framerate','60','-i',path.join(out,'intro-card.png'),'-t','2.5',...enc,path.join(out,'intro-picture.mp4')]).then(()=>console.log('Opening rendered')),
  run(['-ss','4.2','-i',native,'-t','4.8','-vf',`fps=60,${prepared},zoompan=z='${z}':x='${x}':y='${y}':d=1:s=1920x1080:fps=60,setsar=1`,...enc,path.join(out,'notes-picture.mp4')]).then(()=>console.log('Native note shot rendered')),
  run(['-ss','9.2','-i',native,'-t','5.7','-vf',`fps=60,${prepared},zoompan=z='1.09':x='2880-iw/(2*zoom)':y='1670-ih/(2*zoom)':d=1:s=1920x1080:fps=60,setsar=1`,...enc,path.join(out,'replay-picture.mp4')]).then(()=>console.log('Native replay shot rendered')),
  run(['-loop','1','-framerate','60','-i',path.join(out,'end-card.png'),'-t','3',...enc,path.join(out,'end-picture.mp4')]).then(()=>console.log('Brand ending rendered'))
 ]);
 fs.writeFileSync(path.join(out,'concat.txt'),['intro','notes','replay','end'].map(n=>`file '${n}-picture.mp4'`).join('\n'));
 const dest=path.resolve(root,'../../../final/real-app-review/autodoc-real-app-silent.mp4');
 await run(['-f','concat','-safe','0','-i',path.join(out,'concat.txt'),'-map','0:v:0','-c:v','copy','-an','-bsf:v','h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-movflags','+faststart',dest]);
 console.log('Rendered',dest);
}
main().catch(e=>{console.error(e);process.exitCode=1});
