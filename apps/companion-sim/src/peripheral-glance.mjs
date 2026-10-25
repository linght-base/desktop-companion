// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Small peripheral head motion using ephemeral face-facing estimates, never eye-gaze claims. */
export function createPeripheralGlance({clock=Date.now}={}){
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 let scope=null,facing='unknown',facingAt=null,awaySince=null,nextAt=null,anchor=null,startedAt=null,returnUntil=null,suppress=false,returnedAt=null,sign=1,stoppedForFrame=false,returnId=null;
 function reset(){scope=null;facing='unknown';facingAt=null;awaySince=null;nextAt=null;anchor=null;startedAt=null;returnUntil=null;suppress=false;returnedAt=null;sign=1;stoppedForFrame=false;returnId=null;}
 const snapshot=()=>({peripheralState:anchor?'glancing':returnUntil!==null?'returning':'idle',facing:clock()-(facingAt??-Infinity)<=2500?facing:'unknown',facingAt,nextGlanceAt:nextAt,suppressFeedback:suppress,attentionReturnedAt:returnedAt});
 function step({enabled,epoch,head,sight,target,canGlance=false,displayBusy=false,requireCompletion=false,motion=null}={}){
  const now=clock();if(!enabled){reset();return null;}
  if(!sight?.streamId)return null;
  const key=JSON.stringify([epoch,sight.streamId]);if(key!==scope){reset();scope=key;nextAt=now+30000;}
  const fresh=sight.status==='ready'&&Number.isFinite(sight.at)&&now-sight.at>=0&&now-sight.at<500&&target?.confidence>=.9;
  if(!fresh){
   const expired=sight.status!=='ready'||!target||!Number.isFinite(sight.at)||now-sight.at>2500;
   if(expired){awaySince=null;if(anchor||returnUntil!==null){anchor=null;returnUntil=null;nextAt=now+30000;return {kind:'hold'};}}
   else if((anchor||returnUntil!==null)&&!stoppedForFrame){stoppedForFrame=true;return {kind:'hold'};}
   return null;
  }
  stoppedForFrame=false;
  const pose=target.faceOrientation;
  const direction=pose?.source==='landmarks'&&pose.confidence>=.75&&['toward','away'].includes(pose.direction)?pose.direction:'unknown';
  if(facingAt!==sight.at){
   if(direction==='toward'&&facing==='away')returnedAt=sight.at;
   awaySince=direction==='away'?(facing==='away'&&facingAt!==null&&sight.at-facingAt<=2500?awaySince??sight.at:sight.at):null;
   facing=direction;facingAt=sight.at;
  }
  const b=target.box,cx=b.x+b.width/2,cy=b.y+b.height/2;
  const centered=cx>=.45&&cx<=.55&&cy>=.43&&cy<=.57;
  const safe=b.x>.12&&b.x+b.width<.88&&b.y>.10&&b.y+b.height<.90;
  const proposal=(kind,targetHead,durationMs,until)=>({kind,head:targetHead,durationMs:requireCompletion?2200:durationMs,moveMs:kind==='glance'?500:350,until:requireCompletion?now+2200:until,basisId:sight.basisId,observedAt:sight.at});
  if(returnUntil!==null){
   if(requireCompletion){if(motion?.confirmedCommandId!==returnId){if(now>=returnUntil){returnUntil=null;returnId=null;return {kind:'hold'};}return null;}if(sight.at<motion.confirmedAt+150)return null;}
   else if(now<returnUntil||sight.at<returnUntil+100)return null;
   returnUntil=null;if(centered)suppress=false;
  }else if(!anchor&&suppress&&centered)suppress=false;
  if(anchor){
   if(direction!=='away'||!safe||displayBusy||now-startedAt>=700){
    const home=anchor;anchor=null;returnUntil=now+(requireCompletion?2200:500);nextAt=now+30000;returnId=null;
    // Returning to the pre-glance useful pose is bounded; normal framing then rechecks a new frame.
    return proposal('return',home,450,returnUntil);
   }
   return null;
  }
  if(suppress||!canGlance||displayBusy||!safe||!centered||direction!=='away'||awaySince===null||sight.at-awaySince<1200||now<nextAt)return null;
  anchor={...head};startedAt=now;suppress=true;sign=-sign;
  const targetHead={yaw:clamp(head.yaw+sign*3,-45,45),pitch:clamp(head.pitch-1.5,-15,15)};
  return proposal('glance',targetHead,600,now+700);
 }
 return {step,reset,snapshot,accepted(id,proposal){if(proposal.kind==='return')returnId=id;}};
}
