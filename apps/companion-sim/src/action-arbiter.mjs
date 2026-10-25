// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const CHANNELS=['screen','head'];
const MAX_REQUESTS=8192;
const MIN_DURATION_MS=100;
const MAX_DURATION_MS=15000;
const bounds={id:80,desk:200,reason:200};
const finite=Number.isFinite;
const text=(value,max)=>typeof value==='string'&&value.trim().length>=1&&[...value].length<=max&&!value.includes('\0');

/** Generic device-channel lease arbitration. The host owns every authorization:
 *  priority arrives with the request, business meaning stays with the agent, and
 *  this module never escalates privileges on its own. Pure memory, no timers. */
export function createActionArbiter({clock=Date.now}={}) {
 let epoch=-1,closed=false,lastNow=null,seq=0;
 const requests=new Map();
 const leases=new Map();
 const endedNotifications=[];
 const reject=reason=>({accepted:false,reason});
 const meta=lease=>({leaseId:lease.leaseId,requestId:lease.requestId,owner:lease.owner,channels:[...lease.channels],epoch:lease.epoch,deskId:lease.deskId,expiresAt:lease.expiresAt,endedAt:lease.endedAt,reason:lease.endReason});
 const view=lease=>({leaseId:lease.leaseId,requestId:lease.requestId,owner:lease.owner,channels:[...lease.channels],priority:lease.priority,epoch:lease.epoch,deskId:lease.deskId,createdAt:lease.createdAt,expiresAt:lease.expiresAt});
 function end(lease,reason,at) {
  lease.state='ended';lease.endedAt=at;lease.endReason=reason;
  const record=requests.get(lease.requestId);if(record)record.state=reason;
 }
 function revokeAll(reason) {
  const at=lastNow??0;
  for(const lease of leases.values())if(lease.state==='active'){end(lease,reason,at);endedNotifications.push(meta(lease));}
 }
 function now() {
  const t=clock();
  if(!Number.isSafeInteger(t)||t<0){revokeAll('invalid_clock');return null;}
  if(lastNow!==null&&t<lastNow)revokeAll('clock_regressed');
  lastNow=t;return t;
 }
 function activeHolder(channel,t) {
  for(const lease of leases.values())if(lease.state==='active'&&lease.channels.includes(channel)){
   if(t>=lease.expiresAt){end(lease,'expired',t);continue;}
   return lease;
  }
  return null;
 }
 function authorize(context) {
  if(!Number.isSafeInteger(context.epoch)||context.epoch<0)return 'invalid_context';
  if(!text(context.deskId,bounds.desk))return 'invalid_context';
  if(epoch!==-1&&context.epoch<epoch)return 'stale_epoch';
  if(context.enabled!==true)return 'disabled';
  if(context.epoch>epoch){epoch=context.epoch;revokeAll('epoch_changed');requests.clear();leases.clear();}
  return null;
 }
 function validateRequest(request) {
  if(!request||typeof request!=='object')return 'invalid_request';
  if(!text(request.requestId,bounds.id)||!text(request.owner,bounds.id))return 'invalid_request';
  if(!Array.isArray(request.channels)||request.channels.length<1||request.channels.length>CHANNELS.length)return 'invalid_request';
  const set=new Set(request.channels);
  if(set.size!==request.channels.length||[...set].some(channel=>!CHANNELS.includes(channel)))return 'invalid_request';
  if(!Number.isInteger(request.priority)||request.priority<0||request.priority>100)return 'invalid_request';
  if(!finite(request.durationMs)||request.durationMs<MIN_DURATION_MS||request.durationMs>MAX_DURATION_MS)return 'invalid_request';
  return null;
 }
 const samePayload=(a,b)=>a.owner===b.owner&&a.deskId===b.deskId&&a.epoch===b.epoch&&a.priority===b.priority&&a.durationMs===b.durationMs&&a.channels.join('|')===b.channels.join('|');
 function claim(request,context={}) {
  if(closed)return reject('closed');
  const t=now();
  if(t===null)return reject('invalid_clock');
  const denied=authorize(context);if(denied)return reject(denied);
  const invalid=validateRequest(request);if(invalid)return reject(invalid);
  const channels=CHANNELS.filter(channel=>request.channels.includes(channel));
  const payload={owner:request.owner,channels,priority:request.priority,durationMs:request.durationMs,epoch:context.epoch,deskId:context.deskId};
  const known=requests.get(request.requestId);
  if(known){
   if(!samePayload(known.payload,payload))return reject('request_conflict');
   if(known.state!=='active')return reject('request_concluded');
   const lease=leases.get(known.leaseId);
   if(!lease||lease.state!=='active'||t>=lease.expiresAt)return reject('request_concluded');
   return {accepted:true,lease:view(lease),superseded:[]};
  }
  if(requests.size>=MAX_REQUESTS)return reject('budget_exhausted');
  const holders=new Map();
  for(const channel of channels){
   const holder=activeHolder(channel,t);
   if(!holder)continue;
   if(holder.priority>request.priority)return reject('priority_insufficient');
   if(holder.priority===request.priority&&holder.owner!==request.owner)return reject('channel_busy');
   holders.set(channel,holder);
  }
  const superseded=[],supersededChannels=[];
  for(const holder of new Set(holders.values())){const overlap=holder.channels.filter(channel=>channels.includes(channel));supersededChannels.push({leaseId:holder.leaseId,channels:overlap});holder.channels=holder.channels.filter(channel=>!channels.includes(channel));if(!holder.channels.length){superseded.push(holder.leaseId);end(holder,'superseded',t);}}
  const lease={leaseId:`lease-${++seq}`,requestId:request.requestId,owner:request.owner,channels,priority:request.priority,durationMs:request.durationMs,createdAt:t,expiresAt:t+request.durationMs,epoch:context.epoch,deskId:context.deskId,state:'active',endedAt:null,endReason:null};
  leases.set(lease.leaseId,lease);
  requests.set(request.requestId,{payload,leaseId:lease.leaseId,state:'active'});
  return {accepted:true,lease:view(lease),superseded,supersededChannels};
 }
 function check(input={}) {
  const t=closed?(lastNow??clock()):now();
  if(t===null)return {usable:false,expiresAt:null,reason:'invalid_clock'};
  if(!text(input.leaseId,bounds.id))return {usable:false,expiresAt:null,reason:'invalid_lease'};
  const lease=leases.get(input.leaseId);
  if(!lease)return {usable:false,expiresAt:null,reason:'unknown_lease'};
  const expiresAt=lease.expiresAt;
  if(closed)return {usable:false,expiresAt,reason:'closed'};
  if(lease.state!=='active')return {usable:false,expiresAt,reason:lease.endReason};
  if(t>=expiresAt)return {usable:false,expiresAt,reason:'expired'};
  if(!Number.isSafeInteger(input.epoch)||input.epoch!==lease.epoch||input.epoch!==epoch)return {usable:false,expiresAt,reason:'stale_epoch'};
  if(input.deskId!==lease.deskId)return {usable:false,expiresAt,reason:'desk_mismatch'};
  return {usable:true,expiresAt};
 }
 function release(input={}) {
  if(closed)return reject('closed');
  const t=now();
  if(!text(input.leaseId,bounds.id))return reject('invalid_lease');
  const lease=leases.get(input.leaseId);
  if(!lease)return reject('unknown_lease');
  if(lease.state!=='active')return reject('not_active');
  end(lease,'released',t);
  return {accepted:true,terminated:meta(lease)};
 }
 function cancel(input={}) {
  if(closed)return reject('closed');
  const t=now();
  if(!Number.isSafeInteger(input.epoch)||input.epoch<0)return reject('invalid_context');
  const terminated=[];
  for(const lease of leases.values())if(lease.state==='active'&&lease.epoch<=input.epoch){end(lease,'cancelled',t);terminated.push(meta(lease));}
  if(input.epoch>=epoch)epoch=input.epoch+1;
  return {accepted:true,terminated};
 }
 function tick() {
  if(closed)return [];
  const t=now();
  if(t===null)return endedNotifications.splice(0);
  const terminated=endedNotifications.splice(0);
  for(const lease of leases.values())if(lease.state==='active'&&t>=lease.expiresAt){end(lease,'expired',t);terminated.push(meta(lease));}
  return terminated;
 }
 function snapshot() {
  return {closed,epoch,requests:requests.size,capacity:{maxRequests:MAX_REQUESTS,channels:CHANNELS.length},activeLeases:[...leases.values()].filter(lease=>lease.state==='active').map(view)};
 }
 function close() {
  if(closed)return {accepted:true,terminated:[]};
  closed=true;
  const at=lastNow??clock(),terminated=[];
  for(const lease of leases.values())if(lease.state==='active'){end(lease,'closed',at);terminated.push(meta(lease));}
  return {accepted:true,terminated};
 }
 return {claim,check,release,cancel,tick,snapshot,close};
}
