# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Static Chinese font-skeleton vectors. No paging, scrolling, or bitmap output.

System-font masks are used only as an intermediate at 2x canvas resolution.
Zhang-Suen thinning preserves glyph components; walks retain every skeleton edge
and pin branch/end points. RDP error is <=1.25 canvas pixels before rounding
(<=2 after rounding). A whole message either fits or is explicitly rejected.
"""
import json
import math
import os
import subprocess
import sys
from functools import lru_cache

MAX_CHARACTERS = 16
RENDERER_VERSION = 'font-skeleton-static-20261025-1'
FONT_PATH = '/System/Library/Fonts/STHeiti Light.ttc'
SIZES = (36, 32, 28)
NEIGHBORS = ((0,-1),(1,-1),(1,0),(1,1),(0,1),(-1,1),(-1,0),(-1,-1))


class MessageRenderError(ValueError):
    def __init__(self, reason, diagnostics=None):
        super().__init__(reason)
        self.diagnostics = diagnostics or {}


def _validate_text(text):
    if not isinstance(text,str) or not text.strip() or len(text)>MAX_CHARACTERS or any(ord(c)<32 or ord(c)==127 or 0xd800<=ord(c)<=0xdfff for c in text):
        raise MessageRenderError('invalid_message_text')


def _thin(points):
    points=set(points)
    changed=True
    while changed:
        changed=False
        for phase in (0,1):
            drop=[]
            for x,y in points:
                p=[(x+dx,y+dy) in points for dx,dy in NEIGHBORS]
                if not 2<=sum(p)<=6 or sum(not p[i] and p[(i+1)%8] for i in range(8))!=1:continue
                if phase==0 and (p[0] and p[2] and p[4] or p[2] and p[4] and p[6]):continue
                if phase==1 and (p[0] and p[2] and p[6] or p[0] and p[4] and p[6]):continue
                drop.append((x,y))
            if drop:points.difference_update(drop);changed=True
    return points


def _distance(point,a,b):
    dx,dy=b[0]-a[0],b[1]-a[1];length=dx*dx+dy*dy
    t=max(0,min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length)) if length else 0
    return (point[0]-a[0]-t*dx)**2+(point[1]-a[1]-t*dy)**2


def _simplify(points):
    if len(points)<3:return points
    distance,index=max((_distance(p,points[0],points[-1]),i) for i,p in enumerate(points[1:-1],1))
    if distance<=1.25**2:return [points[0],points[-1]]
    return _simplify(points[:index+1])[:-1]+_simplify(points[index:])


@lru_cache(maxsize=512)
def _glyph(character,size=36):
    from PIL import Image,ImageDraw,ImageFont
    try:font=ImageFont.truetype(FONT_PATH,size*2)
    except Exception:raise MessageRenderError('message_font_unavailable') from None
    if character.isspace():return ()
    # FreeType's missing-glyph box must never silently replace a character.
    if bytes(font.getmask(character))==bytes(font.getmask('\u0378')):
        raise MessageRenderError('message_glyph_unavailable',{'codepoint':f'U+{ord(character):04X}'})
    image=Image.new('L',((size+6)*2,(size+6)*2))
    ImageDraw.Draw(image).text((6,6),character,font=font,fill=255,anchor='lt')
    pixels=image.load()
    points=_thin({(x,y) for y in range(image.height) for x in range(image.width) if pixels[x,y]>=128})
    if not points:raise MessageRenderError('message_glyph_unavailable',{'codepoint':f'U+{ord(character):04X}'})
    def adjacent(p):
        return [(p[0]+dx,p[1]+dy) for dx,dy in NEIGHBORS if (p[0]+dx,p[1]+dy) in points and not(dx and dy and ((p[0]+dx,p[1]) in points or (p[0],p[1]+dy) in points))]
    seen=set();paths=[]
    for start in sorted(points):
        if start in seen:continue
        walk=[start];stack=[(start,iter(adjacent(start)))];edges=set();seen.add(start);last_new=0
        while stack:
            p,it=stack[-1];q=next(it,None)
            if q is None:
                stack.pop()
                if stack:walk.append(stack[-1][0])
                continue
            edge=tuple(sorted((p,q)))
            if edge in edges:continue
            edges.add(edge);seen.add(q);walk.append(q);last_new=len(walk)-1
            stack.append((q,iter(adjacent(q))))
        walk=walk[:last_new+1]
        pins=[0]+[i for i in range(1,len(walk)-1) if len(adjacent(walk[i]))!=2]+[len(walk)-1]
        path=[]
        for a,b in zip(pins,pins[1:]):
            part=_simplify([(x/2-3,y/2-3) for x,y in walk[a:b+1]])
            path.extend(part if not path else part[1:])
        paths.append(tuple(path or [(walk[0][0]/2-3,walk[0][1]/2-3)]))
    return tuple(paths)


def _fit(text,size):
    split=(len(text)+1)//2
    lines=[text] if len(text)<=8 else [text[:split],text[split:]]
    paths=[];owner=0
    for row,line in enumerate(lines):
        left=206-len(line)*(size+2)/2;top=277 if len(lines)==1 else 245+row*43
        for slot,char in enumerate(line):
            for path in _glyph(char,size):
                points=[]
                for x,y in path:
                    point=(round(x+left+slot*(size+2)),round(y+top))
                    if not points or points[-1]!=point:points.append(point)
                # Split long walks without dropping a branch or endpoint.
                for start in range(0,max(1,len(points)-1),47):paths.append((owner,points[start:start+48]))
            owner+=1
    diagnostic={'rendererVersion':RENDERER_VERSION,'layout':'single_line' if len(lines)==1 else 'two_lines','lineCount':len(lines),'fontSize':size,'characterCount':len(text),'strokeCount':len(paths),'pointCount':sum(len(p) for _,p in paths),'maxStrokePoints':max((len(p) for _,p in paths),default=0)}
    if diagnostic['pointCount']>192:
        diagnostic['failure']='points';return None,diagnostic
    # Only short intra-glyph bridges; retain every existing skeleton segment.
    while len(paths)>12:
        best=None
        for a,(owner,p) in enumerate(paths):
            for b in range(a+1,len(paths)):
                other,q=paths[b]
                if owner!=other or len(p)+len(q)>48:continue
                for i in (0,len(p)-1):
                    for j in (0,len(q)-1):
                        distance=(p[i][0]-q[j][0])**2+(p[i][1]-q[j][1])**2
                        if distance<=36 and (best is None or distance<best[0]):best=distance,a,b,i,j
        if best is None:
            diagnostic.update(failure='stroke_join',remainingStrokeCount=len(paths));return None,diagnostic
        _,a,b,i,j=best;p=paths[a][1];q=paths[b][1]
        paths[a]=paths[a][0],(p[::-1] if i==0 else p)+(q[::-1] if j==len(q)-1 else q);paths.pop(b)
    encoded=bytearray((1,len(paths)))
    for _,path in paths:
        encoded.extend((3,len(path)))
        for x,y in path:
            if not 0<=x<412 or not 0<=y<412:
                diagnostic['failure']='coordinate_bounds';return None,diagnostic
            encoded.extend(x.to_bytes(2,'big'));encoded.extend(y.to_bytes(2,'big'))
    diagnostic['strokeCount']=len(paths)
    diagnostic['maxStrokePoints']=max((len(p) for _,p in paths),default=0)
    return {'text':text,'vector':encoded.hex(),'rendering':'system_font_skeleton','diagnostics':diagnostic},diagnostic


@lru_cache(maxsize=64)
def _compile_message_pages_local(text):
    _validate_text(text)
    attempts=[]
    for size in SIZES:
        page,diagnostic=_fit(text,size)
        attempts.append(diagnostic)
        if page is not None:return (page,)
    raise MessageRenderError('message_static_budget',{'rendererVersion':RENDERER_VERSION,'attempts':attempts})


def _validated_worker_pages(value,text):
    if not isinstance(value,dict) or value.get('rendererVersion')!=RENDERER_VERSION:raise MessageRenderError('message_font_worker_invalid')
    pages=value.get('pages')
    if not isinstance(pages,list) or len(pages)!=1 or pages[0].get('text')!=text:raise MessageRenderError('message_font_worker_invalid')
    page=pages[0];vector=page.get('vector')
    try:
        if not isinstance(vector,str) or len(vector)>1588:raise ValueError()
        data=bytes.fromhex(vector)
        if vector!=data.hex() or len(data)<2 or data[0]!=1 or not 1<=data[1]<=12:raise ValueError()
        offset,total=2,0
        for _ in range(data[1]):
            width,count=data[offset:offset+2];offset+=2;total+=count
            if not 1<=width<=48 or not 1<=count<=48 or total>192 or offset+count*4>len(data):raise ValueError()
            for i in range(offset,offset+count*4,2):
                if int.from_bytes(data[i:i+2],'big')>=412:raise ValueError()
            offset+=count*4
        if offset!=len(data):raise ValueError()
    except (ValueError,TypeError):raise MessageRenderError('message_font_worker_invalid') from None
    return (page,)


@lru_cache(maxsize=64)
def compile_message_pages(text):
    """Compatibility return shape: exactly one complete static screen, never pages."""
    try:return _compile_message_pages_local(text)
    except MessageRenderError as error:
        if str(error) not in {'message_font_unavailable','message_glyph_unavailable'}:raise
        env={key:os.environ[key] for key in ('PATH','HOME') if key in os.environ};env.update(LANG='en_US.UTF-8',PYTHONDONTWRITEBYTECODE='1')
        try:
            result=subprocess.run([sys.executable,os.path.abspath(__file__),'--font-worker'],input=json.dumps({'text':text}),text=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=1.5,env=env)
            if result.returncode!=0 or len(result.stdout)>40000:raise MessageRenderError('message_font_worker_failed')
            value=json.loads(result.stdout)
            if value.get('ok') is not True:raise MessageRenderError('message_font_worker_failed')
            return _validated_worker_pages(value,text)
        except Exception:error.diagnostics['isolatedReason']='message_font_worker_failed'
        raise error


def prepare_message(text):
    try:
        page=compile_message_pages(text)[0]
        return {'fits':True,'complete':True,'rendering':page['rendering'],**page['diagnostics']}
    except MessageRenderError as error:
        return {'fits':False,'reason':str(error),'rendererVersion':RENDERER_VERSION,'diagnostics':error.diagnostics}


def page_at(created_at,expires_at,count,now):
    if count!=1:raise MessageRenderError('message_pagination_disabled')
    return (0,expires_at) if created_at<=now<expires_at else None


if __name__=='__main__':
    try:
        line=sys.stdin.buffer.readline(4097)
        if len(line)>4096:raise MessageRenderError('invalid_message_text')
        text=json.loads(line).get('text')
        if '--font-worker' in sys.argv:
            print(json.dumps({'ok':True,'rendererVersion':RENDERER_VERSION,'pages':_compile_message_pages_local(text)},separators=(',',':')))
        else:print(json.dumps(prepare_message(text),separators=(',',':')))
    except MessageRenderError as error:print(json.dumps({'ok':False,'fits':False,'reason':str(error),'diagnostics':error.diagnostics},separators=(',',':')))
    except Exception:print('{"ok":false,"fits":false,"reason":"message_font_worker_failed"}')
