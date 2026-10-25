// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const KINDS=new Set(['rate_limited','unavailable','network','timeout','authentication','account','request','unknown']);
const TRANSIENT=new Set(['rate_limited','unavailable','network','timeout']);
const FIELDS=new Set(['kind','retryable','httpStatus','businessCode','retryAfterMs']);
const MAX_RETRY_AFTER_MS=3600000;
const MAX_FAILURES=1000000;
const MAX_SHIFT=32;
const safe=Number.isSafeInteger;

/** Generic in-memory provider availability gate. The host owns scenarios,
 *  networking, timers, models, replay and storage; this module only remembers
 *  whether a provider failure permits another attempt and when. Bounded
 *  metadata only: no frames, exceptions, credentials or user facts are kept,
 *  and no wakeup threads exist. */
export function createProviderAvailability({clock=Date.now,baseDelayMs=2000,maxDelayMs=60000}={}) {
 if(typeof clock!=='function')throw new TypeError('invalid_clock');
 if(!safe(baseDelayMs)||baseDelayMs<=0||baseDelayMs>MAX_RETRY_AFTER_MS)throw new TypeError('invalid_base_delay');
 if(!safe(maxDelayMs)||maxDelayMs<baseDelayMs||maxDelayMs>MAX_RETRY_AFTER_MS)throw new TypeError('invalid_max_delay');
 let closed=false,clockFaulted=false,lastNow=null;
 let consecutiveFailures=0,failedAt=null,nextEligibleAt=null,reason=null;
 function readClock() {
  if(clockFaulted)return null;
  let t;
  try{t=clock();}catch{clockFaulted=true;return null;}
  if(!safe(t)||t<0){clockFaulted=true;return null;}
  if(lastNow!==null&&t<lastNow){clockFaulted=true;return null;}
  lastNow=t;return t;
 }
 function validShape(f) {
  if(!f||typeof f!=='object'||Array.isArray(f))return false;
  for(const key of Object.keys(f))if(!FIELDS.has(key))return false;
  if(typeof f.kind!=='string'||!KINDS.has(f.kind))return false;
  if(typeof f.retryable!=='boolean')return false;
  if(f.httpStatus!==undefined&&(!safe(f.httpStatus)||f.httpStatus<100||f.httpStatus>599))return false;
  if(f.businessCode!==undefined&&(typeof f.businessCode!=='string'||!/^\d{1,8}$/.test(f.businessCode)))return false;
  if(f.retryAfterMs!==undefined&&(!safe(f.retryAfterMs)||f.retryAfterMs<0))return false;
  return true;
 }
 function backoff() {
  const shift=Math.min(consecutiveFailures-1,MAX_SHIFT);
  return Math.min(maxDelayMs,baseDelayMs*2**shift);
 }
 function failed(failure) {
  if(closed)return {recoverable:false,...snapshot()};
  const shapeOk=validShape(failure);
  consecutiveFailures=Math.min(consecutiveFailures+1,MAX_FAILURES);
  reason=shapeOk?failure.kind:null;
  const t=readClock();
  if(t===null){failedAt=null;nextEligibleAt=null;return {recoverable:false,...snapshot()};}
  failedAt=t;
  let recoverable=shapeOk&&TRANSIENT.has(failure.kind)&&failure.retryable===true&&
   (failure.retryAfterMs===undefined||failure.retryAfterMs<=MAX_RETRY_AFTER_MS);
  if(recoverable){
   let delay=backoff();
   if(failure.retryAfterMs!==undefined)delay=Math.max(delay,Math.ceil(failure.retryAfterMs));
   if(safe(t+delay))nextEligibleAt=t+delay;
   else {nextEligibleAt=null;recoverable=false;}
  }else nextEligibleAt=null;
  return {recoverable,...snapshot()};
 }
 function canStart(observedAt) {
  if(closed)return false;
  const t=readClock();
  if(t===null)return false;
  if(failedAt===null)return true;
  if(nextEligibleAt===null||t<nextEligibleAt)return false;
  return safe(observedAt)&&observedAt>failedAt&&observedAt<=t;
 }
 function success() {
  if(closed)return {accepted:false,...snapshot()};
  if(readClock()===null)return {accepted:false,...snapshot()};
  consecutiveFailures=0;failedAt=null;nextEligibleAt=null;reason=null;
  return {accepted:true,...snapshot()};
 }
 function snapshot() {
  const t=readClock();
  let status;
  if(closed)status='closed';
  else if(clockFaulted)status='clock_fault';
  else if(failedAt===null)status='ready';
  else if(nextEligibleAt!==null&&t!==null&&t>=nextEligibleAt)status='needs_observation';
  else status='waiting';
  return {status,consecutiveFailures,failedAt,nextEligibleAt,reason};
 }
 function close() {
  if(closed)return {accepted:true,...snapshot()};
  closed=true;consecutiveFailures=0;failedAt=null;nextEligibleAt=null;reason=null;
  return {accepted:true,...snapshot()};
 }
 return {failed,canStart,success,snapshot,close};
}
