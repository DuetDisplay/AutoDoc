import {AbsoluteFill, Composition, Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';

const cream = '#f5f3e9', ink = '#203b2d', sage = '#769276', lime = '#dce9c7';
const ease = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)} as const;
const Brand = ({dark = false}: {dark?: boolean}) => <div style={{display: 'flex', alignItems: 'center', gap: 14, fontSize: 28, fontWeight: 600, letterSpacing: -.5, color: dark ? cream : ink}}><div style={{display: 'flex', alignItems: 'center', gap: 5, height: 28}}><i style={{width: 5, height: 14, background: sage, borderRadius: 3}}/><i style={{width: 5, height: 27, background: sage, borderRadius: 3}}/><i style={{width: 5, height: 19, background: sage, borderRadius: 3}}/></div>AutoDoc</div>;

export const Opening = () => {
  const f = useCurrentFrame(); const {fps} = useVideoConfig();
  return <AbsoluteFill style={{background: cream, color: ink, padding: '76px 120px'}}>
    <Brand/>
    <div style={{position: 'absolute', left: 210, top: 220, rotate: '-2deg', translate: `0 ${interpolate(f, [0, .32 * fps], [26, 0], ease)}px`, opacity: interpolate(f, [0, .18 * fps], [0, 1], ease)}}>
      <div style={{fontSize: 25, letterSpacing: 4, margin: '0 0 22px 35px', color: '#647361'}}>YESTERDAY YOU</div>
      <div style={{padding: '43px 58px', background: ink, borderRadius: '40px 40px 40px 8px', color: cream, fontSize: 111, letterSpacing: -5, boxShadow: '0 18px 0 #203b2d0a'}}>I’ll remember.</div>
    </div>
    <div style={{position: 'absolute', right: 170, top: 555, rotate: '1.5deg', opacity: interpolate(f, [1.15 * fps, 1.32 * fps], [0, 1], ease), translate: `0 ${interpolate(f, [1.15 * fps, 1.47 * fps], [35, 0], ease)}px`}}>
      <div style={{fontSize: 25, letterSpacing: 4, margin: '0 30px 22px 0', textAlign: 'right', color: '#647361'}}>TODAY YOU</div>
      <div style={{padding: '39px 52px', background: lime, border: '2px solid #cbd8bb', borderRadius: '40px 40px 8px 40px', fontSize: 97, letterSpacing: -4}}>Which version?</div>
    </div>
  </AbsoluteFill>;
};

