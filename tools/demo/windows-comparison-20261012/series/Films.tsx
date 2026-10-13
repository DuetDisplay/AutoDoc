import {AbsoluteFill, Composition, Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
type Variant = 'clicks' | 'section' | 'scroll';
type Props = {variant: Variant};
const cream='#f5f3e9', ink='#203b2d', sage='#769276', lime='#dce9c7';
const ease={extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.out(Easing.cubic)} as const;
const stories={
  clicks:{intro:3,native:9.7,close:3.8,lead:2.5,pull:6.8,label:'THE SETTINGS WALKTHROUGH',before:'The note remembers the setting.',after:'Replay the clicks that got you there.',right:'Oh.',answer:'Those clicks.',thanks:'Got it. Again.',benefit:'Less “wait, how?”',end:'Replay the how.',sub:'The steps. Exactly as they were shown.'},
  section:{intro:3.5,native:8.4,close:3.6,lead:1.7,pull:5.3,label:'THE DOCUMENT REVIEW',before:'“This section.” Excellent coordinates.',after:'The paragraph they actually meant.',right:'Ah.',answer:'This section.',thanks:'Much more helpful.',benefit:'Context beats guesswork.',end:'Find the “this.”',sub:'Revisit the words. And what they pointed at.'},
  scroll:{intro:3.5,native:7,close:3.5,lead:1.7,pull:4.8,label:'THE SCROLLING ENCORE',before:'There was a date in there. Somewhere.',after:'Go back to the moment. On your time.',right:'Found it.',answer:'No encore.',thanks:'Everyone may carry on.',benefit:'One replay. Zero interruptions.',end:'Skip the encore.',sub:'Your meeting. Ready when you need it.'},
};
const Brand=({dark=false}:{dark?:boolean})=><div style={{display:'flex',alignItems:'center',gap:14,fontSize:28,fontWeight:600,color:dark?cream:ink}}><div style={{display:'flex',alignItems:'center',gap:5,height:28}}><i style={{width:5,height:14,background:sage,borderRadius:3}}/><i style={{width:5,height:27,background:sage,borderRadius:3}}/><i style={{width:5,height:19,background:sage,borderRadius:3}}/></div>AutoDoc</div>;
const Bubble=({children,light=false,style={}}:{children:React.ReactNode,light?:boolean,style?:React.CSSProperties})=><div style={{display:'inline-block',background:light?lime:ink,color:light?ink:cream,borderRadius:light?'38px 38px 7px 38px':'38px 38px 38px 7px',padding:'35px 48px',letterSpacing:-4,...style}}>{children}</div>;

const Hook=({variant}:Props)=>{
 const f=useCurrentFrame(),{fps}=useVideoConfig();
 return <AbsoluteFill style={{background:cream,color:ink,padding:'76px 120px'}}><Brand/>
  {variant==='clicks'?<>
   <div style={{position:'absolute',left:210,top:220,rotate:'-2deg',translate:`0 ${interpolate(f,[0,.28*fps],[25,0],ease)}px`}}><div style={{fontSize:25,letterSpacing:3,margin:'0 0 22px 30px',color:'#647361'}}>YOU, DURING THE CALL</div><Bubble style={{fontSize:125}}>Got it.</Bubble></div>
   <div style={{position:'absolute',right:170,top:525,rotate:'1.5deg',opacity:interpolate(f,[.8*fps,1*fps],[0,1],ease),translate:`0 ${interpolate(f,[.8*fps,1.15*fps],[28,0],ease)}px`}}><div style={{fontSize:25,letterSpacing:3,textAlign:'right',margin:'0 28px 20px 0',color:'#647361'}}>YOU, TEN MINUTES LATER</div><Bubble light style={{fontSize:89,lineHeight:1.08}}>I remember none<br/>of the clicks.</Bubble></div>
  </>:variant==='section'?<>
   <div style={{position:'absolute',left:180,top:200}}><div style={{fontSize:50,letterSpacing:-1,marginBottom:28}}>My notes say</div><Bubble style={{fontSize:102,rotate:'-1.5deg'}}>“change this section.”</Bubble></div>
   <div style={{position:'absolute',right:185,top:625,opacity:interpolate(f,[1.6*fps,1.8*fps],[0,1],ease)}}><Bubble light style={{fontSize:99,rotate:'1.5deg'}}>Very helpful.</Bubble></div>
  </>:<>
   <div style={{position:'absolute',left:160,top:205,rotate:'-1.5deg'}}><div style={{fontSize:25,letterSpacing:4,margin:'0 0 22px 30px',color:'#647361'}}>EVERY MEETING, AT SOME POINT</div><Bubble style={{fontSize:93}}>Can you scroll back up?</Bubble></div>
   <div style={{position:'absolute',right:180,top:510,rotate:'1deg',opacity:interpolate(f,[1.05*fps,1.2*fps],[0,1],ease)}}><Bubble light style={{fontSize:87}}>Up a bit.</Bubble></div>
   <div style={{position:'absolute',right:490,top:750,rotate:'-2deg',opacity:interpolate(f,[2.05*fps,2.2*fps],[0,1],ease)}}><Bubble style={{fontSize:80,padding:'25px 44px'}}>Too far.</Bubble></div>
  </>}
 </AbsoluteFill>;
};

const Native=({variant}:Props)=>{
 const c=stories[variant],f=useCurrentFrame(),{fps}=useVideoConfig();
 const zoom=interpolate(f,[.2*fps,.7*fps],[0,1],ease);
 const pull=interpolate(f,[c.pull*fps,(c.pull+.42)*fps],[0,1],{...ease,easing:Easing.inOut(Easing.cubic)});
 return <AbsoluteFill style={{background:cream,color:ink}}>
  <div style={{position:'absolute',left:120,top:62}}><Brand/></div><div style={{position:'absolute',right:120,top:70,fontSize:22,letterSpacing:3,color:'#647361'}}>{c.label}</div>
  <div style={{position:'absolute',left:interpolate(pull,[0,1],[220,120]),top:interpolate(pull,[0,1],[145,210]),width:interpolate(pull,[0,1],[1480,1030]),height:interpolate(pull,[0,1],[790,675]),borderRadius:22,overflow:'hidden',background:'#fbfbf7',boxShadow:'0 28px 65px #1e382b25',border:'1px solid #d9ddcf'}}>
   <OffthreadVideo src={staticFile(`series/${variant}-native.mp4`)} muted style={{position:'absolute',width:1086,height:714,transformOrigin:'0 0',scale:interpolate(pull,[0,1],[1.107+.593*zoom,.946]),left:interpolate(pull,[0,1],[139-479*zoom,0]),top:interpolate(pull,[0,1],[-420*zoom,0])}}/>
  </div>
  <div style={{position:'absolute',bottom:56,width:'100%',textAlign:'center',fontSize:43,letterSpacing:-1.1,opacity:1-pull}}>{f<(c.lead+.2)*fps?c.before:c.after}</div>
  <div style={{position:'absolute',left:1210,top:310,width:630,opacity:interpolate(f,[(c.pull+.3)*fps,(c.pull+.48)*fps],[0,1],ease)}}>
   <div style={{fontSize:25,letterSpacing:4,color:'#667861',marginBottom:30}}>{variant==='scroll'?'YOU, AFTER THE CALL':'YOU, WITH CONTEXT'}</div>
   <div style={{fontSize:110,letterSpacing:-5,lineHeight:1.12}}>{c.right}</div>
   <div style={{fontSize:variant==='scroll'?99:95,letterSpacing:-5,lineHeight:1.15,fontFamily:'Georgia',fontStyle:'italic',color:sage,opacity:interpolate(f,[(c.pull+.8)*fps,(c.pull+1)*fps],[0,1],ease)}}>{c.answer}</div>
   <div style={{marginTop:46,display:'inline-block',background:lime,borderRadius:'24px 24px 4px 24px',padding:'22px 27px',fontSize:variant==='scroll'?31:34,rotate:'-2deg',opacity:interpolate(f,[(c.pull+1.5)*fps,(c.pull+1.7)*fps],[0,1],ease)}}>{c.thanks}</div>
  </div>
  <div style={{position:'absolute',left:128,bottom:111,fontSize:24,color:'#697666',opacity:pull}}>{c.benefit}</div>
 </AbsoluteFill>;
};

const End=({variant}:Props)=>{
 const c=stories[variant],f=useCurrentFrame(),{fps}=useVideoConfig();
 return <AbsoluteFill style={{background:ink,color:cream,padding:'82px 120px'}}><Brand dark/>
  <div style={{position:'absolute',left:180,top:300,fontSize:134,letterSpacing:-6,lineHeight:1.06,fontFamily:'Georgia',fontStyle:'italic',color:lime,translate:`0 ${interpolate(f,[0,.3*fps],[20,0],ease)}px`}}>{c.end}</div>
  <div style={{position:'absolute',left:187,top:530,fontSize:39,color:'#d1dccb',opacity:interpolate(f,[.25*fps,.45*fps],[0,1],ease)}}>{c.sub}</div>
  <div style={{position:'absolute',left:180,right:180,bottom:145,paddingTop:32,borderTop:'1px solid #5c7560',display:'flex',justifyContent:'space-between',alignItems:'center',opacity:interpolate(f,[.5*fps,.7*fps],[0,1],ease)}}><div style={{fontSize:28,color:'#bdccb5'}}>A favor for future you.</div><div style={{fontSize:42,color:lime}}>getautodoc.com <span style={{marginLeft:24}}>↗</span></div></div>
 </AbsoluteFill>;
};

const Film=({variant}:Props)=>{
 const c=stories[variant],{fps}=useVideoConfig();
 return <AbsoluteFill style={{fontFamily:'Arial'}}>
  <Sequence name="The familiar problem" durationInFrames={Math.round(c.intro*fps)} premountFor={fps}><Hook variant={variant}/></Sequence>
  <Sequence name="Real native AutoDoc replay and payoff" from={Math.round(c.intro*fps)} durationInFrames={Math.round(c.native*fps)} premountFor={fps}><Native variant={variant}/></Sequence>
  <Sequence name="Benefit and AutoDoc" from={Math.round((c.intro+c.native)*fps)} durationInFrames={Math.round(c.close*fps)} premountFor={fps}><End variant={variant}/></Sequence>
  <Audio src={staticFile(`series/${variant}-sound.wav`)} premountFor={fps}/>
 </AbsoluteFill>;
};
export const SeriesCompositions=()=> <>
 <Composition id="RememberTheClicks" component={Film} defaultProps={{variant:'clicks'}} durationInFrames={495} fps={30} width={1920} height={1080}/>
 <Composition id="ChangeThisSection" component={Film} defaultProps={{variant:'section'}} durationInFrames={465} fps={30} width={1920} height={1080}/>
 <Composition id="ScrollBackUp" component={Film} defaultProps={{variant:'scroll'}} durationInFrames={420} fps={30} width={1920} height={1080}/>
</>;
