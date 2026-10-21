import React from 'react';
import {AbsoluteFill,Composition,registerRoot} from 'remotion';
import {C,FontGate} from './system';
import {Product} from './scenes/Product';
import {Ending} from './scenes/Ending';
const Film:React.FC=()=> <FontGate><AbsoluteFill style={{background:C.paper,color:C.ink,fontFamily:'DM Sans',overflow:'hidden'}}><Product/><Ending/></AbsoluteFill></FontGate>;
const Root:React.FC=()=> <><Composition id="AutoDocAd" component={Film} fps={60} width={1920} height={1080} durationInFrames={1020}/><Composition id="AutoDocAdSamples" component={Film} fps={120} width={1920} height={1080} durationInFrames={2040}/></>;
registerRoot(Root);
