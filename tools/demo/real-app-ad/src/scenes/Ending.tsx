import React from 'react';
import {AbsoluteFill,useCurrentFrame,useVideoConfig} from 'remotion';
import {at,C,E,logmix,Mark,p,Reveal,T} from '../system';
// cinetic:brand-supplied AutoDoc's existing wordmark uses Instrument Serif.
const wordmarkStyle:React.CSSProperties={fontFamily:'Instrument Serif',fontSize:128,lineHeight:1,letterSpacing:'-.04em'};
export const Ending:React.FC=()=>{
 const raw=useCurrentFrame(),{fps}=useVideoConfig(),f=raw/(fps/60),a=p(f,T.end,T.end+36,E.out),k=logmix(1,1.04,p(f,T.end,T.total,E.smooth));
 return <AbsoluteFill style={{opacity:a,overflow:'hidden'}}>
  <div style={{...at(960,490),transformOrigin:'0 0',transform:`translate(960px,${490+26*(1-a)}px) scale(${k}) translate(-960px,-490px)`}}>
   <div style={{...at(0,348),width:1920,display:'flex',gap:26,alignItems:'center',justifyContent:'center'}}><Mark size={80} f={f-T.end}/><div style={wordmarkStyle}>AutoDoc</div></div>
   <div style={{...at(0,542),width:1920,textAlign:'center'}}><Reveal f={f} start={T.end+30} size={76}>Capture the moment.</Reveal></div>
   <div style={{...at(0,711),width:1920,textAlign:'center',fontSize:30,color:C.deep,opacity:p(f,T.end+45,T.end+70,E.out)}}>getautodoc.com</div>
  </div>
 </AbsoluteFill>;
};
