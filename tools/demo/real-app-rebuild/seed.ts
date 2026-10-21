import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {computeNotesRevision,computeTranscriptRevision,computeNotesAttributionRevision} from '../../../src/main/services/notes-revision';
import {parseMeetingNotesV2} from '../../../src/main/services/notes-schema';
const profile='/private/tmp/autodoc-real-footage-profile';
const meetingId='dceec478-0774-4d18-97e9-27543ff3d312';
const transcript=[
 {id:'review-1',meetingId,speaker:'me',text:'Let’s review the Duet homepage. The opening should show the product in action.',startMs:0,endMs:7500,confidence:1},
 {id:'review-2',meetingId,speaker:'them',text:'This is the image I mean. Keep the iPad shot as the opening visual. It shows how the second display works.',startMs:15000,endMs:21500,confidence:1},
 {id:'review-3',meetingId,speaker:'me',text:'Agreed. Use the iPad image first, then the product features. We’ll keep the page easy to scan.',startMs:22000,endMs:29000,confidence:1},
];
const block=(text:string,i:number)=>({text,sources:[{startMs:transcript[i].startMs,endMs:transcript[i].endMs}],provenance:'generated' as const});
const item=(id:string,text:string,i:number)=>({id,...block(text,i),title:null,topic:null,owner:null,deadline:null});
const content={overview:block('Review the Duet homepage. Lead with the product in action, then explain the features.',0),keyTakeaways:[item('takeaway-1','Lead with the product in action.',2)],sections:[{id:'section-1',title:'Opening visual',summary:null,keyPoints:[item('point-1','Use this iPad shot as the opening visual.',1)],supportingDetails:[]},{id:'section-2',title:'Page hierarchy',summary:null,keyPoints:[item('point-2','Show the product first, then explain the features.',2)],supportingDetails:[]},{id:'section-3',title:'Next review',summary:null,keyPoints:[item('point-3','Check the revised hero on desktop and mobile.',2)],supportingDetails:[]}],decisions:[item('decision-1','Show the iPad image before the feature list.',2)],nextSteps:[]};
const sourceTranscriptRevision=computeTranscriptRevision(meetingId,transcript),sourceAttributionRevision=computeNotesAttributionRevision(meetingId,transcript);
const notes={schemaVersion:2,meetingId,sourceTranscriptRevision,sourceAttributionRevision,revision:computeNotesRevision(meetingId,sourceTranscriptRevision,sourceAttributionRevision,content),...content};
parseMeetingNotesV2(notes,meetingId);
const dir=join(profile,'recordings',meetingId);mkdirSync(dir,{recursive:true});
const write=(file:string,data:unknown)=>writeFileSync(join(dir,file),JSON.stringify(data,null,2));
write('metadata.json',{sourceName:'Homepage review',customTitle:'Homepage review',startedAt:Date.parse('2026-10-20T14:00:00-04:00'),stoppedAt:Date.parse('2026-10-20T14:00:32-04:00'),durationSeconds:32});
write('transcript.json',transcript);write('notes.json',notes);
write('segments.json',{decisions:[],actionItems:[],information:[],discussion:[],statusUpdates:[]});
writeFileSync(join(profile,'autodoc-prefs.json'),JSON.stringify({onboardingComplete:true,onboardingStep:0,launchAtLogin:false,analyticsConsent:false,diagnosticLogUploadConsent:false,videoWatermarkVisible:true,experimentalSpeakerDiarization:false,lowSpecMacProcessingBannerDismissed:true,notesEngineUpgradeEligible:false,notesEngineReadyDismissed:true}));
console.log('Validated mock data in isolated real desktop profile',profile);
