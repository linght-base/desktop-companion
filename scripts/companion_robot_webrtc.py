# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Video-only local WebRTC sender fed by live, explicitly shared robot SDK frames.
No sensor access, files, HTTP, audio or model. Masks apply before encoding.
"""
import asyncio,base64,io,json,signal,sys,time
from fractions import Fraction
MAX_LINE=450000

class SenderError(ValueError):
 def __init__(self,reason):self.reason=reason;super().__init__(reason)

async def read_message(reader):
 try:line=await reader.readline()
 except (ValueError,asyncio.LimitOverrunError):raise SenderError('robot_webrtc_input_overflow') from None
 if not line:return None
 if len(line)>MAX_LINE:raise SenderError('robot_webrtc_input_overflow')
 try:value=json.loads(line)
 except (ValueError,UnicodeError):raise SenderError('robot_webrtc_invalid_message') from None
 if not isinstance(value,dict):raise SenderError('robot_webrtc_invalid_message')
 return value

def finish_consumer(task,report_error,done):
 if task.cancelled():return
 try:task.result()
 except SenderError as error:report_error(error.reason)
 except Exception:report_error('robot_webrtc_sender_failed')
 finally:done.set()

async def main():
 reader=asyncio.StreamReader(limit=MAX_LINE+1);protocol=asyncio.StreamReaderProtocol(reader)
 transport,_=await asyncio.get_running_loop().connect_read_pipe(lambda:protocol,sys.stdin)
 def output(value):
  try:sys.stdout.write(json.dumps(value,separators=(',',':'))+'\n');sys.stdout.flush()
  except (BrokenPipeError,OSError):pass
 pc=None;done=asyncio.Event();frames=asyncio.Queue(maxsize=1);disconnect_timer=None;stage='runtime'
 try:
  from aiortc import RTCPeerConnection,RTCConfiguration,RTCSessionDescription,VideoStreamTrack
  from aiortc.mediastreams import MediaStreamError
  from av import VideoFrame
  from PIL import Image,ImageDraw
  stage='init';init=await read_message(reader)
  if not init or init.get('type')!='init':raise SenderError('robot_webrtc_invalid_init')
  width,height=init['width'],init['height'];started=init['startedAt'];masks=init.get('masks',[])
  if not all(isinstance(v,int) and not isinstance(v,bool) for v in [width,height,started]) or not(1<=width<=640 and 1<=height<=480 and started>=0) or not isinstance(masks,list) or len(masks)>16:raise ValueError('init')
  for m in masks:
   if set(m)!={'x','y','width','height'} or not all(type(v) in (int,float) and 0<=v<=1 for v in m.values()) or not(m['width']>0 and m['height']>0 and m['x']+m['width']<=1 and m['y']+m['height']<=1):raise ValueError('mask')
  class Source(VideoStreamTrack):
   def __init__(self):super().__init__();self.pts=-1
   async def recv(self):
    while True:
     item=await frames.get()
     if time.time()*1000-item['at']>2000:continue
     try:image=Image.open(io.BytesIO(base64.b64decode(item['data'],validate=True))).convert('RGB').resize((width,height))
     except Exception:
      output({'type':'error','reason':'robot_webrtc_frame_decode_failed'});done.set();raise MediaStreamError() from None
     draw=ImageDraw.Draw(image)
     for m in masks:draw.rectangle((int(m['x']*width),int(m['y']*height),min(width,int((m['x']+m['width'])*width+.999)),min(height,int((m['y']+m['height'])*height+.999))),fill=(0,0,0))
     frame=VideoFrame.from_image(image);self.pts=max(self.pts+1,int((item['at']-started)*90));frame.pts=self.pts;frame.time_base=Fraction(1,90000);return frame
  stage='negotiation';pc=RTCPeerConnection(RTCConfiguration(iceServers=[]));pc.addTrack(Source())
  loop=asyncio.get_running_loop()
  def error(reason):output({'type':'error','reason':reason});done.set()
  @pc.on('connectionstatechange')
  async def changed():
   nonlocal disconnect_timer
   output({'type':'state','state':pc.connectionState})
   # Current aiortc has no disconnected state. If a future version exposes it,
   # allow this same authorized peer a bounded recovery window, never reconnect.
   if pc.connectionState=='disconnected':
    if disconnect_timer is None:disconnect_timer=loop.call_later(3,error,'robot_webrtc_disconnected_timeout')
   else:
    if disconnect_timer:disconnect_timer.cancel();disconnect_timer=None
    if pc.connectionState=='failed':error('robot_webrtc_peer_failed')
    elif pc.connectionState=='closed':done.set()
  for sig in (signal.SIGTERM,signal.SIGINT):loop.add_signal_handler(sig,done.set)
  await pc.setLocalDescription(await pc.createOffer())
  output({'type':'offer','sdp':pc.localDescription.sdp,'startedAt':started,'width':width,'height':height,'frameRate':8})
  async def consume():
   last=-1
   while not done.is_set():
    item=await read_message(reader)
    if item is None:raise SenderError('robot_webrtc_parent_closed')
    if item.get('type')=='answer':
     if not isinstance(item.get('sdp'),str) or len(item['sdp'])>131072:raise SenderError('robot_webrtc_invalid_message')
     try:await pc.setRemoteDescription(RTCSessionDescription(type='answer',sdp=item['sdp']))
     except Exception:raise SenderError('robot_webrtc_negotiation_failed') from None
    elif item.get('type')=='close':done.set();return
    elif item.get('type')=='frame':
     at=item.get('at');data=item.get('data')
     if type(at) not in (int,float) or not started<=at<=time.time()*1000+1000 or at<=last or not isinstance(data,str) or len(data)>400000:continue
     last=at
     if frames.full():frames.get_nowait()
     frames.put_nowait({'at':at,'data':data})
    else:raise SenderError('robot_webrtc_invalid_message')
  task=asyncio.create_task(consume());task.add_done_callback(lambda task:finish_consumer(task,error,done));await done.wait();task.cancel();await asyncio.gather(task,return_exceptions=True)
 except SenderError as error:output({'type':'error','reason':error.reason})
 except Exception:output({'type':'error','reason':{'runtime':'robot_webrtc_runtime_unavailable','init':'robot_webrtc_invalid_init','negotiation':'robot_webrtc_negotiation_failed'}.get(stage,'robot_webrtc_sender_failed')})
 finally:
  if disconnect_timer:disconnect_timer.cancel()
  if pc:await pc.close()
  output({'type':'closed'});transport.close()
if __name__=='__main__':asyncio.run(main())