export const RealFootage = () => {
  const f = useCurrentFrame(); const {fps} = useVideoConfig();
  const zoom = interpolate(f, [.35 * fps, 1.05 * fps], [0, 1], ease);
  const pullback = interpolate(f, [5.3 * fps, 5.75 * fps], [0, 1], {...ease, easing: Easing.inOut(Easing.cubic)});
  const scale = interpolate(pullback, [0, 1], [1.107 + .593 * zoom, .946]);
  const caption = f < 2 * fps ? 'The note says “this version.”' : f < 3.2 * fps ? 'Past you left a timestamp.' : 'And the whole picture.';
  return <AbsoluteFill style={{background: cream, color: ink}}>
    <div style={{position: 'absolute', left: 120, top: 62}}><Brand/></div>
    <div style={{position: 'absolute', right: 120, top: 70, fontSize: 22, letterSpacing: 3, color: '#647361'}}>A FAVOR FOR FUTURE YOU</div>
    <div style={{position: 'absolute', left: interpolate(pullback, [0, 1], [220, 120]), top: interpolate(pullback, [0, 1], [145, 210]), width: interpolate(pullback, [0, 1], [1480, 1030]), height: interpolate(pullback, [0, 1], [790, 675]), borderRadius: 22, overflow: 'hidden', background: '#fbfbf7', boxShadow: '0 28px 65px #1e382b25', border: '1px solid #d9ddcf'}}>
      <OffthreadVideo src={staticFile('native-recall.mp4')} trimBefore={fps} muted style={{position: 'absolute', width: 1086, height: 714, transformOrigin: '0 0', scale, left: interpolate(pullback, [0, 1], [139 - 479 * zoom, 0]), top: interpolate(pullback, [0, 1], [-420 * zoom, 0])}}/>
    </div>
    <div style={{position: 'absolute', bottom: 56, width: '100%', textAlign: 'center', fontSize: 43, letterSpacing: -1.1, opacity: 1 - pullback}}>{caption}</div>
    <div style={{position: 'absolute', left: 1240, top: 300, width: 590, opacity: interpolate(f, [5.65 * fps, 5.85 * fps], [0, 1], ease)}}>
      <div style={{fontSize: 26, letterSpacing: 4, color: '#667861', marginBottom: 30}}>TODAY YOU</div>
      <div style={{fontSize: 119, letterSpacing: -6, lineHeight: 1.12}}>Right.</div>
      <div style={{fontSize: 119, letterSpacing: -6, lineHeight: 1.12, fontFamily: 'Georgia', fontStyle: 'italic', color: sage, opacity: interpolate(f, [6.2 * fps, 6.4 * fps], [0, 1], ease), translate: `0 ${interpolate(f, [6.2 * fps, 6.5 * fps], [18, 0], ease)}px`}}>That one.</div>
      <div style={{marginTop: 56, display: 'inline-block', background: lime, borderRadius: '24px 24px 4px 24px', padding: '23px 28px', fontSize: 36, rotate: '-2deg', opacity: interpolate(f, [7.05 * fps, 7.25 * fps], [0, 1], ease)}}>Thanks, past me.</div>
    </div>
    <div style={{position: 'absolute', left: 128, bottom: 111, fontSize: 24, color: '#697666', opacity: pullback}}>A little context goes a long way.</div>
  </AbsoluteFill>;
};

export const Closing = () => {
  const f = useCurrentFrame(); const {fps} = useVideoConfig();
  return <AbsoluteFill style={{background: ink, color: cream, padding: '82px 120px'}}>
    <Brand dark/>
    <div style={{position: 'absolute', left: 180, top: 255, fontSize: 131, letterSpacing: -6, lineHeight: 1.06, translate: `0 ${interpolate(f, [0, .5 * fps], [22, 0], ease)}px`}}>A favor for<br/><span style={{fontFamily: 'Georgia', fontStyle: 'italic', color: lime}}>future you.</span></div>
    <div style={{position: 'absolute', left: 187, top: 620, fontSize: 39, letterSpacing: -.5, color: '#d1dccb', opacity: interpolate(f, [.3 * fps, .5 * fps], [0, 1], ease)}}>Revisit what was said. And shown.</div>
    <div style={{position: 'absolute', left: 180, right: 180, bottom: 136, paddingTop: 32, borderTop: '1px solid #5c7560', display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: interpolate(f, [.65 * fps, .85 * fps], [0, 1], ease)}}><div style={{fontSize: 26, color: '#bdccb5'}}>Meet your memory’s backup.</div><div style={{fontSize: 40, color: lime}}>getautodoc.com <span style={{marginLeft: 24}}>↗</span></div></div>
  </AbsoluteFill>;
};

export const Demo = () => {
  const {fps} = useVideoConfig();
  return <AbsoluteFill style={{fontFamily: 'Arial'}}>
    <Sequence name="Yesterday you / today you" durationInFrames={3 * fps} premountFor={fps}><Opening/></Sequence>
    <Sequence name="Real AutoDoc timestamp and recall" from={3 * fps} durationInFrames={9 * fps} premountFor={fps}><RealFootage/></Sequence>
    <Sequence name="A favor for future you" from={12 * fps} durationInFrames={4 * fps} premountFor={fps}><Closing/></Sequence>
    <Audio src={staticFile('sound-design-short.wav')} premountFor={fps}/>
  </AbsoluteFill>;
};

export const MyShortComposition = () => <Composition id="FutureYouShort" component={Demo} durationInFrames={480} fps={30} width={1920} height={1080}/>;
