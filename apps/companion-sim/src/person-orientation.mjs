// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {createPeripheralGlance} from './peripheral-glance.mjs';
/** Geometry-only continuous framing and finite lost-person search. No identity or semantic scene decisions. */
export function createPersonOrientation({clock=Date.now}={}){
 const peripheral=createPeripheralGlance({clock});
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 let scope=null,status='idle',armed=false,absentAt=null,lastAbsentAt=null,base=null,lastDirection=1,everSeen=false,plan=null,until=null,waypoint=-1,settledAfter=null,pendingId=null,pendingUntil=null,pendingKind=null,commandBasisAt=null,moveMs=350,referenceLost=false,homeAttempts=0,centerX=null,centerY=null;
 function reset(){peripheral.reset();scope=null;status='idle';armed=false;absentAt=null;lastAbsentAt=null;base=null;lastDirection=1;everSeen=false;plan=null;until=null;waypoint=-1;settledAfter=null;pendingId=null;pendingUntil=null;pendingKind=null;referenceLost=false;homeAttempts=0;centerX=null;centerY=null;}
 function snapshot(){const view=peripheral.snapshot();return {...view,status:view.peripheralState==='idle'?status:view.peripheralState,searchUntil:status==='searching'?until:null,until,armed,commandBasisAt,moveMs,centerX,centerY,errorX:centerX===null?null:centerX-.5,errorY:centerY===null?null:centerY-.5};}
 function step({enabled,epoch,head,sight,targetId,requireCompletion=false,referenceReady=true,motion=null,allowPeripheral=false,displayBusy=false}={}){
  const now=clock();
  if(!enabled||!Number.isSafeInteger(epoch)||!head||![head.yaw,head.pitch].every(Number.isFinite)){reset();return null;}
  if(!sight?.streamId)return null;
  const key=JSON.stringify([epoch,sight.streamId]);if(key!==scope){reset();scope=key;armed=true;base={...head};}
  const peripheralTargets=(sight.targets??[]).filter(t=>t.confidence>=.9).sort((a,b)=>Number(b.id===targetId)-Number(a.id===targetId)||b.box.width*b.box.height-a.box.width*a.box.height);
  const glance=peripheral.step({enabled:enabled&&referenceReady&&!referenceLost,epoch,head,sight,target:peripheralTargets[0],canGlance:allowPeripheral&&!pendingId&&status==='holding'&&(peripheralTargets.length===1||peripheralTargets.some(t=>t.id===targetId)),displayBusy,requireCompletion,motion});
  if(glance)return glance;
  if(peripheral.snapshot().peripheralState==='glancing')return null;
  if(requireCompletion&&pendingId){
   if(motion?.confirmedCommandId===pendingId){
    const finished=pendingKind;pendingId=null;pendingUntil=null;pendingKind=null;settledAfter=motion.confirmedAt+150;
    if(finished!=='search'){until=null;status='holding';}
    if(finished==='home'){referenceLost=false;homeAttempts=0;}
    return {kind:'hold'};
   }
   if(now>=pendingUntil){pendingId=null;pendingKind=null;pendingUntil=null;until=null;status='motion_unconfirmed';referenceLost=true;return {kind:'hold'};}
   return null;
  }
  if(until!==null&&now>=until){const was=status,endedAt=until;until=null;plan=null;waypoint=-1;status=was==='searching'?'waiting':'holding';if(was==='searching'){armed=false;return {kind:'release'};}if(was==='aligning')settledAfter=endedAt+100;}
  if(sight?.status!=='ready'||!Number.isFinite(sight.at)||now-sight.at<0||now-sight.at>=500){if((sight?.status!=='ready'||!Number.isFinite(sight.at)||now-sight.at<0||now-sight.at>2500)&&status!=='searching'&&status!=='aligning'){absentAt=null;lastAbsentAt=null;}return null;}
  const people=(sight.targets??[]).filter(t=>t.confidence>=.9).sort((a,b)=>Number(b.id===targetId)-Number(a.id===targetId)||b.box.width*b.box.height-a.box.width*a.box.height);
  const proposal=(kind,target,durationMs=650)=>{const deadline=requireCompletion?Math.min(until??now+2200,now+2200):until;return {kind,head:target,durationMs:requireCompletion?deadline-now:durationMs,moveMs:350,until:deadline,basisId:sight.basisId,observedAt:sight.at};};
  if(requireCompletion&&(!referenceReady||referenceLost)){
   if(status==='homing'&&until>now)return null;if(homeAttempts>=2){status='motion_unconfirmed';return null;}
   homeAttempts++;status='homing';until=now+3000;const p=proposal('home',{yaw:0,pitch:0});p.until=until;p.durationMs=3000;return p;
  }
  if(settledAfter!==null&&sight.at<settledAfter)return null;
  if(people.length){
   const wasSearching=status==='searching';
   armed=true;everSeen=true;absentAt=null;lastAbsentAt=null;
   const box=people[0].box,cx=box.x+box.width/2,cy=box.y+box.height/2;centerX=cx;centerY=cy;
   lastDirection=cx<.5?1:-1;
   if(wasSearching){status='holding';until=null;plan=null;waypoint=-1;base={...head};settledAfter=now+100;return {kind:'hold'};}
   if(status==='aligning')return null;
   base={...head};status='holding';
   if(settledAfter!==null&&sight.at<settledAfter)return null;
   // The real Desktop pan servo increases toward camera-left; image error uses the opposite sign.
   if(cx<.45||cx>.55||cy<.43||cy>.57){
    const target={yaw:clamp(head.yaw-clamp((cx-.5)*70,requireCompletion?-5:-10,requireCompletion?5:10),-45,45),pitch:clamp(head.pitch+clamp((.5-cy)*40,requireCompletion?-4:-6,requireCompletion?4:6),-15,15)};
    if(Math.abs(target.yaw-head.yaw)+Math.abs(target.pitch-head.pitch)>.5){status='aligning';until=now+(requireCompletion?2200:500);return proposal('align',target,450);}
   }
   return null;
  }
  if(status==='aligning'){until=null;status='holding';settledAfter=null;return {kind:'hold'};}
  if(!armed||requireCompletion&&!everSeen)return null;
  if(absentAt===null){absentAt=sight.at;lastAbsentAt=sight.at;return null;}
  if(status!=='searching'){
   if(sight.at===lastAbsentAt||sight.at-absentAt<300)return null;
   status='searching';until=now+(requireCompletion?5000:2000);waypoint=-1;const pose=base??head;
   plan=[lastDirection*18,-lastDirection*18,0].map(offset=>({yaw:clamp(pose.yaw+offset,-45,45),pitch:clamp(pose.pitch+(!everSeen&&offset!==0?8:0),-15,15)}));
  }
  lastAbsentAt=sight.at;
  const index=Math.min(2,Math.floor((now-(until-(requireCompletion?5000:2000)))/(requireCompletion?1700:700)));
  if(index===waypoint)return null;waypoint=index;return proposal('search',plan[index],Math.min(650,until-now));
 }
 return {step,reset,snapshot,cancelPending(){if(!pendingId)return;pendingId=null;pendingUntil=null;pendingKind=null;if(['aligning','homing'].includes(status)){until=null;status='holding';settledAfter=clock()+150;}},accepted(id,proposal){pendingId=id;pendingUntil=proposal.until;pendingKind=proposal.kind;peripheral.accepted(id,proposal);commandBasisAt=proposal.observedAt;moveMs=proposal.moveMs??350;}};
}
