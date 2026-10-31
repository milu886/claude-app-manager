from PIL import Image, ImageDraw
import math
from pathlib import Path
root = Path(__file__).resolve().parent.parent / 'app' / 'ui'
scale = 4
im = Image.new('RGBA', (256*scale, 256*scale))
d = ImageDraw.Draw(im)
def box(values): return tuple(int(v*scale) for v in values)
d.rounded_rectangle(box((12,12,244,244)),radius=58*scale,fill='#b66149')
for angle in range(0,180,22):
    a=math.radians(angle)
    x,y=71*math.cos(a),71*math.sin(a)
    p1,p2=(128-x,128-y),(128+x,128+y)
    d.line((box(p1),box(p2)),fill='#fff5ed',width=11*scale)
    for px,py in (p1,p2): d.ellipse(box((px-5.5,py-5.5,px+5.5,py+5.5)),fill='#fff5ed')
d.ellipse(box((148,148,232,232)),fill='#fff5ed')
d.ellipse(box((156,156,224,224)),fill='#263c51')
d.line([box((173,190)),box((185,202)),box((208,177))],fill='#fff5ed',width=8*scale,joint='curve')
im=im.resize((256,256),Image.Resampling.LANCZOS)
im.save(root/'icon.png')
im.save(root/'icon.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
