import cv2,json
p='tools/demo/real-app-rebuild/source/autodoc-native-take1.mov'
c=cv2.VideoCapture(p);rows=[];first=None
while True:
 ok,im=c.read()
 if not ok:break
 t=c.get(cv2.CAP_PROP_POS_MSEC)/1000
 underline=float(im[319:321,600:710].mean())
 if underline<100 and first is None:first=t
 if int(t*10)%10==0:rows.append([round(t,3),round(underline,1)])
c.release()
print('First native Transcript underline:',first)
print('Samples:',rows[:30])
open('tools/demo/real-app-rebuild/out/native-measurement.json','w').write(json.dumps({'firstTranscriptSeconds':first,'samples':rows},indent=2))
