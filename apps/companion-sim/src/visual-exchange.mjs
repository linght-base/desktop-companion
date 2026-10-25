// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Admission of visual interaction opportunities, never a dialogue script or eye-gaze detector.
 * One current opportunity is reconsidered by the same Pi; nothing is replayed or queued per frame. */
export function createVisualExchange({clock=Date.now}={}){
 let scope=null,since=null,lastVisible=null,lastPulse=null,turn=0,opportunity=null,readingUntil=0,noticed=false,facing='unknown',lastFrontal=null;
 function reset(){scope=null;since=null;lastVisible=null;lastPulse=null;turn=0;opportunity=null;readingUntil=0;noticed=false;facing='unknown';lastFrontal=null;}
 function snapshot(){const active=lastVisible!==null&&clock()-lastVisible<=2500;return {active,since:active?since:null,lastVisibleAt:lastVisible,lastTowardAt:lastFrontal,turn,opportunity:active?opportunity:null,facing:active?facing:'unknown',semanticStatus:'visible_face_opportunity',userAttention:'unknown'};}
 function step({enabled,epoch,sight,busy=false,suppressed=false,displayUntil=null}={}){
  if(!enabled){reset();return null;}
  const key=JSON.stringify([epoch,sight?.streamId]);if(key!==scope){reset();scope=key;}
  const now=clock(),age=now-sight?.at;
  if(Number.isFinite(displayUntil))readingUntil=Math.max(readingUntil,displayUntil+350);
  if(lastVisible!==null&&now-lastVisible>2500){since=null;opportunity=null;noticed=false;}
  const targets=sight?.targets??[];
  // Multiple unselected faces cannot identify which person is engaging with the robot.
  const target=targets.length===1?targets[0]:null,pose=target?.faceOrientation;
  const visible=sight?.status==='ready'&&age>=0&&age<=1250&&target?.confidence>=.9;
  if(!visible)return null;
  facing=pose?.source==='landmarks'&&pose.confidence>=.75&&['toward','away'].includes(pose.direction)?pose.direction:'unknown';
  if(facing==='toward')lastFrontal=sight.at;
  lastVisible=sight.at;if(since===null){since=sight.at;turn=0;}
  if(!suppressed&&now>=readingUntil&&!noticed){noticed=true;if(busy)return {reason:'opening',at:now,since,turn:0,reflexOnly:true};}
  if(suppressed||busy||now<readingUntil||lastPulse!==null&&now-lastPulse<1500)return null;
  opportunity={reason:turn===0?'opening':'continuation',at:now,since,turn:++turn};lastPulse=now;
  return {...opportunity};
 }
 return {step,snapshot,reset};
}
