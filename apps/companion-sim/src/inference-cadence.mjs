// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const bounds={id:80,fingerprint:200,desk:200,reason:200};
const finite=Number.isFinite;
const text=(value,max)=>typeof value==='string'&&[...value].length>=1&&[...value].length<=max;

/** Generic inference admission cadence. The host computes id/at/fingerprint and
 *  judges changed/urgent from low-level signals; this module only decides whether
 *  one existing Pi call may start. Pure memory, no timers, no payload storage,
 *  no scheduling; admission is not understanding and not execution. */
export function createInferenceCadence({clock=Date.now,minIntervalMs=500,stableReviewMs=15000,maxRemembered=128}={}) {
 if(typeof clock!=='function')throw new TypeError('invalid_clock');
 if(!finite(minIntervalMs)||minIntervalMs<0)throw new TypeError('invalid_min_interval');
 if(!finite(stableReviewMs)||stableReviewMs<=0)throw new TypeError('invalid_stable_review');
 if(!Number.isSafeInteger(maxRemembered)||maxRemembered<1)throw new TypeError('invalid_max_remembered');
 let epoch=-1,deskId=null,closed=false,clockFaulted=false,lastNow=null,seq=0;
 let pending=null,lastCommitted=null,lastCommitAt=null,latestAt=null;
 const remembered=new Map();
 const deny=(reason,nextEligibleAt)=>nextEligibleAt===undefined?{admitted:false,reason}:{admitted:false,reason,nextEligibleAt};
 const fail=reason=>({accepted:false,reason});
 function now() {
  const t=clock();
  if(!finite(t))throw new TypeError('invalid_clock_reading');
  if(lastNow!==null&&t<lastNow){pending=null;clockFaulted=true;}
  lastNow=t;return t;
 }
 function clearGeneration() {
  pending=null;lastCommitted=null;lastCommitAt=null;latestAt=null;remembered.clear();
 }
 function authorize(context) {
  if(!context||typeof context!=='object')return 'invalid_context';
  if(!Number.isSafeInteger(context.epoch)||context.epoch<0)return 'invalid_context';
  if(!text(context.deskId,bounds.desk))return 'invalid_context';
  if(epoch!==-1&&context.epoch<epoch)return 'stale_epoch';
  if(deskId!==null&&context.deskId!==deskId)return 'desk_mismatch';
  if(context.enabled!==true)return 'disabled';
  if(context.epoch>epoch){epoch=context.epoch;clearGeneration();}
  if(deskId===null)deskId=context.deskId;
  return null;
 }
 function validateInput(input) {
  if(!input||typeof input!=='object')return 'invalid_input';
  if(!text(input.id,bounds.id)||!text(input.fingerprint,bounds.fingerprint))return 'invalid_input';
  if(!finite(input.at)||input.at<0)return 'invalid_input';
  if(typeof input.changed!=='boolean')return 'invalid_input';
  if(input.urgent!==undefined&&typeof input.urgent!=='boolean')return 'invalid_input';
  return null;
 }
 function admit(input,t,reason) {
  const ticket=`ticket-${++seq}`;
  pending={ticket,id:input.id,fingerprint:input.fingerprint,at:input.at,urgent:input.urgent===true,epoch,deskId,consideredAt:t};
  return {admitted:true,reason,ticket};
 }
 function consider(input,context={}) {
  if(closed)return deny('closed');
  const t=now();
  if(clockFaulted)return deny('clock_regressed');
  const ctxErr=authorize(context);if(ctxErr)return deny(ctxErr);
  const inErr=validateInput(input);if(inErr)return deny(inErr);
  if(input.at>t)return deny('future_observation');
  if(latestAt!==null&&input.at<latestAt)return deny('stale_observation');
  latestAt=input.at;
  if(pending){
   if(pending.id===input.id&&pending.fingerprint===input.fingerprint)return {admitted:true,reason:'replay',ticket:pending.ticket};
   return deny('pending_conflict');
  }
  if(input.urgent===true)return admit(input,t,'urgent');
  if(input.changed===true){
   const eligible=(lastCommitAt??0)+minIntervalMs;
   if(lastCommitAt!==null&&t<eligible)return deny('min_interval',eligible);
   return admit(input,t,'changed');
  }
  const known=remembered.get(input.fingerprint);
  if(known){
   const eligible=known.committedAt+stableReviewMs;
   if(t<eligible)return deny('stable_wait',eligible);
   return admit(input,t,'stable_review');
  }
  return admit(input,t,'first_observation');
 }
 function commit(input={}) {
  if(closed)return fail('closed');
  const t=now();
  if(clockFaulted)return fail('clock_regressed');
  if(!text(input.ticket,bounds.id))return fail('invalid_ticket');
  if(pending&&pending.ticket===input.ticket){
   const done=pending;pending=null;
   if(remembered.has(done.fingerprint))remembered.delete(done.fingerprint);
   remembered.set(done.fingerprint,{fingerprint:done.fingerprint,id:done.id,at:done.at,committedAt:t});
   while(remembered.size>maxRemembered)remembered.delete(remembered.keys().next().value);
   lastCommitAt=t;
   lastCommitted={ticket:done.ticket,id:done.id,fingerprint:done.fingerprint,epoch:done.epoch,deskId:done.deskId,consideredAt:done.consideredAt,committedAt:t};
   return {accepted:true,committed:{...lastCommitted}};
  }
  if(lastCommitted&&lastCommitted.ticket===input.ticket)return {accepted:true,committed:{...lastCommitted},idempotent:true};
  return fail('unknown_ticket');
 }
 function release(input={}) {
  if(closed)return fail('closed');
  now();
  if(clockFaulted)return fail('clock_regressed');
  if(!text(input.ticket,bounds.id))return fail('invalid_ticket');
  if(pending&&pending.ticket===input.ticket){
   const gone=pending;pending=null;
   return {accepted:true,released:{ticket:gone.ticket,id:gone.id,fingerprint:gone.fingerprint,consideredAt:gone.consideredAt}};
  }
  if(lastCommitted&&lastCommitted.ticket===input.ticket)return fail('already_committed');
  return fail('unknown_ticket');
 }
 function reset(input={}) {
  if(closed)return fail('closed');
  if(!Number.isSafeInteger(input.epoch)||input.epoch<0)return fail('invalid_context');
  if(!text(input.deskId,bounds.desk))return fail('invalid_context');
  if(input.reason!==undefined&&!text(input.reason,bounds.reason))return fail('invalid_context');
  now();
  epoch=input.epoch;deskId=input.deskId;clearGeneration();clockFaulted=false;
  return {accepted:true,epoch,deskId};
 }
 function snapshot() {
  return {closed,clockFaulted,epoch,deskId,lastCommitAt,latestAt,remembered:remembered.size,
   pending:pending?{ticket:pending.ticket,id:pending.id,fingerprint:pending.fingerprint,at:pending.at,urgent:pending.urgent,consideredAt:pending.consideredAt}:null,
   capacity:{minIntervalMs,stableReviewMs,maxRemembered}};
 }
 function close() {
  if(closed)return {accepted:true,droppedTicket:null};
  closed=true;
  const dropped=pending?pending.ticket:null;pending=null;
  return {accepted:true,droppedTicket:dropped};
 }
 return {consider,commit,release,reset,snapshot,close};
}
