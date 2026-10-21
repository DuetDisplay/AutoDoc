const path=require('node:path'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
const {bundle}=require('@remotion/bundler');
// The CLI owns its headless render process. A stopped export must not remain alive.
process.once('SIGTERM',()=>process.exit(143));
const {openBrowser,selectComposition,renderMedia,renderStill}=require('@remotion/renderer');
const root=__dirname,mode=process.argv[2]||'stills';
const executable=process.env.REMOTION_BROWSER||process.env.CHROMIUM_PATH;
async function main(){
 fs.mkdirSync(path.join(root,'out'),{recursive:true});
 const serveUrl=await bundle({entryPoint:path.join(root,'src/index.tsx'),publicDir:path.join(root,'public')});
 const opts={...(executable?{browserExecutable:executable}:{}),chromeMode:'headless-shell',chromiumOptions:{gl:'swangle'}};
 const browser=await openBrowser('chrome',opts);
 try{
  const c=await selectComposition({serveUrl,id:mode==='master'?'AutoDocAdSamples':'AutoDocAd',...opts,puppeteerInstance:browser});
  const base={composition:c,serveUrl,...opts,puppeteerInstance:browser,timeoutInMilliseconds:120000};
  if(mode==='stills'){
   for(const frame of (process.argv[3]?process.argv[3].split(',').map(Number):[0,75,175,270,325,354,370,410,456,550,700,790,870,960])){
    await renderStill({...base,frame,output:path.join(root,`out/frame-${frame}.png`),imageFormat:'png'});console.log('frame',frame);
   }
  }else{
   let last=-1;const temp=path.join(root,`out/${mode}.mp4`);
   await renderMedia({...base,codec:'h264',muted:true,crf:mode==='master'?16:20,scale:mode==='master'?1:.5,x264Preset:'fast',pixelFormat:'yuv420p',colorSpace:'bt709',jpegQuality:95,concurrency:4,outputLocation:temp,onProgress:({progress})=>{const x=Math.floor(progress*10);if(x!==last){last=x;console.log(mode,x*10+'%');}}});
   if(mode==='master'){
    const final=path.resolve(root,'../../../final/real-app-ad-review/autodoc-moment-ad.mp4');
    fs.mkdirSync(path.dirname(final),{recursive:true});
    const r=spawnSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-i',temp,'-vf','tmix=frames=2:weights=1 1,fps=60,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv','-an','-c:v','libx264','-crf','16','-preset','slow','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-movflags','+faststart',final],{encoding:'utf8'});
    if(r.status)throw Error(r.stderr);console.log('Master:',final);
   }
  }
 }finally{await browser.close({silent:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1});
