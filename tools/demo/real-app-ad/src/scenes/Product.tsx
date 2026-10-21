import React from 'react';
import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {Video} from '@remotion/media';
import {staticFile} from 'remotion';
import {at,C,E,mix,NativeNotes,noteAperture,noteCamera,p,PIN,Point,project,Rect,Reveal,T} from '../system';

const arc=(a:Point,b:Point,t:number)=>{
 const cx=(a.x+b.x)/2-(b.y-a.y)*.18,cy=(a.y+b.y)/2+(b.x-a.x)*.18;
 return {x:(1-t)**2*a.x+2*(1-t)*t*cx+t*t*b.x,y:(1-t)**2*a.y+2*(1-t)*t*cy+t*t*b.y};
};
const Cursor:React.FC<{f:number;pin:Point}>=({f,pin})=>{
 const q=arc({x:1320,y:940},pin,p(f,T.cursorIn,T.cursorLand,E.out));
 const press=f<T.click?0:1-p(f,T.click,T.click+10,E.out);
 const opacity=p(f,T.cursorIn-8,T.cursorIn,E.smooth)*(1-p(f,T.click+12,T.click+24,E.smooth));
 return <div style={{...at(q.x,q.y),opacity,transformOrigin:'0 0',transform:`translate(${q.x}px,${q.y}px) scale(${1.35*(1-.12*press)})`,filter:'drop-shadow(0 3px 4px #0003)'}}>
  <svg width={30} height={42} viewBox="0 0 30 42" style={{position:'absolute',left:-3,top:-2}}><path d="M3 2V33L10.2 26.4 15 38 20.2 35.8 15.4 24.4H25Z" fill="#17211A" stroke="white" strokeWidth={2.4} strokeLinejoin="round"/></svg>
 </div>;
};
const replayRect=(f:number):Rect=>{
 const a=p(f,T.relay,T.splitDone,E.cam),b=p(f,T.hero,T.heroDone,E.cam);
 return {x:mix(mix(1920,1040,a),300,b),y:mix(mix(370,340,a),192,b),w:mix(780,1320,b),h:mix(468,792,b)};
};
export const Product:React.FC=()=>{
 const raw=useCurrentFrame(),{fps}=useVideoConfig(),rate=fps/60,f=raw/rate;
 const exit=p(f,T.out,T.out+40,E.smooth);
 const cam=noteCamera(f),ap=noteAperture(f),pin=project(cam,PIN),r=replayRect(f);
 const lift=1-p(f,T.hero,T.hero+60,E.smooth);
 const ring=p(f,T.click,T.click+4,E.out)*(1-p(f,T.click+15,T.click+36,E.smooth));
 const link=p(f,T.splitDone-10,T.splitDone+30,E.smooth)*(1-p(f,T.hero,T.hero+30,E.smooth));
 const hero=p(f,T.hero,T.heroDone,E.cam),videoScale=r.w/mix(2560,2130,hero);
 return <AbsoluteFill style={{overflow:'hidden',opacity:1-exit}}>
  <div style={{...at(110,342-20*p(f,0,132,E.smooth)),width:720,opacity:1-p(f,T.zoomIn,T.zoomIn+55,E.smooth)}}>
   <Reveal f={f} start={-24} size={112}>The moment.</Reveal>
   <div style={{marginTop:14}}><Reveal f={f} start={35} size={100} color={C.deep}>One click away.</Reveal></div>
  </div>
  <NativeNotes camera={cam} aperture={ap} opacity={lift}/>
  <div style={{...at(170,320),opacity:p(f,230,260,E.out)*(1-p(f,T.click+15,T.click+45,E.smooth)),fontSize:32,color:C.deep,letterSpacing:'-.025em'}}>Click the timestamp.</div>
  {f<T.click+42&&<>
   <div style={{...at(pin.x,pin.y),width:78,height:50,borderRadius:13,border:`2px solid ${C.sage}`,opacity:p(f,T.cursorLand+10,T.cursorLand+30,E.smooth)*(1-p(f,T.click+20,T.click+40,E.smooth)),transform:`translate(${pin.x-35}px,${pin.y-25}px)`,background:`${C.sage}12`}}/>
   <svg width={1920} height={1080} style={{position:'absolute',left:0,top:0,pointerEvents:'none'}}><circle cx={pin.x} cy={pin.y} r={mix(12,48,p(f,T.click,T.click+35,E.out))} fill="none" stroke={C.sage} strokeWidth={3} opacity={ring}/></svg>
   <Cursor f={f} pin={pin}/>
  </>}
  {f>=T.click&&<>
   <div style={{...at(110,148),opacity:1-p(f,T.hero-20,T.hero+30,E.smooth)}}><Reveal f={f} start={400} size={86}>Back to the moment.</Reveal></div>
   <div style={{...at(1040,285),fontSize:28,color:C.deep,opacity:p(f,430,460,E.out)*lift}}>Recorded moment · <span style={{fontVariantNumeric:'tabular-nums'}}>0:15</span></div>
   <div style={{...at(r.x,r.y),width:r.w,height:r.h,overflow:'hidden',borderRadius:14,border:`1px solid ${C.line}`,boxShadow:'0 26px 70px rgba(0,0,0,.10)',background:C.paper}}>
    <div style={{position:'absolute',left:0,top:0,width:2560,height:1600,transformOrigin:'0 0',transform:`scale(${videoScale}) translate(${-420*hero}px,${-mix(64,250,hero)}px)`}}>
     <Sequence from={T.click*rate} layout="none"><Video src={staticFile('native/replay.mp4')} muted style={{width:2560,height:1600,display:'block'}}/></Sequence>
    </div>
   </div>
   <svg width={1920} height={1080} style={{position:'absolute',left:0,top:0,opacity:lift}}>
    <path d="M224 572 V750 Q224 790 264 790 H980 Q1020 790 1020 750 V620 Q1020 600 1040 600" pathLength={1} stroke={C.sage} strokeWidth={3} fill="none" strokeDasharray={1} strokeDashoffset={1-link}/>
    <circle cx={224} cy={545} r={33} fill="none" stroke={C.sage} strokeWidth={2} opacity={link}/>
    <circle cx={1040} cy={600} r={6} fill={C.sage} opacity={p(f,T.splitDone+20,T.splitDone+30,E.smooth)*lift}/>
   </svg>
  </>}
 </AbsoluteFill>;
};
