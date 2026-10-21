from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
base=Path(__file__).resolve().parent
im=Image.new('RGB',(1920,1080),'#FAFAF7');d=ImageDraw.Draw(im)
f=ImageFont.truetype(str(base/'source/instrument-serif.ttf'),128);word='AutoDoc';bb=d.textbbox((0,0),word,font=f);tw=bb[2]-bb[0];x=(1920-(80+26+tw))/2;word_y=342
# Four exact bars from resources/icon.svg, scaled uniformly; native wordmark font.
scale=80/564;top=word_y+(bb[1]+bb[3])/2-40
for rx,ry,rw,rh in [(230,384,80,256),(390,230,80,564),(550,300,80,424),(710,430,80,164)]:
 xx=x+(rx-230)*scale;yy=top+(ry-230)*scale
 d.rounded_rectangle((xx,yy,xx+rw*scale,yy+rh*scale),radius=40*scale,fill='#7A9E7E')
d.text((x+106-bb[0],word_y),word,font=f,fill='#1A1A17')
for text,size,y,color in [('Capture the moment.',82,554,'#1A1A17'),('getautodoc.com',32,718,'#6A7169')]:
 font=ImageFont.truetype(str(base/'source/dm-sans.ttf'),size);bb=d.textbbox((0,0),text,font=font);d.text(((1920-(bb[2]-bb[0]))/2-bb[0],y),text,font=font,fill=color)
im.save(base/'out/end-card.png')
intro=Image.new('RGB',(1920,1080),'#FAFAF7');d=ImageDraw.Draw(intro)
font=ImageFont.truetype(str(base/'source/instrument-serif.ttf'),64)
d.text((176,156),'AutoDoc',font=font,fill='#536F57')
font=ImageFont.truetype(str(base/'source/dm-sans.ttf'),108)
d.text((176,370),'Click a note.',font=font,fill='#1A1A17')
d.text((176,505),'Replay the moment.',font=font,fill='#1A1A17')
intro.save(base/'out/intro-card.png')
