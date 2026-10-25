// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const finite=Number.isFinite;
const defaults={targetTtlMs:500,searchMs:2000,noticeMs:1000,noticeCooldownMs:60000,maxYaw:45,maxPitch:20,yawFov:70,pitchFov:40,slewDegPerSecond:60};
const waypointMs=500,clearConfidence=.9;

/** Pure, bounded geometry proposals. The host owns every body/channel authorization.
 *  Policy: the head rotates only while no clear person is visible. Once any clear
 *  person is visible the camera holds its useful pose and never continuously follows.
 *  Target IDs are unknown geometry, never identity, so any clear face satisfies the
 *  hold. A lost target triggers at most one bounded, finite waypoint sweep from the
 *  last useful pose that returns to and holds that pose inside searchMs (<=2s). No
 *  motion is proposed from expired detector frames or an unavailable camera, and
 *  focus expiry never commands a gratuitous physical recenter. */
export function createAttentionController({clock=Date.now,policy={}}={}) {
 const p={...defaults};
 for(const key of Object.keys(defaults))if(finite(policy[key])&&policy[key]>0)p[key]=policy[key];
 p.targetTtlMs=Math.min(500,p.targetTtlMs);p.searchMs=Math.min(2000,p.searchMs);p.noticeMs=Math.min(1000,p.noticeMs);p.noticeCooldownMs=Math.max(60000,p.noticeCooldownMs);p.maxYaw=Math.min(45,p.maxYaw);p.maxPitch=Math.min(20,p.maxPitch);
 let epoch=null,enabled=true,sight=null,selected=null,searchUntil=null,searchStarted=null,searchPlan=null,lastUsefulPose=null,lastNoticeAt=null,lastStepAt=null,lastNeutralSightAt=null,reason='initial',retired=[];
 const clear=()=>{sight=null;selected=null;searchUntil=null;searchStarted=null;searchPlan=null;lastUsefulPose=null;lastStepAt=null;lastNeutralSightAt=null;};
 const reset=(why='reset')=>{clear();reason=why;};
 function authorize(context={}) {
  if(!Number.isSafeInteger(context.epoch)||context.epoch<0)return 'invalid_epoch';
  if(epoch!==null&&context.epoch<epoch)return 'stale_epoch';
  if(epoch!==context.epoch){clear();retired=[];epoch=context.epoch;reason='epoch_changed';}
  enabled=context.enabled===true;
  if(!enabled){reset('paused');return 'paused';}
  return null;
 }
 const fresh=()=>sight?.status==='ready'&&clock()-sight.at>=0&&clock()-sight.at<p.targetTtlMs;
 const targets=()=>fresh()?sight.targets:[];
 const rejection=why=>({accepted:false,reason:why});
 function ingest(input,context) {
  const denied=authorize(context);if(denied)return rejection(denied);
  if(!input||!finite(input.at)||input.at>clock()||clock()-input.at>=p.targetTtlMs||typeof input.streamId!=='string'||!input.streamId||input.streamId.length>200||!['ready','unavailable','error'].includes(input.status)||input.detector!=='yunet-2023mar'||!finite(input.processingMs)||input.processingMs<0||!Array.isArray(input.targets)||input.targets.length>8)return rejection('invalid_sight');
  const ids=new Set();
  for(const target of input.targets){
   const b=target?.box;
   if(typeof target?.id!=='string'||!target.id||target.id.length>200||ids.has(target.id)||target.kind!=='face'||target.identity!=='unknown'||!finite(target.confidence)||target.confidence<0||target.confidence>1||!b||![b.x,b.y,b.width,b.height].every(finite)||b.x<0||b.y<0||b.width<=0||b.height<=0||b.x+b.width>1.000001||b.y+b.height>1.000001)return rejection('invalid_target');
   ids.add(target.id);
  }
  if(retired.includes(input.streamId))return rejection('stale_stream');
  if(sight?.streamId===input.streamId&&input.at<=sight.at)return rejection('out_of_order');
  if(sight&&sight.streamId!==input.streamId){retired.push(sight.streamId);retired=retired.slice(-8);clear();reason='stream_changed';}
  sight={at:input.at,streamId:input.streamId,status:input.status,targets:input.status==='ready'?structuredClone(input.targets):[],basisId:typeof input.basisId==='string'?input.basisId:`sight:${input.streamId}:${input.at}`};
  return {accepted:true};
 }
 function focus(input,context) {
  const denied=authorize(context);if(denied)return rejection(denied);
  if(!input||!finite(input.durationMs)||input.durationMs<100||input.durationMs>15000)return rejection('invalid_duration');
  if(!targets().some(target=>target.id===input.targetId))return rejection('target_not_visible');
  selected={targetId:input.targetId,until:clock()+input.durationMs,basisId:sight.basisId};searchUntil=null;searchStarted=null;searchPlan=null;lastUsefulPose=null;lastStepAt=null;reason='focused';
  return {accepted:true,...structuredClone(selected)};
 }
 function step(context) {
  const denied=authorize(context);if(denied)return null;
  const now=clock(),dt=lastStepAt===null?100:clamp(now-lastStepAt,0,100);lastStepAt=now;
  const head=context.head??{yaw:0,pitch:0};
  const headYaw=finite(head.yaw)?head.yaw:0,headPitch=finite(head.pitch)?head.pitch:0;
  const boundedHead=(yaw,pitch)=>({yaw:clamp(clamp(yaw,-p.maxYaw,p.maxYaw),headYaw-p.slewDegPerSecond*dt/1000,headYaw+p.slewDegPerSecond*dt/1000),pitch:clamp(clamp(pitch,-p.maxPitch,p.maxPitch),headPitch-p.slewDegPerSecond*dt/1000,headPitch+p.slewDegPerSecond*dt/1000)});
  const proposal=(kind,extra,durationMs=100)=>({kind,...extra,durationMs,basisId:sight?.basisId??selected?.basisId??null,observedAt:sight?.at??now});
  const release=why=>{const output=proposal('release',{...(context.physicalCameraMoves?{}:{head:{yaw:0,pitch:0}}),...(!context.expressionActive?{gaze:{gazeX:0,gazeY:0}}:{})},250);selected=null;searchUntil=null;searchStarted=null;searchPlan=null;lastNoticeAt=now;reason=why;return output;};
  if(selected){
   if(now>=selected.until)return release('focus_expired');
   const target=targets().find(item=>item.id===selected.targetId);
   if(target){
    searchUntil=null;searchStarted=null;searchPlan=null;lastUsefulPose={yaw:headYaw,pitch:headPitch};
    // Physical camera: a clear person is visible, so hold the useful pose.
    if(context.physicalCameraMoves){reason='holding_person';return null;}
    reason='tracking';
    const x=clamp((target.box.x+target.box.width/2-.5)*2,-1,1),y=clamp((target.box.y+target.box.height/2-.5)*2,-1,1);
    // The body validates a minimum 100 ms command. The host separately caps its
    // channel lease at snapshot.focus.until, preserving a partial final window.
    return proposal('track',{head:boundedHead(x*p.yawFov/2,y*p.pitchFov/2),...(!context.expressionActive?{gaze:{gazeX:x,gazeY:y}}:{})});
   }
   const isFresh=fresh();
   // Physical camera never searches while another clear face is visible: IDs are
   // unknown geometry, so any clear person is enough to keep holding the pose.
   if(context.physicalCameraMoves&&isFresh&&sight.targets.some(item=>item.confidence>=clearConfidence)){
    searchUntil=null;searchStarted=null;searchPlan=null;lastUsefulPose={yaw:headYaw,pitch:headPitch};reason='holding_person';return null;
   }
   if(searchUntil===null){
    if(!isFresh)return null;
    searchStarted=now;searchUntil=Math.min(now+p.searchMs,selected.until);
    const base=lastUsefulPose??{yaw:headYaw,pitch:headPitch},sweep=Math.min(p.yawFov/4,20);
    searchPlan={base:{yaw:clamp(base.yaw,-p.maxYaw,p.maxYaw),pitch:clamp(base.pitch,-p.maxPitch,p.maxPitch)},offsets:[-sweep,sweep,0]};
   }
   // Absolute deadlines fire even without fresh frames; motion never does.
   if(now>=searchUntil)return release('target_lost');
   if(!isFresh)return null;
   reason='searching';
   // Bounded finite waypoints from the last useful pose, then return and hold it.
   // The host separately caps its channel lease at min(focus.until, searchUntil).
   const offset=searchPlan.offsets[Math.min(Math.floor((now-searchStarted)/waypointMs),searchPlan.offsets.length-1)];
   return proposal('search',{head:boundedHead(clamp(searchPlan.base.yaw+offset,-p.maxYaw,p.maxYaw),searchPlan.base.pitch)},context.physicalCameraMoves?700:100);
  }
  if(!context.expressionActive&&targets().length===1&&(context.continuousGaze===true||lastNoticeAt===null||now-lastNoticeAt>=p.noticeCooldownMs)){
   if(context.continuousGaze===true&&lastNeutralSightAt===sight.at)return null;lastNeutralSightAt=sight.at;
   lastNoticeAt=now;reason='neutral_notice';const b=targets()[0].box;
   return proposal('notice',{gaze:{gazeX:clamp((b.x+b.width/2-.5)*2,-1,1),gazeY:clamp((b.y+b.height/2-.5)*2,-1,1)}},context.continuousGaze===true?400:p.noticeMs);
  }
  return null;
 }
 function snapshot(){
  const visible=targets();let status=!enabled?'paused':selected?(searchUntil!==null?'searching':'tracking'):sight?.status==='unavailable'?'unavailable':sight?.status==='error'?'error':visible.length?'visible':'idle';
  return {status,epoch,streamId:sight?.streamId??null,observedAt:sight?.at??null,targets:structuredClone(visible),focus:structuredClone(selected),searchUntil,lastNoticeAt,reason};
 }
 return {ingest,focus,step,reset,snapshot};
}
