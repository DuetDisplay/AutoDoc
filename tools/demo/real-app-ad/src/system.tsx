import React, {useEffect, useState} from 'react';
import {Img, interpolate, staticFile, useDelayRender} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {E} from './lib/anim';
export {E} from './lib/anim';

loadFont({family:'DM Sans',url:staticFile('fonts/dm-sans.woff2'),weight:'100 1000'});
// cinetic:brand-supplied AutoDoc's existing Instrument Serif wordmark.
loadFont({family:'Instrument Serif',url:staticFile('fonts/instrument-serif.ttf'),weight:'400'});
export const C={paper:'#FAFAF7',ink:'#1B2821',sage:'#7A9E7E',deep:'#49674E',line:'#D9E2D8',mute:'#748072'};
export const T={zoomIn:132,zoomDone:270,cursorIn:258,cursorLand:290,click:354,relay:366,splitDone:456,hero:696,heroDone:804,out:828,end:852,total:1020};
export const p=(f:number,a:number,b:number,e=E.smooth)=>interpolate(f,[a,b],[0,1],{easing:e,extrapolateLeft:'clamp',extrapolateRight:'clamp'});
export const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
export const logmix=(a:number,b:number,t:number)=>Math.exp(mix(Math.log(a),Math.log(b),t));
export type Point={x:number;y:number};
export type Shot={ax:number;ay:number;sx:number;sy:number;k:number};
export type Rect={x:number;y:number;w:number;h:number};
export const blend=(a:Shot,b:Shot,t:number):Shot=>({ax:mix(a.ax,b.ax,t),ay:mix(a.ay,b.ay,t),sx:mix(a.sx,b.sx,t),sy:mix(a.sy,b.sy,t),k:logmix(a.k,b.k,t)});
export const rect=(a:Rect,b:Rect,t:number):Rect=>({x:mix(a.x,b.x,t),y:mix(a.y,b.y,t),w:mix(a.w,b.w,t),h:mix(a.h,b.h,t)});
export const project=(c:Shot,q:Point):Point=>({x:c.sx+(q.x-c.ax)*c.k,y:c.sy+(q.y-c.ay)*c.k});
export const PIN={x:1014,y:715};
export const INITIAL:Shot={ax:1280,ay:832,sx:1425,sy:555,k:.45};
export const MACRO:Shot={ax:1350,ay:680,sx:960,sy:580,k:1.15};
export const NOTE:Shot={ax:900,ay:590,sx:110,sy:420,k:1};
export const noteCamera=(f:number)=>blend(blend(INITIAL,MACRO,p(f,T.zoomIn,T.zoomDone,E.cam)),NOTE,p(f,T.relay,T.splitDone,E.cam));
export const noteAperture=(f:number)=>rect(rect({x:849,y:209,w:1152,h:691.2},{x:170,y:440,w:1580,h:330},p(f,T.zoomIn,T.zoomDone,E.cam)),{x:110,y:420,w:800,h:260},p(f,T.relay,T.splitDone,E.cam));
export const at=(x:number,y:number):React.CSSProperties=>({position:'absolute',left:0,top:0,transform:`translate(${x}px,${y}px)`});
export const FontGate:React.FC<{children:React.ReactNode}>=({children})=>{
 const {delayRender,continueRender,cancelRender}=useDelayRender();
 const [h]=useState(()=>delayRender('AutoDoc brand fonts')); const [ready,setReady]=useState(false);
 // cinetic:brand-supplied Instrument Serif is used only for AutoDoc's existing wordmark.
 useEffect(()=>{Promise.all(['500 32px "DM Sans"','600 96px "DM Sans"','400 100px "Instrument Serif"'].map(f=>document.fonts.load(f))).then(()=>document.fonts.ready).then(()=>{setReady(true);continueRender(h);}).catch(cancelRender);},[h,continueRender,cancelRender]);
 return ready?<>{children}</>:null;
};
export const NativeNotes:React.FC<{camera:Shot;aperture:Rect;opacity?:number}>=({camera:c,aperture:r,opacity=1})=><div style={{...at(r.x,r.y),width:r.w,height:r.h,overflow:'hidden',borderRadius:14,opacity,background:C.paper,boxShadow:'0 22px 65px rgba(0,0,0,.08)',border:`1px solid ${C.line}`}}>
 <div style={{...at(c.sx-r.x,c.sy-r.y),transformOrigin:'0 0',transform:`translate(${c.sx-r.x}px,${c.sy-r.y}px) scale(${c.k}) translate(${-c.ax}px,${-c.ay}px)`,width:2560,height:1600}}><Img src={staticFile('native/notes.png')} style={{width:2560,height:1600,display:'block'}}/></div>
</div>;
export const Reveal:React.FC<{children:React.ReactNode;f:number;start:number;size:number;color?:string}>=({children,f,start,size,color=C.ink})=>{
 const a=p(f,start,start+42,E.out);
 return <div style={{overflow:'hidden',paddingBottom:8}}><div style={{fontSize:size,fontWeight:550,lineHeight:1.09,letterSpacing:'-.052em',color,opacity:a,transform:`translateY(${Math.round((1-a)*size*.55)}px)`}}>{children}</div></div>;
};
export const Mark:React.FC<{size:number;f?:number}>=({size,f=999})=><svg width={size} height={size} viewBox="0 0 560 564" fill={C.sage}>{[[0,154,80,256],[160,0,80,564],[320,70,80,424],[480,200,80,164]].map(([x,y,w,h],i)=><rect key={i} x={x} y={y+(1-p(f,i*7,i*7+28,E.out))*h*.35} width={w} height={h*p(f,i*7,i*7+28,E.out)} rx={40}/>)}</svg>;
