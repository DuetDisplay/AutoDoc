const fs=require('fs'),path=require('path'),{spawn,execFileSync}=require('child_process');
const sharp=require('../../../../node_modules/sharp');
const root=__dirname,repo=path.resolve(root,'../../../..');
const ffmpeg=require(path.join(repo,'node_modules/ffmpeg-static'));
const stories=[
 {key:'clicks',id:'b2000000-12ab-4567-89ab-123456789abc',title:'Workspace walkthrough',note:'Set notifications to mentions only',quote:'Settings, notifications, then only mentions. Save it there.',topic:'Workspace preferences',speaker:'Alex Lane'},
 {key:'section',id:'b3000000-12ab-4567-89ab-123456789abc',title:'Draft review',note:'Change this section',quote:'Change this section. Lead with the outcome, not the features.',topic:'Document edits',speaker:'Mira Reed'},
 {key:'scroll',id:'b5000000-12ab-4567-89ab-123456789abc',title:'Launch check-in',note:'Launch timing confirmed',quote:'Can you scroll back up? There—the launch date is Friday, October 16.',topic:'Launch schedule',speaker:'Jules Tran'},
];
const txt=(x,y,text,size=32,color='#203b2d',extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${text}</text>`;
const box=(x,y,w,h,fill,rx=18,extra='')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra}/>`;
function settings(t){
 const step=t<3?0:t<4.5?1:t<6?2:3;
 const px=[430,680,1210,1260][step],py=[350,350,650,825][step];
 return box(45,110,1510,845,'#f8f6ee')+txt(100,185,'FIELDNOTES / Workspace settings',40,'#657b60')+
 box(90,235,260,630,'#e8eadf')+txt(125,315,'General',30)+box(110,350,220,62,step>=1?'#dce9c7':'#e8eadf')+txt(125,392,'Notifications',30)+txt(125,475,'Appearance',30)+
 txt(420,310,'A little less noise.',66,'#203b2d','font-weight="bold"')+txt(425,375,'Choose what reaches your inbox.',34,'#63745d')+
 box(420,435,1050,115,'#eeeee6')+txt(455,505,'All workspace activity',42)+box(1315,466,105,48,step<2?'#769276':'#c8cec0',24)+box(step<2?1376:1321,472,36,36,'white',18)+
 box(420,575,1050,135,step>=2?'#dce9c7':'#eeeee6',18,step>=2?'stroke="#769276" stroke-width="4"':'')+txt(455,655,'Only mentions',48,'#203b2d','font-weight="bold"')+box(1315,617,105,48,step>=2?'#769276':'#c8cec0',24)+box(step>=2?1376:1321,623,36,36,'white',18)+
 box(1120,780,350,84,step>=3?'#dce9c7':'#203b2d',42)+txt(step>=3?1205:1170,835,step>=3?'Saved ✓':'Save changes',34,step>=3?'#203b2d':'#f8f6ee')+
 `<path d="M ${px} ${py} l 0 43 12 -10 10 22 12 -6 -11 -22 17 -3 z" fill="white" stroke="#203b2d" stroke-width="3"/>`;
}
function document(t){
 const selected=t>=2.7, newWords=t>=6;
 return box(45,110,1510,845,'#f8f6ee')+txt(110,185,'FIELDNOTES / Launch announcement',31,'#6d8064')+txt(110,285,'A better first paragraph.',70,'#203b2d','font-weight="bold"')+
 txt(110,365,'Draft 03 · Team review',29,'#6d8064')+
 box(95,425,1400,210,selected?'#dce9c7':'#eeeee6',18,selected?'stroke="#769276" stroke-width="4"':'')+
 txt(130,475,'OPENING PARAGRAPH',26,'#63745d','letter-spacing="3"')+
 txt(130,540,newWords?'Get the answer. Get back to your work.':'Our platform has search, filters, and integrations.',newWords?50:43,'#203b2d','font-weight="bold"')+
 txt(130,595,newWords?'Lead with the outcome. The features can follow.':'It brings a wide range of capabilities to your team.',36,'#506748')+
 txt(110,735,'What changes for the reader?',43,'#203b2d')+txt(110,802,'That belongs in the first line.',37,'#63745d')+
 (selected?box(1090,665,380,65,'#203b2d',32)+txt(1124,708,'REWRITE THIS BIT',27,'#f5f3e9'):'');
}
function scrolling(t){
 const scroll=t<2?260:t<4?260*(1-(t-2)/2):0;
 return box(45,110,1510,845,'#f8f6ee')+`<clipPath id="page"><rect x="70" y="125" width="1460" height="810" rx="15"/></clipPath><g clip-path="url(#page)"><g transform="translate(0 ${-scroll})">`+
 txt(110,205,'FIELDNOTES / Launch checklist',31,'#6d8064')+txt(110,300,'One date. Everyone aligned.',66,'#203b2d','font-weight="bold"')+
 box(95,355,1400,195,t>=4?'#dce9c7':'#eeeee6',18,t>=4?'stroke="#769276" stroke-width="4"':'')+txt(135,413,'LAUNCH DATE',27,'#63745d','letter-spacing="3"')+txt(135,493,'Friday, October 16',68,'#203b2d','font-weight="bold"')+
 txt(110,650,'01  Final copy review',42)+txt(110,750,'02  Homepage ready',42)+txt(110,850,'03  Launch email queued',42)+txt(110,950,'04  Support team briefed',42)+txt(110,1050,'05  Everyone gets some sleep',42)+`</g></g>`+
 box(1510,150,10,740,'#d8dece',5)+box(1510,155+scroll,10,210,'#809676',5);
}
function svg(story,t){
 let content=story.key==='clicks'?settings(t):story.key==='section'?document(t):scrolling(t);
 return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#1e3026"/><g font-family="Arial">${txt(60,64,story.title,32,'#e6eddf')}${txt(1530,64,'FICTIONAL HUDDLE',23,'#bccbb2')}${content}${['AL','MR','JT'].map((s,i)=>box(1600,130+i*260,270,220,'#2c4233',22,i===stories.indexOf(story)?'stroke="#a7c98b" stroke-width="4"':'')+`<circle cx="1735" cy="${210+i*260}" r="48" fill="${['#c5d5aa','#dec5a8','#b4c9d4'][i]}"/>`+txt(1701,225+i*260,s,38,'#203b2d','font-weight="bold"')+txt(1640,310+i*260,['Alex Lane','Mira Reed','Jules Tran'][i],27,'#e6eddf')).join('')}${txt(60,1035,'Original fictional meeting · No real people or accounts',25,'#c5d2bd')}</g></svg>`;
}
async function main(){
 for(const story of stories){
  const output=path.join(root,'assets',story.key+'-meeting.mp4');
  fs.writeFileSync(path.join(root,'assets',story.key+'-reference.svg'),svg(story,4.7));
  const proc=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate','30','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart',output],{stdio:['pipe','ignore','inherit']});
  const done=new Promise((res,rej)=>proc.on('exit',code=>code===0?res():rej(Error('encoder '+code))));
  for(let frame=0;frame<300;frame++){const png=await sharp(Buffer.from(svg(story,frame/30))).png().toBuffer();if(!proc.stdin.write(png))await new Promise(r=>proc.stdin.once('drain',r));}
  proc.stdin.end();await done;console.log('Made '+story.key);
 }
 const profile=path.join(root,'test-profile-series');fs.mkdirSync(profile,{recursive:true});
 fs.writeFileSync(path.join(profile,'autodoc-prefs.json'),JSON.stringify({onboardingComplete:true,launchAtLogin:false,analyticsConsent:false,diagnosticLogUploadConsent:false}));
 for(const [i,story] of stories.entries()){
  const dir=path.join(profile,'recordings',story.id);fs.mkdirSync(dir,{recursive:true});
  const write=(name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value,null,2));
  const startedAt=1791810000000+(2-i)*3600000;
  write('metadata.json',{sourceName:story.title,title:story.title,startedAt,stoppedAt:startedAt+10000,durationSeconds:10,videoStatus:'ready'});
  write('transcript.json',[{id:'t1',meetingId:story.id,speaker:story.speaker,text:'Let’s review this together.',startMs:0,endMs:1800,confidence:1},{id:'t2',meetingId:story.id,speaker:story.speaker,text:story.quote,startMs:2000,endMs:8500,confidence:1}]);
  write('segments.json',{decisions:[{id:'d1',meetingId:story.id,category:'decision',topic:story.topic,title:story.note,content:'“'+story.quote+'”',assignee:null,deadline:null,sourceStartMs:2000,sourceEndMs:8500}],actionItems:[],information:[],discussion:[],statusUpdates:[]});
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-i',path.join(root,'assets',story.key+'-meeting.mp4'),'-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','6','-crf','24','-b:v','0','-an',path.join(dir,'screen.webm')]);
 }
 fs.writeFileSync(path.join(root,'stories.json'),JSON.stringify(stories,null,2));
 const log=fs.openSync(path.join(root,'native-app.log'),'a');
 const env={...process.env,NODE_ENV:'test',AUTODOC_TEST_MODE:'1',AUTODOC_E2E:'1',AUTODOC_TEST_USER_DATA_DIR:profile,AUTODOC_SKIP_INSTALL_POLICY:'1'};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(path.join(repo,'node_modules/electron/dist/electron.exe'),[path.join(repo,'out/main/index.js'),'--autodoc-e2e-profile='+profile],{cwd:repo,env,stdio:['ignore',log,log],detached:true});child.unref();
 console.log('Isolated series AutoDoc PID '+child.pid);
}
main().catch(e=>{console.error(e);process.exit(1)});
