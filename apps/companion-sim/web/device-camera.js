// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Robot-local preview stays local; cloud sharing is an explicit separate grant. */
export function createDeviceCamera({canvas,request,getEpoch,getMasks,onStatus=()=>{},onFrame=()=>{}}){
 let current=null,generation=0;
 function stopSharing(){if(!current?.streamId)return;const streamId=current.streamId;current.streamId=null;request('/api/video/stop',{method:'POST',body:{streamId}}).catch(()=>{});onStatus({state:'stopped'});}
 function stop(){generation++;const old=current;current=null;if(!old)return;old.abort.abort();clearTimeout(old.timer);if(old.streamId)request('/api/video/stop',{method:'POST',body:{streamId:old.streamId}}).catch(()=>{});if(old.previewId)request('/api/device/preview/stop',{method:'POST',body:{previewId:old.previewId}}).catch(()=>{});onStatus({state:'stopped'});}
 async function poll(session){
  if(current!==session)return;
  try{
   const response=await fetch(`/api/device/frame?previewId=${encodeURIComponent(session.previewId)}`,{signal:session.abort.signal,cache:'no-store'});
   if(response.ok){
    const at=Number(response.headers.get('X-Frame-At')),sequence=response.headers.get('X-Frame-Sequence');
    if(Date.now()-at<2000&&sequence!==session.sequence){
     session.sequence=sequence;const image=await createImageBitmap(await response.blob());
     if(current!==session){image.close();return;}
     canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);image.close();ctx.fillStyle='#000';
     for(const m of getMasks())ctx.fillRect(Math.floor(m.x*canvas.width),Math.floor(m.y*canvas.height),Math.ceil(m.width*canvas.width),Math.ceil(m.height*canvas.height));
     session.lastAt=Date.now();onFrame({source:'camera',at,local:true,coverage:getMasks().length?'partial':'visible'});
    }
   }else if(response.status!==404)throw new Error('机器人预览已停止，请重新打开');
   if(Date.now()-session.lastAt>6000)throw new Error('机器人相机暂未送来新画面');
  }catch(error){if(current!==session||error.name==='AbortError')return;if(session.streamId){suspend();onStatus({state:'error',error:'本地预览中断；真机自主观察仍在运行，请刷新查看'});}else {stop();onStatus({state:'error',error:error.message});}return;}
  if(current===session)session.timer=setTimeout(()=>poll(session),125);
 }
 async function start(){
  stop();const session={abort:new AbortController(),previewId:null,streamId:null,lastAt:Date.now(),timer:null,generation};current=session;
  try{
   const result=await request('/api/device/preview',{method:'POST',body:{epoch:getEpoch()}});
   if(current!==session){request('/api/device/preview/stop',{method:'POST',body:{previewId:result.previewId}}).catch(()=>{});return false;}
   session.previewId=result.previewId;session.lastAt=Date.now();onStatus({state:'active'});poll(session);return true;
  }catch(error){if(current===session){stop();throw error;}return false;}
 }
 async function share(){
  const session=current;if(!session?.previewId)throw new Error('请先打开机器人本地预览');
  const epoch=getEpoch();onStatus({state:'connecting'});
  const answer=await request('/api/device/share',{method:'POST',body:{epoch,previewId:session.previewId,masks:getMasks()}});
  if(current!==session||epoch!==getEpoch()){request('/api/video/stop',{method:'POST',body:{streamId:answer.streamId}}).catch(()=>{});return false;}
  session.streamId=answer.streamId;return true;
 }
  function discard(){generation++;const old=current;current=null;if(old){old.abort.abort();clearTimeout(old.timer);}}
  function suspend(){if(!current)return;current.abort.abort();clearTimeout(current.timer);}
  function resume(){if(!current?.previewId)return;current.abort=new AbortController();current.lastAt=Date.now();poll(current);}
  function adopt({previewId,streamId=null}){if(!previewId)return;if(current&&!current.previewId){current.previewId=previewId;current.streamId=streamId;return;}if(current?.previewId===previewId){current.streamId=streamId;return;}if(current){current.abort.abort();clearTimeout(current.timer);}current={previewId,streamId,abort:new AbortController(),lastAt:Date.now(),timer:null,generation};poll(current);}
  async function waitForFrame(){
   const session=current;if(!session?.previewId)return false;const deadline=Date.now()+6500;
   while(current===session&&!session.abort.signal.aborted){
    if(session.sequence!==undefined&&Date.now()-session.lastAt<2000)return true;
    if(Date.now()>=deadline)throw new Error('机器人摄像头未送来首帧，请重试');
    await new Promise(resolve=>setTimeout(resolve,50));
   }
   return false;
  }
  return {start,share,waitForFrame,stop,stopSharing,discard,suspend,resume,adopt,get active(){return current?.previewId!=null;},get sharing(){return current?.streamId!=null;}};
}

/** One explicit user start opens the robot camera and its previously authorized visual observation. */
export async function startRobotObservation({camera,isCurrent,onStep=()=>{}}){
 if(!isCurrent())return false;
 onStep('camera');const opened=await camera.start();
 if(!opened||!isCurrent())return false;
 if(camera.waitForFrame){onStep('first_frame');if(!await camera.waitForFrame()||!isCurrent())return false;}
 onStep('sharing');const shared=await camera.share();
 if(!isCurrent())return false;
 if(shared===false)throw new Error('robot_observation_not_started');
 onStep('waiting');return true;
}
